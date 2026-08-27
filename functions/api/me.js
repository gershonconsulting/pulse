// functions/api/me.js
// GET /api/me — who is signed in?
// 200 + user object when the LinkedIn session cookie is valid; 401 otherwise.
// Both the marketing homepage and the dashboard call this on load.

import { getSession, clearCookie, parseCookies, COOKIE_NAME } from '../_session.js';
import { readAdminStore, findClient, resolveAccess, trialDaysLeft, VIEW_COOKIE, VIEW_DEFAULT } from '../_admin.js';

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

  // Which tenant is this session actually being served? For everyone except a CoHost
  // or an admin that is simply their own client. For those two it is whatever the
  // view switcher selected, so the dashboard can label the screen honestly.
  //
  // NOTE: /api/me is a PUBLIC path in the root middleware (it has to answer 401 for
  // signed-out visitors), which means it never receives the stamped context.data —
  // so the selection is read and re-validated HERE, against the same registry the
  // middleware uses. Same rule, same answer, no drift.
  const canSwitchTenants = !!access.admin || !!access.cohost;
  let viewing = null;
  if (canSwitchTenants) {
    const wanted = String(parseCookies(request.headers.get('Cookie'))[VIEW_COOKIE] || '').trim();
    const selected = (wanted && wanted !== VIEW_DEFAULT) ? wanted : null;
    const client = selected ? findClient(await readAdminStore(env), selected) : null;
    viewing = client
      ? { clientId: client.id, name: client.name, status: client.status, isDefault: false }
      : { clientId: null, name: 'Gershon Consulting', status: 'active', isDefault: true };
  }

  return new Response(JSON.stringify({
    ok: true,
    // isAdmin is authoritative here (env-var driven), NOT read from the cookie — so
    // revoking admin takes effect immediately instead of after the 30-day expiry.
    isAdmin: !!access.admin,
    // Same reasoning for CoHost: the LIVE registry decides, not the 30-day cookie,
    // so revoking a CoHost logs them out on their very next call.
    isCohost: !!access.cohost,
    cohost: access.cohost ? { id: access.cohost.id, name: access.cohost.name } : null,
    canSwitchTenants,
    viewing,
    client: access.client
      ? {
          id: access.client.id,
          name: access.client.name,
          status: access.client.status,
          plan: access.client.plan,
          // Trial clock, so the dashboard can show "6 days left" without a second call.
          trialEndsAt: access.client.trialEndsAt || null,
          trialDaysLeft: trialDaysLeft(access.client),
        }
      : null,
    user: {
      sub: session.sub,
      email: session.email,
      name: session.name,
      picture: session.picture || null,
    },
  }), { status: 200, headers: NO_STORE });
}
