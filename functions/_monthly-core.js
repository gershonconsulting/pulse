// functions/_monthly-core.js — Pulse monthly report: analysis + HTML email + PDF.
// Ported from Linalysis worker/monthly-report-block.js (same PDF engine, same
// "verdict / wins / tiles / charts / detail / what to work on" structure), adapted to
// Pulse's conversation data. Used by functions/api/monthly-report.js.
//
// Two audiences, two renderers:
//   renderClient*  — one tenant's own month, sent to that tenant's registered emails.
//   renderEstate*  — every tenant in one table, sent ONLY to Gershon (report@...).
// Same metric definitions as daily-report.js: "Replied" = ever Red, backlog deltas only
// between days that covered the same inboxes, campaigns under 5 contacts not ranked.

import { Pdf, strWidth, fit } from './_monthly-pdf.js';
import { cmpVer } from './_ext-version.js';

export const DEFAULT_TZ = 'America/New_York';
export const PLATFORMS = [
  { key: 'linkedin-messaging', label: 'LinkedIn Messaging', short: 'LinkedIn' },
  { key: 'sales-navigator', label: 'Sales Navigator', short: 'Sales Nav' },
];
const MIN_CAMPAIGN_N = 5;
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── time helpers (same as daily-report.js) ──────────────────────────────
function zoneOffsetMs(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const part of dtf.formatToParts(instant)) if (part.type !== 'literal') p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second) - instant.getTime();
}
function localYmd(instant, tz) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant); }
function dayStartMs(ymd, tz) { const [y, m, d] = ymd.split('-').map(Number); const g = Date.UTC(y, m - 1, d); let t = g - zoneOffsetMs(new Date(g), tz); return g - zoneOffsetMs(new Date(t), tz); }
const pad2 = (n) => String(n).padStart(2, '0');
const ts = (v) => { const t = Date.parse(v || ''); return Number.isNaN(t) ? null : t; };
const everReplied = (m) => m.status === 'Red' || (m.statusHistory || []).some((h) => h.to === 'Red');
const isHandle = (h) => h.from === 'Red' && (h.to === 'Green' || h.to === 'Orange');
const isFire = (h) => h.to === 'Red' && h.from !== 'Red';

// previous complete month in tz, or explicit "YYYY-MM"
export function monthWindow(now, tz, label) {
  let y, m;
  if (label && /^\d{4}-\d{2}$/.test(label)) { y = +label.slice(0, 4); m = +label.slice(5, 7) - 1; }
  else { const t = localYmd(now, tz); y = +t.slice(0, 4); m = +t.slice(5, 7) - 2; if (m < 0) { m = 11; y--; } }
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const ymd = (d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
  const next = m === 11 ? `${y + 1}-01-01` : `${y}-${pad2(m + 2)}-01`;
  return { y, m, dim, name: MONTHS[m], mon3: MON3[m], key: `${y}-${pad2(m + 1)}`,
    label: `${MONTHS[m]} ${y}`, range: `${MONTHS[m]} 1–${dim}, ${y}`, nextName: MONTHS[(m + 1) % 12],
    ymd, start: dayStartMs(ymd(1), tz), end: dayStartMs(next, tz), tz };
}

// ── analysis: one client, one month ─────────────────────────────────────
export function analyseMonth(data, win, opts = {}) {
  const tz = win.tz, now = opts.now || new Date();
  const scans = Array.isArray(data.scans) ? data.scans : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const inM = (t) => t !== null && t >= win.start && t < win.end;
  const dayOf = (t) => +localYmd(new Date(t), tz).slice(8);

  // per-day rollup: last scan of each platform that day, summed (null = not collected)
  // Prefer the stored daily snapshot (functions/_daily-snapshot.js, one KV row per
  // tenant per day, written on every sync) because data.scans keeps only the last 100
  // scans — not enough for a full month. Fall back to scans for days with no snapshot.
  const snaps = opts.snapshots || {};
  const days = [];
  for (let d = 1; d <= win.dim; d++) {
    const s0 = dayStartMs(win.ymd(d), tz), s1 = d < win.dim ? dayStartMs(win.ymd(d + 1), tz) : win.end;
    let red = 0, orange = 0, green = 0, total = 0; const sources = [];
    const snap = snaps[win.ymd(d)];
    for (const p of PLATFORMS) {
      let last = snap && snap.sources ? snap.sources[p.key] : null;
      if (!last) {
        const list = scans.filter((s) => (s.source || 'linkedin-messaging') === p.key)
          .filter((s) => { const t = ts(s.timestamp); return t !== null && t >= s0 && t < s1; })
          .sort((a, b) => ts(a.timestamp) - ts(b.timestamp));
        last = list[list.length - 1];
      }
      if (!last) continue;
      sources.push(p.key); red += last.red || 0; orange += last.orange || 0; green += last.green || 0; total += last.count || 0;
    }
    days.push(sources.length ? { d, red, orange, green, total, sources, full: sources.length === PLATFORMS.length, fires: 0, handled: 0, arrivals: 0 }
                             : { d, red: null, orange: null, green: null, total: null, sources: [], full: false, fires: 0, handled: 0, arrivals: 0 });
  }
  const collected = days.filter((x) => x.red !== null), fullDays = days.filter((x) => x.full);

  // movement
  let fires = 0, handled = 0, arrivals = 0, closed = 0;
  const waits = []; // hours from turning Red to being handled, for replies handled this month
  const plat = Object.fromEntries(PLATFORMS.map((p) => [p.key, { ...p, total: 0, fires: 0, handled: 0, awaiting: 0 }]));
  for (const m of messages) {
    const src = plat[m.source || 'linkedin-messaging'] || plat['linkedin-messaging'];
    src.total++;
    if (m.status === 'Red' && !m.done) src.awaiting++;
    const fsT = ts(m.firstSeenAt);
    if (inM(fsT)) { arrivals++; days[dayOf(fsT) - 1].arrivals++; }
    if (m.done && inM(ts(m.doneAt))) closed++;
    const hist = (m.statusHistory || []).slice().sort((a, b) => ts(a.timestamp) - ts(b.timestamp));
    let redAt = null;
    for (const h of hist) {
      const t = ts(h.timestamp);
      if (isFire(h)) { redAt = t; if (inM(t)) { fires++; src.fires++; days[dayOf(t) - 1].fires++; } }
      else if (isHandle(h)) {
        if (inM(t)) { handled++; src.handled++; days[dayOf(t) - 1].handled++; if (redAt !== null) waits.push((t - redAt) / 3600000); }
        redAt = null;
      }
    }
  }
  waits.sort((a, b) => a - b);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  const within24 = waits.length ? Math.round(100 * waits.filter((h) => h <= 24).length / waits.length) : null;

  // backlog start/end: first and last FULL-coverage day (same partial-coverage rule as daily-report)
  const bFirst = fullDays[0] || null, bLast = fullDays.length ? fullDays[fullDays.length - 1] : null;
  const comparable = !!(bFirst && bLast && bFirst.d !== bLast.d);
  const backlog = { start: comparable ? bFirst.red : null, end: comparable ? bLast.red : null,
    from: bFirst ? bFirst.d : null, to: bLast ? bLast.d : null, delta: comparable ? bLast.red - bFirst.red : null, comparable };

  // live state
  const followUp = messages.filter((m) => m.status === 'Red' && !m.done);
  const waitingList = followUp.map((m) => {
    const h = (m.statusHistory || []).filter(isFire).map((x) => ts(x.timestamp)).filter((x) => x !== null).sort((a, b) => b - a)[0];
    const since = h || ts(m.updatedAt) || ts(m.firstSeenAt);
    return { name: m.name, campaign: m.campaign || '', source: (plat[m.source] || plat['linkedin-messaging']).short,
      fit: m.fit || '', interest: m.interest || '', focus: !!m.focus, days: since ? Math.max(0, Math.floor((now - since) / 86400000)) : null };
  }).sort((a, b) => (b.days || 0) - (a.days || 0));
  const mix = { red: 0, orange: 0, green: 0 };
  for (const m of messages) { if (m.status === 'Red') mix.red++; else if (m.status === 'Orange') mix.orange++; else mix.green++; }
  const highFit = messages.filter((m) => String(m.fit || '').toLowerCase() === 'high').length;
  const highInterest = messages.filter((m) => String(m.interest || '').toLowerCase() === 'high').length;

  // campaigns
  const cm = new Map();
  for (const m of messages) {
    const name = String(m.campaign || '').trim(); if (!name) continue;
    let c = cm.get(name); if (!c) cm.set(name, c = { name, total: 0, replied: 0, liveRed: 0, highFit: 0, monthReplies: 0, monthHandled: 0, monthNew: 0 });
    c.total++; if (everReplied(m)) c.replied++; if (m.status === 'Red' && !m.done) c.liveRed++;
    if (String(m.fit || '').toLowerCase() === 'high') c.highFit++;
    if (inM(ts(m.firstSeenAt))) c.monthNew++;
    for (const h of m.statusHistory || []) { const t = ts(h.timestamp); if (!inM(t)) continue; if (isFire(h)) c.monthReplies++; else if (isHandle(h)) c.monthHandled++; }
  }
  const campaigns = [...cm.values()].map((c) => ({ ...c, rate: c.total ? Math.round(100 * c.replied / c.total) : 0, ranked: c.total >= MIN_CAMPAIGN_N }))
    .sort((a, b) => (b.ranked - a.ranked) || (b.rate - a.rate) || (b.total - a.total));
  const ranked = campaigns.filter((c) => c.ranked);
  const best = ranked[0] || null, worst = ranked.length > 2 ? ranked[ranked.length - 1] : null;
  const hottest = campaigns.filter((c) => c.monthReplies > 0).sort((a, b) => b.monthReplies - a.monthReplies)[0] || null;

  // best week (7-day window with most handled)
  let bestWeek = null;
  for (let i = 0; i + 6 < win.dim; i++) { const h = days.slice(i, i + 7).reduce((s, x) => s + x.handled, 0); if (!bestWeek || h > bestWeek.h) bestWeek = { h, a: i + 1, b: i + 7 }; }
  const busiestFire = days.reduce((b, x) => (x.fires > (b ? b.fires : 0) ? x : b), null);

  // extension
  const lastScan = scans.slice().sort((a, b) => ts(b.timestamp) - ts(a.timestamp))[0] || null;
  const extInstalled = lastScan && lastScan.version ? lastScan.version : null;
  const extLatest = opts.latestExt || null;
  const extStale = !!(extInstalled && extLatest && cmpVer(extInstalled, extLatest) < 0);

  // wins
  const wins = [];
  if (backlog.comparable && backlog.delta < 0) wins.push([`Backlog down ${Math.abs(backlog.delta)}`, `${backlog.start} → ${backlog.end} needing action over the month`]);
  if (best) wins.push([`${best.name}: ${best.rate}% reply rate`, `${best.replied} of ${best.total} contacts replied, your best campaign`]);
  if (bestWeek && bestWeek.h > 0) wins.push([`${bestWeek.h} replies handled in 7 days`, `${bestWeek.a}–${bestWeek.b} ${win.mon3}, your strongest week`]);
  if (wins.length < 3 && within24 != null && within24 >= 50) wins.push([`${within24}% answered within 24h`, 'of the replies you handled this month']);
  if (wins.length < 3 && fires > 0) wins.push([`${fires} replies received`, `from ${arrivals} new conversations and existing threads`]);

  // what to work on next month
  const notes = [];
  const old = waitingList.filter((w) => (w.days || 0) >= 7);
  if (old.length) notes.push([`${old.length} ${old.length === 1 ? 'reply has' : 'replies have'} waited more than a week.`, `${old.slice(0, 3).map((w) => w.name).join(', ')}${old.length > 3 ? ` and ${old.length - 3} more` : ''}. A warm reply goes cold fast — clear these first.`]);
  if (worst && best && worst.rate < best.rate / 2) notes.push([`${worst.name} is underperforming at ${worst.rate}%.`, `Less than half of ${best.name}'s ${best.rate}%. Rework its opening message or move its volume to ${best.name}.`]);
  if (median != null && median > 24) notes.push([`Median time to answer is ${fmtHours(median)}.`, 'Aim for same-day replies: prospects who wait more than a day reply back far less often.']);
  if (collected.length < win.dim) notes.push([`${win.dim - collected.length} of ${win.dim} days had no sync.`, 'Days with no collection are gaps in every number in this report. Keep Chrome open on the collecting computer.']);
  if (extStale) notes.push(['Your Chrome extension is out of date.', `v${extInstalled} installed, v${extLatest} available — update it from the Extension page.`]);
  if (!notes.length) notes.push(['Keep the rhythm.', 'Every day collected and every reply answered quickly. Nothing to fix.']);

  let verdict;
  if (!collected.length) verdict = { tone: 'bad', head: `Pulse did not collect anything in ${win.name}.`, body: 'No sync was recorded all month, so there is nothing to measure. Open Chrome with the Pulse extension and run Sync Now.' };
  else if (backlog.comparable && backlog.delta < 0) verdict = { tone: 'good', head: `${win.name} cut your backlog from ${backlog.start} to ${backlog.end}.`, body: `You handled ${handled} replies against ${fires} new ones, and ${arrivals} new conversations came in.` };
  else if (backlog.comparable && backlog.delta > 0) verdict = { tone: 'bad', head: `Your backlog grew by ${backlog.delta} in ${win.name}.`, body: `${fires} replies came in and ${handled} were handled — ${backlog.end} people are now waiting on you.` };
  else if (backlog.comparable) verdict = { tone: 'neutral', head: `${win.name} was a holding month.`, body: `${handled} replies handled, ${fires} new — they cancelled out. ${backlog.end} still need action.` };
  else verdict = { tone: 'warn', head: `${win.name}: ${fires} replies in, ${handled} handled.`, body: 'Collection was too patchy to compare the backlog across the month.' };

  return { win, days, collected: collected.length, full: fullDays.length, fires, handled, arrivals, closed,
    backlog, followUp: followUp.length, waitingList, mix, total: messages.length, highFit, highInterest,
    platforms: Object.values(plat), campaigns, best, worst, hottest, bestWeek, busiestFire,
    speed: { median, within24, n: waits.length }, ext: { installed: extInstalled, latest: extLatest, stale: extStale },
    wins: wins.slice(0, 3), notes: notes.slice(0, 3), verdict };
}

export function fmtHours(h) { if (h == null) return '—'; if (h < 1) return `${Math.round(h * 60)} min`; if (h < 48) return `${Math.round(h)}h`; return `${(h / 24).toFixed(1)} days`; }
const fmtN = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const sgn = (n) => (n == null ? '—' : n === 0 ? 'no change' : (n > 0 ? '+' : '−') + Math.abs(n));

// ── subjects / filenames ────────────────────────────────────────────────
export function clientSubject(r, client) {
  const base = `Pulse LinkedIn Monthly Report — ${r.win.range}`;
  const tail = r.backlog.delta == null ? '' : r.backlog.delta === 0 ? ' · backlog flat' : ` · backlog ${r.backlog.delta < 0 ? '−' : '+'}${Math.abs(r.backlog.delta)}`;
  return `${base} · ${client.name} · ${r.fires} replies${tail}`;
}
export function estateSubject(e) {
  return `Pulse Monthly Report — All clients — ${e.win.range} · ${e.live}/${e.clients.length} collecting · ${e.fires} replies`;
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const clientFilename = (r, client, ver) => `Pulse-Monthly-Report_${r.win.key}_${slug(client.name)}_v${ver}.pdf`;
export const estateFilename = (e, ver) => `Pulse-Monthly-Report_${e.win.key}_all-clients_v${ver}.pdf`;

// ── estate (all clients) ────────────────────────────────────────────────
export function analyseEstate(rows, win) {
  const live = rows.filter((x) => x.r.collected > 0);
  const sum = (f) => live.reduce((s, x) => s + (f(x.r) || 0), 0);
  const comp = live.filter((x) => x.r.backlog.comparable);
  return { win, clients: rows, live: live.length, dark: rows.filter((x) => !x.r.collected),
    fires: sum((r) => r.fires), handled: sum((r) => r.handled), arrivals: sum((r) => r.arrivals),
    backlogStart: comp.reduce((s, x) => s + x.r.backlog.start, 0), backlogEnd: comp.reduce((s, x) => s + x.r.backlog.end, 0),
    awaiting: sum((r) => r.followUp), stale: live.filter((x) => x.r.ext.stale),
    improved: comp.filter((x) => x.r.backlog.delta < 0).length, worsened: comp.filter((x) => x.r.backlog.delta > 0) };
}

// ═════════════════════════════════════════════════════════════════════════
//  HTML EMAIL (table-based, inline styles — renders in Gmail/Outlook)
// ═════════════════════════════════════════════════════════════════════════
const C = { ink: '#0f172a', mut: '#64748b', rule: '#e2e8f0', tint: '#f8fafc', acc: '#0077b5', red: '#dc2626', org: '#d97706', grn: '#16a34a', grnBg: '#f0fdf4', redBg: '#fef2f2', orgBg: '#fffbeb' };
const TONE = { good: [C.grnBg, '#166534', C.grn], bad: [C.redBg, '#991b1b', C.red], warn: [C.orgBg, '#92400e', C.org], neutral: ['#f1f5f9', '#334155', C.mut] };
const h = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const F = 'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;';

function eSection(title, inner) {
  return `<tr><td style="padding:22px 28px 6px;${F}"><div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:${C.mut};border-bottom:1px solid ${C.rule};padding-bottom:7px;margin-bottom:12px;">${title}</div>${inner}</td></tr>`;
}
function eTiles(tiles) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:6px 0;"><tr>${tiles.map((t) => `<td width="25%" style="background:#fff;border:1px solid ${C.rule};border-top:3px solid ${t[3]};border-radius:6px;padding:12px 12px 10px;vertical-align:top;${F}">
    <div style="font-size:10px;font-weight:700;letter-spacing:.5px;color:${C.mut};text-transform:uppercase;">${t[0]}</div>
    <div style="font-size:26px;font-weight:800;color:${t[3]};line-height:1.15;margin-top:6px;">${t[1]}</div>
    <div style="font-size:11px;color:${C.mut};margin-top:3px;">${t[2]}</div></td>`).join('')}</tr></table>`;
}
// vertical bar chart as a table; null = not collected (grey stub)
function eBars(days, key, color, caption, opts = {}) {
  const vals = days.map((d) => d[key]);
  const max = Math.max(1, ...vals.filter((v) => v != null));
  const H = 70;
  const cells = days.map((d, i) => {
    const v = vals[i];
    const bh = v == null ? 0 : Math.max(2, Math.round(H * v / max));
    const col = v == null ? C.rule : (opts.colorFn ? opts.colorFn(d) : color);
    const stub = v == null ? `<div style="height:3px;background:${C.rule};font-size:0;line-height:0;">&nbsp;</div>` : `<div title="${d.d}: ${v}" style="height:${bh}px;background:${col};font-size:0;line-height:0;border-radius:1px 1px 0 0;">&nbsp;</div>`;
    return `<td valign="bottom" style="height:${H}px;padding:0 1px;">${stub}</td>`;
  }).join('');
  const ticks = days.map((d) => `<td style="font-size:8px;color:${C.mut};text-align:center;padding-top:3px;${F}">${[1, 8, 15, 22, days.length].includes(d.d) ? d.d : ''}</td>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;"><tr>${cells}</tr><tr>${ticks}</tr></table>
  <div style="font-size:11px;color:${C.mut};margin-top:4px;${F}">${caption} <span style="color:#94a3b8;">· peak ${max}</span></div>`;
}
function eTable(head, rows, align) {
  const th = head.map((x, i) => `<th style="padding:7px 10px;text-align:${align[i]};font-size:10.5px;font-weight:700;color:${C.mut};text-transform:uppercase;letter-spacing:.4px;background:${C.tint};${F}">${x}</th>`).join('');
  const tr = rows.map((r) => `<tr${r.dim ? ' style="opacity:.55;"' : ''}>${r.cells.map((c, i) => `<td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;text-align:${align[i]};font-size:13px;color:${C.ink};${F}">${c}</td>`).join('')}</tr>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>${th}</tr>${tr}</table>`;
}
function eShell(header, body, footer, sampleNote) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pulse monthly report</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;"><tr><td align="center" style="padding:24px 12px;">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid ${C.rule};">
${sampleNote ? `<tr><td style="background:#fef3c7;color:#92400e;padding:8px 28px;font-size:12px;font-weight:600;${F}">${sampleNote}</td></tr>` : ''}
${header}${body}
<tr><td style="padding:20px 28px 26px;${F}"><div style="border-top:1px solid ${C.rule};padding-top:12px;font-size:11.5px;color:#94a3b8;line-height:1.6;">${footer}</div></td></tr>
</table></td></tr></table></body></html>`;
}
function eHeader(sub, right, rightSmall) {
  return `<tr><td style="background:${C.ink};padding:20px 28px;${F}"><table width="100%" cellpadding="0" cellspacing="0"><tr>
  <td style="${F}"><div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:1px;"><span style="color:#38bdf8;">&#9679;</span> PULSE</div><div style="font-size:12.5px;color:#cbd5e1;margin-top:3px;">${sub}</div></td>
  <td align="right" style="${F}"><div style="font-size:18px;font-weight:800;color:#38bdf8;">${right}</div><div style="font-size:11px;color:#94a3b8;margin-top:3px;">${rightSmall}</div></td></tr></table></td></tr>`;
}
function eVerdict(v) {
  const t = TONE[v.tone] || TONE.neutral;
  return `<tr><td style="padding:22px 28px 0;${F}"><div style="background:${t[0]};border-left:4px solid ${t[2]};border-radius:6px;padding:14px 16px;">
  <div style="font-size:18px;font-weight:800;color:${t[1]};line-height:1.3;">${h(v.head)}</div><div style="font-size:13.5px;color:${t[1]};opacity:.9;margin-top:5px;line-height:1.5;">${h(v.body)}</div></div></td></tr>`;
}
function eCards(items, bg, fg, bar) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0 6px;">${items.map((w) => `<tr><td style="background:${bg};border-left:3px solid ${bar};border-radius:5px;padding:9px 12px;${F}"><div style="font-size:13.5px;font-weight:700;color:${fg};">${h(w[0])}</div><div style="font-size:12px;color:${C.mut};margin-top:2px;line-height:1.45;">${h(w[1])}</div></td></tr>`).join('')}</table>`;
}

export function renderClientEmail(r, client, o = {}) {
  const w = r.win, b = r.backlog;
  const tiles = [
    ['Replies received', fmtN(r.fires), `people who answered you in ${w.mon3}`, C.acc],
    ['Replies handled', fmtN(r.handled), r.speed.median != null ? `median ${fmtHours(r.speed.median)} to answer` : 'moved off Red', C.grn],
    ['New conversations', fmtN(r.arrivals), `${r.total} tracked in total`, '#7c3aed'],
    ['Waiting on you', fmtN(r.followUp), b.delta != null ? `${sgn(b.delta)} vs 1 ${w.mon3}` : 'needs a reply now', r.followUp ? C.red : C.grn],
  ];
  const camp = r.campaigns.length ? eTable(['Campaign', 'Contacts', 'Replied', 'Rate', `Replies in ${w.mon3}`, 'Waiting'],
    r.campaigns.map((c) => ({ dim: !c.ranked, cells: [`<strong style="color:${C.acc};">${h(c.name)}</strong>${c === r.best ? ' &#127942;' : ''}`, c.total, c.replied, c.ranked ? `<strong>${c.rate}%</strong>` : '—', c.monthReplies || '—', c.liveRed ? `<span style="color:${C.red};font-weight:700;">${c.liveRed}</span>` : '0'] })),
    ['left', 'right', 'right', 'right', 'right', 'right'])
    + `<div style="font-size:11.5px;color:#94a3b8;margin-top:8px;line-height:1.55;${F}"><strong>Replied</strong> = every contact who has ever answered, even after you replied back. Campaigns under ${MIN_CAMPAIGN_N} contacts are shown but not ranked.</div>`
    : `<div style="font-size:13px;color:${C.mut};${F}">No campaign codes detected yet. Pulse reads codes like BD18 off your outreach messages.</div>`;
  const plat = eTable(['Inbox', 'Conversations', `Replies in ${w.mon3}`, 'Handled', 'Waiting'],
    r.platforms.map((p) => ({ cells: [`<strong>${p.label}</strong>`, p.total, p.fires, p.handled, p.awaiting] })), ['left', 'right', 'right', 'right', 'right']);
  const mixTot = Math.max(1, r.mix.red + r.mix.orange + r.mix.green);
  const mixBar = `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:12px;"><tr>
    <td width="${Math.round(100 * r.mix.red / mixTot)}%" style="background:${C.red};height:12px;font-size:0;">&nbsp;</td>
    <td width="${Math.round(100 * r.mix.orange / mixTot)}%" style="background:#f59e0b;height:12px;font-size:0;">&nbsp;</td>
    <td style="background:${C.grn};height:12px;font-size:0;">&nbsp;</td></tr></table>
    <div style="font-size:12px;color:${C.mut};margin-top:6px;${F}"><span style="color:${C.red};font-weight:700;">● ${r.mix.red} Red</span> — they spoke last &nbsp; <span style="color:${C.org};font-weight:700;">● ${r.mix.orange} Orange</span> — awaiting their reply &nbsp; <span style="color:${C.grn};font-weight:700;">● ${r.mix.green} Green</span> — handled · ${r.highFit} High FIT · ${r.highInterest} High INTEREST</div>`;
  const waiting = r.waitingList.length ? eTable(['Contact', 'Campaign', 'Inbox', 'Waiting'],
    r.waitingList.slice(0, 10).map((x) => ({ cells: [`${x.focus ? '★ ' : ''}<strong>${h(x.name)}</strong>${x.fit.toLowerCase() === 'high' ? ` <span style="font-size:10px;background:${C.grnBg};color:${C.grn};padding:1px 5px;border-radius:3px;font-weight:700;">HIGH FIT</span>` : ''}`, h(x.campaign || '—'), x.source, x.days == null ? '—' : `<span style="color:${x.days >= 7 ? C.red : C.ink};font-weight:${x.days >= 7 ? 700 : 400};">${x.days === 0 ? 'today' : x.days + ' day' + (x.days === 1 ? '' : 's')}</span>`] })),
    ['left', 'left', 'left', 'right'])
    + (r.waitingList.length > 10 ? `<div style="font-size:12px;color:${C.mut};margin-top:6px;${F}">+ ${r.waitingList.length - 10} more on your dashboard.</div>` : '')
    : `<div style="font-size:13px;color:${C.grn};font-weight:700;${F}">Nobody is waiting on you. Inbox zero.</div>`;
  const cov = `<table cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:2px 0;"><tr>${r.days.map((d) => `<td title="${d.d} ${w.mon3}" style="width:14px;height:12px;background:${d.full ? C.grn : d.red != null ? '#f59e0b' : C.rule};border-radius:2px;font-size:0;">&nbsp;</td>`).join('')}</tr></table>
    <div style="font-size:12px;color:${C.mut};margin-top:7px;line-height:1.55;${F}"><strong style="color:${C.ink};">${r.collected} of ${w.dim} days collected</strong>${r.full < r.collected ? ` · ${r.collected - r.full} covered only one inbox (amber)` : ''} · grey = no sync. Chrome extension ${r.ext.installed ? `v${h(r.ext.installed)}` : 'unknown'} ${r.ext.stale ? `<span style="color:${C.red};font-weight:700;">— out of date, v${h(r.ext.latest)} available</span>` : '<span style="color:' + C.grn + ';">— current</span>'}.</div>`;
  const speed = `<table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="33%" style="${F}"><div style="font-size:22px;font-weight:800;color:${C.ink};">${fmtHours(r.speed.median)}</div><div style="font-size:11.5px;color:${C.mut};">median time to answer a reply</div></td>
    <td width="33%" style="${F}"><div style="font-size:22px;font-weight:800;color:${C.ink};">${r.speed.within24 == null ? '—' : r.speed.within24 + '%'}</div><div style="font-size:11.5px;color:${C.mut};">answered within 24 hours</div></td>
    <td width="33%" style="${F}"><div style="font-size:22px;font-weight:800;color:${C.ink};">${r.closed}</div><div style="font-size:11.5px;color:${C.mut};">conversations ticked off ✓</div></td></tr></table>`;

  const body = eVerdict(r.verdict)
    + `<tr><td style="padding:14px 22px 0;">${eTiles(tiles)}</td></tr>`
    + eSection('Highlights', eCards(r.wins, C.grnBg, '#166534', C.grn))
    + eSection('Replies received per day', eBars(r.days, 'fires', C.acc, 'People who answered you, by day. Grey = no sync that day.'))
    + eSection('Backlog — people waiting on you, end of each day', eBars(r.days, 'red', C.red, 'Lower is better. Amber = only one inbox was collected that day.', { colorFn: (d) => (d.full ? C.red : '#f59e0b') }))
    + eSection('Response speed', speed)
    + eSection('Campaign leaderboard', camp)
    + eSection('By inbox', plat + mixBar)
    + eSection(`Still waiting on you (${r.waitingList.length})`, waiting)
    + eSection('Collection', cov)
    + eSection(`What to work on in ${w.nextName}`, eCards(r.notes, '#fff7ed', '#9a3412', C.org))
    + `<tr><td align="center" style="padding:18px 28px 0;${F}"><a href="https://pulse.gershoncrm.com/app.html" style="display:inline-block;background:${C.acc};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:6px;">Open your Pulse dashboard</a></td></tr>`;
  return eShell(eHeader(`Your month on LinkedIn — ${h(client.name)}`, h(w.label).toUpperCase(), h(client.to.join(', '))), body,
    `The same report is attached as a PDF (${h(o.filename || '')}). Generated by Pulse on 1 ${h(w.nextName)} for ${h(w.range)}, times in ${h(w.tz)}.<br>Pulse · pulse.gershoncrm.com · a Gershon Consulting product`, o.sample);
}

export function renderEstateEmail(e, o = {}) {
  const w = e.win;
  const tiles = [
    ['Clients collecting', `${e.live} / ${e.clients.length}`, e.dark.length ? `${e.dark.length} produced no data` : 'every client reported', e.dark.length ? C.red : C.grn],
    ['Replies received', fmtN(e.fires), `across all clients in ${w.mon3}`, C.acc],
    ['Replies handled', fmtN(e.handled), `${fmtN(e.arrivals)} new conversations`, C.grn],
    ['Waiting now', fmtN(e.awaiting), `backlog ${e.backlogStart} → ${e.backlogEnd}`, e.backlogEnd <= e.backlogStart ? C.grn : C.red],
  ];
  const verdict = e.dark.length
    ? { tone: 'warn', head: `${e.live} of ${e.clients.length} clients collected in ${w.name}.`, body: `${e.dark.map((x) => x.client.name).join(', ')} produced no data. ${e.improved} clients cut their backlog.` }
    : { tone: e.worsened.length ? 'neutral' : 'good', head: `Every client collected in ${w.name}.`, body: `${e.fires} replies across all accounts, ${e.handled} handled. ${e.improved} of ${e.live} clients cut their backlog.` };
  const rows = e.clients.map(({ client, r }) => ({ dim: !r.collected, cells: [
    `<strong>${h(client.name)}</strong><div style="font-size:11px;color:${C.mut};">${h(client.status)} · ${h(client.to[0] || 'no user')}</div>`,
    `${r.collected}/${w.dim}`, r.fires, r.handled,
    r.backlog.comparable ? `${r.backlog.start} → <strong>${r.backlog.end}</strong> <span style="color:${r.backlog.delta < 0 ? C.grn : r.backlog.delta > 0 ? C.red : C.mut};font-weight:700;">${sgn(r.backlog.delta)}</span>` : '—',
    r.best ? `${h(r.best.name)} <span style="color:${C.mut};">${r.best.rate}%</span>` : '—',
    !r.collected ? `<span style="color:${C.mut};">no data</span>` : r.ext.stale ? `<span style="color:${C.red};font-weight:700;">v${h(r.ext.installed)} old</span>` : `<span style="color:${C.grn};">v${h(r.ext.installed)}</span>`] }));
  const attn = [];
  if (e.dark.length) attn.push([`${e.dark.length} client${e.dark.length === 1 ? '' : 's'} produced no data.`, `${e.dark.map((x) => x.client.name).join(', ')} — the extension never synced this month.`]);
  if (e.stale.length) attn.push([`${e.stale.length} client${e.stale.length === 1 ? ' is' : 's are'} on an outdated extension.`, e.stale.map((x) => `${x.client.name} (v${x.r.ext.installed})`).join(', ')]);
  for (const x of e.worsened) attn.push([`${x.client.name}: backlog grew ${x.r.backlog.delta}.`, `${x.r.backlog.end} people waiting — ${x.r.waitingList.filter((q) => q.days >= 7).length} for more than a week.`]);
  if (!attn.length) attn.push(['Nothing needs attention.', 'Every client collected and every backlog went down.']);
  const body = eVerdict(verdict) + `<tr><td style="padding:14px 22px 0;">${eTiles(tiles)}</td></tr>`
    + eSection('Clients', eTable(['Client', 'Days', 'Replies', 'Handled', 'Backlog', 'Best campaign', 'Extension'], rows, ['left', 'right', 'right', 'right', 'right', 'left', 'left']))
    + eSection('Needs attention', eCards(attn.slice(0, 5), '#fff7ed', '#9a3412', C.org))
    + eSection('Per-client reports', `<div style="font-size:13px;color:${C.mut};line-height:1.6;${F}">Each client received their own report at their registered email today. All client PDFs are attached to this email.</div>`);
  return eShell(eHeader('Monthly report — all clients', h(w.label).toUpperCase(), 'to report@gershonconsulting.com'), body,
    `Attached: ${h(o.filename || '')} + one PDF per client. Generated by Pulse on 1 ${h(w.nextName)} for ${h(w.range)}.<br>Pulse · pulse.gershoncrm.com`, o.sample);
}

// ═════════════════════════════════════════════════════════════════════════
//  PDF (US Letter, same visual language as the Linalysis monthly PDF)
// ═════════════════════════════════════════════════════════════════════════
const PW = 612, PH = 792, M = 40, CW = PW - 2 * M;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const K = { ink: rgb('#0f172a'), mut: rgb('#64748b'), rule: rgb('#e2e8f0'), tint: rgb('#f8fafc'), acc: rgb('#0077b5'), sky: rgb('#38bdf8'),
  red: rgb('#dc2626'), org: rgb('#f59e0b'), orgD: rgb('#b45309'), grn: rgb('#16a34a'), grnB: rgb('#f0fdf4'), grnD: rgb('#166534'), redB: rgb('#fef2f2'), redD: rgb('#991b1b'),
  orgB: rgb('#fff7ed'), white: [1, 1, 1], bar: rgb('#e8edf2'), purple: rgb('#7c3aed'), sl: rgb('#cbd5e1') };
const PT = { good: [K.grnB, K.grnD, K.grn], bad: [K.redB, K.redD, K.red], warn: [K.orgB, K.orgD, K.org], neutral: [K.tint, K.ink, K.mut] };

function pHead(p, sub, right, rightSmall, page, pages) {
  const y = PH - M;
  p.rect(0, PH - 74, PW, 74, K.ink);
  p.rect(M, y - 10, 4, 30, K.sky);
  p.text(M + 14, y + 6, 'PULSE', 18, true, K.white);
  p.text(M + 14, y - 8, sub, 9.5, false, K.sl);
  p.rtext(PW - M, y + 6, right, 16, true, K.sky);
  p.rtext(PW - M, y - 8, rightSmall + (pages > 1 ? `   ·   page ${page} of ${pages}` : ''), 7.5, false, K.sl);
  return PH - 74;
}
function pSect(p, y, label, x0 = M, x1 = PW - M) { const L = label.toUpperCase(); p.text(x0, y, L, 7.5, true, K.mut); p.line(x0 + strWidth(L, true, 7.5) + 8, y + 2.5, x1, K.rule, 0.5); }
function pFoot(p, left, right) { p.line(M, M + 6, PW - M, K.rule, 0.5); p.text(M, M - 4, left, 6.6, false, K.mut); p.rtext(PW - M, M - 4, right, 6.6, false, K.mut); }
function pVerdict(p, y, v) {
  const t = PT[v.tone] || PT.neutral; y -= 44;
  p.rect(M, y, CW, 36, t[0]); p.rect(M, y, 3, 36, t[2]);
  p.text(M + 13, y + 21, fit(v.head, true, 12.5, CW - 26), 12.5, true, t[1]);
  p.text(M + 13, y + 8, fit(v.body, false, 8.4, CW - 26), 8.4, false, t[1]);
  return y;
}
function pTiles(p, y, tiles, h = 58) {
  const tw = (CW - 3 * 9) / 4; y -= h;
  tiles.forEach((t, i) => { const x = M + i * (tw + 9);
    p.box(x, y, tw, h, K.white, K.rule); p.rect(x, y + h - 3, tw, 3, t[3]);
    p.text(x + 10, y + h - 17, t[0], 6.4, true, K.mut); p.text(x + 10, y + 19, t[1], 20, true, t[3]); p.text(x + 10, y + 7, fit(t[2], false, 6.6, tw - 16), 6.6, false, K.mut); });
  return y;
}
function pCards(p, y, items, bg, fg, bar, cols = 3) {
  const ww = (CW - (cols - 1) * 8) / cols; y -= 28;
  items.forEach((w, i) => { const x = M + i * (ww + 8);
    p.rect(x, y, ww, 28, bg); p.rect(x, y, 2.5, 28, bar);
    p.text(x + 10, y + 16, fit(w[0], true, 8.6, ww - 16), 8.6, true, fg); p.text(x + 10, y + 6, fit(w[1], false, 6.5, ww - 16), 6.5, false, K.mut); });
  return y;
}
function niceTop(max) { if (max <= 0) return 1; const mag = Math.pow(10, Math.floor(Math.log10(max))); for (const s of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (max <= s * mag) return s * mag; return 10 * mag; }
function pChart(p, x, y, w, h, days, vals, colors, caption) {
  p.box(x, y, w, h, K.white, K.rule);
  const ax = x + 22, aw = w - 30, base = y + 12, plot = h - 26, hi = niceTop(Math.max(1, ...vals.filter((v) => v != null)));
  for (const f of [0, 0.5, 1]) { const gy = base + plot * f; p.line(ax, gy, x + w - 6, K.rule, 0.4); p.rtext(ax - 4, gy - 2.4, String(Math.round(hi * f)), 5.6, false, K.mut); }
  const pw = aw / days.length;
  days.forEach((d, i) => { const v = vals[i];
    if (v == null) { p.rect(ax + i * pw + 0.5, base, Math.max(1.6, pw - 1.4), 1.2, K.rule); return; }
    p.rect(ax + i * pw + 0.5, base, Math.max(1.6, pw - 1.4), Math.max(1, plot * v / hi), Array.isArray(colors[0]) ? colors[i] : colors); });
  for (const d of [1, 8, 15, 22, days.length]) p.ctext(ax + (d - 0.5) * pw, y + 4, String(d), 5.6, false, K.mut);
  p.text(ax, y + h - 9, caption, 6.2, false, K.mut);
}
function pTable(p, y, cols, rows, rowH = 15) {
  // cols: [{label, x, align:'l'|'r', w}]
  p.rect(M, y - 5, CW, 15, K.tint);
  for (const c of cols) (c.align === 'r' ? p.rtext.bind(p) : p.text.bind(p))(c.x, y, c.label.toUpperCase(), 6.4, true, K.mut);
  y -= 6;
  for (const r of rows) {
    y -= rowH; p.line(M, y + rowH - 4.5, PW - M, K.rule, 0.4);
    r.cells.forEach((cell, i) => { const c = cols[i]; const [s, bold, col] = Array.isArray(cell) ? cell : [cell, false, K.ink];
      const txt = c.w ? fit(String(s), bold, 8, c.w) : String(s);
      (c.align === 'r' ? p.rtext.bind(p) : p.text.bind(p))(c.x, y, txt, 8, bold, r.dim ? K.mut : col); });
  }
  return y - 6;
}

export function renderClientPdf(r, client, o = {}) {
  const p = new Pdf(PW, PH), w = r.win, b = r.backlog, sub = `Your month on LinkedIn — ${client.name}`, rs = client.to.join(', ');
  const foot = 'Pulse  ·  pulse.gershoncrm.com';
  let y = pHead(p, sub, w.label.toUpperCase(), rs, 1, 2);
  if (o.sample) { p.rect(M, y - 16, CW, 12, rgb('#fef3c7')); p.text(M + 8, y - 12.5, o.sample, 6.6, true, K.orgD); y -= 14; }
  y = pVerdict(p, y - 4, r.verdict);
  y = pCards(p, y - 8, r.wins, K.grnB, K.grnD, K.grn);
  y -= 16; pSect(p, y, 'Your headline numbers');
  y = pTiles(p, y - 8, [
    ['REPLIES RECEIVED', fmtN(r.fires), `people who answered you in ${w.mon3}`, K.acc],
    ['REPLIES HANDLED', fmtN(r.handled), r.speed.median != null ? `median ${fmtHours(r.speed.median)} to answer` : 'moved off Red', K.grn],
    ['NEW CONVERSATIONS', fmtN(r.arrivals), `${r.total} tracked in total`, K.purple],
    ['WAITING ON YOU', fmtN(r.followUp), b.delta != null ? `${sgn(b.delta)} vs 1 ${w.mon3}` : 'need a reply now', r.followUp ? K.red : K.grn]]);
  y -= 18; const CH = (CW - 16) / 2;
  pSect(p, y, 'Replies received per day', M, M + CH); pSect(p, y, 'Backlog at the end of each day', M + CH + 16, PW - M);
  y -= 96;
  pChart(p, M, y, CH, 88, r.days, r.days.map((d) => d.fires), K.acc, 'People who answered you · grey stub = no sync');
  pChart(p, M + CH + 16, y, CH, 88, r.days, r.days.map((d) => d.red), r.days.map((d) => (d.full ? K.red : K.org)), 'Lower is better · amber = one inbox only');
  // campaigns
  y -= 18; pSect(p, y, 'Campaign leaderboard'); y -= 14;
  const cc = [{ label: 'Campaign', x: M + 4, w: 150 }, { label: 'Contacts', x: M + 250, align: 'r' }, { label: 'Replied', x: M + 310, align: 'r' }, { label: 'Rate', x: M + 360, align: 'r' }, { label: `Replies in ${w.mon3}`, x: M + 440, align: 'r' }, { label: 'Waiting', x: PW - M - 4, align: 'r' }];
  y = pTable(p, y, cc, r.campaigns.slice(0, 8).map((c) => ({ dim: !c.ranked, cells: [[c.name + (c === r.best ? '  (best)' : ''), true, K.acc], c.total, c.replied, [c.ranked ? c.rate + '%' : '—', true, K.ink], c.monthReplies || '—', [c.liveRed, c.liveRed > 0, c.liveRed ? K.red : K.ink]] })));
  p.text(M, y - 2, `Replied = every contact who has ever answered, even after you replied back. Campaigns under ${MIN_CAMPAIGN_N} contacts are listed but not ranked.`, 6.4, false, K.mut);
  // inbox + mix
  y -= 22; pSect(p, y, 'By inbox', M, M + CH); pSect(p, y, 'Pipeline today', M + CH + 16, PW - M); y -= 14;
  const ix = [{ label: 'Inbox', x: M + 4 }, { label: 'Convos', x: M + 140, align: 'r' }, { label: 'Replies', x: M + 186, align: 'r' }, { label: 'Waiting', x: M + CH - 4, align: 'r' }];
  const yInbox = y;
  p.rect(M, y - 5, CH, 15, K.tint); for (const c of ix) (c.align === 'r' ? p.rtext.bind(p) : p.text.bind(p))(c.x, y, c.label.toUpperCase(), 6.4, true, K.mut);
  r.platforms.forEach((pl, i) => { const yy = y - 21 - i * 15; p.line(M, yy + 10.5, M + CH, K.rule, 0.4);
    p.text(M + 4, yy, pl.label, 8, true, K.ink); p.rtext(M + 140, yy, String(pl.total), 8, false, K.ink); p.rtext(M + 186, yy, String(pl.fires), 8, false, K.ink); p.rtext(M + CH - 4, yy, String(pl.awaiting), 8, true, pl.awaiting ? K.red : K.ink); });
  const mx = M + CH + 16, tot = Math.max(1, r.mix.red + r.mix.orange + r.mix.green);
  let bx = mx; for (const [v, c] of [[r.mix.red, K.red], [r.mix.orange, K.org], [r.mix.green, K.grn]]) { const ww = CH * v / tot; p.rect(bx, yInbox - 4, ww, 11, c); bx += ww; }
  p.text(mx, yInbox - 18, `${r.mix.red} Red — they spoke last`, 7.6, true, K.red);
  p.text(mx, yInbox - 29, `${r.mix.orange} Orange — awaiting their reply`, 7.6, true, K.orgD);
  p.text(mx, yInbox - 40, `${r.mix.green} Green — handled`, 7.6, true, K.grn);
  p.text(mx + 128, yInbox - 18, `${r.highFit} High FIT`, 7.6, false, K.ink); p.text(mx + 128, yInbox - 29, `${r.highInterest} High INTEREST`, 7.6, false, K.ink);
  y = yInbox - 66; pSect(p, y, 'Response speed'); y -= 40;
  const sw = CW / 4;
  [[fmtHours(r.speed.median), 'median time to answer a reply'], [r.speed.within24 == null ? '—' : r.speed.within24 + '%', 'answered within 24 hours'], [String(r.closed), 'conversations ticked off'], [r.busiestFire ? `${r.busiestFire.fires}` : '—', r.busiestFire ? `replies on ${r.busiestFire.d} ${w.mon3}, your busiest day` : 'busiest day']].forEach((s, i) => {
    p.text(M + i * sw, y + 14, s[0], 20, true, K.ink); p.text(M + i * sw, y + 3, s[1], 7, false, K.mut); });
  pFoot(p, foot, `${w.range}  ·  ${o.filename || ''}`);

  // ── page 2
  p.addPage(); y = pHead(p, sub, w.label.toUpperCase(), rs, 2, 2);
  y -= 22; pSect(p, y, `Still waiting on you (${r.waitingList.length})`); y -= 14;
  const wc = [{ label: 'Contact', x: M + 4, w: 190 }, { label: 'Campaign', x: M + 230, w: 80 }, { label: 'Inbox', x: M + 320 }, { label: 'Fit', x: M + 390 }, { label: 'Waiting', x: PW - M - 4, align: 'r' }];
  y = r.waitingList.length ? pTable(p, y, wc, r.waitingList.slice(0, 15).map((x) => ({ cells: [[(x.focus ? '* ' : '') + x.name, true, K.ink], x.campaign || '—', x.source, [x.fit || '—', x.fit.toLowerCase() === 'high', x.fit.toLowerCase() === 'high' ? K.grn : K.mut], [x.days == null ? '—' : x.days === 0 ? 'today' : `${x.days} day${x.days === 1 ? '' : 's'}`, x.days >= 7, x.days >= 7 ? K.red : K.ink]] })))
    : (p.text(M, y - 6, 'Nobody is waiting on you. Inbox zero.', 9, true, K.grn), y - 16);
  if (r.waitingList.length > 15) { p.text(M, y - 2, `+ ${r.waitingList.length - 15} more on your dashboard.`, 7, false, K.mut); y -= 10; }
  y -= 14; pSect(p, y, 'Collection'); y -= 18;
  const COVW = CW - 170, cell = COVW / w.dim;
  r.days.forEach((d, i) => p.rect(M + i * cell, y, cell - 1, 10, d.full ? K.grn : d.red != null ? K.org : K.rule));
  p.text(M + COVW + 12, y + 5, `${r.collected} of ${w.dim} days collected`, 8, true, K.ink);
  p.text(M + COVW + 12, y - 4, r.full < r.collected ? `${r.collected - r.full} with one inbox only (amber)` : 'both inboxes every day it ran', 6.6, false, K.mut);
  y -= 16; p.text(M, y, `Chrome extension ${r.ext.installed ? 'v' + r.ext.installed : 'unknown'}${r.ext.stale ? ` — out of date, v${r.ext.latest} available` : ' — current'}`, 7.4, r.ext.stale, r.ext.stale ? K.red : K.mut);
  y -= 22; pSect(p, y, `What to work on in ${w.nextName}`); y -= 26;
  for (const n of r.notes) { p.rect(M, y - 2, 3, 22, K.org); p.text(M + 12, y + 11, fit(n[0], true, 9, CW - 16), 9, true, K.ink); p.text(M + 12, y + 1, fit(n[1], false, 7.4, CW - 16), 7.4, false, K.mut); y -= 30; }
  y -= 4; pSect(p, y, 'How to read this report'); y -= 14;
  for (const l of ['Red = the contact spoke last and is waiting on you. Orange = you spoke last, awaiting their answer. Green = handled.',
    'Replies received = conversations that turned Red during the month. Handled = conversations you moved off Red.',
    'Backlog = Red conversations at the end of the day, counted only on days both inboxes were collected.',
    'Open pulse.gershoncrm.com to answer, star or tick off any conversation listed here.']) { p.text(M, y, l, 7, false, K.mut); y -= 11; }
  pFoot(p, foot, `${w.range}  ·  ${o.filename || ''}`);
  return p;
}

export function renderEstatePdf(e, o = {}) {
  const p = new Pdf(PW, PH), w = e.win;
  let y = pHead(p, 'Monthly report — all clients', w.label.toUpperCase(), o.generatedAt || '', 1, 1);
  if (o.sample) { p.rect(M, y - 16, CW, 12, rgb('#fef3c7')); p.text(M + 8, y - 12.5, o.sample, 6.6, true, K.orgD); y -= 14; }
  const verdict = e.dark.length
    ? { tone: 'warn', head: `${e.live} of ${e.clients.length} clients collected in ${w.name}.`, body: `${e.dark.map((x) => x.client.name).join(', ')} produced no data. ${e.improved} clients cut their backlog.` }
    : { tone: 'good', head: `Every client collected in ${w.name}.`, body: `${e.fires} replies, ${e.handled} handled. ${e.improved} of ${e.live} clients cut their backlog.` };
  y = pVerdict(p, y - 4, verdict);
  y -= 16; pSect(p, y, 'The month at a glance');
  y = pTiles(p, y - 8, [
    ['CLIENTS COLLECTING', `${e.live} / ${e.clients.length}`, e.dark.length ? `${e.dark.length} produced no data` : 'every client reported', e.dark.length ? K.red : K.grn],
    ['REPLIES RECEIVED', fmtN(e.fires), `across all clients in ${w.mon3}`, K.acc],
    ['REPLIES HANDLED', fmtN(e.handled), `${fmtN(e.arrivals)} new conversations`, K.grn],
    ['WAITING NOW', fmtN(e.awaiting), `backlog ${e.backlogStart} → ${e.backlogEnd}`, e.backlogEnd <= e.backlogStart ? K.grn : K.red]]);
  y -= 22; pSect(p, y, 'Clients'); y -= 14;
  const X = { name: M + 4, cov: M + 150, days: M + 300, rep: M + 342, han: M + 386, bl: M + 438, best: M + 450, ext: PW - M - 4 };
  p.rect(M, y - 5, CW, 15, K.tint);
  [['CLIENT', X.name], ['COVERAGE, DAY 1-' + w.dim, X.cov]].forEach(([l, x]) => p.text(x, y, l, 6.4, true, K.mut));
  [['DAYS', X.days], ['REPLIES', X.rep], ['HANDLED', X.han], ['BACKLOG', X.bl]].forEach(([l, x]) => p.rtext(x, y, l, 6.4, true, K.mut));
  p.text(X.best, y, 'BEST CAMPAIGN', 6.4, true, K.mut);
  y -= 6;
  // One page: the busiest 12 tenants; the email body lists every one.
  const shown = e.clients.slice().sort((a, b) => b.r.collected - a.r.collected || b.r.fires - a.r.fires).slice(0, 12);
  for (const { client, r } of shown) {
    y -= 26; p.line(M, y + 22, PW - M, K.rule, 0.5); const nc = r.collected ? K.ink : K.mut;
    p.text(X.name, y + 11, fit(client.name, true, 8.6, 140), 8.6, true, nc);
    p.text(X.name, y + 2, fit(`${client.status} · ${client.to[0] || 'no user'}`, false, 6.2, 140), 6.2, false, K.mut);
    const cell = 118 / w.dim; r.days.forEach((d, i) => p.rect(X.cov + i * cell, y + 7, cell - 0.9, 7, d.full ? K.grn : d.red != null ? K.org : K.rule));
    p.rtext(X.days, y + 8, `${r.collected}/${w.dim}`, 8, false, nc);
    p.rtext(X.rep, y + 8, String(r.fires), 8, true, nc); p.rtext(X.han, y + 8, String(r.handled), 8, false, nc);
    if (r.backlog.comparable) { p.rtext(X.bl, y + 11, `${r.backlog.start} → ${r.backlog.end}`, 8, true, nc); p.rtext(X.bl, y + 2, sgn(r.backlog.delta), 6.6, true, r.backlog.delta < 0 ? K.grn : r.backlog.delta > 0 ? K.red : K.mut); }
    else p.rtext(X.bl, y + 8, '—', 8, false, K.mut);
    p.text(X.best, y + 11, r.best ? fit(`${r.best.name} · ${r.best.rate}%`, true, 7.6, 80) : '—', 7.6, true, r.best ? K.acc : K.mut);
    p.text(X.best, y + 2, !r.collected ? 'no data' : r.ext.stale ? `ext v${r.ext.installed} — outdated` : `ext v${r.ext.installed}`, 6.2, r.ext.stale, r.ext.stale ? K.red : K.mut);
  }
  if (e.clients.length > shown.length) { y -= 12; p.text(M, y, `+ ${e.clients.length - shown.length} more clients — listed in the email`, 7, false, K.mut); }
  p.line(M, y - 2, PW - M, K.rule, 0.8);
  y -= 26; pSect(p, y, 'Needs attention'); y -= 28;
  const attn = [];
  if (e.dark.length) attn.push([`${e.dark.length} client${e.dark.length === 1 ? '' : 's'} produced no data.`, `${e.dark.map((x) => x.client.name).join(', ')} — the extension never synced this month.`]);
  if (e.stale.length) attn.push([`${e.stale.length} client${e.stale.length === 1 ? ' is' : 's are'} on an outdated extension.`, e.stale.map((x) => `${x.client.name} (v${x.r.ext.installed})`).join(', ')]);
  for (const x of e.worsened) attn.push([`${x.client.name}: backlog grew ${x.r.backlog.delta}.`, `${x.r.backlog.end} people waiting — ${x.r.waitingList.filter((q) => q.days >= 7).length} for more than a week.`]);
  if (!attn.length) attn.push(['Nothing needs attention.', 'Every client collected and every backlog went down.']);
  for (const n of attn.slice(0, 4)) { p.rect(M, y - 2, 3, 22, K.org); p.text(M + 12, y + 11, n[0], 9, true, K.ink); p.text(M + 12, y + 1, fit(n[1], false, 7.4, CW - 16), 7.4, false, K.mut); y -= 30; }
  y -= 2; pSect(p, y, 'Delivery'); y -= 14;
  p.text(M, y, `Each client received their own two-page report at their registered email. All ${e.clients.length} client PDFs are attached to this email.`, 7.4, false, K.mut);
  pFoot(p, 'Pulse  ·  pulse.gershoncrm.com', `${w.range}  ·  ${o.filename || ''}`);
  return p;
}
