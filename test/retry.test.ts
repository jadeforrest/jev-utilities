import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { withRetry, isTransient, MAX_RETRIES, UNCLASSIFIED_ATTEMPTS } from '../src/retry';

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

test('isTransient: throttling and server faults only', () => {
  for (const s of [429, 500, 502, 503, 504, 529]) assert.equal(isTransient(httpError(s)), true, String(s));
  for (const s of [400, 401, 403, 404, 422]) assert.equal(isTransient(httpError(s)), false, String(s));
  assert.equal(isTransient(new Error('x')), false);
  assert.equal(isTransient(null), false);
  assert.equal(isTransient('529'), false);
  assert.equal(isTransient({ response: { status: '529' } }), false);
});

test('returns the first success without sleeping', async () => {
  const sleeps: number[] = [];
  assert.equal(await withRetry(async () => 7, async (ms) => { sleeps.push(ms); }), 7);
  assert.deepEqual(sleeps, []);
});

test('transient errors back off exponentially, then give up after MAX_RETRIES attempts', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw httpError(529); }, async (ms) => { sleeps.push(ms); }),
    /HTTP 529/
  );
  assert.equal(calls, MAX_RETRIES);
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000]);
});

test('an unclassified error gets exactly one short retry', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw httpError(401); }, async (ms) => { sleeps.push(ms); }),
    /HTTP 401/
  );
  assert.equal(calls, UNCLASSIFIED_ATTEMPTS);
  assert.deepEqual(sleeps, [1000]);
});

test('property: succeeds iff the failures before success fit within the attempt budget', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom(429, 529, 500, 400, 401), { maxLength: 6 }),
    async (failures) => {
      let calls = 0;
      const fn = async () => {
        if (calls < failures.length) throw httpError(failures[calls++]);
        calls++;
        return 'ok';
      };
      // Walk the policy by hand: attempt k (1-based) failing with status s stops if k >= budget(s).
      let expectOk = true;
      for (let k = 1; k <= failures.length; k++) {
        const budget = [429, 529, 500].includes(failures[k - 1]) ? MAX_RETRIES : UNCLASSIFIED_ATTEMPTS;
        if (k >= budget) { expectOk = false; break; }
      }
      const outcome = await withRetry(fn, async () => {}).then(() => true, () => false);
      assert.equal(outcome, expectOk);
    }
  ));
});
