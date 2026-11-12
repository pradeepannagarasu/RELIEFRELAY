/**
 * Plain HTTP is never served by the public deployment: pages are redirected to HTTPS and writes are refused.
 * Only the local preview turns this off (ENFORCE_HTTPS=false), because wrangler dev serves over plain HTTP.
 */
export function requireHttps(request: Request, url: URL, enforce: string | undefined): Response | null {
  if (enforce === 'false' || url.protocol !== 'http:') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: { code: 'https_required', message: 'Use HTTPS.', requestId: null } }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  const secure = new URL(url);
  secure.protocol = 'https:';
  return new Response(null, { status: 301, headers: { Location: secure.toString(), 'Cache-Control': 'no-store' } });
}
