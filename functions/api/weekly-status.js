// functions/api/weekly-status.js
// GET|POST /api/weekly-status — the INTERNAL weekly status report.
//
// WHERE THIS SITS AMONG ITS SIBLINGS (five paths now — do not conflate them):
//   /api/report            — pipeline snapshot, fired by the extension after every sync.
//   /api/health-check      — silent dead-man's-switch, emails only when collection stops.
//   /api/daily-report      — the CLIENT-FACING digest: one email per tenant, to that
//                            tenant's own users, about that tenant's own numbers.
//   /api/daily-report?period=week — the same digest, weekly edition, still per tenant.
//   /api/weekly-status     — THIS FILE. ONE email, to Gershon Consulting only, covering
//                            EVERY user of the platform in a single table. Nobody outside
//                            report@gershonconsulting.com ever receives it.
//
// Why it is its own endpoint rather than a flag on the digest: the digest's contract is
// "a tenant only ever sees its own data". This report's contract is the exact opposite —
// it is a cross-tenant operator view. Keeping them apart means no future edit to the
// per-client mail can leak one client's numbers into another's, and a broken internal
// report cannot stop clients receiving theirs.
//
// The per-USER dedicated weekly report is the planned follow-up; the per-tenant metrics
// this file already computes are the same ones it will use.
//
// Auth: shared secret (DAILY_REPORT_SECRET, falling back to HEALTH_CHECK_SECRET) — the
// repo is PUBLIC, so the value lives only in env vars, never in source. Listed in
// _middleware.js PUBLIC_PATHS because it carries its own credential.
//
// Query/body params:
//   secret  (required) — shared secret
//   date    YYYY-MM-DD — last day of the 7-day window (default: yesterday, local)
//   dry     1|true     — build the report and return it, but send no email
//   tz      IANA zone  — override the report timezone (default America/New_York)
//   to      email,…    — override the recipient (testing); default is the convention address

import { json, readData } from './_shared.js';
import { latestExtVersion } from '../_ext-version.js';
import { readAdminStore } from '../_admin.js';
import { buildReport } from './daily-report.js';

const DEFAULT_TZ = 'America/New_York';

// The reporting convention: every Gershon platform report lands in one inbox, and the
// from-NAME carries the GC prefix so an internal report is recognisable at a glance.
// Client-facing Pulse mail keeps the plain "Pulse" name — that rule is the digest's, not
// this file's.
const CONVENTION_TO = 'report@gershonconsulting.com';
const STATUS_FROM = 'GC Pulse <pulse@gershon.ai>';

const STALE_HOURS = 36;

// ---------------------------------------------------------------------------
// Small helpers (kept local — daily-report.js does not export its formatters)
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ymdMidday(ymd, tz) {
  // Noon UTC on the given calendar day is safely inside that day in every zone we use,
  // which is all this needs for a human-readable label.
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function fmtDay(ymd, tz, opts) {
  return ymdMidday(ymd, tz).toLocaleDateString('en-US', {
    timeZone: 'UTC', ...(opts || { month: 'short', day: 'numeric' }),
  });
}

function fmtWhen(iso, tz) {
  if (!iso) return 'never';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return 'never';
  return t.toLocaleString('en-US', {
    timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function rangeLabel(startYmd, endYmd, tz) {
  const year = fmtDay(endYmd, tz, { year: 'numeric' });
  const sameMonth = String(startYmd).slice(0, 7) === String(endYmd).slice(0, 7);
  const start = fmtDay(startYmd, tz);
  const end = sameMonth ? fmtDay(endYmd, tz, { day: 'numeric' }) : fmtDay(endYmd, tz);
  return `${start}–${end}, ${year}`;
}

const num = (n) => (n === null || n === undefined ? '&mdash;' : String(n));

// ---------------------------------------------------------------------------
// Who is covered
//
// Unlike the client digest, this report lists EVERY tenant including suspended ones —
// a suspended client is exactly the kind of thing an internal status report exists to
// surface. The default tenant (KV key `data`, Gershon's own store) always leads.
// ---------------------------------------------------------------------------

export async function statusTenants(env) {
  const list = [{
    id: null,
    name: env.DEFAULT_TENANT_NAME || 'Gershon Consulting',
    status: 'internal',
    plan: 'internal',
    users: String(env.ALLOWLIST || '').split(',').map((s) => s.trim()).filter((s) => s && s !== '*'),
    createdAt: null,
    trialEndsAt: null,
  }];

  let store = null;
  try { store = await readAdminStore(env); } catch (e) { store = null; }

  for (const c of (store && store.clients) || []) {
    list.push({
      id: c.id,
      name: c.name || c.id,
      status: c.status || 'trial',
      plan: c.plan || '',
      users: (c.users || []).map((u) => u && u.email).filter(Boolean),
      createdAt: c.createdAt || null,
      trialEndsAt: c.trialEndsAt || null,
    });
  }
  return list;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function summarise(tenant, report, now) {
  const w = report.week;
  const hrs = report.hoursSinceLastScan;

  return {
    id: tenant.id || '__default',
    name: tenant.name,
    status: tenant.status,
    plan: tenant.plan,
    seats: tenant.users.length,
    users: tenant.users,

    // The week, as the client's own weekly digest measures it — same function, same
    // definitions, so this table can never disagree with the mail a client received.
    arrivals: w.arrivals,
    newFires: w.newFires,          // replies received (Red arrivals)
    handled: w.handled,            // moved off Red — someone answered
    closed: w.closed,
    collectedDays: w.collectedDays,
    fullDays: w.fullDays,
    backlogDelta: w.backlogDelta,
    weekVerdict: w.verdict.headline.replace(/&mdash;/g, '—'),

    // Live position
    awaiting: report.standing.followUpNeeded,
    tracked: report.standing.totalTracked,

    lastScanAt: report.lastScan ? report.lastScan.timestamp : null,
    hoursSinceLastScan: hrs === null ? null : Math.floor(hrs),
    extInstalled: report.extension.installed,
    extOutdated: !!report.extension.outdated,

    bestCampaign: report.campaigns.best
      ? { name: report.campaigns.best.name, rate: report.campaigns.best.responseRate,
          replied: report.campaigns.best.replied, total: report.campaigns.best.total }
      : null,
    campaigns: report.campaigns.all.map((c) => ({
      name: c.name, total: c.total, replied: c.replied, responseRate: c.responseRate,
      ranked: c.ranked, repliesThisWeek: c.repliesThisWeek, liveRed: c.liveRed,
    })),

    silent: w.collectedDays === 0,
    stale: hrs !== null && hrs > STALE_HOURS,
    never: hrs === null,
    suspended: tenant.status === 'suspended',
    noRecipient: tenant.users.length === 0,
    criticalAlerts: report.alerts.filter((a) => a.level === 'critical').map((a) => a.title),
  };
}

export function buildStatus(rows, meta) {
  const live = rows.filter((r) => !r.suspended);

  const sum = (k) => live.reduce((n, r) => n + (r[k] || 0), 0);
  const totals = {
    tenants: rows.length,
    active: live.length,
    suspended: rows.filter((r) => r.suspended).length,
    seats: sum('seats'),
    tracked: sum('tracked'),
    arrivals: sum('arrivals'),
    newFires: sum('newFires'),
    handled: sum('handled'),
    closed: sum('closed'),
    awaiting: sum('awaiting'),
  };

  const silent = live.filter((r) => r.silent);
  const stale = live.filter((r) => r.stale && !r.silent);
  const outdated = live.filter((r) => r.extOutdated);
  const noRecipient = live.filter((r) => r.noRecipient);
  const partial = live.filter((r) => !r.silent && r.collectedDays < 7);

  // Cross-tenant campaign leaderboard. The campaign NAME is a client's own code, so two
  // clients can legitimately run a "BD18" — they are never merged, the client is carried
  // alongside the code.
  const board = [];
  for (const r of live) {
    for (const c of r.campaigns) {
      board.push({ client: r.name, ...c });
    }
  }
  board.sort((a, b) =>
    (b.repliesThisWeek - a.repliesThisWeek) ||
    (b.responseRate - a.responseRate) ||
    (b.total - a.total));

  return {
    generatedAt: meta.now.toISOString(),
    tz: meta.tz,
    startYmd: meta.startYmd,
    endYmd: meta.endYmd,
    // "Sep 11–17, 2026" within one month, "Aug 28–Sep 3, 2026" across two — the
    // convention wants the platform name and the date range, read at a glance.
    rangeLabel: rangeLabel(meta.startYmd, meta.endYmd, meta.tz),
    totals,
    rows,
    attention: { silent, stale, outdated, noRecipient, partial },
    board: board.slice(0, 12),
    // One honest headline for the whole platform.
    verdict: silent.length
      ? { tone: 'bad', text: `${silent.length} of ${live.length} account${live.length === 1 ? '' : 's'} collected nothing this week` }
      : totals.newFires === 0
        ? { tone: 'warn', text: 'No replies came in across any account this week' }
        : { tone: 'good', text: `${totals.newFires} repl${totals.newFires === 1 ? 'y' : 'ies'} in, ${totals.handled} handled across ${live.length} account${live.length === 1 ? '' : 's'}` },
  };
}

export function statusSubject(s) {
  const base = `Pulse Weekly Status — ${s.rangeLabel}`;
  const tail = `${s.totals.active} account${s.totals.active === 1 ? '' : 's'} · ${s.totals.newFires} replies · ${s.totals.awaiting} awaiting`;
  if (s.attention.silent.length) return `⚠ ${s.attention.silent.length} not collecting — ${base} — ${tail}`;
  if (s.attention.stale.length) return `⚠ ${base} — ${tail}`;
  return `${base} — ${tail}`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const TONE = {
  bad: { bg: '#fef2f2', fg: '#991b1b' },
  warn: { bg: '#fffbeb', fg: '#92400e' },
  good: { bg: '#f0fdf4', fg: '#166534' },
  neutral: { bg: '#f3f4f6', fg: '#374151' },
};

function kpi(label, value, note, color) {
  return `<td style="padding:0 6px;width:25%;vertical-align:top;">
      <div style="background:#f8f9fa;border-radius:8px;padding:12px 10px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:${color || '#111827'};line-height:1.1;">${value}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.5px;">${esc(label)}</div>
        ${note ? `<div style="font-size:11px;color:#9ca3af;margin-top:3px;">${note}</div>` : ''}
      </div>
    </td>`;
}

function clientRows(s) {
  return s.rows.map((r) => {
    const flag = r.suspended ? '<span style="color:#9ca3af;font-size:11px;"> suspended</span>'
      : r.silent ? '<span style="color:#dc2626;font-size:11px;"> not collecting</span>'
      : r.stale ? '<span style="color:#d97706;font-size:11px;"> stale</span>' : '';
    const dim = r.suspended ? ' style="opacity:.5;"' : '';
    const days = r.collectedDays + '/7';
    return `<tr${dim}>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#111827;">
        <strong>${esc(r.name)}</strong>${flag}
        <div style="font-size:11px;color:#9ca3af;margin-top:2px;">${r.seats} user${r.seats === 1 ? '' : 's'}${r.plan ? ' · ' + esc(r.plan) : ''}</div>
      </td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:${r.silent ? '#dc2626' : '#374151'};">${days}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#374151;">${num(r.arrivals)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;font-weight:700;text-align:right;color:#2563eb;">${num(r.newFires)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#16a34a;">${num(r.handled)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;font-weight:700;text-align:right;color:${r.awaiting > 0 ? '#dc2626' : '#9ca3af'};">${num(r.awaiting)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#374151;">${num(r.tracked)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;text-align:right;color:#9ca3af;white-space:nowrap;">${esc(fmtWhen(r.lastScanAt, s.tz))}</td>
    </tr>`;
  }).join('');
}

export function renderStatusEmail(s) {
  const v = TONE[s.verdict.tone] || TONE.neutral;

  const attentionItems = [];
  for (const r of s.attention.silent) {
    attentionItems.push(`<strong>${esc(r.name)}</strong> collected nothing in 7 days${r.lastScanAt ? ` — last sync ${esc(fmtWhen(r.lastScanAt, s.tz))}` : ' — no sync has ever been recorded'}.`);
  }
  for (const r of s.attention.stale) {
    attentionItems.push(`<strong>${esc(r.name)}</strong> has not synced for ${r.hoursSinceLastScan}h.`);
  }
  for (const r of s.attention.outdated) {
    attentionItems.push(`<strong>${esc(r.name)}</strong> is on extension v${esc(r.extInstalled)} — v${esc(s.latestExt || '')} is current.`);
  }
  for (const r of s.attention.noRecipient) {
    attentionItems.push(`<strong>${esc(r.name)}</strong> has no registered user, so its own weekly digest cannot be delivered.`);
  }
  for (const r of s.attention.partial) {
    attentionItems.push(`<strong>${esc(r.name)}</strong> collected only ${r.collectedDays} of 7 days — its counts undercount the week.`);
  }

  const boardRows = s.board.map((c) => `<tr${c.ranked ? '' : ' style="opacity:.55;"'}>
      <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#6b7280;">${esc(c.client)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:700;color:#0077b5;">${esc(c.name)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#374151;">${c.total}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#374151;">${c.replied}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;font-weight:700;color:${c.ranked ? '#111827' : '#9ca3af'};">${c.ranked ? c.responseRate + '%' : '&mdash;'}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#2563eb;">${c.repliesThisWeek || '&mdash;'}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;">

    <div style="background:#0077b5;padding:22px 20px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:#cfe8f5;font-weight:700;">Gershon Consulting &middot; Internal</div>
      <h1 style="margin:4px 0 0;font-size:21px;color:#ffffff;font-weight:700;">Pulse Weekly Status &mdash; all accounts</h1>
      <div style="margin-top:4px;font-size:13px;color:#cfe8f5;">${esc(s.rangeLabel)} &middot; ${s.totals.active} active account${s.totals.active === 1 ? '' : 's'}, ${s.totals.seats} user${s.totals.seats === 1 ? '' : 's'}</div>
    </div>

    <div style="background:${v.bg};padding:14px 20px;border-bottom:1px solid #e5e7eb;">
      <div style="font-size:16px;font-weight:700;color:${v.fg};line-height:1.35;">${esc(s.verdict.text)}</div>
    </div>

    <div style="background:#ffffff;padding:16px 14px;border-bottom:1px solid #e5e7eb;">
      <table width="100%" style="border-collapse:separate;border-spacing:0;"><tr>
        ${kpi('Replies in', s.totals.newFires, 'this week', '#2563eb')}
        ${kpi('Handled', s.totals.handled, 'moved off Red', '#16a34a')}
        ${kpi('Awaiting now', s.totals.awaiting, 'live backlog', s.totals.awaiting > 0 ? '#dc2626' : '#9ca3af')}
        ${kpi('New conversations', s.totals.arrivals, 'first seen', '#111827')}
      </tr></table>
    </div>

    <div style="background:#ffffff;padding:18px 20px;border-bottom:1px solid #e5e7eb;">
      <h2 style="margin:0 0 10px;font-size:15px;font-weight:600;color:#374151;">Every account, this week</h2>
      <table width="100%" style="border-collapse:collapse;">
        <tr style="background:#f8f9fa;">
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;">Account</th>
          <th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Days</th>
          <th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">New</th>
          <th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Replies</th>
          <th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Handled</th>
          <th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Awaiting</th>
          <th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Tracked</th>
          <th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Last sync</th>
        </tr>
        ${clientRows(s)}
        <tr style="background:#f8f9fa;">
          <td style="padding:8px 10px;font-size:13px;font-weight:700;color:#111827;">All accounts</td>
          <td style="padding:8px 10px;"></td>
          <td style="padding:8px 10px;font-size:13px;font-weight:700;text-align:right;color:#111827;">${s.totals.arrivals}</td>
          <td style="padding:8px 10px;font-size:13px;font-weight:700;text-align:right;color:#2563eb;">${s.totals.newFires}</td>
          <td style="padding:8px 10px;font-size:13px;font-weight:700;text-align:right;color:#16a34a;">${s.totals.handled}</td>
          <td style="padding:8px 10px;font-size:13px;font-weight:700;text-align:right;color:#dc2626;">${s.totals.awaiting}</td>
          <td style="padding:8px 10px;font-size:13px;font-weight:700;text-align:right;color:#111827;">${s.totals.tracked}</td>
          <td style="padding:8px 10px;"></td>
        </tr>
      </table>
      <p style="margin:10px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;">
        <strong>Replies</strong> = conversations that turned Red this week (someone answered us).
        <strong>Handled</strong> = moved off Red — we answered them.
        <strong>Awaiting</strong> is the live backlog right now, not a weekly figure.
        <strong>Days</strong> is how many of the 7 days recorded a sync at all; anything under 7/7 undercounts the row.
      </p>
    </div>

    ${attentionItems.length ? `<div style="background:#ffffff;padding:18px 20px;border-bottom:1px solid #e5e7eb;">
      <h2 style="margin:0 0 10px;font-size:15px;font-weight:600;color:#991b1b;">Needs attention</h2>
      <ul style="margin:0;padding-left:18px;font-size:13px;color:#374151;line-height:1.7;">
        ${attentionItems.map((t) => `<li>${t}</li>`).join('')}
      </ul>
    </div>` : `<div style="background:#ffffff;padding:16px 20px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#166534;">
      Every account collected all 7 days on a current extension. Nothing needs attention.
    </div>`}

    ${s.board.length ? `<div style="background:#ffffff;padding:18px 20px;border-bottom:1px solid #e5e7eb;">
      <h2 style="margin:0 0 10px;font-size:15px;font-weight:600;color:#374151;">Campaigns across all accounts</h2>
      <table width="100%" style="border-collapse:collapse;">
        <tr style="background:#f8f9fa;">
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;">Account</th>
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;">Campaign</th>
          <th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Contacts</th>
          <th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Replied</th>
          <th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Rate</th>
          <th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">New 7d</th>
        </tr>${boardRows}
      </table>
      <p style="margin:10px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;">Ordered by new replies this week. Campaigns under 5 contacts are listed but not ranked — one reply swings a small rate 20 points.</p>
    </div>` : ''}

    <div style="background:#f8f9fa;padding:16px 20px;text-align:center;">
      <a href="https://pulse.gershoncrm.com/admin.html" style="display:inline-block;background:#0077b5;color:#ffffff;text-decoration:none;padding:9px 18px;border-radius:6px;font-size:13px;font-weight:600;">Open the Pulse console</a>
      <div style="margin-top:10px;font-size:11px;color:#9ca3af;line-height:1.6;">
        Generated ${esc(fmtWhen(s.generatedAt, s.tz))} (${esc(s.tz)}) by pulse.gershoncrm.com &middot; internal report, not sent to any client.
      </div>
    </div>

  </div></body></html>`;
}

export function renderStatusText(s) {
  const L = [];
  L.push(`PULSE WEEKLY STATUS — ALL ACCOUNTS`, s.rangeLabel, '', s.verdict.text, '');
  L.push(`Replies in ${s.totals.newFires} · Handled ${s.totals.handled} · Awaiting now ${s.totals.awaiting} · New conversations ${s.totals.arrivals}`);
  L.push(`${s.totals.active} active account(s), ${s.totals.seats} user(s), ${s.totals.tracked} conversations tracked`, '');
  L.push('ACCOUNTS');
  for (const r of s.rows) {
    L.push(`  ${r.name}${r.suspended ? ' [suspended]' : r.silent ? ' [NOT COLLECTING]' : r.stale ? ' [stale]' : ''}: ` +
      `${r.collectedDays}/7 days · ${r.arrivals} new · ${r.newFires} replies · ${r.handled} handled · ${r.awaiting} awaiting · ${r.tracked} tracked · last sync ${fmtWhen(r.lastScanAt, s.tz)}`);
  }
  const att = [].concat(s.attention.silent, s.attention.stale, s.attention.outdated, s.attention.noRecipient, s.attention.partial);
  if (att.length) {
    L.push('', 'NEEDS ATTENTION');
    for (const r of s.attention.silent) L.push(`  ${r.name}: collected nothing in 7 days`);
    for (const r of s.attention.stale) L.push(`  ${r.name}: no sync for ${r.hoursSinceLastScan}h`);
    for (const r of s.attention.outdated) L.push(`  ${r.name}: extension v${r.extInstalled} is behind`);
    for (const r of s.attention.noRecipient) L.push(`  ${r.name}: no registered user — its own digest cannot be delivered`);
    for (const r of s.attention.partial) L.push(`  ${r.name}: only ${r.collectedDays}/7 days collected`);
  }
  if (s.board.length) {
    L.push('', 'CAMPAIGNS');
    for (const c of s.board) {
      L.push(`  ${c.client} · ${c.name}: ${c.total} contacts · ${c.replied} replied · ${c.ranked ? c.responseRate + '%' : 'not ranked'} · ${c.repliesThisWeek || 0} new this week`);
    }
  }
  L.push('', 'https://pulse.gershoncrm.com/admin.html');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function handle(request, env) {
  const url = new URL(request.url);
  let body = {};
  if (request.method === 'POST') body = await request.json().catch(() => ({}));

  const expected = env.DAILY_REPORT_SECRET || env.HEALTH_CHECK_SECRET;
  if (!expected) {
    return json({ ok: false, error: 'not_configured', message: 'DAILY_REPORT_SECRET is not set on this environment.' }, 503);
  }
  const supplied = body.secret || url.searchParams.get('secret') || '';
  if (supplied !== expected) return json({ ok: false, error: 'unauthorized' }, 401);

  const dateParam = body.date || url.searchParams.get('date') || null;
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return json({ ok: false, error: 'bad_date', message: 'date must be YYYY-MM-DD' }, 400);
  }

  const dryRaw = body.dry != null ? body.dry : url.searchParams.get('dry');
  const dry = dryRaw === true || dryRaw === 1 || dryRaw === '1' || dryRaw === 'true';

  const tz = body.tz || url.searchParams.get('tz') || env.REPORT_TZ || DEFAULT_TZ;
  const now = new Date();
  const opts = { tz, date: dateParam, period: 'week', latestExt: latestExtVersion(env), now };

  const tenants = await statusTenants(env);

  // Sequential on purpose: a handful of tenants is not worth fanning out, and one bad
  // KV read must not lose the whole report.
  const rows = [];
  let meta = null;
  for (const t of tenants) {
    try {
      const data = await readData(env.PULSE_KV, t.id);
      const report = buildReport(data, opts);
      if (!meta) meta = { now, tz, startYmd: report.week.startYmd, endYmd: report.week.endYmd };
      rows.push(summarise(t, report, now));
    } catch (e) {
      rows.push({
        id: t.id || '__default', name: t.name, status: t.status, plan: t.plan,
        seats: (t.users || []).length, users: t.users || [],
        arrivals: 0, newFires: 0, handled: 0, closed: 0, collectedDays: 0, fullDays: 0,
        backlogDelta: null, weekVerdict: 'Could not be read', awaiting: 0, tracked: 0,
        lastScanAt: null, hoursSinceLastScan: null, extInstalled: null, extOutdated: false,
        bestCampaign: null, campaigns: [], silent: true, stale: false, never: true,
        suspended: t.status === 'suspended', noRecipient: !(t.users || []).length,
        criticalAlerts: [`Store unreadable: ${e.message || e}`],
      });
    }
  }

  if (!meta) return json({ ok: false, error: 'no_tenants', message: 'No tenant could be read.' }, 500);

  const status = buildStatus(rows, meta);
  status.latestExt = opts.latestExt;
  const subject = statusSubject(status);

  const to = String(body.to || url.searchParams.get('to') || env.STATUS_REPORT_EMAIL || CONVENTION_TO)
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (dry) {
    return json({ ok: true, dry: true, to, subject, status });
  }
  if (!env.RESEND_API_KEY) return json({ ok: false, sent: false, error: 'no_resend_key' }, 500);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.STATUS_EMAIL_FROM || STATUS_FROM,
      to,
      subject,
      html: renderStatusEmail(status),
      text: renderStatusText(status),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ ok: false, sent: false, to, subject, error: err.message || `HTTP ${res.status}` }, 502);
  }
  const sentBody = await res.json().catch(() => ({}));

  return json({
    ok: true, sent: true, to, subject, id: sentBody.id || null,
    accounts: status.totals.active, suspended: status.totals.suspended,
    replies: status.totals.newFires, awaiting: status.totals.awaiting,
    silent: status.attention.silent.map((r) => r.name),
  });
}

export const onRequestGet = ({ request, env }) => handle(request, env);
export const onRequestPost = ({ request, env }) => handle(request, env);
