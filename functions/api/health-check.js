// functions/api/health-check.js
// GET|POST /api/health-check — silent dead-man's-switch for the Pulse collector.
//
// Ported from the Radar runbook (gershonconsulting/radar → HEALTH-CHECK-ALERTS.md).
//
// WHY THIS EXISTS ALONGSIDE /api/daily-report: the daily report is a scheduled
// narrative — it always sends, so a missing daily email is itself ambiguous (did the
// cron fail, or did Resend?). This endpoint is the independent second line: it stays
// SILENT while healthy and only speaks when collection has genuinely stopped, on its
// own schedule and its own throttle. Two independent paths means a single broken
// GitHub Action cannot make a dead collector look alive.
//
// WHY NOT chrome.alarms: the standing rule is "use chrome.alarms, not a scheduler,
// for anything the extension can do itself." A watchdog is the exception — a dead
// extension cannot report its own death. This must live server-side.
//
// WHY AN EXTERNAL CRON: Cloudflare Pages has no cron triggers (Workers only), so a
// GitHub Actions schedule POSTs here daily.
//
// Auth: shared secret in env.HEALTH_CHECK_SECRET. The repo is PUBLIC — the value
// lives only in env vars, never in source. Listed in _middleware.js PUBLIC_PATHS.

import { json, readData } from './_shared.js';

const STALE_HOURS = 36;     // longer than the extension's 24h auto-sync cycle + slack
const REALERT_HOURS = 20;   // don't re-nag more than about once a day
const THROTTLE_KEY = 'health_alert_at';  // its OWN key — never the `data` blob, which
                                         // the collector rewrites wholesale on sync

async function handle(request, env) {
  const url = new URL(request.url);
  let body = {};
  if (request.method === 'POST') body = await request.json().catch(() => ({}));

  if (!env.HEALTH_CHECK_SECRET) {
    return json({ ok: false, error: 'not_configured', message: 'HEALTH_CHECK_SECRET is not set.' }, 503);
  }
  const supplied = body.secret || url.searchParams.get('secret') || '';
  if (supplied !== env.HEALTH_CHECK_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const staleHours = Number(env.HEALTH_STALE_HOURS) > 0 ? Number(env.HEALTH_STALE_HOURS) : STALE_HOURS;
  const realertHours = Number(env.HEALTH_REALERT_HOURS) > 0 ? Number(env.HEALTH_REALERT_HOURS) : REALERT_HOURS;

  const data = await readData(env.PULSE_KV);
  const scans = Array.isArray(data.scans) ? data.scans : [];

  // Set-up guard: with no scan ever recorded, Pulse was never running in the first
  // place. Alerting here would just spam a system that has not been switched on yet.
  if (scans.length === 0) {
    return json({ ok: true, status: 'not-configured', reason: 'no scans recorded yet', sent: false });
  }

  const last = scans[0];
  const lastMs = Date.parse(last.timestamp);
  const ageHours = (Date.now() - lastMs) / 3600000;

  if (!(ageHours > staleHours)) {
    return json({ ok: true, status: 'healthy', ageHours: Math.round(ageHours * 10) / 10, sent: false });
  }

  // Stale. Throttle before sending.
  const lastAlert = await env.PULSE_KV.get(THROTTLE_KEY);
  if (lastAlert) {
    const sinceAlert = (Date.now() - Date.parse(lastAlert)) / 3600000;
    if (sinceAlert < realertHours) {
      return json({
        ok: true, status: 'stale', throttled: true, sent: false,
        ageHours: Math.round(ageHours * 10) / 10,
        nextAlertInHours: Math.round((realertHours - sinceAlert) * 10) / 10,
      });
    }
  }

  const to = (env.ALERT_EMAIL || env.REPORT_EMAIL || 'report@gershonconsulting.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const lastPretty = new Date(lastMs).toLocaleString('en-US', {
    timeZone: env.REPORT_TZ || 'America/New_York', dateStyle: 'full', timeStyle: 'short',
  });
  const hours = Math.floor(ageHours);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#7f1d1d;color:#fff;padding:24px;border-radius:12px 12px 0 0;">
      <div style="font-size:13px;letter-spacing:.6px;text-transform:uppercase;opacity:.8;font-weight:700;">Pulse alert</div>
      <h1 style="margin:6px 0 0;font-size:22px;">Pulse has stopped collecting</h1>
    </div>
    <div style="background:#fff;padding:22px;border-radius:0 0 12px 12px;">
      <p style="margin:0 0 14px;font-size:15px;color:#111827;line-height:1.6;">
        No LinkedIn sync has reached Pulse in <strong>${hours} hours</strong>.
        The last successful sync was <strong>${lastPretty}</strong>
        (${(last.count || 0)} conversations from ${last.source === 'sales-navigator' ? 'Sales Navigator' : 'LinkedIn Messaging'}).
      </p>
      <p style="margin:0 0 8px;font-size:14px;color:#374151;font-weight:600;">Most likely causes</p>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:14px;color:#374151;line-height:1.7;">
        <li>Chrome has not been open on the collecting machine</li>
        <li>The Pulse extension was disabled, removed, or crashed</li>
        <li>You are signed out of LinkedIn, or LinkedIn is asking for a checkpoint</li>
      </ul>
      <p style="margin:0 0 18px;font-size:14px;color:#374151;line-height:1.6;">
        Open Chrome, sign in to LinkedIn, then run <strong>Sync Now</strong> from the extension
        or from the dashboard&rsquo;s Extension page. This alert repeats at most every ${realertHours} hours.
      </p>
      <a href="https://pulse.gershoncrm.com/app.html" style="display:inline-block;background:#0077b5;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:8px;">Open Pulse Dashboard</a>
    </div>
  </div>
</body></html>`;

  if (!env.RESEND_API_KEY) {
    return json({ ok: false, status: 'stale', sent: false, error: 'no_resend_key', ageHours: Math.round(ageHours * 10) / 10 }, 500);
  }

  let sent = false;
  let error = null;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'Pulse <pulse@gershon.ai>',
        to,
        subject: `⚠ Pulse has stopped collecting — no sync in ${hours}h`,
        html,
        text: `Pulse has stopped collecting.\n\nNo sync in ${hours} hours. Last successful sync: ${lastPretty}.\n\nCheck: Chrome open? Extension enabled? Signed in to LinkedIn?\nThen run Sync Now.\n\nhttps://pulse.gershoncrm.com/app.html`,
      }),
    });
    if (res.ok) {
      sent = true;
      await env.PULSE_KV.put(THROTTLE_KEY, new Date().toISOString());
    } else {
      const err = await res.json().catch(() => ({}));
      error = err.message || `HTTP ${res.status}`;
    }
  } catch (e) {
    error = e.message;
  }

  return json({ ok: sent, status: 'stale', sent, error, ageHours: Math.round(ageHours * 10) / 10, to }, sent ? 200 : 502);
}

export const onRequestPost = ({ request, env }) => handle(request, env);
export const onRequestGet = ({ request, env }) => handle(request, env);
