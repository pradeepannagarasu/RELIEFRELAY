import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino, { type Logger } from 'pino';
import type { AiProvider } from '../ai/provider';
import { createApp } from '../app';
import { loadConfig } from '../config/env';
import { seedDatabase } from '../db/seed';
import { findUser } from '../repositories/sqlite/readModel';
import { createSyntheticDataset, DEMO_SESSION_USER_ID } from '../seed/syntheticDataset';
import type { RequestContext } from '../services/context';
import { createTempDatabase, type TempDatabase } from './tempDb';

export const TEST_NOW = new Date('2026-11-10T12:00:00.000Z');

/** A migrated temporary database holding the synthetic demo data set. */
export function createSeededDatabase(options: Parameters<typeof createTempDatabase>[0] = {}): TempDatabase {
  const temp = createTempDatabase(options);
  seedDatabase(temp.db, createSyntheticDataset(TEST_NOW));
  return temp;
}

export function contextFor(temp: TempDatabase, userId = DEMO_SESSION_USER_ID): RequestContext {
  const user = findUser(temp.db, userId);
  if (!user) throw new Error(`No user ${userId}`);
  return { actor: { user, organisationId: user.organisationId }, requestId: 'test-request' };
}

export interface RunningApp {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startApp(
  temp: TempDatabase,
  demoUserId = DEMO_SESSION_USER_ID,
  env: NodeJS.ProcessEnv = {},
  options: { aiProvider?: AiProvider | null; logger?: Logger } = {},
): Promise<RunningApp> {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: temp.path, ...env });
  const app = createApp({
    config,
    logger: options.logger ?? pino({ level: 'silent' }),
    db: temp.db,
    demoUserId,
    clock: () => TEST_NOW,
    ...('aiProvider' in options ? { aiProvider: options.aiProvider } : {}),
  });
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
