import { randomUUID } from 'node:crypto';
import { appendAudit } from '../audit/auditLog';
import type { Db } from '../db/connection';
import { isReservedEmailDomain } from '../imports/privacy';
import { maskReceiver } from '../lib/paymentIdentity';

/**
 * Server-side allowlist of synthetic PayPal Sandbox receivers. Payment actions can only reach an exact, active entry.
 * Entries are email addresses on reserved domains only; PayPal Sandbox Payouts is used with EMAIL receivers.
 */

export interface AllowlistEntry {
  id: string;
  organisation_id: string;
  receiver_type: 'EMAIL';
  receiver_value: string;
  receiver_masked: string;
  label: string;
  added_at: string;
  deactivated_at: string | null;
  deactivated_reason: string | null;
}

const EMAIL = /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export function normaliseAllowlistEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Why an address cannot be allowlisted, or null when it can. */
export function allowlistRejection(value: string): string | null {
  const email = normaliseAllowlistEmail(value);
  if (/[*?%\s]/.test(email)) return 'Wildcards and spaces are not allowed. Add one exact email address.';
  if (!EMAIL.test(email) || email.includes('..')) return 'Not a valid email address.';
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (!isReservedEmailDomain(domain)) {
    return 'Only synthetic addresses on reserved domains are accepted, such as PayPal Sandbox personal accounts (…@personal.example.com).';
  }
  return null;
}

/** The active entry exactly matching a receiver, or null. Phone receivers never match. */
export function findActiveEntry(db: Db, organisationId: string, receiverType: string, receiverValue: string): AllowlistEntry | null {
  if (receiverType !== 'EMAIL') return null;
  return (
    (db
      .prepare('SELECT * FROM sandbox_receiver_allowlist WHERE organisation_id = ? AND receiver_value = ? AND deactivated_at IS NULL')
      .get(organisationId, normaliseAllowlistEmail(receiverValue)) as AllowlistEntry | undefined) ?? null
  );
}

export function listEntries(db: Db, organisationId: string): AllowlistEntry[] {
  return db.prepare('SELECT * FROM sandbox_receiver_allowlist WHERE organisation_id = ? ORDER BY added_at, id').all(organisationId) as AllowlistEntry[];
}

export function addEntry(db: Db, organisationId: string, value: string, label: string, now: Date): AllowlistEntry {
  const rejection = allowlistRejection(value);
  if (rejection) throw new Error(rejection);
  const email = normaliseAllowlistEmail(value);
  return db
    .transaction(() => {
      const existing = db.prepare('SELECT * FROM sandbox_receiver_allowlist WHERE organisation_id = ? AND receiver_value = ?').get(organisationId, email) as
        | AllowlistEntry
        | undefined;
      if (existing) {
        throw new Error(existing.deactivated_at ? 'This address was deactivated and cannot be re-added.' : 'This address is already on the allowlist.');
      }
      const id = `rcv_${randomUUID()}`;
      const masked = maskReceiver('EMAIL', email);
      db.prepare(
        `INSERT INTO sandbox_receiver_allowlist (id, organisation_id, receiver_type, receiver_value, receiver_masked, label, added_via, added_at)
         VALUES (?, ?, 'EMAIL', ?, ?, ?, 'cli', ?)`,
      ).run(id, organisationId, email, masked, label.trim(), now.toISOString());
      appendAudit(db, {
        organisationId,
        actor: { type: 'system' },
        action: 'paypal.receiver_allowlisted',
        entityType: 'sandbox_receiver',
        entityId: id,
        outcome: 'succeeded',
        newState: { receiverMasked: masked, label: label.trim() },
        reason: 'Added through the server command line.',
      });
      return db.prepare('SELECT * FROM sandbox_receiver_allowlist WHERE id = ?').get(id) as AllowlistEntry;
    })
    .immediate();
}

export function deactivateEntry(db: Db, organisationId: string, value: string, reason: string, now: Date): AllowlistEntry {
  const email = normaliseAllowlistEmail(value);
  return db
    .transaction(() => {
      const entry = db.prepare('SELECT * FROM sandbox_receiver_allowlist WHERE organisation_id = ? AND receiver_value = ?').get(organisationId, email) as
        | AllowlistEntry
        | undefined;
      if (!entry) throw new Error('No allowlist entry matches that address exactly.');
      if (entry.deactivated_at) throw new Error('That entry is already deactivated.');
      db.prepare('UPDATE sandbox_receiver_allowlist SET deactivated_at = ?, deactivated_reason = ? WHERE id = ?').run(now.toISOString(), reason.trim(), entry.id);
      appendAudit(db, {
        organisationId,
        actor: { type: 'system' },
        action: 'paypal.receiver_deactivated',
        entityType: 'sandbox_receiver',
        entityId: entry.id,
        outcome: 'succeeded',
        previousState: { active: true },
        newState: { active: false, receiverMasked: entry.receiver_masked },
        reason: `Deactivated through the server command line: ${reason.trim().slice(0, 200)}`,
      });
      return db.prepare('SELECT * FROM sandbox_receiver_allowlist WHERE id = ?').get(entry.id) as AllowlistEntry;
    })
    .immediate();
}
