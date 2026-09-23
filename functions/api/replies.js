// functions/api/replies.js  (app v5.10.0)
// The tenant's REPLY LIBRARY — past replies that Suggested replies learns from.
// GET    /api/replies          — list (library + harvested "you sent last" messages)
// POST   /api/replies          — add {text, context?, intent?, language?, leadName?, source?}
//                                source 'copied' = a suggestion Olivier copied (dedup -> uses++)
// DELETE /api/replies?id=<id>  — remove one library entry
// KV key: replies / replies:<clientId>. Capped at MAX_LIBRARY, least-used oldest dropped.

import { json, clientIdOf, scopedKey, readData } from './_shared.js';
import { MAX_LIBRARY, harvestSent, detectIntent, detectLanguage } from './_suggest-engine.js';

export async function readLibrary(kv, clientId) {
  const raw = await kv.get(scopedKey('replies', clientId), 'json');
  return (raw && Array.isArray(raw.replies)) ? raw : { replies: [] };
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export async function onRequestGet(context) {
  const { env } = context;
  const clientId = clientIdOf(context);
  try {
    const [lib, data] = await Promise.all([readLibrary(env.PULSE_KV, clientId), readData(env.PULSE_KV, clientId)]);
    return json({ replies: lib.replies, sent: harvestSent(data.messages) });
  } catch (err) { return json({ error: err.message }, 500); }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = clientIdOf(context);
  try {
    const b = await request.json();
    const text = String((b && b.text) || '').trim().slice(0, 3000);
    if (text.length < 5) return json({ error: 'Reply text is required' }, 400);
    const lib = await readLibrary(env.PULSE_KV, clientId);
    const now = new Date().toISOString();
    const existing = lib.replies.find((r) => norm(r.text) === norm(text));
    let entry;
    if (existing) {
      existing.uses = (existing.uses || 0) + 1;
      existing.lastUsedAt = now;
      if (b.context && !existing.context) existing.context = String(b.context).slice(0, 1000);
      entry = existing;
    } else {
      const context_ = String(b.context || '').slice(0, 1000);
      // Intent is only known when we know what the reply answered; a pasted reply with
      // no context stays general-purpose (null) and is matched on wording + language.
      const pseudo = context_ ? { snippet: context_, language: b.language, lastSender: 'them' } : null;
      entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text,
        context: context_,
        intent: b.intent || (pseudo ? detectIntent(pseudo) : null),
        language: (String(b.language || '').toLowerCase().startsWith('fr')) ? 'fr' : (b.language ? 'en' : detectLanguage({ snippet: text })),
        leadName: String(b.leadName || '').slice(0, 120),
        source: b.source === 'copied' ? 'copied' : 'manual',
        uses: b.source === 'copied' ? 1 : 0,
        createdAt: now,
        lastUsedAt: b.source === 'copied' ? now : null,
      };
      lib.replies.unshift(entry);
      if (lib.replies.length > MAX_LIBRARY) {
        // keep the most-used; among equals keep the newest
        lib.replies.sort((a, c) => (c.uses || 0) - (a.uses || 0) || String(c.createdAt).localeCompare(String(a.createdAt)));
        lib.replies = lib.replies.slice(0, MAX_LIBRARY);
      }
    }
    await env.PULSE_KV.put(scopedKey('replies', clientId), JSON.stringify(lib));
    return json({ ok: true, reply: entry, total: lib.replies.length });
  } catch (err) { return json({ error: err.message }, 500); }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const clientId = clientIdOf(context);
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return json({ error: 'id required' }, 400);
    const lib = await readLibrary(env.PULSE_KV, clientId);
    const before = lib.replies.length;
    lib.replies = lib.replies.filter((r) => r.id !== id);
    await env.PULSE_KV.put(scopedKey('replies', clientId), JSON.stringify(lib));
    return json({ ok: true, removed: before - lib.replies.length });
  } catch (err) { return json({ error: err.message }, 500); }
}
