/** Parallel CPI requests per user action; keeps tenant-wide reads fast without flooding the tenant. */
export const CPI_CONCURRENCY = 6

/** Runs `fn` for all items with at most `limit` calls in flight. */
export async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  }))
}
