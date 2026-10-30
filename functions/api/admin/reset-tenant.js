// functions/api/admin/reset-tenant.js   (Pulse v5.13.0, 2026-10-28)
// POST /api/admin/reset-tenant  { clientId, mirror?: true, dryRun?: false }
//
// Gives one client a CLEAN store so the next verified crawl (collector >= 1.20.0)
// rebuilds it from the inbox as it is today. Built for Anne Bougel (Altavia), whose
// store had accumulated stale + crossed records from collector <= 1.19.0.
//
//  1. Backs up the whole current store to `backup:<dataKey>:<iso>` (90-day TTL).
//  2. Carries manual work (manualStatus / focus / done / note / fit / interest)
//     keyed by threadId, so it is re-applied when that thread is crawled again.
//  3. Writes { scans: [], messages: [], settings: { mirror } }. With mirror on, every
//     COMPLETE crawl drops conversations that are no longer in the inbox (they move
//     to `archived`, never silently deleted) — see functions/api/messages.js.
// Super-admin only (both admin locks). Audited.

import { readAdminStore, writeAdminStore, audit, findClient } from '../../_admin.js';
import { readData, writeData, dataKey } from '../_shared.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: NO_STORE });

const MANUAL_FIELDS = ['manualStatus', 'focus', 'done', 'doneAt', 'note', 'fit', 'interest'];

export async function onRequestPost({ request, env, data }) {
  let body = {};
  try { body = await request.json(); } catch (e) { /* empty body */ }
  const id = String((body && body.clientId) || '').trim();
  if (!id || id === '__default') return json({ ok: false, error: 'clientId required (the default tenant cannot be reset here)' }, 400);

  const store = await readAdminStore(env);
  const client = findClient(store, id);
  if (!client) return json({ ok: false, error: 'not-found' }, 404);

  const current = await readData(env.PULSE_KV, client.id);
  const carry = {};
  for (const m of current.messages || []) {
    const key = m.threadId || null;
    if (!key) continue;
    const manual = {};
    for (const f of MANUAL_FIELDS) {
      if (m[f] === undefined || m[f] === null || m[f] === '') continue;
      if ((f === 'fit' || f === 'interest') && !m.manualGrade) continue; // auto grades are not manual work
      manual[f] = m[f];
    }
    if (Object.keys(manual).length) carry[key] = manual;
  }

  const summary = {
    clientId: client.id,
    before: (current.messages || []).length,
    scansBefore: (current.scans || []).length,
    manualCarried: Object.keys(carry).length,
    mirror: body.mirror !== false,
  };
  if (body.dryRun) return json({ ok: true, dryRun: true, ...summary });

  const backupKey = 'backup:' + dataKey(client.id) + ':' + new Date().toISOString();
  await env.PULSE_KV.put(backupKey, JSON.stringify(current), { expirationTtl: 90 * 24 * 3600 });

  await writeData(env.PULSE_KV, client.id, {
    scans: [],
    messages: [],
    archived: [],
    manualCarry: carry,
    settings: { ...(current.settings || {}), mirror: summary.mirror, resetAt: new Date().toISOString(), backupKey },
  });

  audit(store, data.adminEmail, 'tenant.reset', client.id, { before: summary.before, backupKey });
  await writeAdminStore(env, store);

  return json({ ok: true, ...summary, backupKey });
}
