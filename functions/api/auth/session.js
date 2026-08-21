// functions/api/auth/session.js
// GET /api/auth/session — "is this credential good, and whose is it?"
//
// WHY THIS EXISTS: the Chrome extension verifies a collector token here before
// storing it, so a stale or wrong token is rejected at connect time instead of
// silently failing halfway through a sync. Until v1.18.0 this route did not
// exist at all — it only appeared to work because Cloudflare Pages' SPA fallback
// answers 200 for unknown paths once the middleware has accepted the request.
// That made "is my token valid?" indistinguishable from "does this path exist?".
//
// The middleware has already authenticated the caller by the time we run: a
// bearer collector token (X-Pulse-Token / Authorization: Bearer) or a signed
// LinkedIn session cookie. Anything else was turned away with a 401 upstream,
// so reaching this handler at all IS the answer.
//
// Returns no secrets — never the token, never the session's identity beyond the
// tenant it belongs to.

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export async function onRequestGet(context) {
  const d = context.data || {};

  return new Response(
    JSON.stringify({
      ok: true,
      auth: d.auth || null,        // 'token' | 'session'
      clientId: d.clientId || null, // null = the default tenant (Gershon's own)
    }),
    { status: 200, headers: NO_STORE }
  );
}

// A HEAD is cheap and enough for a liveness/credential probe.
export async function onRequestHead(context) {
  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
