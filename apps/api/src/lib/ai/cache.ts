// Per-process result cache with TTL and in-flight de-duplication. Keys always carry tenant, unit, role and the data version, so a cached answer is never
// served to another company/unit/profile and goes stale automatically when the underlying data changes.
type Entry<T> = { value: T; expires: number };
const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const MAX_ENTRIES = 2000;
export const cacheStats = { hits: 0, misses: 0, deduped: 0 };

export function cacheKey(parts: Array<string | null | undefined>) { return parts.map(part => part ?? '-').join('|'); }

export async function cached<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<{ value: T; source: 'cache' | 'computed' | 'deduplicated' }> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (ttlSeconds > 0 && hit && hit.expires > now) { cacheStats.hits++; return { value: hit.value, source: 'cache' }; }
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) { cacheStats.deduped++; return { value: await running, source: 'deduplicated' }; }
  cacheStats.misses++;
  const promise = compute();
  inflight.set(key, promise);
  try {
    const value = await promise;
    if (ttlSeconds > 0) {
      if (store.size >= MAX_ENTRIES) { const oldest = store.keys().next().value; if (oldest !== undefined) store.delete(oldest); }
      store.set(key, { value, expires: now + ttlSeconds * 1000 });
    }
    return { value, source: 'computed' };
  } finally { inflight.delete(key); }
}
export function clearCache(prefix?: string) { for (const key of [...store.keys()]) if (!prefix || key.startsWith(prefix)) store.delete(key); }
