import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { verifyAuditChain } from '../../server/src/audit/auditLog';
import { openDatabase } from '../../server/src/db/connection';
import { runMigrations } from '../../server/src/db/migrate';

/**
 * One-time, repeatable import of the public Judge Demo database into the cloud Judge Demo (Durable Object SQLite).
 *
 *   npx tsx --tsconfig server/tsconfig.json cloud/scripts/migrate-judge-demo.ts --target <url> [--dry-run]
 *   (the import token is read from the RR_IMPORT_TOKEN environment variable and never printed)
 *
 * 1. Backs up server/data/judge-demo.db with SQLite's online backup (safe while the local Judge Demo runs).
 * 2. Builds the schema from the existing migrations (a fresh migration run is the source of truth) and refuses to
 *    continue unless the backup's schema is identical.
 * 3. Adapts only what Durable Object SQLite cannot run: the two audit-chain triggers that call rr_sha256(). The chain
 *    row is written by the cloud database adapter instead, and the consecutive-sequence and previous-hash checks stay
 *    as a trigger. Every other trigger, constraint and index is applied unchanged.
 * 4. Sends tables (in foreign-key order), then rows, then triggers; the cloud side reconciles row counts, runs a
 *    foreign-key check and verifies the whole audit chain against this database's chain head before opening.
 * Never opens the private database (server/data/reliefrelay.db).
 */

const JUDGE_DB = resolve('server/data/judge-demo.db');
const PRIVATE_DB = resolve('server/data/reliefrelay.db');
const BACKUP_DIR = resolve('server/data/backups');
const CHUNK_ROWS = 100;

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };

const CLOUD_CHAIN_VERIFY = `CREATE TRIGGER audit_chain_verify_insert BEFORE INSERT ON audit_chain
BEGIN
  SELECT RAISE(ABORT, 'audit chain must be extended by exactly one consecutive event')
  WHERE NEW.seq IS NOT (SELECT coalesce(max(seq), 0) + 1 FROM audit_chain);
  SELECT RAISE(ABORT, 'audit chain previous hash does not match the chain head')
  WHERE NEW.prev_hash IS NOT (SELECT hash FROM audit_chain WHERE seq = NEW.seq - 1);
END`;

function master(db: Database.Database): MasterRow[] {
  return db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid`).all() as MasterRow[];
}

/** Durable Object SQLite has no rr_sha256(); see the header comment. Fails if the triggers are not as expected. */
export function cloudTriggers(rows: MasterRow[]): string[] {
  const triggers = rows.filter((r) => r.type === 'trigger');
  const out: string[] = [];
  for (const trigger of triggers) {
    if (trigger.name === 'audit_events_extend_chain') {
      if (!trigger.sql?.includes('rr_sha256(')) throw new Error('audit_events_extend_chain is not the expected trigger.');
      continue;
    }
    if (trigger.name === 'audit_chain_verify_insert') {
      if (!trigger.sql?.includes('rr_sha256(')) throw new Error('audit_chain_verify_insert is not the expected trigger.');
      out.push(CLOUD_CHAIN_VERIFY);
      continue;
    }
    if (trigger.sql?.includes('rr_sha256(')) throw new Error(`Unexpected rr_sha256() use in trigger ${trigger.name}.`);
    out.push(trigger.sql!);
  }
  return out;
}

function tableOrder(db: Database.Database, tables: string[]): string[] {
  const deps = new Map(tables.map((t) => [t, new Set((db.prepare(`SELECT "table" FROM pragma_foreign_key_list(?)`).all(t) as { table: string }[]).map((r) => r.table).filter((d) => d !== t))]));
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (t: string) => {
    if (ordered.includes(t)) return;
    if (visiting.has(t)) throw new Error(`Foreign-key cycle involving ${t}`);
    visiting.add(t);
    for (const d of deps.get(t) ?? []) visit(d);
    visiting.delete(t);
    ordered.push(t);
  };
  tables.forEach(visit);
  return ordered;
}

async function post(target: string, token: string, step: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(`/__cloud/import/${step}`, target), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${step}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`${step}: HTTP ${response.status} ${JSON.stringify(parsed).slice(0, 400)}`);
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const target = args[args.indexOf('--target') + 1];
  const token = process.env.RR_IMPORT_TOKEN ?? '';
  if (!dryRun && (!target || args.indexOf('--target') === -1)) throw new Error('Usage: migrate-judge-demo.ts --target <url> [--dry-run]');
  if (!dryRun && token.length < 32) throw new Error('Set RR_IMPORT_TOKEN to the import token (at least 32 characters).');
  if (JUDGE_DB.toLowerCase() === PRIVATE_DB.toLowerCase()) throw new Error('Refusing: the Judge Demo database path is the private database.');

  // 1. Backup.
  mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = join(BACKUP_DIR, `judge-demo-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  const live = new Database(JUDGE_DB, { readonly: true, fileMustExist: true });
  await live.backup(backupPath);
  live.close();
  const source = new Database(backupPath, { readonly: true, fileMustExist: true });
  console.log(`Backup: ${backupPath}`);

  // 2. Schema from the migrations, compared with the backup.
  const freshPath = join(tmpdir(), `rr-cloud-schema-${process.pid}.db`);
  const fresh = openDatabase(freshPath);
  runMigrations(fresh);
  const expected = master(fresh);
  fresh.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(freshPath + suffix, { force: true });
  const actual = master(source);
  const key = (r: MasterRow) => `${r.type}|${r.name}|${r.sql ?? ''}`;
  const expectedKeys = new Set(expected.map(key));
  const actualKeys = new Set(actual.map(key));
  const differences = [...expectedKeys].filter((k) => !actualKeys.has(k)).concat([...actualKeys].filter((k) => !expectedKeys.has(k)));
  if (differences.length > 0) throw new Error(`The Judge Demo database schema differs from the migrations: ${differences.map((d) => d.split('|').slice(0, 2).join(' ')).join(', ')}`);
  console.log(`Schema: identical to a fresh run of the ${(source.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n} migrations.`);

  const tables = tableOrder(source, expected.filter((r) => r.type === 'table').map((r) => r.name));
  const tableSql = new Map(expected.filter((r) => r.type === 'table').map((r) => [r.name, r.sql!]));
  const schema = [...tables.map((t) => tableSql.get(t)!), ...expected.filter((r) => r.type === 'index' && r.sql).map((r) => r.sql!)];
  const triggers = cloudTriggers(expected);

  // 3. Local facts the cloud must reproduce.
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t] = (source.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n;
  const audit = verifyAuditChain(source as never);
  if (!audit.ok) throw new Error(`The local audit chain does not verify: ${JSON.stringify(audit.problems.slice(0, 3))}`);
  const fk = source.prepare('PRAGMA foreign_key_check').all().length;
  console.log(`Local: ${tables.length} tables, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows, audit chain ok (${audit.eventCount} events, head ${audit.head?.seq}:${audit.head?.hash.slice(0, 12)}…), foreign-key problems ${fk}.`);
  console.log(`Cloud schema: ${schema.length} tables and indexes, ${triggers.length} triggers (2 audit-chain triggers adapted).`);
  if (dryRun) {
    source.close();
    console.log('Dry run: nothing was sent.');
    return;
  }

  // 4. Send.
  await post(target!, token, 'begin', { schema });
  for (const t of tables) {
    const columns = (source.prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as { name: string }[]).map((c) => c.name);
    const withoutRowid = /WITHOUT\s+ROWID/i.test(tableSql.get(t)!);
    const rows = source.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${t}" ORDER BY ${withoutRowid ? '1' : 'rowid'}`).raw().all() as unknown[][];
    for (let i = 0; i < rows.length; i += CHUNK_ROWS) await post(target!, token, 'rows', { table: t, columns, rows: rows.slice(i, i + CHUNK_ROWS) });
    if (rows.length > 0) process.stdout.write(`  ${t}: ${rows.length}\n`);
  }
  const result = await post(target!, token, 'finish', { triggers, counts, auditHead: audit.head });
  source.close();
  console.log(JSON.stringify(result, null, 2));
  if (result.ok !== true) throw new Error('The cloud import did not reconcile; the cloud Judge Demo stays closed.');
  console.log(`Imported ${basename(backupPath)} into ${new URL(target!).host}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
