import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  categorize, decide, failed, parseItems, parseSpec, parseThreshold, questionFor, summarize,
  CategorySpec, SystemOne, QUESTION_KEY, DEFAULT_MIN_CONFIDENCE,
} from '../src/categorize';
import { JevRequest, JevResult } from '../src/client';

const spec: CategorySpec = { question: 'Which?', categories: { a: 'first', b: 'second', c: 'third' } };
const labels = Object.keys(spec.categories);

/** A fake client answering from a function of the item's state. */
function fakeClient(answer: (state: JevRequest['state']) => { choice: string; confidence: number } | Error, delay = () => 0): SystemOne & { calls: JevRequest[] } {
  const calls: JevRequest[] = [];
  return {
    calls,
    async systemOne(req: JevRequest): Promise<JevResult> {
      calls.push(req);
      await new Promise((r) => setTimeout(r, delay()));
      const a = answer(req.state);
      if (a instanceof Error) throw a;
      return {
        model: 'jev-test',
        answers: { [QUESTION_KEY]: { type: 'choice', choice: a.choice, probabilities: { [a.choice]: a.confidence }, confidence: a.confidence } },
        usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.001 },
      };
    },
  };
}

test('parseSpec accepts a valid spec and its optional threshold', () => {
  assert.deepEqual(parseSpec({ question: 'Q?', categories: { x: 'X', y: 'Y' } }), { question: 'Q?', categories: { x: 'X', y: 'Y' } });
  assert.equal(parseSpec({ question: 'Q?', categories: { x: 'X', y: 'Y' }, minConfidence: 0.7 }).minConfidence, 0.7);
});

test('parseSpec rejects malformed specs with a specific message', () => {
  const cases: [unknown, RegExp][] = [
    [null, /JSON object/], [[], /JSON object/], [{ categories: { x: 'X', y: 'Y' } }, /question/],
    [{ question: '  ', categories: { x: 'X', y: 'Y' } }, /question/], [{ question: 'Q', categories: [] }, /"categories" object/],
    [{ question: 'Q', categories: { x: 'X' } }, /at least two/], [{ question: 'Q', categories: { x: 'X', y: '' } }, /"y" needs/],
    [{ question: 'Q', categories: { x: 'X', '': 'Y' } }, /non-empty/], [{ question: 'Q', categories: { x: 'X', y: 'Y' }, minConfidence: 2 }, /between 0 and 1/],
  ];
  for (const [raw, re] of cases) assert.throws(() => parseSpec(raw), re, JSON.stringify(raw));
});

test('parseThreshold accepts numbers and numeric strings in [0, 1] only', () => {
  assert.equal(parseThreshold('0.6', 'x'), 0.6);
  assert.equal(parseThreshold(0, 'x'), 0);
  assert.equal(parseThreshold(1, 'x'), 1);
  for (const bad of ['', 'abc', -0.1, 1.01, NaN, null, undefined, '1e3']) assert.throws(() => parseThreshold(bad, 'x'), /between 0 and 1/, String(bad));
});

test('parseItems validates shape and uniqueness', () => {
  assert.deepEqual(parseItems([{ id: 1, state: 'x' }, { id: 'b', state: { k: 1 } }]), [{ id: 1, state: 'x' }, { id: 'b', state: { k: 1 } }]);
  const cases: [unknown, RegExp][] = [
    [{}, /JSON array/], [[1], /item 0 must be an object/], [[{ state: 'x' }], /item 0 needs .*"id"/],
    [[{ id: '', state: 'x' }], /"id"/], [[{ id: NaN, state: 'x' }], /"id"/], [[{ id: 1 }], /"state"/],
    [[{ id: 1, state: '' }], /"state"/], [[{ id: 1, state: [1] }], /"state"/],
    [[{ id: 1, state: 'x' }, { id: '1', state: 'y' }], /item 1 repeats id 1/],
  ];
  for (const [raw, re] of cases) assert.throws(() => parseItems(raw), re, JSON.stringify(raw));
});

test('questionFor builds a choice question from the spec', () => {
  assert.deepEqual(questionFor(spec), { type: 'choice', instructions: 'Which?', criteria: spec.categories });
});

test('property: decide withholds the label exactly when confidence is below the threshold', () => {
  fc.assert(fc.property(fc.constantFrom(...labels), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }),
    (choice, confidence, min) => {
      const r = decide(7, { type: 'choice', choice, probabilities: {}, confidence }, min);
      assert.equal(r.suggestion, choice);
      assert.equal(r.needsReview, confidence < min);
      assert.equal(r.label, confidence < min ? null : choice);
    }));
});

test('failed records the error and flags review', () => {
  assert.deepEqual(failed('x', new Error('boom')), { id: 'x', label: null, suggestion: null, confidence: 0, probabilities: {}, needsReview: true, error: 'boom' });
  assert.equal(failed(1, 'str').error, 'str');
});

test('categorize sends one choice question per item with the item state', async () => {
  const client = fakeClient(() => ({ choice: 'a', confidence: 0.9 }));
  const run = await categorize(client, spec, [{ id: 1, state: 'one' }, { id: 2, state: { k: 'two' } }]);
  assert.deepEqual(client.calls.map((c) => c.state), ['one', { k: 'two' }]);
  assert.deepEqual(client.calls[0].questions, { [QUESTION_KEY]: questionFor(spec) });
  assert.equal(run.inputTokens, 20);
  assert.ok(Math.abs(run.costUsd - 0.002) < 1e-12);
});

test('categorize threshold precedence: option, then spec, then default', async () => {
  const client = fakeClient(() => ({ choice: 'a', confidence: 0.6 }));
  const items = [{ id: 1, state: 's' }];
  assert.equal((await categorize(client, spec, items)).results[0].label, 0.6 >= DEFAULT_MIN_CONFIDENCE ? 'a' : null);
  assert.equal((await categorize(client, { ...spec, minConfidence: 0.7 }, items)).results[0].label, null);
  assert.equal((await categorize(client, { ...spec, minConfidence: 0.7 }, items, { minConfidence: 0.55 })).results[0].label, 'a');
});

test('property: results keep input order, failures are isolated, and every item is accounted for', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ choice: fc.constantFrom(...labels), confidence: fc.double({ min: 0, max: 1, noNaN: true }), fail: fc.boolean(), delay: fc.nat(3) }), { maxLength: 20 }),
    fc.integer({ min: 1, max: 6 }),
    async (plan, concurrency) => {
      const items = plan.map((_, i) => ({ id: `i${i}`, state: String(i) }));
      const client = fakeClient((state) => {
        const p = plan[Number(state)];
        return p.fail ? new Error(`fail ${state}`) : { choice: p.choice, confidence: p.confidence };
      }, () => Math.floor(Math.random() * 3));
      const progress: number[] = [];
      const run = await categorize(client, spec, items, { concurrency, minConfidence: 0.5, onProgress: (d) => progress.push(d) });
      assert.deepEqual(run.results.map((r) => r.id), items.map((i) => i.id));
      assert.deepEqual(progress, items.map((_, i) => i + 1));
      run.results.forEach((r, i) => {
        if (plan[i].fail) assert.equal(r.error, `fail ${i}`);
        else assert.equal(r.label, plan[i].confidence >= 0.5 ? plan[i].choice : null);
      });
      const s = summarize(spec, run.results);
      assert.equal(s.total, items.length);
      assert.equal(s.labeled + s.needsReview, s.total);
      assert.equal(Object.values(s.byLabel).reduce((a, b) => a + b, 0), s.labeled);
      assert.equal(s.failed, plan.filter((p) => p.fail).length);
    }
  ), { numRuns: 50 });
});

test('summarize lists every label, including unused ones', () => {
  const s = summarize(spec, [decide(1, { type: 'choice', choice: 'b', probabilities: {}, confidence: 1 }, 0.5)]);
  assert.deepEqual(s, { total: 1, labeled: 1, needsReview: 0, failed: 0, byLabel: { a: 0, b: 1, c: 0 } });
});

test('an answer exactly at the threshold is accepted', () => {
  assert.equal(decide(1, { type: 'choice', choice: 'a', probabilities: {}, confidence: 0.6 }, 0.6).label, 'a');
});

test('parseThreshold rejects whitespace-only strings and names the field', () => {
  assert.throws(() => parseThreshold('   ', 'minConfidence'), /^Error: minConfidence must be/);
  assert.throws(() => parseSpec({ question: 'Q', categories: { x: 'X', y: 'Y' }, minConfidence: 'x' }), /^Error: minConfidence must be/);
});
