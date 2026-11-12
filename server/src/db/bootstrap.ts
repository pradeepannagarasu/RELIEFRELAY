import type { Logger } from 'pino';
import type { AppConfig } from '../config/env';
import { createSyntheticDataset } from '../seed/syntheticDataset';
import { openDatabase, type Db } from './connection';
import { runMigrations } from './migrate';
import { isDatabaseEmpty, seedDatabase } from './seed';

/**
 * Opens the database and applies pending migrations. An empty database is seeded with synthetic
 * demo data in development only; production is never seeded automatically.
 */
export function prepareDatabase(config: AppConfig, logger: Logger, now: Date = new Date()): Db {
  const db = openDatabase(config.databasePath);
  try {
    const applied = runMigrations(db);
    if (applied.length > 0) logger.info({ migrations: applied.map((m) => m.name) }, 'Applied database migrations');

    if (isDatabaseEmpty(db)) {
      if (config.nodeEnv === 'development') {
        seedDatabase(db, createSyntheticDataset(now));
        logger.info('Seeded the empty development database with synthetic demo data');
      } else {
        logger.warn({ nodeEnv: config.nodeEnv }, 'The database is empty. It is only seeded automatically in development; run npm run db:seed to add synthetic demo data.');
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
