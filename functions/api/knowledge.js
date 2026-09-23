// functions/api/knowledge.js  (app v5.10.0)
// GET /api/knowledge  — this tenant's company knowledge (feeds Suggested replies)
// PUT /api/knowledge  — save it
// KV key: kb (Gershon's default tenant) / kb:<clientId>. Unset -> sensible default.

import { json, clientIdOf, scopedKey } from './_shared.js';
import { DEFAULT_KB, emptyKb } from './_suggest-engine.js';

const FIELDS = ['company', 'sender', 'pitch', 'proof', 'pitchFr', 'proofFr', 'market', 'marketFr', 'cta', 'calendarLink', 'tone', 'notes'];
const LIMITS = { notes: 4000, pitch: 1200, proof: 800, pitchFr: 1200, proofFr: 800, tone: 400 };

export async function readKb(kv, clientId) {
  const raw = await kv.get(scopedKey('kb', clientId), 'json');
  if (raw) return raw;
  return clientId ? emptyKb('') : Object.assign({}, DEFAULT_KB);
}

export async function onRequestGet(context) {
  const clientId = clientIdOf(context);
  try {
    const kb = await readKb(context.env.PULSE_KV, clientId);
    return json({ kb });
  } catch (err) { return json({ error: err.message }, 500); }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const clientId = clientIdOf(context);
  try {
    const body = await request.json();
    const src = (body && body.kb) || body || {};
    const kb = {};
    for (const f of FIELDS) kb[f] = String(src[f] == null ? '' : src[f]).slice(0, LIMITS[f] || 300).trim();
    if (kb.calendarLink && !/^https?:\/\//i.test(kb.calendarLink)) kb.calendarLink = 'https://' + kb.calendarLink;
    kb.updatedAt = new Date().toISOString();
    await env.PULSE_KV.put(scopedKey('kb', clientId), JSON.stringify(kb));
    return json({ ok: true, kb });
  } catch (err) { return json({ error: err.message }, 500); }
}
