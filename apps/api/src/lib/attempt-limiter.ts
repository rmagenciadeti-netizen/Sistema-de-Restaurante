// In-memory failed-attempt limiter (per process). Good enough to slow password guessing; not shared across API instances.
export function createAttemptLimiter(maxFailures = 5, windowMs = 15 * 60 * 1000) {
  const failures = new Map<string, number[]>();
  const recent = (key: string, now: number) => (failures.get(key) ?? []).filter(at => now - at < windowMs);
  return {
    // Seconds until another attempt is allowed, or 0 when the key is not blocked.
    blockedFor(key: string, now = Date.now()): number {
      const list = recent(key, now);
      if (list.length === 0) failures.delete(key); else failures.set(key, list);
      return list.length >= maxFailures ? Math.ceil((list[0] + windowMs - now) / 1000) : 0;
    },
    fail(key: string, now = Date.now()) { failures.set(key, [...recent(key, now), now]); },
    reset(key: string) { failures.delete(key); },
  };
}
