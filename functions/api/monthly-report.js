// functions/api/monthly-report.js
// GET|POST /api/monthly-report — the MONTHLY report (v5.11.0), modelled on Linalysis's
// monthly report (gershonconsulting/linalysis worker/monthly-report-block.js).
//
// What one run sends, for the previous complete month:
//   1. To EVERY tenant (client), at the emails its users sign in with: that tenant's own
//      month — the full report in the email body AND the same report as a 2-page PDF.
//      A tenant only ever receives its own numbers (same contract as daily-report.js).
//   2. To Gershon (report@gershonconsulting.com, GC-prefixed sender): the all-clients
//      report — one table of every tenant — in the body, plus a 1-page PDF, plus every
//      client's PDF attached.
//
// Fired on the 1st of the month by .github/workflows/monthly-report.yml.
// Idempotent: each delivery writes report:monthly:<tenant>:<YYYY-MM> to KV once sent,
// so a re-run never mails anyone twice unless force=1.
//
// Auth: shared secret (DAILY_REPORT_SECRET, falling back to HEALTH_CHECK_SECRET), same
// as the other report endpoints. Listed in _middleware.js PUBLIC_PATHS for that reason.
//
// Params (query or JSON body):
//   secret  (required)
//   month   YYYY-MM   — report on this month instead of the previous one
//   dry     1|true    — build everything, send nothing; returns subjects + sizes
//   tenant  <id>      — only this tenant ('__default' = Gershon's own store); skips the
//                       all-clients email unless estate=1
//   to      email,…   — TEST: send every email to this address instead of the real
//                       recipients (and do not mark anything as sent)
//   force   1         — resend even if already sent for that month
//   tz      IANA zone — default America/New_York

import { json, readData } from './_shared.js';
import { latestExtVersion } from '../_ext-version.js';
import { resolveTenants } from './daily-report.js';
import { readMonthSnapshots } from '../_daily-snapshot.js';
import {
  DEFAULT_TZ, monthWindow, analyseMonth, analyseEstate,
  renderClientEmail, renderClientPdf, clientSubject, clientFilename,
  renderEstateEmail, renderEstatePdf, estateSubject, estateFilename,
} from '../_monthly-core.js';

export const APP_VERSION = '5.11.0';
const CONVENTION_TO = 'report@gershonconsulting.com';
const ESTATE_FROM = 'GC Pulse <pulse@gershon.ai>';   // internal report: GC prefix
const CLIENT_FROM = 'Pulse <pulse@gershon.ai>';      // client-facing: product brand

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';
const split = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

async function sendMail(env, { from, to, subject, html, attachments }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html, attachments }),
  });
  if (res.ok) return { sent: true };
  const err = await res.json().catch(() => ({}));
  return { sent: false, error: err.message || `HTTP ${res.status}` };
}

async function handle(request, env) {
  const url = new URL(request.url);
  let body = {};
  if (request.method === 'POST') body = await request.json().catch(() => ({}));
  const param = (k) => (body[k] != null ? body[k] : url.searchParams.get(k));

  const expected = env.DAILY_REPORT_SECRET || env.HEALTH_CHECK_SECRET;
  if (!expected) return json({ ok: false, error: 'not_configured', message: 'DAILY_REPORT_SECRET is not set on this environment.' }, 503);
  if ((param('secret') || '') !== expected) return json({ ok: false, error: 'unauthorized' }, 401);

  const month = param('month') || null;
  if (month && !/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, error: 'bad_month', message: 'month must be YYYY-MM' }, 400);
  const dry = truthy(param('dry'));
  const force = truthy(param('force'));
  const testTo = split(param('to'));
  const tenantParam = String(param('tenant') || '').trim() || null;
  const wantEstate = !tenantParam || truthy(param('estate'));
  const tz = param('tz') || env.REPORT_TZ || DEFAULT_TZ;

  if (!dry && !env.RESEND_API_KEY) return json({ ok: false, sent: false, error: 'no_resend_key' }, 500);

  const now = new Date();
  const win = monthWindow(now, tz, month);
  const latestExt = latestExtVersion(env);
  const generatedAt = 'Generated ' + now.toLocaleString('en-US', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  const tenants = await resolveTenants(env, tenantParam);
  if (!tenants.length) return json({ ok: false, error: 'no_tenants' }, 404);

  const rows = [];
  const results = [];
  for (const t of tenants) {
    const id = t.id || '__default';
    const client = { id, name: t.name, status: t.status || 'active', to: t.to || [] };
    const row = { tenant: id, name: t.name, to: client.to, sent: false, skipped: null, error: null };
    try {
      const data = await readData(env.PULSE_KV, t.id);
      const snapshots = await readMonthSnapshots(env.PULSE_KV, t.id, win);
      const r = analyseMonth(data, win, { now, latestExt, snapshots });
      const filename = clientFilename(r, client, APP_VERSION);
      const pdf = renderClientPdf(r, client, { filename });
      const b64 = pdf.base64();
      rows.push({ client, r, filename, b64 });
      Object.assign(row, { subject: clientSubject(r, client), filename, pdfKb: Math.round(b64.length * 0.75 / 1024),
        collected: r.collected, replies: r.fires, handled: r.handled, backlog: r.backlog });

      const sentKey = `report:monthly:${id}:${win.key}`;
      if (dry) { results.push(row); continue; }
      if (!client.to.length && !testTo.length) { row.skipped = 'no_recipient'; results.push(row); continue; }
      if (!force && !testTo.length && await env.PULSE_KV.get(sentKey)) { row.skipped = 'already_sent'; results.push(row); continue; }

      const res = await sendMail(env, {
        from: env.EMAIL_FROM || CLIENT_FROM,
        to: testTo.length ? testTo : client.to,
        subject: (testTo.length ? '[TEST] ' : '') + row.subject,
        html: renderClientEmail(r, client, { filename }),
        attachments: [{ filename, content: b64 }],
      });
      Object.assign(row, res);
      if (res.sent && !testTo.length) await env.PULSE_KV.put(sentKey, JSON.stringify({ sentAt: now.toISOString(), to: client.to }), { expirationTtl: 400 * 86400 });
    } catch (e) {
      row.error = e.message || String(e);
    }
    results.push(row);
  }

  let estate = null;
  if (wantEstate && rows.length) {
    const e = analyseEstate(rows.map((x) => ({ client: x.client, r: x.r })), win);
    const filename = estateFilename(e, APP_VERSION);
    const pdf = renderEstatePdf(e, { filename, generatedAt });
    const b64 = pdf.base64();
    const to = testTo.length ? testTo : split(env.MONTHLY_REPORT_EMAIL || env.STATUS_REPORT_EMAIL || CONVENTION_TO);
    estate = { subject: estateSubject(e), to, filename, pdfKb: Math.round(b64.length * 0.75 / 1024), attachments: rows.length + 1, sent: false };
    const sentKey = `report:monthly:estate:${win.key}`;
    if (!dry) {
      if (!force && !testTo.length && await env.PULSE_KV.get(sentKey)) estate.skipped = 'already_sent';
      else {
        const res = await sendMail(env, {
          from: env.STATUS_EMAIL_FROM || ESTATE_FROM,
          to,
          subject: (testTo.length ? '[TEST] ' : '') + estate.subject,
          html: renderEstateEmail(e, { filename }),
          attachments: [{ filename, content: b64 }, ...rows.map((x) => ({ filename: x.filename, content: x.b64 }))],
        });
        Object.assign(estate, res);
        if (res.sent && !testTo.length) await env.PULSE_KV.put(sentKey, JSON.stringify({ sentAt: now.toISOString(), to }), { expirationTtl: 400 * 86400 });
      }
    }
  }

  const failures = results.filter((r) => r.error).length + (estate && estate.error ? 1 : 0);
  return json({ ok: failures === 0, dry, month: win.key, range: win.range, version: APP_VERSION,
    tenants: results.length, sent: results.filter((r) => r.sent).length, failed: failures, results, estate },
  failures === 0 ? 200 : 502);
}

export const onRequestPost = ({ request, env }) => handle(request, env);
export const onRequestGet = ({ request, env }) => handle(request, env);
