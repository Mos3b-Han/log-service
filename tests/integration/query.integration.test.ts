// tests/integration/query.integration.test.ts
//
// The read path end to end: filters, ordering, keyset pagination, and
// aggregation, all against a live database that also holds unrelated
// load-test data. Every test writes into its own unique service so the
// assertions stay exact regardless of what else is stored.
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
interface AggregateResponse {
  buckets: { start: string; group: string | null; count: number }[];
}

// One shared fixture for the whole suite: 12 entries, one per minute,
// spread across two levels and two regions so every filter dimension
// has something to discriminate on.
const SERVICE = uniqueService('read');
const OTHER_SERVICE = uniqueService('read-other');
const ENTRY_COUNT = 12;

beforeAll(async () => {
  await waitForHealthy();

  const logs = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
    // i=0 is oldest. 60s apart keeps them in distinct 1m buckets.
    timestamp: isoAgo((ENTRY_COUNT - i) * 60),
    level: i % 3 === 0 ? 'error' : 'info',
    service: SERVICE,
    message: i % 2 === 0 ? `alpha entry ${i}` : `BETA entry ${i}`,
    attributes: {
      region: i % 2 === 0 ? 'eu-west' : 'us-east',
      seq: i,
    },
  }));
  // A second service in the same time range, to prove filters exclude.
  logs.push({
    timestamp: isoAgo(120),
    level: 'error',
    service: OTHER_SERVICE,
    message: 'alpha decoy',
    attributes: { region: 'eu-west', seq: 999 },
  });

  const res = await postJson<{ accepted: number }>('/logs', { logs });
  expect(res.status).toBe(200);
  expect(res.body.accepted).toBe(ENTRY_COUNT + 1);
});

describe('filters', () => {
  it('matches service exactly, excluding a similarly-named one', async () => {
    const res = await get<LogsResponse>(`/logs?service=${SERVICE}&limit=1000`);
    expect(res.body.logs).toHaveLength(ENTRY_COUNT);
    expect(res.body.logs.every((r) => r.service === SERVICE)).toBe(true);
  });

  it('matches level exactly', async () => {
    const res = await get<LogsResponse>(`/logs?service=${SERVICE}&level=error&limit=1000`);
    // i % 3 === 0 for i in 0..11 -> 4 entries.
    expect(res.body.logs).toHaveLength(4);
    expect(res.body.logs.every((r) => r.level === 'error')).toBe(true);
  });

  it('combines service, level, and an attribute filter', async () => {
    const res = await get<LogsResponse>(
      `/logs?service=${SERVICE}&level=info&attr.region=us-east&limit=1000`,
    );
    expect(res.body.logs.length).toBeGreaterThan(0);
    for (const row of res.body.logs) {
      expect(row.level).toBe('info');
      expect(row.attributes['region']).toBe('us-east');
    }
  });

  it('compares attribute values as strings, including numeric ones', async () => {
    // `seq` was sent as a number and stored as a string; the filter must
    // still find it when given the string form.
    const res = await get<LogsResponse>(`/logs?service=${SERVICE}&attr.seq=5`);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0]!.attributes['seq']).toBe('5');
  });

  it('matches q case-insensitively', async () => {
    // Half the messages say "alpha", half "BETA". Lowercase "beta" must
    // find the uppercase ones.
    const lower = await get<LogsResponse>(`/logs?service=${SERVICE}&q=beta&limit=1000`);
    const upper = await get<LogsResponse>(`/logs?service=${SERVICE}&q=BETA&limit=1000`);
    expect(lower.body.logs.length).toBe(6);
    expect(upper.body.logs.length).toBe(lower.body.logs.length);
  });

  it('treats LIKE metacharacters in q literally', async () => {
    // If % were passed through as a wildcard, this would match all 12
    // entries instead of none.
    const res = await get<LogsResponse>(`/logs?service=${SERVICE}&q=%25&limit=1000`);
    expect(res.body.logs).toHaveLength(0);
  });

  it('honours since as inclusive and until as exclusive', async () => {
    const all = await get<LogsResponse>(`/logs?service=${SERVICE}&limit=1000`);
    const timestamps = all.body.logs.map((r) => r.timestamp).sort();
    const first = timestamps[0]!;
    const second = timestamps[1]!;

    // [first, second) must contain exactly the first entry.
    const res = await get<LogsResponse>(
      `/logs?service=${SERVICE}&since=${encodeURIComponent(first)}` +
        `&until=${encodeURIComponent(second)}&limit=1000`,
    );
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0]!.timestamp).toBe(first);
  });
});

describe('ordering', () => {
  it('returns rows newest first', async () => {
    const res = await get<LogsResponse>(`/logs?service=${SERVICE}&limit=1000`);
    const times = res.body.logs.map((r) => Date.parse(r.timestamp));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('breaks timestamp ties deterministically by descending id', async () => {
    // Same-timestamp rows are the case where a naive ORDER BY would let
    // pages overlap or skip. Ordering must be total, not just by time.
    const service = uniqueService('ties');
    const sameTs = isoAgo(300);
    await postJson('/logs', {
      logs: Array.from({ length: 10 }, (_, i) => ({
        timestamp: sameTs,
        level: 'info',
        service,
        message: `tie ${i}`,
      })),
    });

    const res = await get<LogsResponse>(`/logs?service=${service}&limit=1000`);
    expect(res.body.logs).toHaveLength(10);
    expect(res.body.logs.every((r) => r.timestamp === sameTs)).toBe(true);
    const ids = res.body.logs.map((r) => BigInt(r.id));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! < ids[i - 1]!).toBe(true);
    }
  });
});

describe('keyset pagination', () => {
  it('walks every row exactly once with no gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const qs = new URLSearchParams({ service: SERVICE, limit: '5' });
      if (cursor) qs.set('cursor', cursor);
      const res = await get<LogsResponse>(`/logs?${qs.toString()}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.logs.map((r) => r.id));
      cursor = res.body.next_cursor;
      pages++;
      expect(pages).toBeLessThan(10); // guard against a cursor loop
    } while (cursor !== null);

    expect(seen).toHaveLength(ENTRY_COUNT);
    expect(new Set(seen).size).toBe(ENTRY_COUNT);
  });

  it('preserves descending order across page boundaries', async () => {
    const page1 = await get<LogsResponse>(`/logs?service=${SERVICE}&limit=5`);
    const cursor = page1.body.next_cursor;
    expect(cursor).toBeTypeOf('string');
    const page2 = await get<LogsResponse>(
      `/logs?service=${SERVICE}&limit=5&cursor=${encodeURIComponent(cursor!)}`,
    );

    const lastOfPage1 = Date.parse(page1.body.logs.at(-1)!.timestamp);
    const firstOfPage2 = Date.parse(page2.body.logs[0]!.timestamp);
    expect(firstOfPage2).toBeLessThanOrEqual(lastOfPage1);
  });

  it('keeps a cursor usable alongside its original filters', async () => {
    const page1 = await get<LogsResponse>(
      `/logs?service=${SERVICE}&level=error&limit=2`,
    );
    expect(page1.body.logs).toHaveLength(2);
    const page2 = await get<LogsResponse>(
      `/logs?service=${SERVICE}&level=error&limit=2` +
        `&cursor=${encodeURIComponent(page1.body.next_cursor!)}`,
    );
    // Filters are re-supplied by the client; the cursor only carries
    // position, so the level filter must still apply on page 2.
    expect(page2.body.logs.every((r) => r.level === 'error')).toBe(true);
  });

  it('paginates a tie-heavy result set without loss', async () => {
    // Identical timestamps make the id tiebreak load-bearing: without it
    // a page boundary landing mid-tie would repeat or drop rows.
    const service = uniqueService('tiepage');
    const sameTs = isoAgo(600);
    await postJson('/logs', {
      logs: Array.from({ length: 20 }, (_, i) => ({
        timestamp: sameTs,
        level: 'info',
        service,
        message: `t${i}`,
      })),
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({ service, limit: '3' });
      if (cursor) qs.set('cursor', cursor);
      const res = await get<LogsResponse>(`/logs?${qs.toString()}`);
      seen.push(...res.body.logs.map((r) => r.id));
      cursor = res.body.next_cursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
  });
});

describe('aggregation', () => {
  const range = () =>
    `since=${encodeURIComponent(isoAgo(3600))}&until=${encodeURIComponent(isoAgo(-60))}`;

  it('counts every matching row across buckets', async () => {
    const res = await get<AggregateResponse>(
      `/logs/aggregate?${range()}&bucket=1m&service=${SERVICE}`,
    );
    const total = res.body.buckets.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(ENTRY_COUNT);
  });

  it('produces the same total at every bucket size', async () => {
    // Bucket width changes how counts are distributed, never the sum.
    const totals: number[] = [];
    for (const bucket of ['1m', '5m', '1h', '1d']) {
      const res = await get<AggregateResponse>(
        `/logs/aggregate?${range()}&bucket=${bucket}&service=${SERVICE}`,
      );
      totals.push(res.body.buckets.reduce((n, b) => n + b.count, 0));
    }
    expect(totals).toEqual([ENTRY_COUNT, ENTRY_COUNT, ENTRY_COUNT, ENTRY_COUNT]);
  });

  it('splits fine buckets and collapses coarse ones', async () => {
    // Entries are one minute apart, so 1m must yield more buckets than
    // 1d, which must collapse them all into one.
    const fine = await get<AggregateResponse>(
      `/logs/aggregate?${range()}&bucket=1m&service=${SERVICE}`,
    );
    const coarse = await get<AggregateResponse>(
      `/logs/aggregate?${range()}&bucket=1d&service=${SERVICE}`,
    );
    expect(fine.body.buckets.length).toBeGreaterThan(coarse.body.buckets.length);
    expect(coarse.body.buckets).toHaveLength(1);
  });

  it('groups by level, and the groups sum to the ungrouped total', async () => {
    const grouped = await get<AggregateResponse>(
      `/logs/aggregate?${range()}&bucket=1h&group_by=level&service=${SERVICE}`,
    );
    const byLevel = new Map<string, number>();
    for (const b of grouped.body.buckets) {
      byLevel.set(b.group!, (byLevel.get(b.group!) ?? 0) + b.count);
    }
    expect(byLevel.get('error')).toBe(4);
    expect(byLevel.get('info')).toBe(ENTRY_COUNT - 4);
    const sum = [...byLevel.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(ENTRY_COUNT);
  });

  it('groups by service and excludes other services when filtered', async () => {
    const res = await get<AggregateResponse>(
      `/logs/aggregate?${range()}&bucket=1h&group_by=service&service=${SERVICE}`,
    );
    expect(res.body.buckets.every((b) => b.group === SERVICE)).toBe(true);
  });

  it('orders buckets by start ascending', async () => {
    const res = await get<AggregateResponse>(
      `/logs/aggregate?${range()}&bucket=1m&service=${SERVICE}`,
    );
    const starts = res.body.buckets.map((b) => Date.parse(b.start));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('aligns the first bucket to since', async () => {
    // date_bin uses `since` as its origin, so bucket boundaries start
    // exactly at the range start rather than at an arbitrary epoch.
    const since = isoAgo(3600);
    const res = await get<AggregateResponse>(
      `/logs/aggregate?since=${encodeURIComponent(since)}` +
        `&until=${encodeURIComponent(isoAgo(-60))}&bucket=1h&service=${SERVICE}`,
    );
    expect(res.body.buckets).toHaveLength(1);
    expect(res.body.buckets[0]!.start).toBe(new Date(since).toISOString());
  });

  it('applies the same filters as GET /logs', async () => {
    const filter = `&attr.region=eu-west`;
    const list = await get<LogsResponse>(
      `/logs?service=${SERVICE}${filter}&limit=1000`,
    );
    const agg = await get<AggregateResponse>(
      `/logs/aggregate?${range()}&bucket=1h&service=${SERVICE}${filter}`,
    );
    const aggTotal = agg.body.buckets.reduce((n, b) => n + b.count, 0);
    expect(aggTotal).toBe(list.body.logs.length);
  });
});
