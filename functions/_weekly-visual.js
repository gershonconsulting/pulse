// functions/_weekly-visual.js — the Monday weekly report, visual edition (v5.16.0).
//
// One compact, colourful page: KPI tiles, pipeline mix, daily activity columns,
// backlog-by-day stacked columns, week-vs-week bars, campaign leaderboard and the
// top follow-ups. Everything is drawn with nested <table> cells (bgcolor + height),
// because Gmail strips <svg> and <canvas>, and Outlook ignores div heights.
//
// Input: the object returned by buildReport() in api/daily-report.js with period='week'.
// The daily digest keeps its own renderer (renderEmail) — this file is weekly-only.

const C = {
  brand: '#FE1B04', brandDark: '#d11200',
  red: '#e11d48', orange: '#f59e0b', green: '#16a34a',
  blue: '#2563eb', violet: '#7c3aed', teal: '#0d9488', pink: '#db2777',
  ink: '#1d1d1f', mute: '#6b7280', faint: '#9ca3af', line: '#e5e7eb', track: '#f1f2f4',
};
const RAINBOW = [C.violet, C.blue, C.teal, C.green, C.orange, C.pink, C.red, C.brand];

const TONES = {
  good: { bg: '#ecfdf3', fg: '#166534', bar: C.green, icon: '&#9650;' },
  neutral: { bg: '#f3f4f6', fg: '#374151', bar: C.faint, icon: '&#9679;' },
  warn: { bg: '#fffbeb', fg: '#92400e', bar: C.orange, icon: '&#9888;' },
  bad: { bg: '#fff1f2', fg: '#9f1239', bar: C.red, icon: '&#9660;' },
  critical: { bg: '#7f1d1d', fg: '#ffffff', bar: '#fecaca', icon: '&#9888;' },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Headlines from buildReport may already carry &mdash; entities; keep those, escape the rest.
function safeHtml(s) {
  return esc(String(s || '').replace(/&mdash;/g, '—').replace(/&middot;/g, '·'));
}

function fmtWhen(iso, tz) {
  if (!iso) return 'never';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return 'never';
  return t.toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// A solid block of colour, `w` x `h` px — the atom of every chart below.
function block(color, w, h, radius) {
  if (w <= 0 || h <= 0) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td width="${w}" height="${h}" bgcolor="${color}" style="width:${w}px;height:${h}px;background:${color};font-size:0;line-height:0;${radius ? `border-radius:${radius};` : ''}">&nbsp;</td></tr></table>`;
}

function card(title, inner, accent, sub) {
  return `<td valign="top" style="background:#ffffff;border:1px solid ${C.line};border-radius:12px;padding:14px 16px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${accent || C.brand};">${title}</div>
    ${sub ? `<div style="font-size:11px;color:${C.faint};margin-top:2px;">${sub}</div>` : ''}
    <div style="margin-top:10px;">${inner}</div>
  </td>`;
}
function row1(cell) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin-top:12px;"><tr>${cell}</tr></table>`;
}
function row2(a, b) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin-top:12px;"><tr>
    ${a.replace('<td ', '<td width="50%" ')}<td width="12" style="width:12px;"></td>${b.replace('<td ', '<td width="50%" ')}
  </tr></table>`;
}

function pill(pct, goodUp) {
  if (pct === null || pct === undefined) return `<span style="font-size:11px;color:${C.faint};">new</span>`;
  if (pct === 0) return `<span style="font-size:11px;color:${C.faint};">= last wk</span>`;
  const up = pct > 0;
  const good = up === goodUp;
  return `<span style="display:inline-block;font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;background:${good ? '#dcfce7' : '#ffe4e6'};color:${good ? '#166534' : '#9f1239'};">${up ? '&#9650;' : '&#9660;'} ${Math.abs(pct)}%</span>`;
}

function kpiTiles(r) {
  const w = r.week, pw = r.priorWeek, wow = r.weekOverWeek;
  const tile = (val, label, prev, delta, goodUp, color, tint) => `<td width="25%" valign="top" style="padding:0 4px;">
      <div style="background:${tint};border-radius:12px;padding:14px 10px;text-align:center;border-top:4px solid ${color};">
        <div style="font-size:30px;font-weight:800;color:${color};line-height:1;">${val}</div>
        <div style="font-size:11px;font-weight:700;color:${C.ink};margin-top:6px;text-transform:uppercase;letter-spacing:.4px;">${label}</div>
        <div style="margin-top:6px;">${pill(delta, goodUp)}</div>
        <div style="font-size:10px;color:${C.faint};margin-top:4px;">last week ${prev}</div>
      </div>
    </td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr>
    ${tile(w.handled, 'Handled', pw.handled, wow.handled, true, C.green, '#f0fdf4')}
    ${tile(w.newFires, 'New replies', pw.newFires, wow.newFires, true, C.red, '#fff1f2')}
    ${tile(w.arrivals, 'New convos', pw.arrivals, wow.arrivals, true, C.blue, '#eff6ff')}
    ${tile(w.closed, 'Ticked off', pw.closed, wow.closed, true, C.violet, '#f5f3ff')}
  </tr></table>`;
}

function mixCard(r) {
  const m = r.mix || { red: 0, orange: 0, green: 0 };
  const total = m.red + m.orange + m.green;
  const W = 250;
  let bar;
  if (!total) bar = block(C.track, W, 18, '6px');
  else {
    const parts = [[m.red, C.red], [m.orange, C.orange], [m.green, C.green]].filter((p) => p[0] > 0);
    let used = 0;
    const cells = parts.map(([n, col], i) => {
      const px = i === parts.length - 1 ? W - used : Math.max(4, Math.round((n / total) * W));
      used += px;
      return `<td width="${px}" height="18" bgcolor="${col}" style="width:${px}px;height:18px;background:${col};font-size:0;line-height:0;">&nbsp;</td>`;
    }).join('');
    bar = `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:6px;overflow:hidden;"><tr>${cells}</tr></table>`;
  }
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const leg = (n, col, label) => `<tr>
      <td style="padding:4px 0;width:14px;">${block(col, 10, 10, '3px')}</td>
      <td style="padding:4px 6px;font-size:12px;color:${C.ink};">${label}</td>
      <td style="padding:4px 0;font-size:13px;font-weight:800;color:${col};text-align:right;">${n}</td>
      <td style="padding:4px 0 4px 6px;font-size:11px;color:${C.faint};text-align:right;width:34px;">${pct(n)}%</td>
    </tr>`;
  const inner = `${bar}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;">
      ${leg(m.red, C.red, 'Your turn (Red)')}
      ${leg(m.orange, C.orange, 'Waiting / soft no')}
      ${leg(m.green, C.green, 'Handled (Green)')}
    </table>`;
  return card('Pipeline right now', inner, C.red, `${r.standing.totalTracked} conversations tracked`);
}

function collectionCard(r) {
  const days = r.dailyActivity || [];
  const trendBy = Object.fromEntries((r.trend || []).map((d) => [d.ymd, d]));
  const dots = days.map((d) => {
    const t = trendBy[d.ymd];
    const col = !d.synced ? C.red : (t && t.partial ? C.orange : C.green);
    const lab = String(d.label).split(',')[0].slice(0, 2);
    return `<td align="center" style="padding:0 2px;">
        <div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:${col};color:#fff;font-size:11px;font-weight:700;text-align:center;">${esc(lab)}</div>
      </td>`;
  }).join('');
  const w = r.week;
  const ext = r.extension;
  const inner = `<table role="presentation" cellpadding="0" cellspacing="0"><tr>${dots}</tr></table>
    <div style="margin-top:10px;font-size:22px;font-weight:800;color:${w.collectedDays === 7 ? C.green : w.collectedDays ? C.orange : C.red};">${w.collectedDays}<span style="font-size:13px;color:${C.faint};font-weight:600;">/7 days synced</span></div>
    <div style="font-size:11px;color:${C.mute};margin-top:4px;line-height:1.5;">
      <span style="color:${C.green};">&#9679;</span> both inboxes &nbsp;<span style="color:${C.orange};">&#9679;</span> one inbox &nbsp;<span style="color:${C.red};">&#9679;</span> no sync<br>
      ${ext.outdated ? `<span style="color:${C.orange};font-weight:700;">Extension v${esc(ext.installed)} &rarr; v${esc(ext.latest)} available</span>` : ext.installed ? `Extension v${esc(ext.installed)} &middot; up to date` : 'Extension version unknown'}
    </div>`;
  return card('Collection health', inner, C.teal, `Last sync ${esc(fmtWhen(r.lastScan && r.lastScan.timestamp, r.tz))}`);
}

// Grouped columns per day: handled / new replies / new conversations.
function activityChart(r) {
  const days = r.dailyActivity || [];
  const H = 90;
  const max = Math.max(1, ...days.flatMap((d) => [d.handled, d.newFires, d.arrivals]));
  const h = (n) => (n > 0 ? Math.max(3, Math.round((n / max) * H)) : 0);
  const cols = days.map((d) => `<td valign="bottom" align="center" style="padding:0 3px;">
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
        <td valign="bottom" style="padding:0 1px;"><div style="font-size:9px;color:${C.green};font-weight:700;text-align:center;">${d.handled || ''}</div>${block(C.green, 12, h(d.handled), '3px 3px 0 0')}</td>
        <td valign="bottom" style="padding:0 1px;"><div style="font-size:9px;color:${C.red};font-weight:700;text-align:center;">${d.newFires || ''}</div>${block(C.red, 12, h(d.newFires), '3px 3px 0 0')}</td>
        <td valign="bottom" style="padding:0 1px;"><div style="font-size:9px;color:${C.blue};font-weight:700;text-align:center;">${d.arrivals || ''}</div>${block(C.blue, 12, h(d.arrivals), '3px 3px 0 0')}</td>
      </tr></table>
    </td>`).join('');
  const labels = days.map((d) => `<td align="center" style="padding:6px 3px 0;font-size:10px;color:${d.synced ? C.mute : C.red};border-top:2px solid ${C.line};">${esc(String(d.label).split(',')[0])}</td>`).join('');
  const legend = `<span style="color:${C.green};">&#9632;</span> Handled &nbsp; <span style="color:${C.red};">&#9632;</span> New replies &nbsp; <span style="color:${C.blue};">&#9632;</span> New conversations`;
  const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr style="height:${H + 14}px;">${cols}</tr><tr>${labels}</tr>
    </table>
    <div style="font-size:11px;color:${C.mute};margin-top:8px;">${legend}</div>`;
  return card('Daily activity', inner, C.blue, 'What moved each day');
}

// Stacked columns per day: Red / Orange / Green from the last scan of each day.
function backlogChart(r) {
  const days = r.trend || [];
  const H = 90;
  const max = Math.max(1, ...days.map((d) => (d.total || ((d.red || 0) + (d.orange || 0) + (d.green || 0)))));
  const seg = (n, col) => (n > 0 ? block(col, 22, Math.max(2, Math.round((n / max) * H))) : '');
  const cols = days.map((d) => {
    if (d.red === null) {
      return `<td valign="bottom" align="center" style="padding:0 4px;"><div style="font-size:9px;color:${C.red};">no sync</div>${block(C.track, 22, 4)}</td>`;
    }
    return `<td valign="bottom" align="center" style="padding:0 4px;">
        <div style="font-size:10px;font-weight:800;color:${C.red};">${d.red}</div>
        ${seg(d.green, C.green)}${seg(d.orange, C.orange)}${seg(d.red, C.red)}
      </td>`;
  }).join('');
  const labels = days.map((d) => `<td align="center" style="padding:6px 2px 0;font-size:10px;color:${C.mute};border-top:2px solid ${C.line};">${esc(String(d.label).split(',')[0])}${d.partial && d.red !== null ? `<br><span style="color:${C.orange};">partial</span>` : ''}</td>`).join('');
  const w = r.week;
  const delta = w.backlogDelta;
  const deltaTxt = delta === null ? 'not comparable'
    : delta === 0 ? 'unchanged' : `${delta < 0 ? '&#9660;' : '&#9650;'} ${Math.abs(delta)} over the week`;
  const deltaCol = delta === null ? C.faint : delta < 0 ? C.green : delta > 0 ? C.red : C.mute;
  const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr style="height:${H + 16}px;">${cols}</tr><tr>${labels}</tr>
    </table>
    <div style="font-size:11px;color:${C.mute};margin-top:8px;"><span style="color:${C.red};">&#9632;</span> Your turn &nbsp;<span style="color:${C.orange};">&#9632;</span> Waiting &nbsp;<span style="color:${C.green};">&#9632;</span> Handled &nbsp;&middot;&nbsp; Backlog <strong style="color:${deltaCol};">${deltaTxt}</strong></div>`;
  return card('Pipeline by day', inner, C.orange, 'Number on top = conversations waiting on you');
}

// Paired horizontal bars: this week (colour) vs last week (grey).
function weekVsWeek(r) {
  const w = r.week, pw = r.priorWeek;
  const rows = [
    ['Handled', w.handled, pw.handled, C.green],
    ['New replies', w.newFires, pw.newFires, C.red],
    ['New conversations', w.arrivals, pw.arrivals, C.blue],
    ['Ticked off', w.closed, pw.closed, C.violet],
  ];
  const max = Math.max(1, ...rows.flatMap((x) => [x[1], x[2]]));
  const W = 140;
  const px = (n) => (n > 0 ? Math.max(3, Math.round((n / max) * W)) : 0);
  const body = rows.map(([label, a, b, col]) => `<tr>
      <td style="padding:5px 8px 5px 0;font-size:12px;color:${C.ink};white-space:nowrap;width:110px;">${label}</td>
      <td style="padding:5px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td>${block(col, px(a), 10, '0 4px 4px 0') || block(C.track, 3, 10)}</td><td style="padding-left:6px;font-size:12px;font-weight:800;color:${col};">${a}</td></tr></table>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:3px;"><tr><td>${block('#d1d5db', px(b), 6, '0 3px 3px 0') || block(C.track, 3, 6)}</td><td style="padding-left:6px;font-size:10px;color:${C.faint};">${b}</td></tr></table>
      </td>
    </tr>`).join('');
  return card('This week vs last week', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>
    <div style="font-size:11px;color:${C.faint};margin-top:6px;">Coloured = ${esc(w.label)} &middot; grey = ${esc(pw.label)}</div>`, C.violet);
}

function campaignChart(r) {
  const c = r.campaigns;
  if (!c.all.length) {
    return card('Campaign leaderboard', `<div style="font-size:12px;color:${C.mute};line-height:1.6;">No campaign codes detected yet. Pulse reads codes like <strong>BD18</strong> off your outreach messages &mdash; the leaderboard fills in on the next sync.</div>`, C.pink);
  }
  const ranked = c.all.filter((x) => x.ranked).slice(0, 6);
  const unranked = c.all.length - c.all.filter((x) => x.ranked).length;
  const W = 110;
  const maxRate = Math.max(1, ...ranked.map((x) => x.responseRate));
  const body = ranked.length ? ranked.map((x, i) => {
    const col = RAINBOW[i % RAINBOW.length];
    const px = Math.max(4, Math.round((x.responseRate / maxRate) * W));
    return `<tr>
      <td style="padding:5px 8px 5px 0;font-size:12px;font-weight:800;color:${col};white-space:nowrap;width:90px;">${i === 0 ? '&#127942; ' : ''}${esc(x.name)}</td>
      <td style="padding:5px 0;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td>${block(col, px, 14, '0 6px 6px 0')}</td>
        <td style="padding-left:8px;font-size:13px;font-weight:800;color:${C.ink};white-space:nowrap;">${x.responseRate}%</td>
      </tr></table></td>
      <td style="padding:5px 0 5px 8px;font-size:11px;color:${C.mute};white-space:nowrap;text-align:right;">${x.replied}/${x.total} replied${x.repliesThisWeek ? ` &middot; <span style="color:${C.red};font-weight:700;">+${x.repliesThisWeek} this wk</span>` : ''}</td>
    </tr>`;
  }).join('') : `<tr><td style="font-size:12px;color:${C.mute};">Every campaign is under ${c.minN} contacts &mdash; too small to rank yet.</td></tr>`;
  const note = `Reply rate = contacts who ever replied &divide; contacts reached.${unranked ? ` ${unranked} campaign${unranked === 1 ? '' : 's'} under ${c.minN} contacts not ranked.` : ''}${c.hottestThisWeek ? ` Hottest this week: <strong>${esc(c.hottestThisWeek.name)}</strong> (${c.hottestThisWeek.repliesThisWeek} new replies).` : ''}`;
  return card('Campaign leaderboard', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>
    <div style="font-size:11px;color:${C.faint};margin-top:8px;line-height:1.5;">${note}</div>`, C.pink);
}

function followUpCard(r) {
  const list = (r.standing.followUps || []).slice(0, 5);
  if (!list.length) {
    return card('Waiting on you', `<div style="font-size:14px;font-weight:700;color:${C.green};">&#10003; Inbox zero &mdash; nobody is waiting on a reply.</div>`, C.green);
  }
  const items = list.map((f, i) => `<tr>
      <td style="padding:7px 0;border-bottom:${i === list.length - 1 ? '0' : `1px solid ${C.track}`};">
        <span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${C.red};"></span>
        <strong style="font-size:13px;color:${C.ink};margin-left:6px;">${f.focus ? '&#9733; ' : ''}${esc(f.name)}</strong>
        ${f.campaign ? `<span style="font-size:10px;font-weight:700;color:#fff;background:${C.violet};border-radius:999px;padding:1px 7px;margin-left:4px;">${esc(f.campaign)}</span>` : ''}
        <span style="font-size:10px;color:${C.faint};margin-left:4px;">${f.source === 'sales-navigator' ? 'Sales Nav' : 'LinkedIn'}</span>
        ${f.snippet ? `<div style="font-size:12px;color:${C.mute};margin:3px 0 0 14px;line-height:1.4;">${esc(f.snippet.slice(0, 110))}</div>` : ''}
      </td>
    </tr>`).join('');
  const more = r.standing.followUpNeeded - list.length;
  return card(`Waiting on you &middot; ${r.standing.followUpNeeded}`, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
    ${more > 0 ? `<div style="font-size:11px;color:${C.faint};margin-top:6px;">+ ${more} more on the dashboard</div>` : ''}`, C.red);
}

function alertStrip(r) {
  if (!r.alerts.length) return '';
  return r.alerts.map((a) => {
    const crit = a.level === 'critical';
    return `<div style="margin-top:12px;background:${crit ? '#7f1d1d' : '#fffbeb'};color:${crit ? '#fff' : '#92400e'};border-left:5px solid ${crit ? '#fecaca' : C.orange};border-radius:10px;padding:12px 14px;">
      <div style="font-size:14px;font-weight:800;">&#9888; ${esc(a.title)}</div>
      <div style="font-size:12px;margin-top:4px;line-height:1.5;opacity:.9;"><strong>What to do:</strong> ${esc(a.fix)}</div>
    </div>`;
  }).join('');
}

export function renderWeeklyEmail(r) {
  const w = r.week;
  const v = TONES[w.verdict.tone] || TONES.neutral;
  const best = r.campaigns.best;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pulse Weekly Report</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.ink};">
<div style="max-width:680px;margin:0 auto;padding:18px 14px;">

  <div style="background:${C.brand};background:linear-gradient(135deg,${C.brand} 0%,${C.brandDark} 60%,#7c0a00 100%);border-radius:14px;padding:20px 22px;color:#fff;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="top">
        <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;opacity:.85;font-weight:700;">Pulse by Gershon.AI</div>
        <div style="font-size:24px;font-weight:800;margin-top:4px;">Weekly Report</div>
        <div style="font-size:13px;opacity:.9;margin-top:3px;">${esc(w.label)} &middot; week ending ${esc(r.dayLabel)}</div>
      </td>
      <td valign="top" align="right" style="white-space:nowrap;">
        <div style="font-size:34px;font-weight:800;line-height:1;">${r.standing.followUpNeeded}</div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;opacity:.85;margin-top:3px;">waiting on you</div>
      </td>
    </tr></table>
  </div>

  ${alertStrip(r)}

  <div style="margin-top:12px;background:${v.bg};border-radius:12px;padding:14px 16px;border-left:6px solid ${v.bar};">
    <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${v.fg};opacity:.8;">Did the week move?</div>
    <div style="font-size:18px;font-weight:800;color:${v.fg};margin-top:3px;line-height:1.3;">${safeHtml(w.verdict.headline)}</div>
    <div style="font-size:12px;color:${v.fg};opacity:.85;margin-top:4px;line-height:1.5;">${safeHtml(w.verdict.detail)}${best ? ` Best campaign: <strong>${esc(best.name)}</strong> at ${best.responseRate}%.` : ''}</div>
  </div>

  ${kpiTiles(r)}
  ${row2(mixCard(r), collectionCard(r))}
  ${row2(activityChart(r), backlogChart(r))}
  ${row2(weekVsWeek(r), campaignChart(r))}
  ${row1(followUpCard(r))}

  <div style="text-align:center;margin-top:16px;">
    <a href="https://pulse.gershoncrm.com/app.html" style="display:inline-block;background:${C.brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 24px;border-radius:999px;">Open Pulse Dashboard &rarr;</a>
    <div style="font-size:10px;color:${C.faint};margin-top:10px;line-height:1.6;">
      Sent every Monday by Pulse &middot; times in ${esc(r.tz)} &middot; generated ${esc(fmtWhen(r.generatedAt, r.tz))}
    </div>
  </div>
</div>
</body></html>`;
}
