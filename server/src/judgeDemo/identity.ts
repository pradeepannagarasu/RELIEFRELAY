import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Role } from '@shared/domain/types';

/**
 * Server-signed demonstration identity for the public Judge Demo. The cookie carries a user id and an HMAC made with
 * a secret that never leaves the server process, so a visitor cannot forge or edit it to pick another account.
 */
export interface IdentitySigner {
  sign(userId: string): string;
  /** The signed user id, or null for a missing, malformed or forged value. */
  verify(value: string | null | undefined): string | null;
}

const USER_ID = /^usr_[a-z0-9_]{1,40}$/;

export function createIdentitySigner(secret: Buffer = randomBytes(32)): IdentitySigner {
  if (secret.length < 32) throw new Error('The identity signing secret must be at least 32 bytes.');
  const mac = (userId: string) => createHmac('sha256', secret).update(`rr-judge-identity:${userId}`).digest();
  return {
    sign(userId) {
      if (!USER_ID.test(userId)) throw new Error('Invalid user id.');
      return `${userId}.${mac(userId).toString('base64url')}`;
    },
    verify(value) {
      if (!value) return null;
      const dot = value.lastIndexOf('.');
      if (dot <= 0) return null;
      const userId = value.slice(0, dot);
      if (!USER_ID.test(userId)) return null;
      const given = Buffer.from(value.slice(dot + 1), 'base64url');
      const expected = mac(userId);
      return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null;
    },
  };
}

/** Roles a public judge may act as. The administrator role is never available in the Judge Demo. */
export const JUDGE_ROLES: readonly Role[] = Object.freeze(['operator', 'approver', 'viewer'] as const);

export interface SignedIdentityOptions {
  signer: IdentitySigner;
  roles: readonly Role[];
}

export function assertNoAdminRole(roles: readonly Role[]): void {
  if (roles.includes('admin')) throw new Error('The administrator role must never be available to public judges.');
}
