/**
 * GoWatch CORS proxy - Cloudflare Worker.
 * Forwards an allowlisted set of requests to online-go.com and adds CORS headers.
 * Deploy: paste into a new Worker (dash.cloudflare.com > Workers) or `wrangler deploy`.
 * Optional env var ALLOWED_ORIGIN (e.g. https://you.github.io) restricts which site may call it.
 * The proxy keeps nothing: tokens pass through in the Authorization header / token request body.
 */
const UPSTREAM = 'https://online-go.com';
const ALLOW = [/^\/oauth2\/token\/$/, /^\/api\/v1\/me\/$/, /^\/api\/v1\/me\/games\/sgf\/.+/, /^\/api\/v1\/library\/.+/];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const allowed = env?.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': allowed === '*' ? '*' : allowed,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (allowed !== '*' && origin !== allowed) return new Response('Origin not allowed', { status: 403, headers: cors });

    const url = new URL(request.url);
    if (!ALLOW.some((re) => re.test(url.pathname))) return new Response('Path not allowed', { status: 403, headers: cors });

    const headers = new Headers();
    for (const h of ['authorization', 'content-type', 'accept']) if (request.headers.get(h)) headers.set(h, request.headers.get(h));
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual',
    });
    const out = new Headers(upstream.headers);
    out.delete('set-cookie');
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
