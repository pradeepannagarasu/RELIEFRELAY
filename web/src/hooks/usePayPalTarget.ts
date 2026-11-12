import { useCallback } from 'react';
import { forPayPalTarget, type PayPalTarget } from '@shared/domain/payouts';
import { useSession } from './useSession';

/**
 * The PayPal target this server talks to, and `t` to word "PayPal Sandbox" text for it, so that pages never present
 * a local-stub response as a PayPal Sandbox result.
 */
export function usePayPalTarget(): { target: PayPalTarget | null; t: (text: string) => string } {
  const { data } = useSession();
  const target = data?.environment.paypalTarget ?? null;
  const t = useCallback((text: string) => forPayPalTarget(text, target), [target]);
  return { target, t };
}
