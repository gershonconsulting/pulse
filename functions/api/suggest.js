// functions/api/suggest.js  (app v5.10.0)
// POST /api/suggest {name}  -> suggested replies for one conversation.
// Grounded in the tenant's company knowledge (/api/knowledge) and past replies
// (/api/replies + "you sent last" messages). See _suggest-engine.js for the tiers:
// Claude if ANTHROPIC_API_KEY is set, Workers AI if an `AI` binding exists,
// otherwise built-in templates — so it always answers.

import { json, clientIdOf, readData } from './_shared.js';
import { suggest } from './_suggest-engine.js';
import { readKb } from './knowledge.js';
import { readLibrary } from './replies.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = clientIdOf(context);
  try {
    const b = await request.json();
    const name = String((b && b.name) || '');
    const [data, kb, lib] = await Promise.all([
      readData(env.PULSE_KV, clientId),
      readKb(env.PULSE_KV, clientId),
      readLibrary(env.PULSE_KV, clientId),
    ]);
    const msg = data.messages.find((m) => m.name === name);
    if (!msg) return json({ error: 'Conversation not found' }, 404);
    const out = await suggest({
      msg, kb, library: lib.replies, allMessages: data.messages, env,
      fetchFn: (u, o) => fetch(u, o),
    });
    return json(out);
  } catch (err) { return json({ error: err.message }, 500); }
}
