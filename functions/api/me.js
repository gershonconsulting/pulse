// functions/api/me.js
// GET /api/me — who is signed in?
// 200 + user object when the LinkedIn session cookie is valid; 401 otherwise.
// Both the marketing homepage and the dashboard call this on load.

import { getSession, isAllowed, clearCookie, COOKIE_NAME } from '../_session.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);

  if (!session) {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: NO_STORE });
  }

  // Revocation: dropping someone from ALLOWLIST kills their session on the next call,
  // even though they still hold a validly-signed cookie.
  if (!isAllowed(session.email, env)) {
    return new Response(JSON.stringify({ ok: false, error: 'revoked' }), {
      status: 401,
      headers: Object.assign({ 'Set-Cookie': clearCookie(COOKIE_NAME) }, NO_STORE),
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    user: {
      sub: session.sub,
      email: session.email,
      name: session.name,
      picture: session.picture || null,
    },
  }), { status: 200, headers: NO_STORE });
}
