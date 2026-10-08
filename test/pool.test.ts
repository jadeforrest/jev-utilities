import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { forEachConcurrent } from '../src/pool';

test('property: visits every index exactly once and never exceeds the limit', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.nat(3), { maxLength: 30 }),
    fc.oneof(fc.integer({ min: -2, max: 10 }), fc.constant(NaN), fc.constant(Infinity), fc.double({ min: 0, max: 5, noNaN: true })),
    async (delays, limit) => {
      const seen: number[] = [];
      let inFlight = 0;
      let peak = 0;
      await forEachConcurrent(delays, limit, async (d, i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, d));
        seen.push(i);
        inFlight--;
      });
      assert.deepEqual([...seen].sort((a, b) => a - b), delays.map((_, i) => i));
      const effective = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
      assert.ok(peak <= effective, `peak ${peak} > ${effective}`);
    }
  ), { numRuns: 60 });
});

test('runs items concurrently up to the limit', async () => {
  let peak = 0;
  let inFlight = 0;
  await forEachConcurrent([1, 2, 3, 4, 5, 6], 3, async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
  });
  assert.equal(peak, 3);
});
