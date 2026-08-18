// functions/api/admin/clients.js
// The client registry CRUD. Flat routes on purpose — no [id] path segments — so the
// whole control plane lives in one directory and deploys in a single upload.
//
//   GET    /api/admin/clients              → list (tokens masked)
//   POST   /api/admin/clients              → create  { name, status?, plan?, reportEmail?,
//                                                      notes?, trialEndsAt?, ownerEmail? }
//   PATCH  /api/admin/clients              → update  { id, ...fields }
//   DELETE /api/admin/clients?id=…         → remove
//
// The extension token is generated at creation and returned IN FULL exactly once here.
// Every later read masks it — rotating is the only way to see a new one, the standard
// "you get one look at your API key" behaviour.
//
// NOTE: DELETE removes the client RECORD. Collected conversations still live in the
// shared `data` KV key, so deleting revokes ACCESS — it does not erase history. Per-client
// data isolation is the planned follow-up.

import {
  readAdminStore, writeAdminStore, audit, findClient, newClientId, newExtensionToken,
  publicClient, CLIENT_STATUSES, EMAIL_RE,
} from '../../_admin.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: NO_STORE });

export async function onRequestGet({ env }) {
  const store = await readAdminStore(env);
  return json({ ok: true, clients: (store.clients || []).map(publicClient), updatedAt: store.updatedAt });
}

export async function onRequestPost({ request, env, data }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad-json' }, 400); }

  const name = String((body && body.name) || '').trim();
  if (!name) return json({ ok: false, error: 'name-required' }, 400);
  if (name.length > 80) return json({ ok: false, error: 'name-too-long' }, 400);

  const status = CLIENT_STATUSES.indexOf(body.status) !== -1 ? body.status : 'trial';
  const ownerEmail = String(body.ownerEmail || '').trim().toLowerCase();
  if (ownerEmail && !EMAIL_RE.test(ownerEmail)) return json({ ok: false, error: 'bad-email' }, 400);

  const store = await readAdminStore(env);

  // One email belongs to exactly one client — refuse rather than create an ambiguity
  // that resolveAccess() would have to settle with "first match wins".
  if (ownerEmail) {
    const clash = store.clients.find(c => c.users.some(u => u.email === ownerEmail));
    if (clash) return json({ ok: false, error: 'email-taken', clientId: clash.id, clientName: clash.name }, 409);
  }

  const now = new Date().toISOString();
  const client = {
    id: newClientId(name, store),
    name,
    status,
    plan: String(body.plan || 'trial').slice(0, 32),
    createdAt: now,
    trialEndsAt: body.trialEndsAt || null,
    notes: String(body.notes || '').slice(0, 2000),
    reportEmail: String(body.reportEmail || '').trim().toLowerCase(),
    extensionToken: newExtensionToken(),
    tokenRotatedAt: now,
    users: ownerEmail ? [{ email: ownerEmail, role: 'owner', addedAt: now, lastSeenAt: null }] : [],
  };

  store.clients.push(client);
  audit(store, data.adminEmail, 'client.create', client.id, { name, status, ownerEmail: ownerEmail || null });
  await writeAdminStore(env, store);

  return json({ ok: true, client: publicClient(client), extensionToken: client.extensionToken }, 201);
}

export async function onRequestPatch({ request, env, data }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad-json' }, 400); }

  const store = await readAdminStore(env);
  const client = findClient(store, body && body.id);
  if (!client) return json({ ok: false, error: 'not-found' }, 404);

  const changes = {};

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return json({ ok: false, error: 'name-required' }, 400);
    if (name !== client.name) { changes.name = [client.name, name]; client.name = name.slice(0, 80); }
  }
  if (typeof body.status === 'string') {
    if (CLIENT_STATUSES.indexOf(body.status) === -1) return json({ ok: false, error: 'bad-status' }, 400);
    if (body.status !== client.status) { changes.status = [client.status, body.status]; client.status = body.status; }
  }
  if (typeof body.plan === 'string' && body.plan.trim() !== client.plan) {
    changes.plan = [client.plan, body.plan.trim()];
    client.plan = body.plan.trim().slice(0, 32);
  }
  if (typeof body.notes === 'string' && body.notes !== client.notes) {
    changes.notes = true;                       // free text never gets copied into the audit log
    client.notes = body.notes.slice(0, 2000);
  }
  if (typeof body.reportEmail === 'string') {
    const em = body.reportEmail.trim().toLowerCase();
    if (em && !EMAIL_RE.test(em)) return json({ ok: false, error: 'bad-email' }, 400);
    if (em !== client.reportEmail) { changes.reportEmail = [client.reportEmail, em]; client.reportEmail = em; }
  }
  if ('trialEndsAt' in body) {
    const v = body.trialEndsAt ? String(body.trialEndsAt) : null;
    if (v !== client.trialEndsAt) { changes.trialEndsAt = [client.trialEndsAt, v]; client.trialEndsAt = v; }
  }

  if (!Object.keys(changes).length) return json({ ok: true, client: publicClient(client), unchanged: true });

  audit(store, data.adminEmail, 'client.update', client.id, changes);
  await writeAdminStore(env, store);
  return json({ ok: true, client: publicClient(client) });
}

export async function onRequestDelete({ request, env, data }) {
  const id = new URL(request.url).searchParams.get('id');
  const store = await readAdminStore(env);
  const client = findClient(store, id);
  if (!client) return json({ ok: false, error: 'not-found' }, 404);

  store.clients = store.clients.filter(c => c.id !== client.id);
  audit(store, data.adminEmail, 'client.delete', client.id, {
    name: client.name,
    users: client.users.map(u => u.email),
  });
  await writeAdminStore(env, store);
  return json({ ok: true, deleted: client.id });
}
