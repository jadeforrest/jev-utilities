import { FetchLike } from '../src/client';

/** A fetch stub that answers each call from a script of (status, body); the last step repeats. */
export function scriptedFetch(script: { status: number; body: unknown }[]) {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body)),
    };
  };
  return { fetch, calls };
}

export const noSleep = async (): Promise<void> => {};
