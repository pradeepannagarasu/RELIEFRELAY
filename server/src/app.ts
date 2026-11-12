import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { createOpenAiProvider } from './ai/openaiProvider';
import type { AiProvider } from './ai/provider';
import { isLoopbackUrl, type AppConfig } from './config/env';
import type { Db } from './db/connection';
import { demoAuthentication } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { judgeGatewayGuard, publicReadOnlyGuard } from './middleware/publicDemo';
import { casesRouter } from './routes/cases';
import { importsRouter } from './routes/imports';
import { investigationsRouter } from './routes/investigations';
import { createPayoutModule, type PayoutModule } from './payouts/module';
import { boundPayPalTarget } from './payouts/target';
import { demoRouter } from './routes/demo';
import { auditRouter, integrationsRouter } from './routes/integrations';
import { overviewRouter } from './routes/overview';
import { payoutsRouter } from './routes/payouts';
import { sessionRouter } from './routes/session';
import { createCaseService } from './services/caseService';
import { createImportService } from './services/importService';
import { createInvestigationService, type InvestigationService } from './services/investigationService';
import type { SignedIdentityOptions } from './judgeDemo/identity';
import { judgeDemoRouter } from './judgeDemo/routes';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  db: Db;
  demoUserId: string;
  clock?: () => Date;
  /** Overrides the provider built from configuration; null disables AI investigation. */
  aiProvider?: AiProvider | null;
  /** PayPal Sandbox payment actions. Built from configuration when omitted. */
  payouts?: PayoutModule;
  /** Public Judge Demo: server-signed demo identities limited to these roles, and the scenario endpoint. */
  judgeDemo?: SignedIdentityOptions;
}

/**
 * The OpenAI provider for this configuration, or null when no key is set. Automated tests can never reach the
 * real API: under NODE_ENV=test a provider is only built for a local stub server.
 */
export function providerFromConfig(config: AppConfig): AiProvider | null {
  const { openai } = config;
  if (!openai.apiKey) return null;
  if (config.nodeEnv === 'test' && !isLoopbackUrl(openai.baseUrl)) return null;
  return createOpenAiProvider({
    apiKey: openai.apiKey,
    model: openai.model,
    baseUrl: openai.baseUrl,
    timeoutMs: openai.timeoutMs,
    maxOutputTokens: openai.maxOutputTokens,
    reasoningEffort: openai.reasoningEffort,
  });
}

export function createInvestigations(deps: AppDependencies): InvestigationService {
  return createInvestigationService({
    db: deps.db,
    clock: deps.clock ?? (() => new Date()),
    provider: deps.aiProvider === undefined ? providerFromConfig(deps.config) : deps.aiProvider,
    dailyLimit: deps.config.openai.dailyLimit,
    timeoutMs: deps.config.openai.timeoutMs,
    logger: deps.logger,
  });
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export function createApp(deps: AppDependencies): Express {
  const { config, logger, db, demoUserId, clock = () => new Date() } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  const imports = createImportService(db, clock);
  const cases = createCaseService(db, clock);
  const investigations = createInvestigations({ ...deps, clock });
  const payouts = deps.payouts ?? createPayoutModule({ db, config, clock, logger });

  const api = express.Router();
  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: config.version, providerMode: config.providerMode });
  });
  api.use(judgeGatewayGuard(!!deps.judgeDemo));
  api.use(publicReadOnlyGuard());
  api.use(demoAuthentication(db, demoUserId, { roleSwitcher: config.demoRoleSwitcher, signedIdentity: deps.judgeDemo }));
  if (config.demoRoleSwitcher || deps.judgeDemo) api.use('/demo', demoRouter(db, demoUserId, deps.judgeDemo));
  if (deps.judgeDemo) api.use('/judge-demo', judgeDemoRouter(db, clock));
  api.use('/session', sessionRouter(db, config, !!deps.judgeDemo));
  api.use('/overview', overviewRouter(db, clock));
  api.use('/imports', importsRouter(imports, db, clock));
  api.use('/cases/:id/investigations', investigationsRouter(investigations, () => boundPayPalTarget(db)));
  api.use('/', payoutsRouter(payouts.service, () => boundPayPalTarget(db)));
  api.use('/cases', casesRouter(cases));
  api.use('/integrations', integrationsRouter(db, config, payouts.client, clock));
  api.use('/audit', auditRouter(db));
  api.use(notFoundHandler);

  app.use('/api', api);
  app.use(errorHandler);
  return app;
}
