// loadgen/discover.ts


import { parseJson, timedFetch } from './util.js';

export interface Dataset {

  readonly end: Date;

  readonly service: string;

  readonly attrKey: string | undefined;
  readonly attrValue: string | undefined;
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
