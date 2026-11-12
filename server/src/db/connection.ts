import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export const DEFAULT_DATABASE_PATH = resolve('server/data/reliefrelay.db');

export interface OpenDatabaseOptions {
  /** Milliseconds to wait for another connection's write lock before failing with SQLITE_BUSY. */
  busyTimeoutMs?: number;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class DatabaseConfigurationError extends Error {
  override name = 'DatabaseConfigurationError';
}

/**
 * Opens the ReliefRelay database with the settings every connection must use, and verifies they took effect.
 * Only the Express server and the db:* scripts open this file.
 */
export function openDatabase(path: string, { busyTimeoutMs = 5000 }: OpenDatabaseOptions = {}): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
    db.pragma('synchronous = FULL');
    // Used by the audit-chain triggers. Deterministic: the same text always produces the same hash.
    db.function('rr_sha256', { deterministic: true }, (value: unknown) => sha256Hex(String(value)));

    const checks: [string, unknown, unknown][] = [
      ['journal_mode', db.pragma('journal_mode', { simple: true }), 'wal'],
      ['foreign_keys', db.pragma('foreign_keys', { simple: true }), 1],
      ['busy_timeout', db.pragma('busy_timeout', { simple: true }), Math.trunc(busyTimeoutMs)],
      ['synchronous', db.pragma('synchronous', { simple: true }), 2],
    ];
    for (const [name, actual, expected] of checks) {
      if (actual !== expected) {
        throw new DatabaseConfigurationError(`SQLite ${name} is ${String(actual)}, expected ${String(expected)}.`);
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function isBusyError(error: unknown): boolean {
  return error instanceof Database.SqliteError && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_BUSY_SNAPSHOT');
}

export function isConstraintError(error: unknown): error is Database.SqliteError {
  return error instanceof Database.SqliteError && error.code.startsWith('SQLITE_CONSTRAINT');
}