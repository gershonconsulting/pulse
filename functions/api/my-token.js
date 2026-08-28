// functions/api/my-token.js
// GET  /api/my-token  — the caller's OWN collector token, in full.
// POST /api/my-token  — rotate it (the old one stops working immediately).
//
// WHY THIS EXISTS: since sign-in provisions the tenant itself (see functions/_admin.js
// → enrollUser), a new user has nobody to ask for their extension token. This hands it
// to them from their own dashboard.
//
// SESSION ONLY, deliberately. A collector bearer token must never be able to read or
// rotate itself: a leaked token would otherwise be able to lock the real owner out.

import { readAdminStore, findClient, rotateClientToken } from '../_admin.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: NO_STORE });

// The signed-in identity, or null when the caller is a bearer token.
function humanOf(context) {
  const d = context.data || {};
  return d.auth === 'session' && d.session ? d : null;
}

function forbidden() {
  return json({ ok: false, error: 'forbidden', message: 'Sign in on the website to see your access token.' }, 403);
}

// A CoHost (or an admin) looking at somebody else's tenant must not be handed that
// tenant's collector token — reading it would be a credential leak and rotating it
// would silently break the owner's extension. Tokens belong to the tenant, not to
// whoever is currently viewing it.
function viewingSomeoneElse(context) {
  return !!((context.data || {}).viewingAs);
}

function notYours() {
  return json({
    ok: false, error: 'not-your-tenant',
    message: 'Access tokens belong to the account that owns them. Switch back to your own view to see yours.',
  }, 403);
}

export async function onRequestGet(context) {
  const me = humanOf(context);
  if (!me) return forbidden();
  if (viewingSomeoneElse(context)) return notYours();

  // ── The default tenant (Gershon's own) ────────────────────────────────────
  // It has no registry client, so its collector credential is the shared
  // EXTENSION_TOKEN set in Cloudflare rather than a `pls_…` issued by /admin.
  //
  // This route used to withhold it on principle, which made the ONE account we
  // actually run Pulse on the only account that could not self-connect: the
  // dashboard's auto-connect dead-ended on `managed: 'env'`, the collector never
  // received a token, and "Sync now" refused every run in silence (2026-08-28).
  //
  // Handing it over is safe. This route is session-only, and the default tenant is
  // reachable ONLY by a super-admin or an ALLOWLIST email — both already hold a
  // session cookie granting full read/write over exactly the data this token
  // unlocks, so the token confers nothing they did not already have. It is still
  // never readable by a bearer token (a leaked collector token cannot read itself),
  // never handed to a CoHost viewing this tenant, and still not rotatable here —
  // changing it means editing the Cloudflare variable and redeploying.
  if (!me.clientId) {
    const shared = (context.env && context.env.EXTENSION_TOKEN) || null;
    return json({
      ok: true,
      clientId: null,
      token: shared || null,
      managed: 'env',
      rotatable: false,
      message: shared
        ? null
        : 'EXTENSION_TOKEN is not set in Cloudflare, so there is no collector token to hand out.',
    });
  }

  const client = findClient(await readAdminStore(context.env), me.clientId);
  if (!client) return json({ ok: false, error: 'not-found' }, 404);

  return json({
    ok: true,
    clientId: client.id,
    token: client.extensionToken || null,
    tokenRotatedAt: client.tokenRotatedAt || null,
    rotatable: true,
  });
}

export async function onRequestPost(context) {
  const me = humanOf(context);
  if (!me) return forbidden();
  if (viewingSomeoneElse(context)) return notYours();
  // Still not rotatable: the default tenant's token is a Cloudflare variable, and
  // rewriting it from here would not survive (env vars only apply on a new deploy).
  if (!me.clientId) {
    return json({
      ok: false, error: 'not-rotatable',
      message: 'This account uses the shared environment token. Change EXTENSION_TOKEN in Cloudflare, then redeploy.',
    }, 400);
  }

  const token = await rotateClientToken(context.env, me.clientId, me.session.email);
  if (!token) return json({ ok: false, error: 'not-found' }, 404);

  return json({ ok: true, clientId: me.clientId, token, rotated: true });
}
