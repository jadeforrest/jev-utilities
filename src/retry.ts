/**
 * Retry policy for TypeSafe API calls, ported from email-narrative's
 * src/util/retry.ts: exponential backoff (1s, 2s, 4s, 8s) for throttling and
 * server faults, and exactly one short retry for anything else — a one-off
 * blip shouldn't cost a whole batch, and retrying a genuinely bad request
 * wastes only one call.
 */

/** Attempts for an error classed as transient, including the first. */
export const MAX_RETRIES = 5;

/** Attempts granted to an error matching no retryable status — one retry. */
export const UNCLASSIFIED_ATTEMPTS = 2;

/** Throttling and transient server faults (529 is TypeSafe's "overloaded"). */
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504, 529]);

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the error carries an HTTP status worth full backoff. */
export function isTransient(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const status = (err as { response?: { status?: unknown } }).response?.status;
  return typeof status === 'number' && RETRYABLE_CODES.has(status);
}

/**
 * Runs `fn`, retrying per the policy above.
 *
 * @param sleep injectable so tests don't wait real seconds
 * @throws the last error seen once attempts are exhausted
 */
export async function withRetry<T>(fn: () => Promise<T>, sleep: Sleep = realSleep): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = isTransient(err);
      if (attempt >= (transient ? MAX_RETRIES : UNCLASSIFIED_ATTEMPTS)) {
        throw err;
      }
      await sleep(transient ? 1000 * 2 ** (attempt - 1) : 1000);
    }
  }
}
