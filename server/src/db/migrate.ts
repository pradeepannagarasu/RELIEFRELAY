import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, type Db } from './connection';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const match = FILE_PATTERN.exec(file);
      if (!match) throw new MigrationError(`Migration file name ${file} must look like 0001_description.sql`);
      // Normalise line endings so a Git checkout on Windows produces the same checksum.
      const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
      return { version: Number(match[1]), name: match[2]!, sql, checksum: sha256Hex(sql) };
    })
    .sort((a, b) => a.version - b.version);

  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(`Migrations must be numbered consecutively from 0001; found ${String(migration.version).padStart(4, '0')}.`);
    }
  });
  return migrations;
}

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

/**
 * Applies pending migrations, each in its own IMMEDIATE transaction. Refuses to continue if an applied
 * migration file has been edited, or if the database was migrated by newer code.
 */
export function runMigrations(db: Db, migrations: Migration[] = loadMigrations()): Migration[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT`);

  const applied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as AppliedMigration[];
  const known = new Map(migrations.map((m) => [m.version, m]));
  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) {
      throw new MigrationError(
        `The database has migration ${row.version} (${row.name}) which this version of ReliefRelay does not know. Use a newer build.`,
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(
        `Migration ${row.version} (${row.name}) was edited after it was applied. Add a new migration instead of changing an applied one.`,
      );
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = migrations.filter((m) => !appliedVersions.has(m.version));
  const record = db.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)');
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migration.checksum);
    }).immediate();
  }
  return pending;
}
