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

test('unreadable files are named in the error', async () => {
  const f = fakeDeps();
  assert.equal(await runCli(['--categories', 'nope.json', '--input', 'items.json'], f.deps), 1);
  assert.match(f.err.join(''), /could not read categories file nope\.json: ENOENT/);
  const g = fakeDeps();
  assert.equal(await runCli(['--categories', 'cats.json', '--input', 'nope.json'], g.deps), 1);
  assert.match(g.err.join(''), /could not read input file nope\.json/);
});

test('--concurrency limits calls in flight; default runs them in parallel', async () => {
  const peakFor = async (extra: string[]) => {
    const f = fakeDeps({ env: { TYPESAFE_API_KEY: 'k' } });
    let inFlight = 0;
    let peak = 0;
    f.deps.makeClient = () => ({
      async systemOne() {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { model: 'm', answers: { [QUESTION_KEY]: { type: 'choice', choice: 'a', probabilities: {}, confidence: 1 } }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      },
    });
    assert.equal(await runCli([...base, ...extra], f.deps), 0);
    return peak;
  };
  assert.equal(await peakFor(['--concurrency', '1']), 1);
  assert.equal(await peakFor([]), 2);
});

test('reports progress every 25 items and at the end', async () => {
  files['many.json'] = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i, state: 'hi' })));
  const f = fakeDeps({ env: { TYPESAFE_API_KEY: 'k' } });
  assert.equal(await runCli(['--categories', 'cats.json', '--input', 'many.json'], f.deps), 0);
  assert.deepEqual(f.err.filter((s) => /^ {2}\d+\/30\n$/.test(s)), ['  25/30\n', '  30/30\n']);
});

test('an empty input exits 0, not "all failed"', async () => {
  files['empty.json'] = '[]';
  const f = fakeDeps({ env: { TYPESAFE_API_KEY: 'k' } });
  assert.equal(await runCli(['--categories', 'cats.json', '--input', 'empty.json'], f.deps), 0);
});

test('estimateTokens is about a quarter of the characters', () => {
  const spec = { question: 'Q', categories: { a: 'A', b: 'B' } };
  const n = estimateTokens(spec, [{ id: 1, state: 'x'.repeat(4000) }]);
  assert.ok(n >= 1000 && n < 1100, String(n));
});

test('the executable entry point runs with real I/O and sets the exit code', () => {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const path = require('node:path') as typeof import('node:path');
  const tsx = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
  const cli = path.join(__dirname, '..', 'src', 'cli.ts');
  const ex = path.join(__dirname, '..', 'examples');
  const help = spawnSync(tsx, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: jev-categorize/);
  const dry = spawnSync(tsx, [cli, '--categories', `${ex}/categories.json`, '--input', `${ex}/items.json`, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0);
  assert.equal(JSON.parse(dry.stdout).state, 'I was charged twice this month');
  assert.match(dry.stderr, /dry run: 2 item/);
  assert.equal(spawnSync(tsx, [cli], { encoding: 'utf8' }).status, 1);
});
