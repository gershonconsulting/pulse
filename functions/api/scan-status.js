// functions/api/scan-status.js
// Lightweight scan progress channel so the dashboard can show a live progress
// bar while the Chrome extension runs a Sync Now collect.
// GET  /api/scan-status  -> current status { phase, count, total, updatedAt }
// POST /api/scan-status  -> extension background worker reports progress

import { json } from './_shared.js';

export async function onRequestGet({ env }) {
  const raw = await env.PULSE_KV.get('scan-status', 'json');
  return json(raw || { phase: 'idle', count: 0, total: 0 });
}

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const status = {
    phase: body.phase || 'scanning',   // starting | scanning | capturing-links | done | idle
    count: body.count || 0,
    total: body.total || 0,
    updatedAt: new Date().toISOString(),
  };
  // Auto-expire after 1h so a crashed scan doesn't leave a stuck bar.
  await env.PULSE_KV.put('scan-status', JSON.stringify(status), { expirationTtl: 3600 });
  return json({ ok: true });
}
