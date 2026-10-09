import { withRetry, realSleep, Sleep } from './retry';

/**
 * Client for TypeSafe's Jev, a "System One" decision model
 * (https://docs.typesafe.ai). Jev doesn't generate text: it answers typed
 * questions about a piece of state with a probability distribution over the
 * options it was given. email-narrative consumes this package (it used to carry its own copy).
 *
 * Talks to the HTTP API with `fetch` rather than `@typesafe-ai/sdk` — one
 * endpoint, and an injected fetch keeps the test mock surface to one function.
 */

export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

/**
 * Jev bills input only, $42 per billion tokens, and every alias (jev-latest,
 * jev-preview, jev-1.x) shares the price.
 */
export const JEV_USD_PER_MTOK = 0.042;

/**
 * True for model ids that name a Jev model (`jev`, `jev-latest`, `jev-1.13.0`)
 * rather than a text LLM, so callers can route by id. A bare prefix such as
 * `jevx` or `claude-jev` does not match.
 */
export function isJevModel(model: string): boolean {
  return /^jev(-|$)/.test(model);
}

/** A choice question: pick one key of `criteria` (key → description). */
export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** The answer to a choice question. */
export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevRequest {
  /** What the questions are about. Jev takes a string, object, or array. */
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, JevChoiceQuestion>;
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface JevResult {
  answers: Record<string, JevChoiceAnswer>;
  usage: JevUsage;
  model: string;
}

/** The slice of `fetch` this client uses, injectable for tests. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** An HTTP failure shaped so `withRetry` can classify it by status. */
export class JevHttpError extends Error {
  readonly response: { status: number };

  constructor(status: number, body: string) {
    super(`TypeSafe API ${status}: ${body.slice(0, 300)}`);
    this.name = 'JevHttpError';
    this.response = { status };
  }
}

interface WireResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** USD cost of a call: Jev bills input tokens only. */
export function jevCost(inputTokens: number): number {
  return (inputTokens / 1_000_000) * JEV_USD_PER_MTOK;
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Probabilities restricted to the question's labels, non-finite ones dropped. */
function cleanProbabilities(raw: unknown, question: JevChoiceQuestion): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (hasOwn(question.criteria, k) && Number.isFinite(v)) out[k] = v as number;
  }
  return out;
}

/**
 * Narrows one wire answer to a choice answer, or throws. The API promises the
 * choice is one of the supplied keys; this checks anyway, because a label
 * outside the set written into someone's data is worse than a failed item. An
 * own-property check, not `in`, which would accept "toString".
 */
export function parseChoiceAnswer(raw: unknown, question: JevChoiceQuestion): JevChoiceAnswer {
  const a = raw as Partial<JevChoiceAnswer> | undefined;
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string' || !hasOwn(question.criteria, a.choice)) {
    throw new Error(`Jev returned an invalid choice answer: ${JSON.stringify(raw)?.slice(0, 300)}`);
  }
  // A NaN confidence would compare false against every threshold, so treat it
  // as no confidence at all — which routes the item to review.
  const confidence = Number.isFinite(a.confidence) ? Math.min(1, Math.max(0, a.confidence as number)) : 0;
  return { type: 'choice', choice: a.choice, probabilities: cleanProbabilities(a.probabilities, question), confidence };
}

export interface JevClientOptions {
  model?: string;
  fetch?: FetchLike;
  endpoint?: string;
  sleep?: Sleep;
}

/** Client for one Jev model; retries throttling and server faults. */
export class JevClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly sleep: Sleep;

  constructor(apiKey: string, opts: JevClientOptions = {}) {
    if (!apiKey) throw new Error('A TypeSafe API key is required (set TYPESAFE_API_KEY)');
    this.apiKey = apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.fetchImpl = opts.fetch ?? (fetch as unknown as FetchLike);
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.sleep = opts.sleep ?? realSleep;
  }

  /**
   * Asks every question in `req` about its state in one call.
   *
   * @throws JevHttpError on a non-2xx after retries, or Error on a malformed answer
   */
  async systemOne(req: JevRequest): Promise<JevResult> {
    const body = JSON.stringify({ state: req.state, model: this.model, questions: req.questions });
    const wire = await withRetry(async () => {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body,
      });
      const text = await res.text();
      if (!res.ok) throw new JevHttpError(res.status, text);
      return JSON.parse(text) as WireResponse;
    }, this.sleep);

    const answers: Record<string, JevChoiceAnswer> = {};
    for (const [key, question] of Object.entries(req.questions)) {
      answers[key] = parseChoiceAnswer(wire.answers?.[key], question);
    }
    const inputTokens = wire.usage?.input_tokens ?? 0;
    const outputTokens = wire.usage?.output_tokens ?? 0;
    return {
      answers,
      model: wire.model ?? this.model,
      usage: { inputTokens, outputTokens, costUsd: jevCost(inputTokens) },
    };
  }
}
