// functions/api/admin/audit.js
// GET /api/admin/audit?limit=100 — the change log for the client registry.
// Every mutating admin action appends here; nothing else writes to it.

import { readAdminStore } from '../../_admin.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: NO_STORE });

export async function onRequestGet({ request, env }) {
  const store = await readAdminStore(env);
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);
  const clientId = url.searchParams.get('client');
  let entries = store.audit || [];
  if (clientId) entries = entries.filter(e => e.target === clientId);
  return json({ ok: true, total: entries.length, entries: entries.slice(0, limit) });
}
