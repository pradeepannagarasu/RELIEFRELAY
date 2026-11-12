import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionResponse } from '@shared/api/contracts';
import { PUBLIC_GATEWAY_HEADER } from '../middleware/publicDemo';
import { DEMO_SESSION_USER_ID } from '../seed/syntheticDataset';
import { createSeededDatabase, startApp, type RunningApp } from '../test-support/seededApp';
import type { TempDatabase } from '../test-support/tempDb';
import { createPublicGateway } from './gateway';

let temp: TempDatabase;
let api: RunningApp;
let gateway: Server;
let gatewayUrl: string;
let staticDir: string;

beforeAll(async () => {
  temp = createSeededDatabase();
  api = await startApp(temp);
  staticDir = mkdtempSync(join(tmpdir(), 'rr-gateway-'));
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  gateway = createPublicGateway({ staticDir, apiOrigin: new URL(api.baseUrl).origin });
  gateway.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => gateway.once('listening', resolve));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  await api.close();
  temp.cleanup();
  rmSync(staticDir, { recursive: true, force: true });
});

const PUBLIC = { [PUBLIC_GATEWAY_HEADER]: '1' };
const WRITES: [string, string][] = [
  ['POST', '/proposals/prop_x/approve'],
  ['POST', '/proposals/prop_x/reject'],
  ['POST', '/cases/case_x/proposals'],
  ['POST', '/submissions/sub_x/retry'],
  ['POST', '/cancellations/can_x/recheck'],
  ['POST', '/cases/case_x/notes'],
  ['POST', '/cases/case_x/assign'],
  ['POST', '/imports'],
  ['PUT', '/imports/imp_x/mapping'],
  ['POST', '/integrations/paypal/connection-check'],
  ['POST', '/cases/case_x/investigations'],
  ['POST', '/demo/identity'],
];

describe('API read-only guard for public gateway requests', () => {
  it('rejects every change with 403 before any route runs, even with the app write header', async () => {
    for (const [method, path] of WRITES) {
      const res = await fetch(`${api.baseUrl}${path}`, {
        method,
        headers: { ...PUBLIC, 'Content-Type': 'application/json', 'X-ReliefRelay-Demo': '1' },
        body: '{}',
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    }
  });

  it('refuses the role demonstration endpoints, in any letter case', async () => {
    for (const path of ['/demo/identities', '/DEMO/identities']) {
      expect((await fetch(`${api.baseUrl}${path}`, { headers: PUBLIC })).status, path).toBe(403);
    }
  });

  it('acts as the read-only viewer, ignores a selected identity cookie and reports read-only mode', async () => {
    const res = await fetch(`${api.baseUrl}/session`, { headers: { ...PUBLIC, Cookie: `rr_demo_user=${DEMO_SESSION_USER_ID}` } });
    const body = (await res.json()) as SessionResponse;
    expect(body.user.role).toBe('viewer');
    expect(body.environment.publicReadOnly).toBe(true);
    expect(body.environment.demoRoleSwitcher).toBe(false);
  });

  it('leaves local requests unchanged', async () => {
    const body = (await (await fetch(`${api.baseUrl}/session`)).json()) as SessionResponse;
    expect(body.user.id).toBe(DEMO_SESSION_USER_ID);
    expect(body.user.role).not.toBe('viewer');
    expect(body.environment.publicReadOnly).toBe(false);
  });
});

describe('public demonstration gateway', () => {
  it('serves the built app, with client routes falling back to the app shell', async () => {
    for (const path of ['/', '/cases', '/cases/case_123']) {
      const res = await fetch(`${gatewayUrl}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
    expect((await fetch(`${gatewayUrl}/assets/app.js`)).status).toBe(200);
    expect((await fetch(`${gatewayUrl}/assets/missing.js`)).status).toBe(404);
  });

  it('never serves files outside the built app', async () => {
    writeFileSync(join(staticDir, '..', 'rr-gateway-secret.txt'), 'outside-secret');
    try {
      for (const path of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/.env', '/..\\..\\.env', '/..%2frr-gateway-secret.txt', '/%2e%2e%5crr-gateway-secret.txt']) {
        const res = await fetch(`${gatewayUrl}${path}`);
        const text = await res.text();
        expect(res.status === 404 || res.status === 400 || text.includes('<div id="root">'), path).toBe(true);
        expect(text, path).not.toContain('outside-secret');
      }
    } finally {
      rmSync(join(staticDir, '..', 'rr-gateway-secret.txt'), { force: true });
    }
  });

  it('forwards reads to the API as the viewer, without cookies in either direction', async () => {
    const res = await fetch(`${gatewayUrl}/api/session`, { headers: { Cookie: `rr_demo_user=${DEMO_SESSION_USER_ID}`, [PUBLIC_GATEWAY_HEADER]: '0' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = (await res.json()) as SessionResponse;
    expect(body.user.role).toBe('viewer');
    expect(body.environment.publicReadOnly).toBe(true);
    expect((await fetch(`${gatewayUrl}/api/overview`)).status).toBe(200);
    expect((await fetch(`${gatewayUrl}/api/cases`)).status).toBe(200);
  });

  it('refuses every non-read method itself, so nothing reaches the API', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await fetch(`${gatewayUrl}/api/proposals/prop_x/approve`, { method, headers: { 'X-ReliefRelay-Demo': '1' } });
      expect(res.status, method).toBe(405);
    }
  });

  it('refuses the role demonstration endpoints, including through dot segments and letter case', async () => {
    for (const path of ['/api/demo/identities', '/api/DEMO/identities', '/api/../api/demo/identities', '/api/cases/../demo/identities']) {
      expect((await fetch(`${gatewayUrl}${path}`)).status, path).toBe(403);
    }
  });
});
