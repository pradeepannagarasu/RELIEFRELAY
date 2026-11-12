/**
 * Stands in for the native better-sqlite3 module inside the Worker bundle. The Worker never opens a database file:
 * its database is the Durable Object's SQLite storage (see doSqlite.ts). Only the error class is used at runtime.
 */
export class SqliteError extends Error {
  override name = 'SqliteError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export default class Database {
  static SqliteError = SqliteError;
  constructor() {
    throw new Error('better-sqlite3 is not available in the Cloudflare Worker; use the Durable Object database.');
  }
}
