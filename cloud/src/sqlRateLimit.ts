import type { RateLimiter } from '../../server/src/publicDemo/rateLimit';
import type { DoSqlStorage } from './doSqlite';

/**
 * The gateway's fixed-window limiter, stored in the Durable Object's SQLite database instead of process memory, so
 * the limits hold across Worker isolates, restarts and redeployments. Same semantics as createRateLimiter().
 */
export const RATE_LIMIT_TABLE = `CREATE TABLE IF NOT EXISTS cloud_rate_limits (
  id       TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
) WITHOUT ROWID`;

export function createSqlRateLimiter(sql: DoSqlStorage, now: () => number = Date.now): RateLimiter & { sweep(): void } {
  const read = (id: string) => sql.exec('SELECT count, reset_at FROM cloud_rate_limits WHERE id = ?', id).toArray()[0] as { count: number; reset_at: number } | undefined;
  return {
    hit(key, rule) {
      const at = now();
      const id = `${rule.name}:${key}`;
      const bucket = read(id);
      let count: number;
      let resetAt: number;
      if (!bucket || bucket.reset_at <= at) {
        count = 1;
        resetAt = at + rule.windowMs;
      } else {
        count = bucket.count + 1;
        resetAt = bucket.reset_at;
      }
      sql.exec('INSERT INTO cloud_rate_limits (id, count, reset_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at', id, count, resetAt).toArray();
      return { allowed: count <= rule.limit, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - at) / 1000)) };
    },
    peek(key, rule) {
      const at = now();
      const bucket = read(`${rule.name}:${key}`);
      if (!bucket || bucket.reset_at <= at) return { allowed: rule.limit > 0, retryAfterSeconds: 1 };
      return { allowed: bucket.count < rule.limit, retryAfterSeconds: Math.max(1, Math.ceil((bucket.reset_at - at) / 1000)) };
    },
    sweep() {
      sql.exec('DELETE FROM cloud_rate_limits WHERE reset_at <= ?', now()).toArray();
    },
  };
}
