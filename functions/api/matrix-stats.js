// functions/api/matrix-stats.js — POST /api/matrix-stats
// Read-only feed for the weekly "Client Platform Matrix" email (Supabase edge function
// `client-platform-matrix` in task.gershoncrm.com). Same contract as social.gershon.ai,
// linalysis.net and nexashare.com:
//
//   Request : {"secret":"…","people":[{"key":"…","company":"…","emails":["a@b.com"]}]}
//   Auth    : SHA-256 hex of `secret` must equal MATRIX_SECRET_SHA256. Only the hash lives
//             here (plain value = cc_health_config.matrix_stats_secret in the task project),
//             so NO new Pages secret is needed. Mismatch -> 401 {"ok":false}.
//             The path is listed in PUBLIC_PATHS (functions/_middleware.js) because it
//             carries its own secret, exactly like /api/daily-report.
//   Response: {"ok":true,"platform":"pulse","as_of":"<ISO>","results":[{"key","ok","note"}]}
//
// Matching: person email -> registry client (KV `admin`, users[].email). A super-admin
// email with no client of its own maps to the default store and is reported "admin only".
// ok   = client not suspended / trial not lapsed AND the collector synced within 14 days.
// note = "N convos · M red" or "no sync 14d" / "suspended" / "not on Pulse".
// Reads KV only — never writes.

import { readAdminStore, findClientByEmail, isAdminEmail, isTrialExpired } from '../_admin.js';
import { json, readData } from './_shared.js';

const MATRIX_SECRET_SHA256 = '7031a38bde30c34db677585e85f696f51d78cc417e40d38572d20ebeb1c77569';
const DAY = 86400000;

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function summarize(data) {
  const scans = Array.isArray(data && data.scans) ? data.scans : [];
  const msgs = Array.isArray(data && data.messages) ? data.messages : [];
  const last = scans.reduce((m, s) => Math.max(m, Date.parse(s && s.timestamp) || 0), 0);
  const red = msgs.filter((m) => m && m.status === 'Red' && !m.done).length;
  return { last, total: msgs.length, red };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false }, 401); }
  const secret = typeof (body && body.secret) === 'string' ? body.secret : '';
  if (!secret || (await sha256Hex(secret)) !== MATRIX_SECRET_SHA256) return json({ ok: false }, 401);

  try {
    const people = Array.isArray(body.people) ? body.people.slice(0, 200) : [];
    const store = await readAdminStore(env);
    const cache = new Map();
    const load = async (id) => {
      const k = id || '';
      if (!cache.has(k)) cache.set(k, summarize(await readData(env.PULSE_KV, id || null)));
      return cache.get(k);
    };
    const now = Date.now();
    const results = [];
    for (const p of people) {
      const key = String((p && p.key) ?? '');
      const emails = (Array.isArray(p && p.emails) ? p.emails : []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
      const client = emails.map((e) => findClientByEmail(store, e)).find(Boolean);
      if (!client) {
        if (emails.some((e) => isAdminEmail(e, env))) {
          const s = await load(null);
          results.push({ key, ok: false, note: `admin only · ${s.total} convos` });
        } else {
          results.push({ key, ok: false, note: 'not on Pulse' });
        }
        continue;
      }
      if (client.status === 'suspended' || isTrialExpired(client)) {
        results.push({ key, ok: false, note: client.status === 'suspended' ? 'suspended' : 'trial lapsed' });
        continue;
      }
      const s = await load(client.id);
      const idle = s.last ? Math.floor((now - s.last) / DAY) : null;
      const fresh = idle !== null && idle <= 14;
      results.push({
        key,
        ok: fresh,
        note: fresh ? `${s.total} convos · ${s.red} red` + (idle > 2 ? ` · synced ${idle}d ago` : '') : (idle === null ? 'never synced' : `no sync ${idle}d`),
      });
    }
    return json({ ok: true, platform: 'pulse', as_of: new Date().toISOString(), results });
  } catch (e) {
    return json({ ok: false }, 500);
  }
}
