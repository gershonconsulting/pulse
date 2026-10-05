// functions/api/intelligence.js — Gershon "Intelligence" menu, server side (v1.0, 2026-10-05)
//
// One endpoint, three modes, all on Cloudflare Workers AI (env.AI binding).
// No Anthropic / OpenAI key anywhere — the model runs inside our own Cloudflare account.
//
//   POST /api/intelligence  { mode: 'analyze' | 'suggest' | 'chat', app, data, messages? }
//   GET  /api/intelligence  -> { ok, ai }   (health: is the AI binding attached?)
//
// Auth: inherits the app's own middleware (this file sits under /api/*), so only
// signed-in users of the app can reach it.
// Portable: copy this file into any Cloudflare Pages app's functions/api/ folder.

const MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];
const MAX_DATA = 14000;      // chars of app data sent to the model
const MAX_TURNS = 12;        // chat history kept

const BASE = (app) =>
  `You are the Intelligence assistant inside ${app || 'a Gershon.AI app'}, a business tool run by ` +
  'Gershon Consulting (US market entry, LinkedIn outbound, lead generation). ' +
  'You only know what is in the DATA block below — never invent numbers, names or facts. ' +
  'If the data is thin, say so plainly. Write for a busy founder: short, concrete, no filler. ' +
  'Use short markdown: "## " headings, "- " bullets, **bold** for key figures.';

const TASK = {
  analyze:
    'Produce an ANALYSIS of the data. Sections: "## Snapshot" (3-5 bullets with the key figures), ' +
    '"## What stands out" (patterns, trends, concentrations, outliers), "## Risks" (what looks wrong, stale or at risk). ' +
    'Max ~250 words.',
  suggest:
    'Produce IMPROVEMENT SUGGESTIONS based on the data. Give the 5 highest-impact actions, ranked. ' +
    'For each: "- **Action** — why (cite the figure from the data) — expected effect". ' +
    'Then "## Quick win today" with one action that takes under 15 minutes. Max ~300 words.',
  chat:
    'Answer the user\'s question about the data and possible improvements. Be direct; cite figures from the data. ' +
    'If the question cannot be answered from the data, say what is missing.',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function run(env, messages, maxTokens) {
  let lastErr = 'no model answered';
  for (const model of MODELS) {
    try {
      const r = await env.AI.run(model, { messages, max_tokens: maxTokens, temperature: 0.3 });
      const text = r && (typeof r.response === 'string' ? r.response : (r.result && r.result.response) || '');
      if (text && text.trim()) return { text: text.trim(), model };
      lastErr = 'empty answer from ' + model;
    } catch (e) { lastErr = String(e && e.message || e); }
  }
  throw new Error(lastErr);
}

export async function onRequestGet({ env }) {
  return json({ ok: true, ai: !!env.AI, models: MODELS });
}

export async function onRequestPost({ request, env }) {
  if (!env.AI) return json({ error: 'Cloudflare Workers AI binding "AI" is not attached to this project.' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const mode = TASK[body.mode] ? body.mode : 'analyze';
  const data = String(typeof body.data === 'string' ? body.data : JSON.stringify(body.data || '')).slice(0, MAX_DATA);
  const system = BASE(body.app) + '\n\n' + TASK[mode] + '\n\nDATA (captured ' + new Date().toISOString() + '):\n"""\n' + (data || '(no data captured)') + '\n"""';

  const messages = [{ role: 'system', content: system }];
  if (mode === 'chat') {
    const turns = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-MAX_TURNS)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!turns.length || turns[turns.length - 1].role !== 'user') return json({ error: 'Chat needs a user message' }, 400);
    messages.push(...turns);
  } else {
    messages.push({ role: 'user', content: mode === 'analyze' ? 'Analyse this data.' : 'What should we improve?' });
  }

  try {
    const out = await run(env, messages, mode === 'chat' ? 700 : 900);
    return json({ mode, text: out.text, model: out.model, engine: 'cloudflare-workers-ai' });
  } catch (e) {
    return json({ error: 'AI unavailable: ' + e.message }, 502);
  }
}
