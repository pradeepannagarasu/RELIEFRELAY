import { createApp, createInvestigations } from './app';
import { ConfigError, loadConfig, loadDotEnv } from './config/env';
import { prepareDatabase } from './db/bootstrap';
import { createLogger } from './lib/logger';
import { createWebhookApp, WEBHOOK_PATH } from './paypal/webhookServer';
import { createPayoutModule } from './payouts/module';
import { DEMO_SESSION_USER_ID } from './seed/syntheticDataset';

function main(): void {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config);
  let db;
  try {
    db = prepareDatabase(config, logger);
  } catch (error) {
    logger.fatal({ err: error }, 'Could not prepare the database');
    process.exit(1);
  }
  const interrupted = createInvestigations({ config, logger, db, demoUserId: DEMO_SESSION_USER_ID }).recoverInterrupted();
  if (interrupted > 0) logger.warn({ interrupted }, 'Marked unfinished investigation attempts as interrupted');
  const payouts = createPayoutModule({ db, config, clock: () => new Date(), logger });
  const app = createApp({ config, logger, db, demoUserId: DEMO_SESSION_USER_ID, payouts });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, providerMode: config.providerMode }, 'ReliefRelay API listening');
  });

  let webhookServer: ReturnType<ReturnType<typeof createWebhookApp>['listen']> | null = null;
  if (config.providerMode === 'sandbox' && payouts.client) {
    payouts.start();
    if (config.paypal.webhookId) {
      const webhookApp = createWebhookApp({
        db,
        verify: payouts.verifyWebhook,
        logger,
        clock: () => new Date(),
        captureDir: config.paypal.webhookCaptureDir,
        onEventStored: () => void payouts.webhookProcessor.processPending(),
      });
      webhookServer = webhookApp.listen(config.paypal.webhookPort, () => {
        logger.info({ port: config.paypal.webhookPort, path: WEBHOOK_PATH }, 'PayPal Sandbox webhook listener ready');
      });
    } else {
      logger.warn('PAYPAL_WEBHOOK_ID is not set: the webhook listener is off and status changes are found by polling only');
    }
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    payouts.stop();
    webhookServer?.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
