// functions/api/suggest.js  (app v5.10.0 → reply format 2026-10-04)
// POST /api/suggest {name}  -> suggested replies for one conversation.
// 2026-10-04 — Olivier's format, always: ONE sentence tied to the previous exchange, then
// "Let's discuss this further. My calendar is at <calendar link from Settings>".
// See _reply-format.js. Sentences come from Cloudflare Workers AI (free at our volume).

import { json, clientIdOf, readData } from './_shared.js';
import { readKb } from './knowledge.js';
import { suggestFormatted } from './_reply-format.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = clientIdOf(context);
  try {
    const b = await request.json();
    const name = String((b && b.name) || '');
    const [data, kb] = await Promise.all([
      readData(env.PULSE_KV, clientId),
      readKb(env.PULSE_KV, clientId),
    ]);
    const msg = data.messages.find((m) => m.name === name);
    if (!msg) return json({ error: 'Conversation not found' }, 404);
    const out = await suggestFormatted({ msg, kb, env, fetchFn: (u, o) => fetch(u, o) });
    return json(out);
  } catch (err) { return json({ error: err.message }, 500); }
}
