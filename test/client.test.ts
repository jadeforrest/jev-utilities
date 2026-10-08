import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { JevClient, JevHttpError, JevChoiceQuestion, parseChoiceAnswer, jevCost, DEFAULT_ENDPOINT } from '../src/client';
import { scriptedFetch, noSleep } from './helpers';

const question: JevChoiceQuestion = { type: 'choice', instructions: 'Which?', criteria: { work: 'w', personal: 'p' } };

const goodBody = {
  model: 'jev-1.13.0',
  answers: { label: { type: 'choice', choice: 'work', probabilities: { work: 0.9, personal: 0.1 }, confidence: 0.8 } },
  usage: { input_tokens: 2_000_000, output_tokens: 3 },
};

test('posts the state, model and questions with a bearer token', async () => {
  const { fetch, calls } = scriptedFetch([{ status: 200, body: goodBody }]);
  const client = new JevClient('secret', { fetch, endpoint: 'https://example.test/v1/systemone', sleep: noSleep });
  const result = await client.systemOne({ state: { a: 1 }, questions: { label: question } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/v1/systemone');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, { Authorization: 'Bearer secret', 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { state: { a: 1 }, model: 'jev-latest', questions: { label: question } });
  assert.deepEqual(result.answers.label, goodBody.answers.label);
  assert.equal(result.model, 'jev-1.13.0');
  assert.equal(result.usage.inputTokens, 2_000_000);
  assert.equal(result.usage.outputTokens, 3);
  assert.ok(Math.abs(result.usage.costUsd - 0.084) < 1e-12);
});

test('defaults: TypeSafe endpoint, jev-latest, zero usage when omitted', async () => {
  const { fetch, calls } = scriptedFetch([{ status: 200, body: { answers: goodBody.answers } }]);
  const result = await new JevClient('k', { fetch }).systemOne({ state: 's', questions: { label: question } });
  assert.equal(calls[0].url, DEFAULT_ENDPOINT);
  assert.equal(result.model, 'jev-latest');
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
});

test('honors a model override', async () => {
  const { fetch, calls } = scriptedFetch([{ status: 200, body: goodBody }]);
  await new JevClient('k', { fetch, model: 'jev-preview' }).systemOne({ state: 's', questions: { label: question } });
  assert.equal(JSON.parse(calls[0].init.body).model, 'jev-preview');
});

test('refuses to construct without a key', () => {
  assert.throws(() => new JevClient(''), /TYPESAFE_API_KEY/);
});

test('retries 429 and 529, then succeeds', async () => {
  const { fetch, calls } = scriptedFetch([
    { status: 429, body: 'slow down' }, { status: 529, body: 'overloaded' }, { status: 200, body: goodBody },
  ]);
  const result = await new JevClient('k', { fetch, sleep: noSleep }).systemOne({ state: 's', questions: { label: question } });
  assert.equal(calls.length, 3);
  assert.equal(result.answers.label.choice, 'work');
});

test('gives up on a 401 after one retry, with the status attached', async () => {
  const { fetch, calls } = scriptedFetch([{ status: 401, body: 'bad key' }]);
  const err = await new JevClient('k', { fetch, sleep: noSleep })
    .systemOne({ state: 's', questions: { label: question } })
    .catch((e: unknown) => e);
  assert.ok(err instanceof JevHttpError);
  assert.equal(err.response.status, 401);
  assert.match(err.message, /TypeSafe API 401: bad key/);
  assert.equal(calls.length, 2);
});

test('throws on an answer outside the label set', async () => {
  const bad = { ...goodBody, answers: { label: { ...goodBody.answers.label, choice: 'junk' } } };
  const { fetch } = scriptedFetch([{ status: 200, body: bad }]);
  await assert.rejects(new JevClient('k', { fetch, sleep: noSleep }).systemOne({ state: 's', questions: { label: question } }), /invalid choice/);
});

test('parseChoiceAnswer rejects malformed answers and inherited keys', () => {
  for (const raw of [undefined, null, {}, { type: 'score', choice: 'work' }, { type: 'choice' }, { type: 'choice', choice: 3 },
    { type: 'choice', choice: 'toString' }, { type: 'choice', choice: '__proto__' }]) {
    assert.throws(() => parseChoiceAnswer(raw, question), /invalid choice/, JSON.stringify(raw));
  }
});

test('property: confidence is always clamped into [0, 1]; non-finite becomes 0', () => {
  fc.assert(fc.property(fc.oneof(fc.double(), fc.constant(undefined), fc.string()), (confidence) => {
    const a = parseChoiceAnswer({ type: 'choice', choice: 'work', confidence }, question);
    assert.ok(a.confidence >= 0 && a.confidence <= 1);
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) assert.equal(a.confidence, 0);
    else assert.equal(a.confidence, Math.min(1, Math.max(0, confidence)));
  }));
});

test('property: probabilities keep only finite values for known labels', () => {
  fc.assert(fc.property(
    fc.dictionary(fc.oneof(fc.constantFrom('work', 'personal', 'toString'), fc.string()), fc.oneof(fc.double(), fc.string())),
    (probabilities) => {
      const a = parseChoiceAnswer({ type: 'choice', choice: 'personal', confidence: 0.5, probabilities }, question);
      for (const [k, v] of Object.entries(a.probabilities)) {
        assert.ok(k === 'work' || k === 'personal', k);
        assert.ok(Number.isFinite(v));
        assert.equal(v, probabilities[k]);
      }
    }
  ));
  assert.deepEqual(parseChoiceAnswer({ type: 'choice', choice: 'work', probabilities: null }, question).probabilities, {});
});

test('jevCost bills input at $0.042 per million tokens', () => {
  assert.equal(jevCost(0), 0);
  assert.ok(Math.abs(jevCost(1_000_000) - 0.042) < 1e-12);
});
