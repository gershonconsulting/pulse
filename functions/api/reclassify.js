// functions/api/reclassify.js  (2026-10-04)
// POST /api/reclassify  -> re-runs the server-side rules on the conversations ALREADY
// stored for the caller's tenant, so the backlog is fixed without waiting for syncs:
//   - social rule (birthday / work-anniversary wishes),
//   - decline / maybe-later / selling-to-us rule, keywords + Workers AI fallback.
// AI is called for at most `?max=` (default 40) still-Red conversations per request,
// each verdict cached on the record, so calling it again continues where it stopped.
// Manual status overrides are never touched.

import { json, readData, writeData, clientIdOf } from './_shared.js';
import { applySocialRule } from '../_social-rules.js';
import { applyDeclineRulesAsync } from '../_decline-rules.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = clientIdOf(context);
  try {
    const url = new URL(request.url);
    const max = Math.max(0, Math.min(45, parseInt(url.searchParams.get('max') || '40', 10) || 40));
    const data = await readData(env.PULSE_KV, clientId);
    const before = data.messages.filter((m) => m.status === 'Red').length;
    const social = data.messages.map(applySocialRule);
    const prev = new Map(social.map((m) => [m.name, m]));
    const out = await applyDeclineRulesAsync(social, prev, env, (u, o) => fetch(u, o), max);
    data.messages = out;
    await writeData(env.PULSE_KV, clientId, data);
    const after = out.filter((m) => m.status === 'Red').length;
    const pending = out.filter((m) => m.status === 'Red' && !m.manualStatus && m.lastSender !== 'you' && !m.aiIntent).length;
    const by = (c) => out.filter((m) => m.category === c).length;
    return json({
      success: true, redBefore: before, redAfter: after, stillToCheck: pending,
      decline: by('decline'), later: by('later'), sellingToUs: by('vendor_pitch'), social: by('social'),
      ai: !!env.AI,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
