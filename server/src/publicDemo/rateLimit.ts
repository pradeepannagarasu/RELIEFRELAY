/** Fixed-window request counters held in memory by the public gateway. */
export interface RateRule {
  name: string;
  limit: number;
  windowMs: number;
}

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(key: string, rule: RateRule): RateDecision;
  /** Whether one more hit would be allowed, without counting one. */
  peek(key: string, rule: RateRule): RateDecision;
}

const MAX_BUCKETS = 50_000;

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const sweep = (at: number) => {
    for (const [key, bucket] of buckets) if (bucket.resetAt <= at) buckets.delete(key);
  };
  return {
    hit(key, rule) {
      const at = now();
      if (buckets.size > MAX_BUCKETS) sweep(at);
      const id = `${rule.name}:${key}`;
      let bucket = buckets.get(id);
      if (!bucket || bucket.resetAt <= at) {
        bucket = { count: 0, resetAt: at + rule.windowMs };
        buckets.set(id, bucket);
      }
      bucket.count += 1;
      return { allowed: bucket.count <= rule.limit, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - at) / 1000)) };
    },
    peek(key, rule) {
      const at = now();
      const bucket = buckets.get(`${rule.name}:${key}`);
      if (!bucket || bucket.resetAt <= at) return { allowed: rule.limit > 0, retryAfterSeconds: 1 };
      return { allowed: bucket.count < rule.limit, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - at) / 1000)) };
    },
  };
}
