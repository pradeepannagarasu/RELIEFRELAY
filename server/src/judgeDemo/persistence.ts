import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { toPayPalAmount } from '@shared/domain/payouts';
import type { Db } from '../db/connection';
import type { PayPalStub } from '../test-support/paypalStub';

/**
 * Keeps the Judge Demo usable across restarts. The database is kept unless a reset is requested explicitly, and a
 * reset is refused while judges have been active recently. Nothing here runs on a timer: data is never reset
 * automatically.
 */

export const JUDGE_RECENT_ACTIVITY_MS = 30 * 60_000;

/** The time of the most recent action by a demo identity, or null if judges have done nothing yet. */
export function lastJudgeActivity(db: Db): Date | null {
  const row = db.prepare("SELECT max(recorded_at) AS at FROM audit_events WHERE actor_type = 'user'").get() as { at: string | null };
  return row.at ? new Date(row.at) : null;
}

export type JudgeStartDecision = { action: 'create' } | { action: 'keep' } | { action: 'reset' };

/** Decides what happens to an existing Judge Demo database on start. Throws instead of wiping recent activity. */
export function decideJudgeStart(input: { exists: boolean; reset: boolean; force: boolean; lastActivity: Date | null; now: Date }): JudgeStartDecision {
  if (!input.exists) return { action: 'create' };
  if (!input.reset) return { action: 'keep' };
  const idleMs = input.lastActivity ? input.now.getTime() - input.lastActivity.getTime() : Number.POSITIVE_INFINITY;
  if (idleMs < JUDGE_RECENT_ACTIVITY_MS && !input.force) {
    const minutes = Math.max(1, Math.floor(idleMs / 60_000));
    throw new Error(
      `Refusing to reset: a demo identity acted ${minutes} minute${minutes === 1 ? '' : 's'} ago, so a judge may still be using the demo. ` +
        'Wait until it has been idle for 30 minutes, or add --force to reset anyway.',
    );
  }
  return { action: 'reset' };
}

/** True when something already listens on this loopback port, such as a running Judge Demo API. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

export function removeJudgeDemoFiles(databasePath: string, keyPath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`, keyPath]) {
    if (existsSync(path)) rmSync(path);
  }
}

/** The identity-signing secret, kept beside the Judge Demo database so signed identities survive a restart. */
export function loadOrCreateIdentitySecret(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    const secret = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex');
    if (secret.length >= 32) return secret;
  }
  const secret = randomBytes(32);
  writeFileSync(keyPath, secret.toString('hex'), { mode: 0o600 });
  return secret;
}

/**
 * Gives a restarted local stub back the payouts it accepted before, from this database's record of its responses,
 * so status polling keeps working. Only payouts the stub itself answered (with a provider batch and item ID) are
 * restored. Returns how many were restored.
 */
export function restoreStubPayouts(db: Db, stub: PayPalStub): number {
  const rows = db
    .prepare(
      `SELECT s.provider_batch_id, s.sender_batch_id, si.provider_item_id, si.sender_item_id, si.amount_minor, si.currency,
              p.status, p.provider_transaction_id, i.receiver_type, i.receiver_value
       FROM payout_submissions s
       JOIN payout_submission_items si ON si.submission_id = s.id
       JOIN payment_items i ON i.id = si.recovery_item_id
       LEFT JOIN provider_transactions p ON p.payment_item_id = si.recovery_item_id
       WHERE s.provider_batch_id IS NOT NULL AND si.provider_item_id IS NOT NULL`,
    )
    .all() as {
    provider_batch_id: string;
    sender_batch_id: string;
    provider_item_id: string;
    sender_item_id: string;
    amount_minor: number;
    currency: string;
    status: string | null;
    provider_transaction_id: string | null;
    receiver_type: string;
    receiver_value: string;
  }[];
  for (const row of rows) {
    stub.restore({
      batchId: row.provider_batch_id,
      senderBatchId: row.sender_batch_id,
      itemId: row.provider_item_id,
      transactionId: row.provider_transaction_id,
      status: row.status ?? 'PENDING',
      payoutItem: {
        recipient_type: row.receiver_type,
        amount: { value: toPayPalAmount(row.amount_minor), currency: row.currency },
        receiver: row.receiver_value,
        sender_item_id: row.sender_item_id,
      },
    });
  }
  return rows.length;
}
