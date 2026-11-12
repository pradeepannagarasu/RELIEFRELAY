import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/env';
import { startPayPalStub } from '../test-support/paypalStub';
import { assertLocalStubDemoAllowed, LOCAL_STUB_DEMO_DATABASE, localStubDemoEnv } from './localStubDemo';

/** What a .env could hold if someone later adds real PayPal Sandbox settings or tries a live host. */
const ENV_WITH_REAL_SETTINGS = {
  NODE_ENV: 'development',
  PAYMENT_PROVIDER_MODE: 'sandbox',
  PAYPAL_API_BASE_URL: 'https://api-m.sandbox.paypal.com',
  PAYPAL_CLIENT_ID: 'real-sandbox-client-id',
  PAYPAL_CLIENT_SECRET: 'real-sandbox-client-secret',
  PAYPAL_WEBHOOK_ID: 'WH-REAL',
  OPENAI_API_KEY: 'sk-test-real-key',
  DATABASE_PATH: 'server/data/reliefrelay.db',
};

describe('local PayPal stub demonstration', () => {
  it('refuses any PayPal host, live or Sandbox, as the stub address', () => {
    for (const url of ['https://api-m.paypal.com', 'https://api.paypal.com', 'https://api-m.sandbox.paypal.com', 'https://api.sandbox.paypal.com', 'http://example.com:4010']) {
      expect(() => localStubDemoEnv(url), url).toThrow(/loopback/);
    }
  });

  it('replaces every PayPal setting from .env, so only the local stub is called and real credentials are never used', async () => {
    const stub = await startPayPalStub();
    try {
      expect(new URL(stub.baseUrl).hostname).toBe('127.0.0.1');
      const config = loadConfig({ ...ENV_WITH_REAL_SETTINGS, ...localStubDemoEnv(stub.baseUrl) });
      expect(config.paypal.target).toBe('local_stub');
      expect(config.paypal.apiBaseUrl).toBe(stub.baseUrl);
      expect(config.paypal.clientId).not.toBe('real-sandbox-client-id');
      expect(config.paypal.clientSecret).not.toBe('real-sandbox-client-secret');
      expect(config.paypal.webhookId).toBeUndefined();
      expect(config.openai.apiKey).toBeUndefined();
      expect(config.databasePath.replaceAll('\\', '/').endsWith(LOCAL_STUB_DEMO_DATABASE)).toBe(true);
      expect(config.nodeEnv).toBe('development');
    } finally {
      await stub.close();
    }
  });

  it('runs only in development, and the configuration refuses a stub address in production', () => {
    expect(() => assertLocalStubDemoAllowed({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertLocalStubDemoAllowed({})).not.toThrow();
    expect(() => assertLocalStubDemoAllowed({ NODE_ENV: 'production' })).toThrow(/NODE_ENV=development/);
    expect(() => assertLocalStubDemoAllowed({ NODE_ENV: 'test' })).toThrow(/NODE_ENV=development/);
    expect(() => loadConfig({ ...localStubDemoEnv('http://127.0.0.1:4010'), NODE_ENV: 'production', DEMO_ROLE_SWITCHER: 'false' })).toThrow(
      /local stub in development and test/,
    );
  });

  it('never accepts live PayPal, and normal simulation mode keeps payment actions off', () => {
    for (const url of ['https://api-m.paypal.com', 'https://api.paypal.com']) {
      expect(() => loadConfig({ ...ENV_WITH_REAL_SETTINGS, PAYPAL_API_BASE_URL: url }), url).toThrow(/Live PayPal is not supported/);
    }
    const simulation = loadConfig({});
    expect(simulation.providerMode).toBe('simulation');
    expect(simulation.paypal.payoutsEnabled).toBe(false);
  });
});
