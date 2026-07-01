import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from './concurrency.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('returns an empty array for empty input without invoking the fn', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 3, async () => { calls++; return 1; });
    assert.deepEqual(out, []);
    assert.equal(calls, 0);
  });

  it('preserves input order in the output', async () => {
    const items = [10, 30, 5, 20, 1];
    const out = await mapWithConcurrency(items, 3, async (n) => {
      // Stagger by value so completion order differs from input order.
      await sleep(n);
      return n * 2;
    });
    assert.deepEqual(out, [20, 60, 10, 40, 2]);
  });

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
      return null;
    });
    assert.equal(peak, 3);
  });

  it('caps the pool at items.length when limit > items.length', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [1, 2];
    await mapWithConcurrency(items, 100, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(2);
      inFlight--;
      return null;
    });
    assert.equal(peak, 2);
  });

  it('rejects the overall promise on first task rejection and stops scheduling new work', async () => {
    let started = 0;
    const items = [1, 2, 3, 4, 5, 6];
    const err = await mapWithConcurrency(items, 2, async (n) => {
      started++;
      await sleep(1);
      if (n === 2) throw new Error('boom');
      return n;
    }).catch(e => e as Error);
    assert.ok(err instanceof Error);
    assert.equal((err as Error).message, 'boom');
    // The two initial workers started 1 and 2. After 2 fails, no more are
    // started. The first worker may have started a third item before the
    // rejection propagates, but we should NOT have scheduled all 6.
    assert.ok(started < items.length, `expected fewer than ${items.length} starts, got ${started}`);
  });

  it('throws when limit is < 1', async () => {
    await assert.rejects(
      () => mapWithConcurrency([1], 0, async () => null),
      /limit must be >= 1/,
    );
  });
});
