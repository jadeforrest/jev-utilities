import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, CliDeps, estimateTokens } from '../src/cli';
import { QUESTION_KEY, SystemOne } from '../src/categorize';

const files: Record<string, string> = {
  'cats.json': JSON.stringify({ question: 'Which?', categories: { a: 'first', b: 'second' } }),
  'items.json': JSON.stringify([{ id: 1, state: 'hi' }, { id: 2, state: 'low' }]),
  'bad.json': '{not json',
};

/** In-memory deps; `answer` decides each call's outcome by state. */
function fakeDeps(opts: { env?: Record<string, string>; answer?: (state: unknown) => number | Error } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const clients: { key: string; model: string }[] = [];
  const envFiles: string[] = [];
  const env: Record<string, string | undefined> = { ...opts.env };
  const answer = opts.answer ?? ((s) => (s === 'hi' ? 0.9 : 0.2));
  const deps: CliDeps = {
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFile: (p, d) => { written[p] = d; },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env,
    loadEnvFile: (p) => { envFiles.push(p); env.TYPESAFE_API_KEY = 'from-file'; },
    makeClient: (key, model): SystemOne => {
      clients.push({ key, model });
      return {
        async systemOne(req) {
          const c = answer(req.state);
          if (c instanceof Error) throw c;
          return { model, answers: { [QUESTION_KEY]: { type: 'choice', choice: 'a', probabilities: { a: c }, confidence: c } }, usage: { inputTokens: 5, outputTokens: 0, costUsd: 0 } };
        },
      };
    },
  };
  return { deps, out, err, written, clients, envFiles };
}

const base = ['--categories', 'cats.json', '--input', 'items.json'];

test('--help prints usage and exits 0', async () => {
  const f = fakeDeps();
  assert.equal(await runCli(['--help'], f.deps), 0);
  assert.match(f.out.join(''), /Usage: jev-categorize/);
});

test('missing required flags print usage and exit 1', async () => {
  const f = fakeDeps();
  assert.equal(await runCli(['--input', 'items.json'], f.deps), 1);
  assert.match(f.err.join(''), /Usage/);
});

test('unknown flags and unreadable files fail cleanly', async () => {
  for (const args of [['--bogus'], ['--categories', 'nope.json', '--input', 'items.json'], ['--categories', 'bad.json', '--input', 'items.json']]) {
    const f = fakeDeps();
    assert.equal(await runCli(args, f.deps), 1, args.join(' '));
    assert.match(f.err.join(''), /^jev-categorize: /);
  }
});

test('--dry-run prints the first request and sends nothing (no key needed)', async () => {
  const f = fakeDeps();
  assert.equal(await runCli([...base, '--dry-run', '--model', 'jev-preview'], f.deps), 0);
  assert.equal(f.clients.length, 0);
  const sample = JSON.parse(f.out.join(''));
  assert.equal(sample.state, 'hi');
  assert.equal(sample.model, 'jev-preview');
  assert.ok(sample.questions[QUESTION_KEY]);
  assert.match(f.err.join(''), /dry run: 2 item\(s\), ~\d+ input tokens, ~\$[\d.]+; nothing sent/);
});

test('--dry-run with no items prints null', async () => {
  files['empty.json'] = '[]';
  const f = fakeDeps();
  assert.equal(await runCli(['--categories', 'cats.json', '--input', 'empty.json', '--dry-run'], f.deps), 0);
  assert.equal(f.out.join('').trim(), 'null');
});

test('fails without an API key', async () => {
  const f = fakeDeps();
  assert.equal(await runCli(base, f.deps), 1);
  assert.match(f.err.join(''), /TYPESAFE_API_KEY is not set/);
});

test('categorizes to stdout, flags low confidence, and reports a summary', async () => {
  const f = fakeDeps({ env: { TYPESAFE_API_KEY: 'k' } });
  assert.equal(await runCli(base, f.deps), 0);
  assert.deepEqual(f.clients, [{ key: 'k', model: 'jev-latest' }]);
  const results = JSON.parse(f.out.join(''));
  assert.deepEqual(results.map((r: { label: string | null }) => r.label), ['a', null]);
  assert.equal(results[1].needsReview, true);
  assert.match(f.err.join(''), /1\/2 labeled, 1 need review \(0 failed\); 10 tokens/);
  assert.match(f.err.join(''), /a=1 b=0/);
});

test('--env-file, --output, --min-confidence and --concurrency', async () => {
  const f = fakeDeps();
  assert.equal(await runCli([...base, '--env-file', '.env', '--output', 'out.json', '--min-confidence', '0.1', '--concurrency', '1'], f.deps), 0);
  assert.deepEqual(f.envFiles, ['.env']);
  assert.equal(f.clients[0].key, 'from-file');
  assert.equal(f.out.length, 0);
  assert.deepEqual(JSON.parse(f.written['out.json']).map((r: { label: string }) => r.label), ['a', 'a']);
});

test('rejects an out-of-range --min-confidence', async () => {
  const f = fakeDeps({ env: { TYPESAFE_API_KEY: 'k' } });
  assert.equal(await runCli([...base, '--min-confidence', '5'], f.deps), 1);
  assert.match(f.err.join(''), /--min-confidence must be a number between 0 and 1/);
});

test('exits 2 when every item failed, 0 when only some did', async () => {
  const all = fakeDeps({ env: { TYPESAFE_API_KEY: 'k' }, answer: () => new Error('401') });
  assert.equal(await runCli(base, all.deps), 2);
  const some = fakeDeps({ env: { TYPESAFE_API_KEY: 'k' }, answer: (s) => (s === 'hi' ? new Error('x') : 0.9) });
  assert.equal(await runCli(base, some.deps), 0);
  assert.match(some.err.join(''), /1 failed/);
});

test('estimateTokens grows with item size', () => {
  const spec = { question: 'Q', categories: { a: 'A', b: 'B' } };
  const small = estimateTokens(spec, [{ id: 1, state: 'x' }]);
  const big = estimateTokens(spec, [{ id: 1, state: 'x'.repeat(400) }]);
  assert.ok(big >= small + 100);
  assert.equal(estimateTokens(spec, []), 0);
});
