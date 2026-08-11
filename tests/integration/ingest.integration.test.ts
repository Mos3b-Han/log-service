// tests/integration/ingest.integration.test.ts
//
// The write path end to end: HTTP -> validation -> buffer -> COPY ->
// Postgres -> readable again. Everything here is asserted by reading
// data back through the API, because that is the only evidence that a
// write actually landed rather than merely being accepted.
//
// Requires a running stack: docker compose up -d --build --wait

import { describe, it, expect, beforeAll } from 'vitest';
import {
  get,
  postJson,
  waitForHealthy,
  uniqueService,
  isoAgo,
} from '../helpers/client.js';

interface IngestResponse {
  accepted: number;
  rejected: { index: number; reason: string }[];
}
interface LogsResponse {
  logs: {
    id: string;
    timestamp: string;
    level: string;
    service: string;
    message: string;
    attributes: Record<string, string>;
  }[];
  next_cursor: string | null;
}

beforeAll(async () => {
  await waitForHealthy();
});

/** Ingest, then read back everything written for that service. */
async function ingestAndRead(
  service: string,
  logs: unknown[],
): Promise<{ accepted: IngestResponse; rows: LogsResponse['logs'] }> {
  const res = await postJson<IngestResponse>('/logs', { logs });
  expect(res.status).toBe(200);
  const read = await get<LogsResponse>(`/logs?service=${service}&limit=1000`);
  expect(read.status).toBe(200);
  return { accepted: res.body, rows: read.body.logs };
}

describe('durability', () => {
  it('makes an accepted entry readable immediately after the response', async () => {
    // The writer resolves each caller's promise only once the COPY
    // containing its rows has committed, so a 200 means the data is
    // already durable -- no polling needed here.
    const service = uniqueService('durable');
    const { accepted, rows } = await ingestAndRead(service, [
      { timestamp: isoAgo(10), level: 'info', service, message: 'durable write' },
    ]);
    expect(accepted.accepted).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe('durable write');
  });

  it('persists a multi-entry batch completely', async () => {
    const service = uniqueService('batch');
    const logs = Array.from({ length: 50 }, (_, i) => ({
      timestamp: isoAgo(100 - i),
      level: 'info',
      service,
      message: `entry ${i}`,
    }));
    const { accepted, rows } = await ingestAndRead(service, logs);
    expect(accepted.accepted).toBe(50);
    expect(rows).toHaveLength(50);
  });

  it('coalesces concurrent batches without losing any of them', async () => {
    // Concurrent writes merge into shared COPY flushes. Each caller
    // still has to get its own rows back -- this is the property that
    // makes micro-batching safe to report as 200.
    const service = uniqueService('concurrent');
    const batches = Array.from({ length: 8 }, (_, b) =>
      postJson<IngestResponse>('/logs', {
        logs: Array.from({ length: 25 }, (_, i) => ({
          timestamp: isoAgo(500 - b * 25 - i),
          level: 'info',
          service,
          message: `b${b}-e${i}`,
        })),
      }),
    );
    const results = await Promise.all(batches);
    for (const r of results) expect(r.status).toBe(200);

    const read = await get<LogsResponse>(`/logs?service=${service}&limit=1000`);
    expect(read.body.logs).toHaveLength(200);
  });
});

describe('field handling', () => {
  it('round-trips all four levels by name', async () => {
    const service = uniqueService('levels');
    const { rows } = await ingestAndRead(
      service,
      ['debug', 'info', 'warn', 'error'].map((level, i) => ({
        timestamp: isoAgo(40 - i * 5),
        level,
        service,
        message: level,
      })),
    );
    expect(rows.map((r) => r.level).sort()).toEqual(
      ['debug', 'error', 'info', 'warn'],
    );
  });

  it('normalizes attribute values to strings (§10)', async () => {
    // Numbers and booleans are coerced at ingest so `attr.<key>`
    // filters compare uniformly. Verified by reading the stored form.
    const service = uniqueService('attrs');
    const { rows } = await ingestAndRead(service, [
      {
        timestamp: isoAgo(10),
        level: 'info',
        service,
        message: 'attr types',
        attributes: { num: 42, bool: true, str: 'x', float: 1.5 },
      },
    ]);
    expect(rows[0]!.attributes).toEqual({
      num: '42',
      bool: 'true',
      str: 'x',
      float: '1.5',
    });
  });

  it('stores an absent attributes field as an empty object', async () => {
    const service = uniqueService('noattrs');
    const { rows } = await ingestAndRead(service, [
      { timestamp: isoAgo(10), level: 'info', service, message: 'none' },
    ]);
    expect(rows[0]!.attributes).toEqual({});
  });

  it('preserves control characters that would break COPY text format', async () => {
    // Tab, newline, carriage return and backslash are the field and row
    // delimiters (or their escape) in COPY's text format. A stack trace
    // pasted into `message` contains all of them.
    const service = uniqueService('escapes');
    const message = 'line1\nline2\ttabbed\rcarriage\\backslash';
    const { rows } = await ingestAndRead(service, [
      {
        timestamp: isoAgo(10),
        level: 'error',
        service,
        message,
        attributes: { path: 'C:\\Users\\me', note: 'a\tb' },
      },
    ]);
    expect(rows[0]!.message).toBe(message);
    expect(rows[0]!.attributes['path']).toBe('C:\\Users\\me');
    expect(rows[0]!.attributes['note']).toBe('a\tb');
  });

  it('stores SQL-shaped input as inert text', async () => {
    const service = uniqueService('injection');
    const payload = "'; DROP TABLE logs; --";
    const { rows } = await ingestAndRead(service, [
      {
        timestamp: isoAgo(10),
        level: 'warn',
        service,
        message: payload,
        attributes: { evil: payload },
      },
    ]);
    expect(rows[0]!.message).toBe(payload);
    // The table is obviously still there if this read succeeded, but
    // assert it explicitly so the intent of the test is unmistakable.
    const still = await get<LogsResponse>('/logs?limit=1');
    expect(still.status).toBe(200);
  });
});

describe('late-arriving entries', () => {
  it('accepts an entry from well inside the retention window', async () => {
    // Regression guard: partitions are provisioned backwards across the
    // retention window precisely so a delayed agent flush has somewhere
    // to land.
    const service = uniqueService('late');
    const { accepted, rows } = await ingestAndRead(service, [
      {
        timestamp: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        level: 'info',
        service,
        message: 'buffered flush',
      },
    ]);
    expect(accepted.accepted).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it('rejects an entry older than retention per-entry, keeping the batch', async () => {
    // This used to be a 500 that destroyed the whole batch. The
    // surviving entries are the point of the test.
    const service = uniqueService('ancient');
    const ancient = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const res = await postJson<IngestResponse>('/logs', {
      logs: [
        { timestamp: isoAgo(10), level: 'info', service, message: 'valid A' },
        { timestamp: ancient, level: 'info', service, message: 'too old' },
        { timestamp: isoAgo(5), level: 'warn', service, message: 'valid B' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(2);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0]!.index).toBe(1);
    expect(res.body.rejected[0]!.reason).toMatch(/retention window/);

    const read = await get<LogsResponse>(`/logs?service=${service}&limit=100`);
    expect(read.body.logs.map((r) => r.message).sort()).toEqual([
      'valid A',
      'valid B',
    ]);
  });
});

describe('batch semantics (§8)', () => {
  it('writes the valid entries of a mixed batch and only those', async () => {
    const service = uniqueService('mixed');
    const res = await postJson<IngestResponse>('/logs', {
      logs: [
        { timestamp: isoAgo(30), level: 'info', service, message: 'keep 1' },
        { timestamp: isoAgo(25), level: 'critical', service, message: 'drop' },
        { timestamp: isoAgo(20), level: 'info', service, message: 'keep 2' },
        { timestamp: 'not-a-date', level: 'info', service, message: 'drop' },
        { timestamp: isoAgo(15), level: 'warn', service, message: 'keep 3' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(3);
    expect(res.body.rejected.map((r) => r.index)).toEqual([1, 3]);

    const read = await get<LogsResponse>(`/logs?service=${service}&limit=100`);
    expect(read.body.logs).toHaveLength(3);
    expect(read.body.logs.every((r) => r.message.startsWith('keep'))).toBe(true);
  });

  it('writes nothing when every entry is rejected', async () => {
    const service = uniqueService('allbad');
    const res = await postJson('/logs', {
      logs: [
        { timestamp: isoAgo(10), level: 'nope', service, message: 'x' },
        { timestamp: isoAgo(10), level: 'info', service, message: '' },
      ],
    });
    expect(res.status).toBe(400);
    const read = await get<LogsResponse>(`/logs?service=${service}`);
    expect(read.body.logs).toEqual([]);
  });
});
