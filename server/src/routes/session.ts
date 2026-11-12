import { Router } from 'express';
import type { SessionResponse } from '@shared/api/contracts';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/connection';
import { AppError } from '../lib/errors';
import { requireActor } from '../middleware/auth';
import { isPublicDemoRequest } from '../middleware/publicDemo';
import { findOrganisation } from '../repositories/sqlite/readModel';

/** Reports whether integrations are configured without ever revealing credential values. */
export function describeEnvironment(config: AppConfig, organisationIsSynthetic: boolean): Omit<SessionResponse['environment'], 'publicReadOnly' | 'judgeDemo'> {
  const paypalConfigured = Boolean(config.paypal.clientId && config.paypal.clientSecret);
  const sandbox = config.providerMode === 'sandbox';
  return {
    providerMode: config.providerMode,
    authMode: 'demo',
    paypal: {
      configured: paypalConfigured,
      detail: !paypalConfigured
        ? 'No PayPal credentials configured. Provider events are simulated and payment actions are disabled.'
        : !sandbox
          ? 'PayPal Sandbox credentials are present, but the server runs in simulation mode, so payment actions are disabled.'
          : config.paypal.target === 'local_stub'
            ? `Local PayPal stub at ${new URL(config.paypal.apiBaseUrl).host}: payment actions are answered by the ReliefRelay server itself for testing. Nothing is sent to PayPal, not even PayPal Sandbox.${config.paypal.payoutsEnabled ? '' : ' Payment actions are switched off on this server (PAYPAL_PAYOUTS_ENABLED).'}`
            : config.paypal.payoutsEnabled
              ? 'PayPal Sandbox mode: approved recovery actions are sent to PayPal Sandbox. Test money only; Sandbox results do not show real-world delivery.'
              : 'PayPal Sandbox mode with payment actions switched off on this server (PAYPAL_PAYOUTS_ENABLED).',
    },
    paypalTarget: config.paypal.target,
    ai: {
      configured: Boolean(config.openai.apiKey),
      detail: config.openai.apiKey
        ? `AI-assisted investigation is available using ${config.openai.model}. Only a minimised evidence snapshot is sent, never names, contact details, notes or file contents.`
        : 'No OpenAI API key configured. AI-assisted investigation is unavailable.',
    },
    database: {
      configured: true,
      detail: organisationIsSynthetic
        ? 'Local SQLite database on the server, holding synthetic demo data only.'
        : 'Local SQLite database on the server.',
    },
    version: config.version,
    demoRoleSwitcher: config.demoRoleSwitcher,
  };
}

export function sessionRouter(db: Db, config: AppConfig, judgeDemo = false): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const actor = requireActor(req);
    const organisation = findOrganisation(db, actor.organisationId);
    if (!organisation) throw new AppError('not_found', 'Organisation data not found.');
    const publicReadOnly = isPublicDemoRequest(req);
    const environment = describeEnvironment(config, organisation.isSynthetic);
    const body: SessionResponse = {
      user: { id: actor.user.id, displayName: actor.user.displayName, role: actor.user.role },
      organisation,
      environment: {
        ...environment,
        demoRoleSwitcher: (environment.demoRoleSwitcher || judgeDemo) && !publicReadOnly,
        publicReadOnly,
        judgeDemo: judgeDemo && !publicReadOnly,
      },
    };
    res.json(body);
  });

  return router;
}
