// functions/api/matrix-stats.js
// POST /api/matrix-stats — read-only status for the weekly "Client Platform Matrix"
// email (Supabase edge function). Same contract on all Gershon apps:
//   in : {"secret":"...","people":[{"key":"<id>","company":"<name>","emails":["a@b.com"]}]}
//   out: {"ok":true,"platform":"pulse","results":[{"key":"<id>","ok":bool,"note":"<short>"}]}
// Auth: SHA-256 hex of `secret` must equal SECRET_HASH (plaintext secret is never committed —
// this repo is PUBLIC). Listed in ../_middleware.js PUBLIC_PATHS because it carries its own
// credential, and exempted from CORS in ./_middleware.js (server-to-server only).
//
// Matching (an email resolves to the Pulse store that person actually works in):
//   1. member of a registry client (KV `admin`)  -> that client's store `data:<clientId>`
//   2. on the ALLOWLIST env var                   -> Gershon's default store `data`
//   3. super-admin (ADMIN_EMAILS) or active CoHost with no tenant of their own
//                                                 -> "admin only" / "cohost only" (ok:false)
//   otherwise "no account". With several emails, the one with the most conversations wins.
// Note: "<red> red of <total>" when follow-ups are awaiting, else "<total> convos";
// "no data" for an account with an empty store; "suspended" for a suspended client.
// Read-only: this file only calls KV.get (via readAdminStore / readData).

import { readData } from './_shared.js';
import { readAdminStore, findCohostByEmail, isAdminEmail } from '../_admin.js';

const SECRET_HASH = '7031a38bde30c34db677585e85f696f51d78cc417e40d38572d20ebeb1c77569';
const MAX_PEOPLE = 500;
const MAX_EMAILS = 10;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function envList(value) {
  return String(value || '').toLowerCase().split(',').map(s => s.trim()).filter(s => s && s !== '*');
}

function countStore(data) {
  const msgs = Array.isArray(data && data.messages) ? data.messages : [];
  const red = msgs.filter(m => m && m.status === 'Red' && !m.done).length;
  return { total: msgs.length, red };
}

// Resolve one email to { rank, ok, note, total }. Higher rank = more informative.
async function resolveEmail(env, store, allow, cache, email) {
  let tenant; // undefined = no store; null = default store; string = client id
  let suspended = false;
  const client = (store.clients || []).find(c => (c.users || []).some(u => u.email === email));
  if (client) {
    tenant = client.id;
    suspended = client.status === 'suspended';
  } else if (allow.includes(email)) {
    tenant = null;
  }

  if (tenant !== undefined) {
    const k = tenant || '__default';
    if (!cache.has(k)) cache.set(k, countStore(await readData(env.PULSE_KV, tenant)));
    const { total, red } = cache.get(k);
    if (suspended) return { rank: 2, ok: false, note: 'suspended', total };
    if (!total) return { rank: 2, ok: false, note: 'no data', total: 0 };
    return { rank: 3, ok: true, note: red ? `${red} red of ${total}` : `${total} convos`, total };
  }
  if (isAdminEmail(email, env)) return { rank: 1, ok: false, note: 'admin only', total: 0 };
  if (findCohostByEmail(store, email)) return { rank: 1, ok: false, note: 'cohost only', total: 0 };
  return { rank: 0, ok: false, note: 'no account', total: 0 };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false }, 401); }
  const secret = body && typeof body.secret === 'string' ? body.secret : '';
  if (!secret || (await sha256Hex(secret)) !== SECRET_HASH) return json({ ok: false }, 401);

  if (!env.PULSE_KV) return json({ ok: false, error: 'storage_unavailable' }, 503);

  const store = await readAdminStore(env);
  const allow = envList(env.ALLOWLIST);
  const cache = new Map();

  const people = Array.isArray(body.people) ? body.people.slice(0, MAX_PEOPLE) : [];
  const results = [];
  for (const p of people) {
    const key = p && p.key != null ? String(p.key) : null;
    const emails = [...new Set((Array.isArray(p && p.emails) ? p.emails : [])
      .map(e => String(e || '').trim().toLowerCase())
      .filter(e => e.includes('@')))].slice(0, MAX_EMAILS);
    if (!emails.length) { results.push({ key, ok: false, note: 'no email' }); continue; }
    try {
      let best = null;
      for (const email of emails) {
        const r = await resolveEmail(env, store, allow, cache, email);
        if (!best || r.rank > best.rank || (r.rank === best.rank && r.total > best.total)) best = r;
      }
      results.push({ key, ok: best.ok, note: best.note });
    } catch (e) {
      results.push({ key, ok: false, note: 'lookup error' });
    }
  }
  return json({ ok: true, platform: 'pulse', results });
}

export async function onRequest() {
  return json({ ok: false }, 405);
}
