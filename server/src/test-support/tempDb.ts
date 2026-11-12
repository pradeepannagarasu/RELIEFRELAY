import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db, type OpenDatabaseOptions } from '../db/connection';
import { runMigrations } from '../db/migrate';

export interface TempDatabase {
  db: Db;
  path: string;
  dir: string;
  /** Opens a second, independent connection to the same file. */
  connect(options?: OpenDatabaseOptions): Db;
  cleanup(): void;
}

/** A fresh, fully migrated SQLite database in the system temp folder. Every test gets its own file. */
export function createTempDatabase(options: OpenDatabaseOptions & { migrate?: boolean } = {}): TempDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'reliefrelay-test-'));
  const path = join(dir, 'test.db');
  const db = openDatabase(path, options);
  if (options.migrate !== false) runMigrations(db);
  const extra: Db[] = [];
  return {
    db,
    path,
    dir,
    connect(connectOptions) {
      const connection = openDatabase(path, connectOptions);
      extra.push(connection);
      return connection;
    },
    cleanup() {
      for (const connection of [...extra, db]) if (connection.open) connection.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Minimal organisation and users for schema-level tests. */
export function insertBaseRecords(db: Db): void {
  db.prepare("INSERT INTO organisations (id, name, is_synthetic) VALUES ('org_t', 'Test org', 1)").run();
  const user = db.prepare("INSERT INTO users (id, organisation_id, display_name, email, role) VALUES (?, 'org_t', ?, ?, ?)");
  user.run('usr_op', 'Operator', 'op@example.org', 'operator');
  user.run('usr_ap', 'Approver', 'ap@example.org', 'approver');
}
