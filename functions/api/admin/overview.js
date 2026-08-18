// functions/api/admin/overview.js
// GET /api/admin/overview — the numbers the admin landing page shows.
// Deliberately cheap: two KV reads, no per-client fan-out.

import { readAdminStore } from '../../_admin.js';
import { readData } from '../_shared.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: NO_STORE });

export async function onRequestGet({ env, data }) {
  const store = await readAdminStore(env);

  let dataStore = { scans: [], messages: [] };
  try { dataStore = await readData(env.PULSE_KV); } catch (e) { /* registry still renders */ }

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
    platform: {
      conversations: messages.length,
      red: messages.filter(m => m.status === 'Red').length,
      lastScanAt: lastScan ? lastScan.timestamp : null,
      lastScanCount: lastScan ? lastScan.count : null,
      scans: (dataStore.scans || []).length,
    },
    updatedAt: store.updatedAt,
  });
}
