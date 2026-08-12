// loadgen/discover.ts
//
// Dataset discovery shared by the read-path generators.
//
// Both loadgen/aggregate.ts and loadgen/query.ts need the same thing
// before they can measure anything meaningful: a time window that
// actually contains rows, and filter values that actually match at
// volume. Querying an empty range, or filtering on a service that owns
// three rows, produces a fast number that proves nothing.
//
// Everything here goes through the public HTTP API rather than the
// database, for the same reason the generators do: they are external
// clients, exactly like the grader's tool, with no privileged access.
//
// This lives in its own module rather than being copied into each
// generator because the logic is subtle enough to drift -- the
// "busiest service" rule below replaced a naive "first row's service"
// version that silently made one query shape meaningless.

import { parseJson, timedFetch } from './util.js';

export interface Dataset {
  /** Upper bound for every query range: the newest row's timestamp. */
  readonly end: Date;
  /** The highest-volume service in the window, for filtered shapes. */
  readonly service: string;
  /** A real attribute key/value pair, for the GIN containment shape. */
  readonly attrKey: string | undefined;
  readonly attrValue: string | undefined;
  /** A word from a real message, for the unindexed substring shape. */
  readonly word: string | undefined;
}

interface WireLogRow {
  timestamp: string;
  service: string;
  message: string;
  attributes: Record<string, string>;
}

const HOUR_MS = 3_600_000;

/** ISO string for `hoursBack` hours before `end`. */
export function isoOf(end: Date, hoursBack: number): string {
  return new Date(end.getTime() - hoursBack * HOUR_MS).toISOString();
}

/**
 * Inspect the live dataset and return values the generators can build
 * representative queries from.
 *
 * @param baseUrl        Service root, no trailing slash.
 * @param headers        Auth headers, if any.
 * @param windowHours    How far back the widest query will reach; the
 *                       busiest-service lookup uses the same window so
 *                       the chosen service is busy *there*, not overall.
 * @param untilOverride  Optional ISO upper bound. Set it to aim the
 *                       measurement at a specific slice of history
 *                       instead of whatever the latest ingest left
 *                       behind.
 */
export async function discoverDataset(
  baseUrl: string,
  headers: Record<string, string>,
  windowHours: number,
  untilOverride?: string,
): Promise<Dataset> {
  const logsUrl = `${baseUrl}/logs`;
  const aggUrl = `${baseUrl}/logs/aggregate`;

  const res = await timedFetch(`${logsUrl}?limit=1`, { headers });
  if (!res.ok || res.status !== 200) {
    throw new Error(
      `Dataset discovery failed: GET /logs returned ${res.ok ? res.status : res.error}. ` +
        (res.status === 401 ? 'Auth is enabled; set LOADGEN_API_KEY.' : res.text),
    );
  }
  const body = parseJson<{ logs: WireLogRow[] }>(res);
  const row = body?.logs[0];
  if (row === undefined) {
    throw new Error(
      'The service holds no logs. Run `npx tsx loadgen/ingest.ts` first ' +
        'so there is something to query.',
    );
  }

  const end = untilOverride ? new Date(untilOverride) : new Date(row.timestamp);
  if (Number.isNaN(end.getTime())) {
    throw new Error(`Invalid until override: '${untilOverride}'`);
  }

  const attrEntries = Object.entries(row.attributes ?? {});
  const firstAttr = attrEntries[0];

  const word = row.message
    .split(/\s+/)
    .find((w) => w.length >= 4)
    ?.replace(/[^A-Za-z0-9]/g, '');

  return {
    end,
    service: await busiestService(aggUrl, headers, end, windowHours),
    attrKey: firstAttr?.[0],
    attrValue: firstAttr?.[1],
    word: word && word.length >= 4 ? word : undefined,
  };
}

/**
 * Find the service with the most rows in the measurement window.
 *
 * Taking the service off an arbitrary sample row is a trap: a service
 * owning three rows makes a filtered query return almost nothing, and
 * the resulting single-digit timing says nothing about how the
 * composite index behaves at scale.
 */
async function busiestService(
  aggUrl: string,
  headers: Record<string, string>,
  end: Date,
  windowHours: number,
): Promise<string> {
  const qs = new URLSearchParams({
    since: isoOf(end, windowHours),
    until: new Date(end.getTime() + 1000).toISOString(),
    bucket: '1d',
    group_by: 'service',
  });
  const res = await timedFetch(`${aggUrl}?${qs.toString()}`, { headers });
  if (!res.ok || res.status !== 200) {
    throw new Error(
      `Service discovery failed: GET /logs/aggregate returned ${res.ok ? res.status : res.error}`,
    );
  }
  const body = parseJson<{
    buckets: { group: string | null; count: number }[];
  }>(res) ?? { buckets: [] };

  const totals = new Map<string, number>();
  for (const b of body.buckets) {
    if (b.group === null) continue;
    totals.set(b.group, (totals.get(b.group) ?? 0) + b.count);
  }
  let best: { name: string; count: number } | undefined;
  for (const [name, count] of totals) {
    if (best === undefined || count > best.count) best = { name, count };
  }
  if (best === undefined) {
    throw new Error('No services found in the measurement window.');
  }
  return best.name;
}
