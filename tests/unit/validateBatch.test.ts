// tests/unit/validateBatch.test.ts
//
// Batch-level validation. The distinction this file guards is the one
// the route depends on: a malformed *envelope* is a flat 400, whereas a
// well-formed envelope with bad entries still yields per-entry verdicts
// so the good entries survive (§8).

import { describe, it, expect } from 'vitest';
import { validateBatch } from '../../src/core/validation/validateBatch.js';

const RETENTION_DAYS = 30;

/** A valid entry timestamped now, so it is always inside the window. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'svc',
    message: 'msg',
    ...overrides,
  };
}

function run(body: unknown) {
  return validateBatch(body, RETENTION_DAYS);
}

describe('validateBatch — envelope errors (flat 400, no per-entry data)', () => {
  it.each([
    ['null body', null],
    ['a string body', 'nope'],
    ['an array body', [entry()]],
    ['a number body', 7],
  ])('rejects %s', (_label, body) => {
    const out = run(body);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/must be a JSON object/);
  });

  it('rejects a missing logs key', () => {
    const out = run({ foo: 1 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/'logs' must be an array/);
  });

  it('rejects a non-array logs value', () => {
    expect(run({ logs: 'nope' }).ok).toBe(false);
    expect(run({ logs: { 0: entry() } }).ok).toBe(false);
  });

  it('rejects an empty logs array', () => {
    // §8: "If `logs` is empty or missing, return 400".
    const out = run({ logs: [] });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/at least one entry/);
  });

  it('rejects a batch above the 5,000 entry cap', () => {
    const out = run({ logs: new Array(5001).fill(entry()) });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/batch too large/);
  });

  it('accepts a batch of exactly 5,000 entries', () => {
    // The documented cap is inclusive; off-by-one here would reject a
    // legitimate maximum-size batch.
    const out = run({ logs: new Array(5000).fill(entry()) });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.accepted).toHaveLength(5000);
  });
});

describe('validateBatch — per-entry verdicts', () => {
  it('accepts every valid entry', () => {
    const out = run({ logs: [entry(), entry(), entry()] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.accepted).toHaveLength(3);
    expect(out.result.rejected).toHaveLength(0);
  });

  it('keeps valid entries when others are invalid, with correct indexes', () => {
    // The core promise of §8: one bad entry must not sink the batch,
    // and the client must be told exactly which positions failed.
    const out = run({
      logs: [
        entry(),
        entry({ level: 'critical' }),
        entry(),
        entry({ message: '' }),
        entry(),
      ],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.accepted).toHaveLength(3);
    expect(out.result.rejected.map((r) => r.index)).toEqual([1, 3]);
    expect(out.result.rejected[0]!.reason).toBe("invalid level: 'critical'");
  });

  it('reports zero accepted when every entry is invalid', () => {
    // Still `ok: true` -- the envelope was fine. The route is what turns
    // "nothing accepted" into a 400.
    const out = run({ logs: [entry({ level: 'nope' }), entry({ service: '' })] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.accepted).toHaveLength(0);
    expect(out.result.rejected).toHaveLength(2);
  });

  it('rejects entries older than the retention window without failing the batch', () => {
    // Regression guard for the late-arrival defect: a stale entry used
    // to pass validation and then take the whole batch down with a 500
    // when COPY found no partition for it.
    const stale = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const out = run({ logs: [entry(), entry({ timestamp: stale }), entry()] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.accepted).toHaveLength(2);
    expect(out.result.rejected).toHaveLength(1);
    expect(out.result.rejected[0]!.index).toBe(1);
    expect(out.result.rejected[0]!.reason).toMatch(/retention window/);
  });

  it('applies one clock to the whole batch', () => {
    // `now` is computed once per batch, so an entry near the future
    // boundary cannot be judged differently depending on its position.
    const nearFuture = new Date(Date.now() + 4 * 60_000).toISOString();
    const out = run({ logs: new Array(500).fill(entry({ timestamp: nearFuture })) });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.accepted).toHaveLength(500);
  });
});

describe('validateBatch — never throws', () => {
  it('survives hostile entry shapes inside a well-formed envelope', () => {
    const out = run({
      logs: [null, undefined, 'x', 42, [], { get level() { throw new Error('boom'); } }],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.rejected).toHaveLength(6);
  });
});
