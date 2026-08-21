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

export async function onRequestGet(context) {
  const me = humanOf(context);
  if (!me) return forbidden();

  // Gershon's own tenant has no registry client — it uses the shared EXTENSION_TOKEN
  // from the environment, which is deliberately not readable over the API.
  if (!me.clientId) {
    return json({ ok: true, clientId: null, token: null, managed: 'env' });
  }

  const client = findClient(await readAdminStore(context.env), me.clientId);
  if (!client) return json({ ok: false, error: 'not-found' }, 404);

  return json({
    ok: true,
    clientId: client.id,
    token: client.extensionToken || null,
    tokenRotatedAt: client.tokenRotatedAt || null,
  });
}

export async function onRequestPost(context) {
  const me = humanOf(context);
  if (!me) return forbidden();
  if (!me.clientId) return json({ ok: false, error: 'not-rotatable', message: 'This account uses the shared environment token.' }, 400);

  const token = await rotateClientToken(context.env, me.clientId, me.session.email);
  if (!token) return json({ ok: false, error: 'not-found' }, 404);

  return json({ ok: true, clientId: me.clientId, token, rotated: true });
}
