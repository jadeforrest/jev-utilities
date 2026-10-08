#!/usr/bin/env node
import * as fs from 'fs';
import { parseArgs } from 'util';
import { JevClient, DEFAULT_MODEL, jevCost } from './client';
import {
  categorize, parseItems, parseSpec, parseThreshold, questionFor, summarize, QUESTION_KEY,
  DEFAULT_CONCURRENCY, DEFAULT_MIN_CONFIDENCE, SystemOne, Categorized, CategorySpec, Item,
} from './categorize';

const USAGE = `Usage: jev-categorize --categories <cats.json> --input <items.json> [options]

Categorize each item into one of the labels in cats.json with TypeSafe's Jev.
Items below the confidence threshold get label null and needsReview: true.

Options:
  --categories <file>       { "question": "...", "categories": { "label": "description", ... } }
  --input <file>            [ { "id": ..., "state": "text" | { ... } }, ... ]
  --output <file>           write results JSON here (default: stdout)
  --min-confidence <0-1>    review threshold (default: spec's minConfidence, else ${DEFAULT_MIN_CONFIDENCE})
  --concurrency <n>         calls in flight (default ${DEFAULT_CONCURRENCY})
  --model <id>              Jev model (default ${DEFAULT_MODEL})
  --env-file <file>         load TYPESAFE_API_KEY from a dotenv file
  --dry-run                 print the first request and a cost estimate; send nothing
  -h, --help
`;

/** Everything the CLI touches outside itself, injectable for tests. */
export interface CliDeps {
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
  stdout(s: string): void;
  stderr(s: string): void;
  env: Record<string, string | undefined>;
  loadEnvFile(path: string): void;
  makeClient(apiKey: string, model: string): SystemOne;
}

export const realDeps: CliDeps = {
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  writeFile: (p, d) => fs.writeFileSync(p, d),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  loadEnvFile: (p) => process.loadEnvFile(p),
  makeClient: (key, model) => new JevClient(key, { model }),
};

function readJson(deps: CliDeps, path: string, what: string): unknown {
  try {
    return JSON.parse(deps.readFile(path));
  } catch (err) {
    throw new Error(`could not read ${what} file ${path}: ${(err as Error).message}`);
  }
}

/** ≈4 characters per token: enough for an order-of-magnitude cost estimate. */
export function estimateTokens(spec: CategorySpec, items: readonly Item[]): number {
  const questionChars = JSON.stringify(questionFor(spec)).length;
  return items.reduce((n, it) => n + Math.ceil((JSON.stringify(it.state).length + questionChars) / 4), 0);
}

function dryRun(deps: CliDeps, spec: CategorySpec, items: Item[], model: string): void {
  const sample = items.length ? { state: items[0].state, model, questions: { [QUESTION_KEY]: questionFor(spec) } } : null;
  const tokens = estimateTokens(spec, items);
  deps.stdout(`${JSON.stringify(sample, null, 2)}\n`);
  deps.stderr(`dry run: ${items.length} item(s), ~${tokens} input tokens, ~$${jevCost(tokens).toFixed(4)}; nothing sent\n`);
}

function report(deps: CliDeps, spec: CategorySpec, results: Categorized[], tokens: number, cost: number): void {
  const s = summarize(spec, results);
  const counts = Object.entries(s.byLabel).map(([k, v]) => `${k}=${v}`).join(' ');
  deps.stderr(`${s.labeled}/${s.total} labeled, ${s.needsReview} need review (${s.failed} failed); ${tokens} tokens, $${cost.toFixed(4)}\n${counts}\n`);
}

const OPTIONS = {
  categories: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' },
  'min-confidence': { type: 'string' }, concurrency: { type: 'string' }, model: { type: 'string' },
  'env-file': { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} as const;

type Flags = ReturnType<typeof parseArgs<{ args: string[]; options: typeof OPTIONS }>>['values'];

/** The API key from the environment, after loading --env-file if given. */
function apiKeyFrom(deps: CliDeps, envFile: string | undefined): string {
  if (envFile) deps.loadEnvFile(envFile);
  const key = deps.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY is not set (export it or pass --env-file)');
  return key;
}

/** Calls Jev for every item, writes the results, and returns the exit code. */
async function run(deps: CliDeps, flags: Flags, spec: CategorySpec, items: Item[], model: string): Promise<number> {
  const minConfidence = flags['min-confidence'] !== undefined ? parseThreshold(flags['min-confidence'], '--min-confidence') : undefined;
  const concurrency = flags.concurrency !== undefined ? Number(flags.concurrency) : undefined;
  const client = deps.makeClient(apiKeyFrom(deps, flags['env-file']), model);
  const result = await categorize(client, spec, items, {
    minConfidence, concurrency,
    onProgress: (done, total) => { if (done % 25 === 0 || done === total) deps.stderr(`  ${done}/${total}\n`); },
  });
  const json = `${JSON.stringify(result.results, null, 2)}\n`;
  if (flags.output) deps.writeFile(flags.output, json); else deps.stdout(json);
  report(deps, spec, result.results, result.inputTokens, result.costUsd);
  const allFailed = result.results.length > 0 && result.results.every((r) => r.error !== undefined);
  return allFailed ? 2 : 0;
}

/**
 * Runs the CLI. Returns the exit code: 0 on success (even with items flagged
 * for review — that's an expected outcome, not a failure), 1 on bad usage or
 * input, 2 when every item failed (likely a bad key or an outage).
 */
export async function runCli(argv: string[], deps: CliDeps = realDeps): Promise<number> {
  try {
    const { values: flags } = parseArgs({ args: argv, options: OPTIONS });
    if (flags.help) { deps.stdout(USAGE); return 0; }
    if (!flags.categories || !flags.input) { deps.stderr(USAGE); return 1; }
    const spec = parseSpec(readJson(deps, flags.categories, 'categories'));
    const items = parseItems(readJson(deps, flags.input, 'input'));
    const model = flags.model ?? DEFAULT_MODEL;
    if (flags['dry-run']) { dryRun(deps, spec, items, model); return 0; }
    return await run(deps, flags, spec, items, model);
  } catch (err) {
    deps.stderr(`jev-categorize: ${(err as Error).message}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
