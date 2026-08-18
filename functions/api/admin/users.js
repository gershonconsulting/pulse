// functions/api/admin/users.js
// POST   /api/admin/users            { clientId, email, role? }  — invite a user
// DELETE /api/admin/users?clientId=…&email=…                     — revoke a user
//
// Adding a user IS the onboarding step: on their next "Sign in with LinkedIn",
// resolveAccess() finds them in the registry and lets them through. No deploy, no env var.
// Removing them kills any live session on the next /api/me call.

import {
  readAdminStore, writeAdminStore, audit, findClient, publicClient,
  USER_ROLES, EMAIL_RE,
} from '../../_admin.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: NO_STORE });

export async function onRequestPost({ request, env, data }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad-json' }, 400); }

  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'bad-email' }, 400);
  const role = USER_ROLES.indexOf(body.role) !== -1 ? body.role : 'member';

  const store = await readAdminStore(env);
  const client = findClient(store, body.clientId);
  if (!client) return json({ ok: false, error: 'not-found' }, 404);

  // An email may belong to exactly one client — otherwise "which client am I?" has no
  // deterministic answer once data is split per tenant.
  const clash = store.clients.find(c => c.users.some(u => u.email === email));
  if (clash) {
    return clash.id === client.id
      ? json({ ok: false, error: 'already-member' }, 409)
      : json({ ok: false, error: 'email-taken', clientId: clash.id, clientName: clash.name }, 409);
  }

  client.users.push({ email, role, addedAt: new Date().toISOString(), lastSeenAt: null });
  audit(store, data.adminEmail, 'user.add', client.id, { email, role });
  await writeAdminStore(env, store);
  return json({ ok: true, client: publicClient(client) }, 201);
}

export async function onRequestDelete({ request, env, data }) {
  const url = new URL(request.url);
  const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
  if (!email) return json({ ok: false, error: 'email-required' }, 400);

  const store = await readAdminStore(env);
  const client = findClient(store, url.searchParams.get('clientId'));
  if (!client) return json({ ok: false, error: 'not-found' }, 404);

  const before = client.users.length;
  client.users = client.users.filter(u => u.email !== email);
  if (client.users.length === before) return json({ ok: false, error: 'user-not-found' }, 404);

  audit(store, data.adminEmail, 'user.remove', client.id, { email });
  await writeAdminStore(env, store);
  return json({ ok: true, client: publicClient(client) });
}
