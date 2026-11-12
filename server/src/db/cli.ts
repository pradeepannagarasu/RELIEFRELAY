import { existsSync, rmSync } from 'node:fs';
import { verifyAuditChain } from '../audit/auditLog';
import { loadConfig, loadDotEnv } from '../config/env';
import { createSyntheticDataset } from '../seed/syntheticDataset';
import { openDatabase } from './connection';
import { runMigrations } from './migrate';
import { isDatabaseEmpty, seedDatabase } from './seed';

const USAGE = `Usage: tsx server/src/db/cli.ts <command>

  migrate        Apply pending migrations.
  seed           Add the synthetic demo data set to an empty database.
  reset          Delete the database file and recreate it with synthetic demo data (refused in production).
  verify-audit [seq:hash]
                 Recompute the audit hash chain and report the head. Pass a previously recorded head as an anchor.`;

function main(command: string | undefined): number {
  loadDotEnv();
  const config = loadConfig();
  const path = config.databasePath;

  switch (command) {
    case 'migrate': {
      const db = openDatabase(path);
      try {
        const applied = runMigrations(db);
        console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(', ')}` : 'Database is up to date.');
      } finally {
        db.close();
      }
      return 0;
    }
    case 'seed': {
      const db = openDatabase(path);
      try {
        runMigrations(db);
        if (!isDatabaseEmpty(db)) {
          console.error('The database already contains data. Seeding is only allowed on an empty database; use db:reset in development.');
          return 1;
        }
        seedDatabase(db, createSyntheticDataset(new Date()));
        console.log(`Seeded synthetic demo data into ${path}`);
      } finally {
        db.close();
      }
      return 0;
    }
    case 'reset': {
      if (config.nodeEnv === 'production') {
        console.error('db:reset is refused when NODE_ENV=production.');
        return 1;
      }
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        if (existsSync(path + suffix)) rmSync(path + suffix);
      }
      const db = openDatabase(path);
      try {
        runMigrations(db);
        seedDatabase(db, createSyntheticDataset(new Date()));
      } finally {
        db.close();
      }
      console.log(`Recreated ${path} with synthetic demo data.`);
      return 0;
    }
    case 'verify-audit': {
      const db = openDatabase(path);
      try {
        const anchorArg = process.argv[3];
        const anchorMatch = anchorArg ? /^(\d+):([0-9a-f]{64})$/.exec(anchorArg) : null;
        if (anchorArg && !anchorMatch) {
          console.error('The anchor must look like <seq>:<64 hex characters>, as printed by a previous run.');
          return 1;
        }
        const result = verifyAuditChain(db, anchorMatch ? { seq: Number(anchorMatch[1]), hash: anchorMatch[2]! } : undefined);
        console.log(`Events checked: ${result.eventCount}`);
        console.log(`Head: ${result.head ? `${result.head.seq}:${result.head.hash}` : '(empty log)'}`);
        if (result.ok) {
          console.log(
            anchorMatch
              ? 'Audit chain is consistent and still contains the recorded anchor.'
              : 'Audit chain is consistent. Keep the head value outside this database and pass it as an anchor next time to detect truncation or a rewritten chain.',
          );
          return 0;
        }
        console.error(`Audit chain verification FAILED with ${result.problems.length} problem(s):`);
        for (const problem of result.problems.slice(0, 20)) console.error(`  ${JSON.stringify(problem)}`);
        return 2;
      } finally {
        db.close();
      }
    }
    default:
      console.error(USAGE);
      return 1;
  }
}

process.exitCode = main(process.argv[2]);
