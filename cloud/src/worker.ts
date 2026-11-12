import { timingSafeEqual } from 'node:crypto';
import { requireHttps } from './https';
import type { Env } from './judgeObject';

export { JudgeDemo } from './judgeObject';

/**
 * Cloud entry point of the public ReliefRelay Judge Demo.
 * - Hashed files under /assets/ are served by Workers Static Assets before this code runs; pages pass through here
 *   first so that plain HTTP can be redirected to HTTPS.
 * - /api/* goes to the single Judge Demo Durable Object, which applies the public gateway rules and runs the API.
 * - /__cloud/* exists only while the IMPORT_TOKEN secret is set (one-time data import and verification).
 * - The Cron Trigger runs the payout worker tick (status polling of simulated payouts).
 * There is no route to the private ReliefRelay application, its database or the PayPal Sandbox.
 */
const judgeDemo = (env: Env) => env.JUDGE_DEMO.get(env.JUDGE_DEMO.idFromName('judge-demo'));

function tokenMatches(request: Request, token: string | undefined): boolean {
  if (!token || token.length < 32) return false;
  const given = Buffer.from(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const notFound = () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.', requestId: null } }), { status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const insecure = requireHttps(request, url, env.ENFORCE_HTTPS);
    if (insecure) return insecure;
    if (url.pathname.startsWith('/__cloud/')) {
      if (!tokenMatches(request, env.IMPORT_TOKEN)) return notFound();
      if (url.pathname === '/__cloud/status') return Response.json(await judgeDemo(env).status());
      if (url.pathname === '/__cloud/tick') return Response.json(await judgeDemo(env).tick());
      return judgeDemo(env).fetch(request);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return judgeDemo(env).fetch(request);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(judgeDemo(env).tick());
  },
} satisfies ExportedHandler<Env>;
