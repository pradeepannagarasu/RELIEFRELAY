import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SECURITY_HEADERS } from '../../server/src/publicDemo/gateway';

/**
 * Writes Workers Static Assets headers for the built app: the same security headers as the local public gateway,
 * plus HSTS, which only the HTTPS-only cloud deployment may send (it matches the API's helmet default).
 */
const dir = resolve('dist/web');
if (!existsSync(resolve(dir, 'index.html'))) throw new Error('Run npm run build first.');
const headers = { ...SECURITY_HEADERS, 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' };
const lines = ['/*', ...Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`), '/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''];
writeFileSync(resolve(dir, '_headers'), lines.join('\n'));
console.log(`Wrote ${resolve(dir, '_headers')}`);
