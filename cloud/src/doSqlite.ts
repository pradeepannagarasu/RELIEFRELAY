import { createHash } from 'node:crypto';
import type { Db } from '../../server/src/db/connection';
import { SqliteError } from './shims/betterSqlite3';

/**
 * The subset of the better-sqlite3 API that ReliefRelay uses, implemented on a SQLite-backed Durable Object.
 * Durable Object SQL is synchronous like better-sqlite3, so the existing services, transactions and triggers run
 * unchanged. Two differences are handled here:
 * - transactions use ctx.storage.transactionSync (BEGIN and SAVEPOINT statements are not allowed);
 * - custom SQL functions cannot be registered, so the audit chain row that migration 0004's trigger computes with
 *   rr_sha256() is written here instead, in the same transaction and with the same formula, right after each
 *   audit event insert. The cloud schema keeps the other chain checks as triggers (see cloudSchema.ts).
 */

export interface DoSqlStorage {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

type Compiled = { text: string; params: (string | null)[] };

/** Rewrites @name, :name and $name parameters to ? and records their order. Skips string literals and comments. */
export function compileSql(sql: string): Compiled {
  let text = '';
  const params: (string | null)[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = findQuoteEnd(sql, i, ch);
      text += sql.slice(i, end);
      i = end;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      text += sql.slice(i, stop);
      i = stop;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      text += sql.slice(i, stop);
      i = stop;
    } else if (ch === '?') {
      params.push(null);
      text += '?';
      i += 1;
    } else if ((ch === '@' || ch === ':' || ch === '$') && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j += 1;
      params.push(sql.slice(i + 1, j));
      text += '?';
      i = j;
    } else {
      text += ch;
      i += 1;
    }
  }
  return { text, params };
}

function findQuoteEnd(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) i += 2;
      else return i + 1;
    } else i += 1;
  }
  return sql.length;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer);

function toSqlValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return value;
}

function bindings(compiled: Compiled, args: unknown[]): unknown[] {
  const named = args.find(isPlainObject);
  const positional = args.filter((a) => !isPlainObject(a)).flat();
  let next = 0;
  return compiled.params.map((name) => {
    if (name === null) {
      if (next >= positional.length) throw new RangeError('Too few parameter values were provided');
      return toSqlValue(positional[next++]);
    }
    if (!named || !(name in named)) throw new RangeError(`Missing named parameter "${name}"`);
    return toSqlValue(named[name]);
  });
}

function fromRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(row)) if (value instanceof ArrayBuffer) row[key] = Buffer.from(value);
  return row;
}

/** Maps a Durable Object SQL error to the better-sqlite3 error shape the services already understand. */
function asSqliteError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof SqliteError) return error;
  const explicit = /SQLITE_[A-Z_]+/.exec(error.message)?.[0];
  const code =
    explicit ??
    (/constraint failed|RAISE|FOREIGN KEY/i.test(error.message)
      ? 'SQLITE_CONSTRAINT'
      : /no such table|syntax error|no such column/i.test(error.message)
        ? 'SQLITE_ERROR'
        : 'SQLITE_ERROR');
  const wrapped = new SqliteError(error.message.replace(/^Error:\s*/, ''), code);
  return wrapped;
}

const AUDIT_INSERT = /^\s*INSERT\s+INTO\s+audit_events\b/i;

export const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Same content and formula as the audit_events_extend_chain trigger in migration 0004. */
function extendAuditChain(sql: DoSqlStorage, seq: number): void {
  const row = sql
    .exec(
      `SELECT head.hash AS prev_hash,
              coalesce(head.hash, 'GENESIS') || char(10) || json_array(
                e.seq, e.recorded_at, e.organisation_id, e.actor_type, e.actor_user_id, e.actor_role,
                e.action, e.entity_type, e.entity_id, e.outcome, e.request_id,
                e.previous_state, e.new_state, e.reason) AS material
       FROM audit_events AS e, (SELECT max(seq) AS seq FROM audit_chain) AS last
       LEFT JOIN audit_chain AS head ON head.seq = last.seq
       WHERE e.seq = ?`,
      seq,
    )
    .toArray()[0];
  if (!row) throw new SqliteError(`Audit event ${seq} was not found after insert`, 'SQLITE_CONSTRAINT');
  sql.exec('INSERT INTO audit_chain (seq, prev_hash, hash) VALUES (?, ?, ?)', seq, row.prev_hash ?? null, sha256Hex(String(row.material)));
}

export function createDoDatabase(sql: DoSqlStorage, transactionSync: <T>(fn: () => T) => T): Db {
  let depth = 0;
  const run = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      throw asSqliteError(error);
    }
  };

  const prepare = (source: string) => {
    const compiled = compileSql(source);
    const auditInsert = AUDIT_INSERT.test(source);
    const exec = (args: unknown[]) => sql.exec(compiled.text, ...bindings(compiled, args)).toArray();
    return {
      source,
      get: (...args: unknown[]) => run(() => {
        const rows = exec(args);
        return rows[0] ? fromRow(rows[0]) : undefined;
      }),
      all: (...args: unknown[]) => run(() => exec(args).map(fromRow)),
      run: (...args: unknown[]) =>
        run(() => {
          exec(args);
          const meta = sql.exec('SELECT changes() AS changes, last_insert_rowid() AS rowid').toArray()[0]!;
          const changes = Number(meta.changes);
          const lastInsertRowid = Number(meta.rowid);
          if (auditInsert && changes === 1) extendAuditChain(sql, lastInsertRowid);
          return { changes, lastInsertRowid };
        }),
    };
  };

  const transaction = <A extends unknown[], T>(fn: (...args: A) => T) => {
    const call = (...args: A): T => {
      if (depth > 0) return fn(...args);
      depth += 1;
      try {
        return transactionSync(() => fn(...args));
      } finally {
        depth -= 1;
      }
    };
    return Object.assign(call, { immediate: call, deferred: call, exclusive: call, default: call });
  };

  const db = {
    name: 'durable-object',
    open: true,
    memory: false,
    readonly: false,
    get inTransaction() {
      return depth > 0;
    },
    prepare,
    transaction,
    exec(source: string) {
      run(() => sql.exec(source).toArray());
      return db;
    },
    pragma(source: string, options?: { simple?: boolean }) {
      const rows = run(() => sql.exec(`PRAGMA ${source}`).toArray());
      return options?.simple ? (rows[0] ? Object.values(rows[0])[0] : undefined) : rows;
    },
    function() {
      throw new Error('Custom SQL functions are not available on Durable Object SQLite.');
    },
    close() {
      return db;
    },
  };
  return db as unknown as Db;
}
