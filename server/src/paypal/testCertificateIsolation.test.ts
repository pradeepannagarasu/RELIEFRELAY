import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TEST_WEBHOOK_CERT_PEM, TEST_WEBHOOK_KEY_PEM } from '../test-support/paypalTestCert';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEST_SUPPORT = join(ROOT, 'server', 'src', 'test-support');
const CERT_MODULE = join(TEST_SUPPORT, 'paypalTestCert.ts');
const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@shared/') ? join(ROOT, 'shared', 'src', spec.slice('@shared/'.length)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every source file reachable through static and dynamic imports from an entry point. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const target = resolveImport(file, match[1] ?? match[2] ?? match[3]!);
      if (target) queue.push(target);
    }
  }
  return seen;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const pemBody = (pem: string) => pem.split('\n').filter((line) => line && !line.startsWith('-----')).slice(1, 3).join('');

describe('local webhook test certificate isolation', () => {
  it('is unreachable from the server, the command-line tools and the browser app', () => {
    const entries = ['server/src/index.ts', 'server/src/paypal/cli.ts', 'server/src/paypal/localStubDemo.ts', 'server/src/db/cli.ts', 'server/src/ai/smoke.ts', 'web/src/main.tsx'].map((p) => join(ROOT, p));
    for (const entry of entries) {
      const files = reachable(entry);
      expect(files.size, entry).toBeGreaterThan(5);
      expect(files.has(CERT_MODULE), relative(ROOT, entry)).toBe(false);
    }
    const runtime = reachable(join(ROOT, 'server/src/index.ts'));
    expect([...runtime].filter((f) => f.startsWith(TEST_SUPPORT)).map((f) => relative(ROOT, f))).toEqual([]);
    expect(runtime.has(join(ROOT, 'server/src/paypal/webhookVerifier.ts'))).toBe(true);
  });

  it('is imported only by test files, and its key material appears nowhere else in the source', () => {
    const importers = [...sourceFiles(join(ROOT, 'server')), ...sourceFiles(join(ROOT, 'web', 'src')), ...sourceFiles(join(ROOT, 'shared'))].filter(
      (f) => f !== CERT_MODULE && /paypalTestCert/.test(readFileSync(f, 'utf8')),
    );
    expect(importers.length).toBeGreaterThan(0);
    for (const f of importers) expect(relative(ROOT, f)).toMatch(/\.test\.tsx?$/);

    const keyFragment = pemBody(TEST_WEBHOOK_KEY_PEM);
    const certFragment = pemBody(TEST_WEBHOOK_CERT_PEM);
    expect(keyFragment.length).toBeGreaterThan(100);
    const holders = [...sourceFiles(join(ROOT, 'server')), ...sourceFiles(join(ROOT, 'web', 'src')), ...sourceFiles(join(ROOT, 'shared'))]
      .filter((f) => f !== CERT_MODULE)
      .filter((f) => {
        const text = readFileSync(f, 'utf8');
        return text.includes(keyFragment) || text.includes(certFragment);
      });
    expect(holders).toEqual([]);
  });

  it('is never trusted by the production listener: index.ts passes no certificate fetcher, so only PayPal Sandbox hosts are used', () => {
    const index = readFileSync(join(ROOT, 'server/src/index.ts'), 'utf8');
    expect(index).not.toMatch(/fetchCert/);
    const verifier = readFileSync(join(ROOT, 'server/src/paypal/webhookVerifier.ts'), 'utf8');
    expect(verifier).toMatch(/fetchCert = fetchCertificate/);
    expect(verifier).toMatch(/CERT_HOSTS = new Set\(\['api\.sandbox\.paypal\.com', 'api-m\.sandbox\.paypal\.com'\]\)/);
  });
});
