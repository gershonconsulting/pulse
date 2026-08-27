// functions/api/cohost.js
// The tenant switcher for CoHosts (and super-admins).
//
//   GET  /api/cohost   → the tenants this caller may view + which one is selected
//   POST /api/cohost   { clientId }  → select a tenant (null/'__default' = the
//                                      default store), returns the new selection
//
// SESSION ONLY. A collector bearer token can never switch tenants — that would turn
// one leaked token into a key to every client's inbox. `humanOf` enforces it.
//
// The selection is stored in the plain `pulse_view` cookie. It is a PREFERENCE, not a
// permission: functions/_middleware.js only reads it after confirming the caller is a
// super-admin or an ACTIVE CoHost, and re-checks the id against the registry on every
// single request. An ordinary client user who forges the cookie gets nothing at all.

import { readAdminStore, findClient, findCohostByEmail, isAdminEmail, VIEW_COOKIE, VIEW_DEFAULT } from '../_admin.js';
import { readData } from './_shared.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (d, s = 200, extra) => new Response(JSON.stringify(d), {
  status: s, headers: Object.assign({}, NO_STORE, extra || {}),
});

// A year — the switcher is a UI preference, so it should survive a browser restart.
const VIEW_MAX_AGE = 60 * 60 * 24 * 365;

function viewCookie(value) {
  // Deliberately NOT HttpOnly-sensitive data; still HttpOnly so page script cannot
  // desync the UI from what the server is actually serving.
  return `${VIEW_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${VIEW_MAX_AGE}`;
}

/** The signed-in identity, or null when the caller is a bearer token. */
function humanOf(context) {
  const d = context.data || {};
  return d.auth === 'session' && d.session ? d : null;
}

/** May this caller switch tenants at all? */
async function switcher(context) {
  const me = humanOf(context);
  if (!me) return null;
  const email = String(me.session.email || '').toLowerCase();
  const store = await readAdminStore(context.env);
  const admin = isAdminEmail(email, context.env);
  const cohost = admin ? null : findCohostByEmail(store, email);
  if (!admin && !cohost) return null;
  return { me, store, admin, cohost };
}

function forbidden() {
  return json({
    ok: false, error: 'forbidden',
    message: 'Only CoHosts and administrators can switch between accounts.',
  }, 403);
}

export async function onRequestGet(context) {
  const ctx = await switcher(context);
  if (!ctx) return forbidden();

  // One cheap KV read per tenant so the switcher can show real volume rather than
  // a list of bare names — that is what makes it usable for verification work.
  const tenants = [];
  try {
    const d = await readData(context.env.PULSE_KV, null);
    const msgs = d.messages || [];
    tenants.push({
      clientId: null,
      id: VIEW_DEFAULT,
      name: 'Gershon Consulting',
      status: 'active',
      isDefault: true,
      conversations: msgs.length,
      followUp: msgs.filter(m => m.status === 'Red' && !m.done).length,
      lastScanAt: ((d.scans || [])[0] || {}).timestamp || null,
    });
  } catch (e) { /* a KV hiccup must not empty the switcher */ }

  for (const c of (ctx.store.clients || [])) {
    try {
      const d = await readData(context.env.PULSE_KV, c.id);
      const msgs = d.messages || [];
      tenants.push({
        clientId: c.id, id: c.id, name: c.name, status: c.status, isDefault: false,
        conversations: msgs.length,
        followUp: msgs.filter(m => m.status === 'Red' && !m.done).length,
        lastScanAt: ((d.scans || [])[0] || {}).timestamp || null,
      });
    } catch (e) {
      tenants.push({
        clientId: c.id, id: c.id, name: c.name, status: c.status, isDefault: false,
        conversations: null, followUp: null, lastScanAt: null,
      });
    }
  }

  const currentId = (context.data || {}).clientId || null;
  const current = tenants.find(t => t.clientId === currentId) || tenants[0] || null;

  return json({
    ok: true,
    role: ctx.admin ? 'admin' : 'cohost',
    cohostId: ctx.cohost ? ctx.cohost.id : null,
    current,
    tenants,
  });
}

export async function onRequestPost(context) {
  const ctx = await switcher(context);
  if (!ctx) return forbidden();

  let body = {};
  try { body = await context.request.json(); } catch (e) { /* clientId may be a query param */ }
  const raw = String(
    (body && body.clientId !== undefined && body.clientId !== null ? body.clientId : '') ||
    new URL(context.request.url).searchParams.get('clientId') || ''
  ).trim();

  if (!raw || raw === VIEW_DEFAULT) {
    return json({ ok: true, clientId: null, name: 'Gershon Consulting', isDefault: true },
      200, { 'Set-Cookie': viewCookie(VIEW_DEFAULT) });
  }

  const target = findClient(ctx.store, raw);
  if (!target) return json({ ok: false, error: 'not-found' }, 404);

  return json({ ok: true, clientId: target.id, name: target.name, isDefault: false },
    200, { 'Set-Cookie': viewCookie(target.id) });
}
