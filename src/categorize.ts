import { JevChoiceAnswer, JevChoiceQuestion, JevRequest, JevResult } from './client';
import { forEachConcurrent } from './pool';

/**
 * Categorize a list of items into a fixed label set with Jev, one call per
 * item. Answers below a confidence threshold are *not* labeled: they come back
 * with `label: null`, Jev's best guess as `suggestion`, and `needsReview`, so
 * a human decides instead of the model guessing. Per-item API failures are
 * isolated the same way — visible in the output, never a silent gap.
 */

/** What to ask and which labels are allowed. Loaded from a categories JSON file. */
export interface CategorySpec {
  /** The question posed about every item, e.g. "Which channel did this lead come from?" */
  question: string;
  /** label → description. Jev reads descriptions literally, so put the rules on the label they qualify. */
  categories: Record<string, string>;
  /** Optional per-spec default threshold (0–1). */
  minConfidence?: number;
}

/** One thing to categorize. `state` is what Jev sees: a string or a JSON object. */
export interface Item {
  id: string | number;
  state: string | Record<string, unknown>;
}

export interface Categorized {
  id: string | number;
  /** The accepted label, or null when the item needs a human. */
  label: string | null;
  /** Jev's top choice, accepted or not (null only when the call failed). */
  suggestion: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  needsReview: boolean;
  error?: string;
}

export interface CategorizeOptions {
  /** Answers with confidence below this go to review (inclusive at the threshold: equal is accepted). */
  minConfidence?: number;
  concurrency?: number;
  /** Called after each item completes, in completion order. */
  onProgress?: (done: number, total: number) => void;
}

export interface CategorizeRun {
  results: Categorized[];
  inputTokens: number;
  costUsd: number;
}

/** The one method of `JevClient` this module needs — injectable for tests. */
export interface SystemOne {
  systemOne(req: JevRequest): Promise<JevResult>;
}

export const DEFAULT_MIN_CONFIDENCE = 0.5;
export const DEFAULT_CONCURRENCY = 8;
/** Key of the single question in each request. */
export const QUESTION_KEY = 'category';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Validates a parsed categories file.
 *
 * @throws Error naming the first problem found
 */
export function parseSpec(raw: unknown): CategorySpec {
  if (!isPlainObject(raw)) throw new Error('categories file must be a JSON object');
  if (!nonEmptyString(raw.question)) throw new Error('categories file needs a non-empty "question" string');
  if (!isPlainObject(raw.categories)) throw new Error('categories file needs a "categories" object of label → description');
  const entries = Object.entries(raw.categories);
  if (entries.length < 2) throw new Error('"categories" needs at least two labels');
  for (const [label, desc] of entries) {
    if (!nonEmptyString(label)) throw new Error('category labels must be non-empty');
    if (!nonEmptyString(desc)) throw new Error(`category "${label}" needs a non-empty description`);
  }
  const spec: CategorySpec = { question: raw.question, categories: raw.categories as Record<string, string> };
  if (raw.minConfidence !== undefined) spec.minConfidence = parseThreshold(raw.minConfidence, 'minConfidence');
  return spec;
}

/** A 0–1 threshold, or throws. Accepts numbers and numeric strings (CLI flags). */
export function parseThreshold(v: unknown, name: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return n;
}

/**
 * Validates a parsed items file: an array of { id, state } with unique ids.
 *
 * @throws Error naming the offending index
 */
export function parseItems(raw: unknown): Item[] {
  if (!Array.isArray(raw)) throw new Error('items file must be a JSON array');
  const seen = new Set<string>();
  return raw.map((it, i) => {
    if (!isPlainObject(it)) throw new Error(`item ${i} must be an object`);
    const { id, state } = it;
    if (!(nonEmptyString(id) || Number.isFinite(id))) throw new Error(`item ${i} needs a string or number "id"`);
    if (!(nonEmptyString(state) || isPlainObject(state))) throw new Error(`item ${i} needs a non-empty string or object "state"`);
    const key = String(id);
    if (seen.has(key)) throw new Error(`item ${i} repeats id ${key}`);
    seen.add(key);
    return { id: id as string | number, state: state as Item['state'] };
  });
}

/** The Jev question for a spec. */
export function questionFor(spec: CategorySpec): JevChoiceQuestion {
  return { type: 'choice', instructions: spec.question, criteria: spec.categories };
}

/** Turns one Jev answer into a result, withholding the label below the threshold. */
export function decide(id: Item['id'], answer: JevChoiceAnswer, minConfidence: number): Categorized {
  const accepted = answer.confidence >= minConfidence;
  return {
    id,
    label: accepted ? answer.choice : null,
    suggestion: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    needsReview: !accepted,
  };
}

/** A failed item: no label, flagged for review, with the reason. */
export function failed(id: Item['id'], err: unknown): Categorized {
  return {
    id,
    label: null,
    suggestion: null,
    confidence: 0,
    probabilities: {},
    needsReview: true,
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Categorizes every item. Results come back in input order.
 */
export async function categorize(
  client: SystemOne,
  spec: CategorySpec,
  items: readonly Item[],
  opts: CategorizeOptions = {}
): Promise<CategorizeRun> {
  const minConfidence = opts.minConfidence ?? spec.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const question = questionFor(spec);
  const results: Categorized[] = new Array(items.length);
  let inputTokens = 0;
  let costUsd = 0;
  let done = 0;
  await forEachConcurrent(items, opts.concurrency ?? DEFAULT_CONCURRENCY, async (item, i) => {
    try {
      const res = await client.systemOne({ state: item.state, questions: { [QUESTION_KEY]: question } });
      inputTokens += res.usage.inputTokens;
      costUsd += res.usage.costUsd;
      results[i] = decide(item.id, res.answers[QUESTION_KEY], minConfidence);
    } catch (err) {
      results[i] = failed(item.id, err);
    }
    opts.onProgress?.(++done, items.length);
  });
  return { results, inputTokens, costUsd };
}

export interface Summary {
  total: number;
  labeled: number;
  needsReview: number;
  failed: number;
  /** Accepted labels only, every spec label present (0 when unused). */
  byLabel: Record<string, number>;
}

/** Counts for a run, for the CLI's stderr report. */
export function summarize(spec: CategorySpec, results: readonly Categorized[]): Summary {
  const byLabel: Record<string, number> = Object.fromEntries(Object.keys(spec.categories).map((k) => [k, 0]));
  let labeled = 0;
  let failedCount = 0;
  for (const r of results) {
    if (r.label !== null) {
      labeled++;
      byLabel[r.label]++;
    }
    if (r.error !== undefined) failedCount++;
  }
  return { total: results.length, labeled, needsReview: results.length - labeled, failed: failedCount, byLabel };
}
