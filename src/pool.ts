/**
 * Runs `fn` over `items` with at most `limit` calls in flight (ported from
 * email-narrative). Callers catch inside `fn` for per-item failure isolation.
 *
 * @param limit maximum concurrent calls (below 1, or not finite, means 1 — a
 *   NaN would otherwise start zero workers and silently do nothing)
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  };
  const width = Math.min(Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1, items.length);
  await Promise.all(Array.from({ length: width }, worker));
}
