/**
 * Map an array through an async function with a cap on in-flight tasks.
 *
 * The Anthropic API encourages the model to issue parallel tool_use blocks
 * in a single turn, but unbounded fan-out hammers our PHP/Postgres stack:
 * write-heavy bursts can saturate the FrankenPHP worker pool, exhaust the
 * Postgres connection pool, or race optimistic-version checks against each
 * other. Capping at a small number keeps tail-latency variance bounded.
 *
 * Output preserves input order regardless of completion order.
 *
 * Errors propagate the same way Promise.all does — the first rejection
 * rejects the overall promise. Other in-flight tasks are NOT cancelled
 * (Promises aren't cancellable), but no further work is started after
 * the rejection surfaces.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error('limit must be >= 1');
  if (items.length === 0) return [];

  const out = new Array<R>(items.length);
  let nextIndex = 0;
  let rejected: unknown = undefined;

  const worker = async (): Promise<void> => {
    while (rejected === undefined) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        rejected = err;
        throw err;
      }
    }
  };

  const poolSize = Math.min(limit, items.length);
  const workers = Array.from({ length: poolSize }, worker);
  await Promise.all(workers);
  return out;
}
