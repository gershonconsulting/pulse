// functions/api/admin/overview.js
// GET /api/admin/overview — the numbers the admin landing page shows.
// Since data isolation landed (2026-08-21) each client has its own `data:<id>` key,
// so this fans out one cheap KV read per client on top of the default tenant.

import { readAdminStore } from '../../_admin.js';
import { readData } from '../_shared.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: NO_STORE });

export async function onRequestGet({ env, data }) {
  const store = await readAdminStore(env);

  let dataStore = { scans: [], messages: [] };
  try { dataStore = await readData(env.PULSE_KV); } catch (e) { /* registry still renders */ }

  // Per-tenant conversation counts, so the console shows real numbers instead of
  // repeating Gershon's own store for every client.
  const perClient = [];
  for (const c of (store.clients || [])) {
    try {
      const d = await readData(env.PULSE_KV, c.id);
      const last = (d.scans && d.scans[0]) || null;
      perClient.push({
        id: c.id,
        name: c.name,
        conversations: (d.messages || []).length,
        red: (d.messages || []).filter(m => m.status === 'Red').length,
        lastScanAt: last ? last.timestamp : null,
      });
    } catch (e) {
      perClient.push({ id: c.id, name: c.name, conversations: null, red: null, lastScanAt: null });
    }
  }

  const clients = store.clients || [];
  const byStatus = { trial: 0, active: 0, suspended: 0 };
  clients.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });

  const lastScan = (dataStore.scans && dataStore.scans[0]) || null;
  const messages = dataStore.messages || [];

  return json({
    ok: true,
    admin: (data && data.adminEmail) || null,
    // envAllowlistCount is shown as a warning strip: emails that bypass the registry.
    envAllowlistCount: String(env.ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean).length,
    legacyTokenSet: !!env.EXTENSION_TOKEN,
    adminEmailsSet: !!env.ADMIN_EMAILS,
    clients: {
      total: clients.length,
      users: clients.reduce((n, c) => n + c.users.length, 0),
      withToken: clients.filter(c => !!c.extensionToken).length,
      byStatus,
    },
    perClient,
    platform: {
      // The DEFAULT tenant (KV key `data`) — Gershon's own store.
      conversations: messages.length,
      red: messages.filter(m => m.status === 'Red').length,
      lastScanAt: lastScan ? lastScan.timestamp : null,
      lastScanCount: lastScan ? lastScan.count : null,
      scans: (dataStore.scans || []).length,
    },
    updatedAt: store.updatedAt,
  });
}
