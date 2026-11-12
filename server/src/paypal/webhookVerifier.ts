import { verify as verifySignature, X509Certificate } from 'node:crypto';
import { crc32 } from 'node:zlib';

/**
 * Self-verification of PayPal webhook signatures, as documented by PayPal:
 *   message   = <transmission id>|<transmission time>|<webhook id>|<CRC32 of the raw body, decimal>
 *   signature = SHA256withRSA over message, base64, checked with the public key in the certificate at paypal-cert-url.
 * The raw request bytes are verified exactly as received; nothing is re-serialised.
 */

export const CERT_HOSTS = new Set(['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com']);
const CERT_PATH = /^\/v1\/notifications\/certs\/[A-Za-z0-9._-]{1,200}$/;
const MAX_CERT_BYTES = 16 * 1024;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const MAX_AGE_MS = 4 * 24 * 60 * 60_000;
const CERT_CACHE_TTL_MS = 24 * 60 * 60_000;

export type WebhookFailureCode =
  | 'missing_headers'
  | 'unsupported_algorithm'
  | 'invalid_transmission_time'
  | 'transmission_in_future'
  | 'transmission_too_old'
  | 'cert_url_invalid'
  | 'cert_fetch_failed'
  | 'cert_invalid'
  | 'cert_expired'
  | 'signature_invalid'
  | 'webhook_id_missing';

export interface WebhookHeaders {
  transmissionId?: string;
  transmissionTime?: string;
  transmissionSig?: string;
  certUrl?: string;
  authAlgo?: string;
}

export type CertFetcher = (url: string) => Promise<string>;

/** Accepts only https://api.sandbox.paypal.com/v1/notifications/certs/<id> (or the api-m host), with nothing else in the URL. */
export function validateCertUrl(raw: string | undefined): { ok: true; url: URL } | { ok: false } {
  if (!raw || raw.length > 500) return { ok: false };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== 'https:') return { ok: false };
  if (!CERT_HOSTS.has(url.hostname)) return { ok: false };
  if (url.port !== '' && url.port !== '443') return { ok: false };
  if (url.username || url.password || url.search || url.hash) return { ok: false };
  if (!CERT_PATH.test(url.pathname)) return { ok: false };
  if (raw.includes('\\') || raw.includes('%')) return { ok: false };
  return { ok: true, url };
}

/** Fetches a certificate over HTTPS without following redirects, with a timeout and a size cap. */
export const fetchCertificate: CertFetcher = async (url) => {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response.ok || !response.body) throw new Error(`Certificate fetch returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_CERT_BYTES) {
      await reader.cancel();
      throw new Error('Certificate response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export interface VerifierOptions {
  webhookId: string | undefined;
  fetchCert?: CertFetcher;
  clock?: () => Date;
}

export type VerificationResult = { ok: true; certHost: string; certPem: string } | { ok: false; code: WebhookFailureCode; certHost: string | null };

/**
 * The string PayPal signs: transmission ID, transmission time, webhook ID and the CRC32 of the exact raw body as an
 * unsigned decimal, joined by "|".
 */
export function webhookSigningString(transmissionId: string, transmissionTime: string, webhookId: string, rawBody: Buffer): string {
  return `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody) >>> 0}`;
}

export function createWebhookVerifier({ webhookId, fetchCert = fetchCertificate, clock = () => new Date() }: VerifierOptions) {
  const cache = new Map<string, { pem: string; fetchedAt: number }>();

  const certificateFor = async (url: string): Promise<string> => {
    const cached = cache.get(url);
    if (cached && clock().getTime() - cached.fetchedAt < CERT_CACHE_TTL_MS) return cached.pem;
    const pem = await fetchCert(url);
    if (cache.size >= 20) cache.delete(cache.keys().next().value!);
    cache.set(url, { pem, fetchedAt: clock().getTime() });
    return pem;
  };

  return async function verifyWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<VerificationResult> {
    if (!webhookId) return { ok: false, code: 'webhook_id_missing', certHost: null };
    const { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo } = headers;
    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) return { ok: false, code: 'missing_headers', certHost: null };
    if (authAlgo !== 'SHA256withRSA') return { ok: false, code: 'unsupported_algorithm', certHost: null };
    if (transmissionId.length > 100 || transmissionSig.length > 1024) return { ok: false, code: 'missing_headers', certHost: null };

    const sentAt = Date.parse(transmissionTime);
    if (!Number.isFinite(sentAt) || !/^\d{4}-\d{2}-\d{2}T/.test(transmissionTime)) return { ok: false, code: 'invalid_transmission_time', certHost: null };
    const now = clock().getTime();
    if (sentAt > now + FUTURE_TOLERANCE_MS) return { ok: false, code: 'transmission_in_future', certHost: null };
    if (sentAt < now - MAX_AGE_MS) return { ok: false, code: 'transmission_too_old', certHost: null };

    const parsedUrl = validateCertUrl(certUrl);
    if (!parsedUrl.ok) return { ok: false, code: 'cert_url_invalid', certHost: null };
    const certHost = parsedUrl.url.hostname;

    let pem: string;
    try {
      pem = await certificateFor(parsedUrl.url.toString());
    } catch {
      return { ok: false, code: 'cert_fetch_failed', certHost };
    }
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pem);
    } catch {
      return { ok: false, code: 'cert_invalid', certHost };
    }
    if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) return { ok: false, code: 'cert_expired', certHost };

    const message = webhookSigningString(transmissionId, transmissionTime, webhookId, rawBody);
    let valid = false;
    try {
      valid = verifySignature('sha256', Buffer.from(message, 'utf8'), cert.publicKey, Buffer.from(transmissionSig, 'base64'));
    } catch {
      valid = false;
    }
    return valid ? { ok: true, certHost, certPem: pem } : { ok: false, code: 'signature_invalid', certHost };
  };
}

export type WebhookVerifier = ReturnType<typeof createWebhookVerifier>;
