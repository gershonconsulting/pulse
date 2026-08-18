// functions/api/me.js
// GET /api/me — who is signed in?
// 200 + user object when the LinkedIn session cookie is valid; 401 otherwise.
// Both the marketing homepage and the dashboard call this on load.

import { getSession, clearCookie, COOKIE_NAME } from '../_session.js';
import { resolveAccess } from '../_admin.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);

  if (!session) {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: NO_STORE });
  }

  // Revocation: removing someone from the client registry (or suspending their client,
  // or dropping them from ALLOWLIST) kills the session on the next call, even though
  // they still hold a validly-signed cookie.
  const access = await resolveAccess(session.email, env);
  if (!access.allowed) {
    return new Response(JSON.stringify({ ok: false, error: 'revoked', reason: access.reason }), {
      status: 401,
      headers: Object.assign({ 'Set-Cookie': clearCookie(COOKIE_NAME) }, NO_STORE),
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    // isAdmin is authoritative here (env-var driven), NOT read from the cookie — so
    // revoking admin takes effect immediately instead of after the 30-day expiry.
    isAdmin: !!access.admin,
    client: access.client
      ? { id: access.client.id, name: access.client.name, status: access.client.status, plan: access.client.plan }
      : null,
    user: {
      sub: session.sub,
      email: session.email,
      name: session.name,
      picture: session.picture || null,
    },
  }), { status: 200, headers: NO_STORE });
}
