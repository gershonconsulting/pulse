// functions/api/daily-report.js
// GET|POST /api/daily-report — the morning digest: "what happened yesterday?"
//
// WHAT THIS IS (and how it differs from its two siblings):
//   /api/report        — pipeline snapshot, fired by the extension after every sync.
//                        Answers "where do things stand right now?" Rolling 7-day window.
//   /api/health-check  — silent dead-man's-switch. Emails ONLY when collection has
//                        stopped. Answers "is the machine still breathing?"
//   /api/daily-report  — THIS FILE. Sends EVERY morning, healthy or not. Answers
//                        "did we make progress yesterday, and is anything broken?"
//                        It is not a watchdog: an email that only arrives when things
//                        are wrong is indistinguishable from an email that failed to
//                        send. This one arriving daily is itself the proof of life.
//
// Auth: shared secret (DAILY_REPORT_SECRET, falling back to HEALTH_CHECK_SECRET) —
// the repo is PUBLIC, so the value lives only in env vars, never in source.
// Listed in _middleware.js PUBLIC_PATHS because it carries its own credential.
//
// Query/body params:
//   secret  (required) — shared secret
//   date    YYYY-MM-DD — report on this local day instead of yesterday (backfill/testing)
//   dry     1|true     — build the report and return it, but send no email
//   tz      IANA zone  — override the report timezone (default America/New_York)
//   tenant  <id>       — report on ONE tenant only ('__default' = Gershon's own store)
//
// PER-TENANT (2026-09-02). This used to read the single `data` KV key and send one
// copy to a fixed address. Pulse is multi-tenant now: each client's conversations
// live under `data:<clientId>`, so one global email was BOTH wrong (it reported only
// Gershon's own store) and useless to a client (they never saw their own numbers).
// The run now loops the client registry and sends every tenant its own digest, to the
// email addresses that tenant's users actually sign in with — "the email registered
// in the profile". Nobody is emailed a number that is not theirs.

import { json, readData } from './_shared.js';
import { latestExtVersion, cmpVer } from '../_ext-version.js';
import { readAdminStore } from '../_admin.js';

const DEFAULT_TZ = 'America/New_York';
const PLATFORMS = [
  { key: 'linkedin-messaging', label: 'LinkedIn Messaging', short: 'LI' },
  { key: 'sales-navigator', label: 'Sales Navigator', short: 'SN' },
];

// ---------------------------------------------------------------------------
// Timezone helpers
//
// Workers ships full ICU, so Intl does the heavy lifting. The one thing Intl will
// NOT do is the inverse: given a local wall-clock date, what UTC instant is that?
// We solve it by measuring the zone's offset at a guessed instant, then correcting
// once — a second pass is enough because the only error source is a DST shift, and
// the corrected guess always lands on the right side of it.
// ---------------------------------------------------------------------------

function zoneOffsetMs(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  const hour = p.hour === '24' ? '00' : p.hour;
  const asIfUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return asIfUTC - instant.getTime();
}

// Local calendar date (YYYY-MM-DD) of a given instant, in tz.
function localYmd(instant, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

// UTC timestamp (ms) of local midnight starting the given YYYY-MM-DD in tz.
function dayStartMs(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  let ts = guess - zoneOffsetMs(new Date(guess), tz);
  ts = guess - zoneOffsetMs(new Date(ts), tz);
  return ts;
}

function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function prettyDay(ymd, tz) {
  return new Date(dayStartMs(ymd, tz) + 43200000).toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function shortDay(ymd, tz) {
  return new Date(dayStartMs(ymd, tz) + 43200000).toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'short', month: 'numeric', day: 'numeric',
  });
}

function fmtTime(iso, tz) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const ts = (v) => { const t = Date.parse(v || ''); return Number.isNaN(t) ? null : t; };

// A campaign needs at least this many contacts before its response rate is worth
// ranking. Below it, one reply swings the percentage by 20+ points and the
// "best campaign" line would be noise dressed up as a finding.
const MIN_CAMPAIGN_N = 5;

// A conversation counts as a reply the moment the collector has EVER classified it
// Red — not only while it is still Red. Live-Red alone undercounts badly: answering
// someone flips them Green and their reply silently stops being counted.
function everReplied(m) {
  if (m.status === 'Red') return true;
  return (m.statusHistory || []).some((h) => h.to === 'Red');
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export function buildReport(data, opts) {
  const tz = opts.tz || DEFAULT_TZ;
  const now = opts.now || new Date();
  const latestExt = opts.latestExt || '0';

  const todayYmd = localYmd(now, tz);
  const dayYmd = opts.date || shiftYmd(todayYmd, -1);
  const start = dayStartMs(dayYmd, tz);
  const end = dayStartMs(shiftYmd(dayYmd, 1), tz);

  const scans = Array.isArray(data.scans) ? data.scans : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const inWindow = (t) => t !== null && t >= start && t < end;

  // --- Did the machine run? ------------------------------------------------
  const scansYesterday = scans
    .filter((s) => inWindow(ts(s.timestamp)))
    .sort((a, b) => ts(a.timestamp) - ts(b.timestamp));

  const bySource = {};
  for (const s of scansYesterday) {
    const key = s.source || 'linkedin-messaging';
    (bySource[key] = bySource[key] || []).push(s);
  }
  const platforms = PLATFORMS.map((p) => {
    const list = bySource[p.key] || [];
    const last = list.length ? list[list.length - 1] : null;
    return {
      ...p,
      scans: list.length,
      conversations: last ? (last.count || 0) : 0,
      lastAt: last ? last.timestamp : null,
    };
  });
  const coveredPlatforms = platforms.filter((p) => p.scans > 0);

  // A "sync run" walks both inboxes, so scans cluster. Group scans <30min apart.
  let syncRuns = 0;
  let prevT = -Infinity;
  for (const s of scansYesterday) {
    const t = ts(s.timestamp);
    if (t - prevT > 30 * 60 * 1000) syncRuns++;
    prevT = t;
  }

  const lastScanEver = scans.length ? scans[0] : null;
  const lastScanT = lastScanEver ? ts(lastScanEver.timestamp) : null;
  const hoursSinceLastScan = lastScanT === null ? null : (now.getTime() - lastScanT) / 3600000;

  // --- What moved? ---------------------------------------------------------
  // statusHistory is the collector's own record of every status flip, timestamped.
  // It is the honest source for "what changed yesterday" — scan.diff summaries only
  // cover the 50 most recent transitions of a single scan.
  const moves = [];
  for (const m of messages) {
    for (const h of m.statusHistory || []) {
      const t = ts(h.timestamp);
      if (!inWindow(t)) continue;
      moves.push({
        name: m.name, from: h.from, to: h.to, at: h.timestamp, t,
        campaign: m.campaign || '', source: m.source || 'linkedin-messaging',
      });
    }
  }
  moves.sort((a, b) => a.t - b.t);

  const handled = moves.filter((m) => m.from === 'Red' && (m.to === 'Green' || m.to === 'Orange'));
  const newFires = moves.filter((m) => m.to === 'Red' && m.from !== 'Red');
  const otherMoves = moves.filter((m) => !handled.includes(m) && !newFires.includes(m));

  const arrivals = messages
    .filter((m) => inWindow(ts(m.firstSeenAt)))
    .map((m) => ({
      name: m.name, status: m.status, campaign: m.campaign || '',
      source: m.source || 'linkedin-messaging',
      snippet: (m.snippet || '').slice(0, 140), at: m.firstSeenAt,
    }))
    .sort((a, b) => ts(a.at) - ts(b.at));

  const closed = messages
    .filter((m) => m.done && inWindow(ts(m.doneAt)))
    .map((m) => ({ name: m.name, campaign: m.campaign || '', at: m.doneAt }))
    .sort((a, b) => ts(a.at) - ts(b.at));

  // --- Backlog trend -------------------------------------------------------
  // Per day, take the LAST scan of each platform and sum them: that is the pipeline
  // as the collector last saw it that day. Days with no scan report null, not zero —
  // "we did not look" must never render as "there is nothing there".
  function rollup(ymd) {
    const s0 = dayStartMs(ymd, tz);
    const s1 = dayStartMs(shiftYmd(ymd, 1), tz);
    let red = 0, orange = 0, green = 0, total = 0;
    const sources = [];
    for (const p of PLATFORMS) {
      const list = scans.filter((s) => (s.source || 'linkedin-messaging') === p.key)
        .filter((s) => { const t = ts(s.timestamp); return t !== null && t >= s0 && t < s1; })
        .sort((a, b) => ts(a.timestamp) - ts(b.timestamp));
      const last = list[list.length - 1];
      if (!last) continue;
      sources.push(p.key);
      red += last.red || 0; orange += last.orange || 0;
      green += last.green || 0; total += last.count || 0;
    }
    if (!sources.length) return { ymd, red: null, orange: null, green: null, total: null, sources: [], partial: true };
    return { ymd, red, orange, green, total, sources, partial: sources.length < PLATFORMS.length };
  }

  const trend = [];
  for (let i = 6; i >= 0; i--) trend.push(rollup(shiftYmd(dayYmd, -i)));

  // A day-over-day delta is only honest when both days looked at the SAME inboxes.
  // If Sales Navigator silently skipped yesterday, Red drops purely because half the
  // pipeline went uncounted — reporting that as "progress" would be a fabrication.
  const yRoll = trend[trend.length - 1];
  const coverageKey = (d) => (d && d.sources ? d.sources.join('|') : '');
  const prevRoll = [...trend.slice(0, -1)].reverse()
    .find((d) => d.red !== null && coverageKey(d) === coverageKey(yRoll)) || null;
  const prevAny = [...trend.slice(0, -1)].reverse().find((d) => d.red !== null) || null;
  const backlogComparable = !!(yRoll.red !== null && prevRoll);
  const backlogDelta = backlogComparable ? yRoll.red - prevRoll.red : null;

  // Live backlog, override-aware: Red and not ticked off. This is the number that
  // actually represents work owed, because a manual ✓ retires a conversation even
  // while the collector keeps classifying it Red.
  const followUpNeeded = messages.filter((m) => m.status === 'Red' && !m.done);
  const starred = messages.filter((m) => m.focus && !m.done);

  const followUps = followUpNeeded
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, 10)
    .map((m) => ({
      name: m.name, campaign: m.campaign || '', focus: !!m.focus,
      source: m.source || 'linkedin-messaging',
      snippet: (m.snippet || '').slice(0, 130),
    }));

  // --- Rolling windows: "did we move since last week?" ---------------------
  // Same partial-coverage honesty as the daily delta: a backlog number is only
  // comparable between two days that both looked at the SAME set of inboxes, so
  // the window endpoints are drawn from FULL-coverage days only. A week where
  // Sales Navigator never ran reports its movement counts and refuses its delta.
  function aggregateWindow(endYmd, days) {
    const s0 = dayStartMs(shiftYmd(endYmd, -(days - 1)), tz);
    const s1 = dayStartMs(shiftYmd(endYmd, 1), tz);
    const inW = (t) => t !== null && t >= s0 && t < s1;

    let handled = 0, newFires = 0, otherMoves = 0;
    for (const m of messages) {
      for (const h of m.statusHistory || []) {
        if (!inW(ts(h.timestamp))) continue;
        if (h.from === 'Red' && (h.to === 'Green' || h.to === 'Orange')) handled++;
        else if (h.to === 'Red' && h.from !== 'Red') newFires++;
        else otherMoves++;
      }
    }
    const arrivals = messages.filter((m) => inW(ts(m.firstSeenAt))).length;
    const closed = messages.filter((m) => m.done && inW(ts(m.doneAt))).length;

    const rolls = [];
    for (let i = days - 1; i >= 0; i--) rolls.push(rollup(shiftYmd(endYmd, -i)));
    const collectedDays = rolls.filter((d) => d.red !== null).length;
    const fullRolls = rolls.filter((d) => d.red !== null && !d.partial);
    const first = fullRolls[0] || null;
    const last = fullRolls.length ? fullRolls[fullRolls.length - 1] : null;
    const comparable = !!(first && last && first.ymd !== last.ymd);

    return {
      days,
      startYmd: shiftYmd(endYmd, -(days - 1)),
      endYmd,
      label: shortDay(shiftYmd(endYmd, -(days - 1)), tz) + ' – ' + shortDay(endYmd, tz),
      handled, newFires, otherMoves, arrivals, closed,
      collectedDays,
      fullDays: fullRolls.length,
      missedDays: days - collectedDays,
      backlogStart: comparable ? first.red : null,
      backlogEnd: comparable ? last.red : null,
      backlogFrom: comparable ? shortDay(first.ymd, tz) : null,
      backlogTo: comparable ? shortDay(last.ymd, tz) : null,
      backlogDelta: comparable ? last.red - first.red : null,
      comparable,
    };
  }

  const thisWeek = aggregateWindow(dayYmd, 7);
  const priorWeek = aggregateWindow(shiftYmd(dayYmd, -7), 7);
  const wow = (a, b) => (b === 0 ? (a === 0 ? 0 : null) : Math.round(((a - b) / b) * 100));

  let weekVerdict;
  if (thisWeek.collectedDays === 0) {
    weekVerdict = { tone: 'critical', headline: 'Nothing collected in the last 7 days', detail: 'Pulse has not recorded a single sync this week, so no week-over-week comparison exists.' };
  } else if (!thisWeek.comparable) {
    weekVerdict = {
      tone: 'warn',
      headline: 'Week not measurable — coverage was too patchy',
      detail: `Only ${thisWeek.collectedDays} of 7 days collected, and fewer than two of them covered both inboxes. ${thisWeek.handled} handled and ${thisWeek.newFires} new fires were still recorded, but the backlog cannot be compared across the week.`,
    };
  } else if (thisWeek.backlogDelta < 0) {
    weekVerdict = { tone: 'good', headline: `Yes — backlog down ${Math.abs(thisWeek.backlogDelta)} over the week`, detail: `${thisWeek.backlogStart} → ${thisWeek.backlogEnd} needing action (${thisWeek.backlogFrom} → ${thisWeek.backlogTo}). ${thisWeek.handled} handled against ${thisWeek.newFires} new fires.` };
  } else if (thisWeek.backlogDelta === 0) {
    weekVerdict = { tone: 'neutral', headline: 'Flat week — backlog unchanged', detail: `Still ${thisWeek.backlogEnd} needing action. ${thisWeek.handled} handled, ${thisWeek.newFires} new — they cancelled out.` };
  } else {
    weekVerdict = { tone: 'bad', headline: `Backlog grew ${thisWeek.backlogDelta} over the week`, detail: `${thisWeek.backlogStart} → ${thisWeek.backlogEnd} needing action. ${thisWeek.newFires} new fires against ${thisWeek.handled} handled.` };
  }

  // --- Campaign performance ------------------------------------------------
  const wStart = dayStartMs(thisWeek.startYmd, tz);
  const wEnd = dayStartMs(shiftYmd(dayYmd, 1), tz);
  const campMap = new Map();
  for (const m of messages) {
    const name = String(m.campaign || '').trim();
    if (!name) continue;
    let c = campMap.get(name);
    if (!c) {
      c = { name, total: 0, replied: 0, liveRed: 0, orange: 0, green: 0, done: 0,
            highFit: 0, highInterest: 0, newThisWeek: 0, repliesThisWeek: 0, handledThisWeek: 0 };
      campMap.set(name, c);
    }
    c.total++;
    if (m.status === 'Red') c.liveRed++;
    else if (m.status === 'Orange') c.orange++;
    else if (m.status === 'Green') c.green++;
    if (everReplied(m)) c.replied++;
    if (m.done) c.done++;
    if (String(m.fit || '').toLowerCase() === 'high') c.highFit++;
    if (String(m.interest || '').toLowerCase() === 'high') c.highInterest++;
    const fs = ts(m.firstSeenAt);
    if (fs !== null && fs >= wStart && fs < wEnd) c.newThisWeek++;
    for (const h of m.statusHistory || []) {
      const t = ts(h.timestamp);
      if (t === null || t < wStart || t >= wEnd) continue;
      if (h.to === 'Red' && h.from !== 'Red') c.repliesThisWeek++;
      else if (h.from === 'Red' && (h.to === 'Green' || h.to === 'Orange')) c.handledThisWeek++;
    }
  }
  const campaigns = [...campMap.values()].map((c) => ({
    ...c,
    responseRate: c.total ? Math.round((c.replied / c.total) * 100) : 0,
    awaitingRate: c.total ? Math.round((c.liveRed / c.total) * 100) : 0,
    ranked: c.total >= MIN_CAMPAIGN_N,
  })).sort((a, b) => (b.responseRate - a.responseRate) || (b.total - a.total));

  const rankedCampaigns = campaigns.filter((c) => c.ranked);
  const bestCampaign = rankedCampaigns[0] || null;
  const runnerUp = rankedCampaigns[1] || null;
  const worstCampaign = rankedCampaigns.length > 2 ? rankedCampaigns[rankedCampaigns.length - 1] : null;
  const hottestThisWeek = [...campaigns]
    .filter((c) => c.repliesThisWeek > 0)
    .sort((a, b) => b.repliesThisWeek - a.repliesThisWeek)[0] || null;

  // --- Extension version ---------------------------------------------------
  const versionsSeen = [...new Set(scansYesterday.map((s) => s.version).filter(Boolean))];
  const installedExt = (lastScanEver && lastScanEver.version) || null;
  const extOutdated = installedExt ? cmpVer(installedExt, latestExt) < 0 : false;
  const extUnknown = !installedExt;

  // --- Alerts --------------------------------------------------------------
  const alerts = [];
  if (scansYesterday.length === 0) {
    alerts.push({
      level: 'critical',
      title: 'Pulse did NOT run yesterday',
      body: hoursSinceLastScan === null
        ? 'No sync has ever been recorded. The collector has never reported in.'
        : `No sync was recorded for ${prettyDay(dayYmd, tz)}. The last successful sync was ${fmtTime(lastScanEver.timestamp, tz)} — ${Math.floor(hoursSinceLastScan)} hours ago.`,
      fix: 'Usual causes: Chrome was closed all day, the Pulse extension was disabled or removed, or you were signed out of LinkedIn. Open Chrome, sign in to LinkedIn, then run Sync Now from the extension or the dashboard Extension page.',
    });
  } else if (coveredPlatforms.length < PLATFORMS.length) {
    const missing = platforms.filter((p) => p.scans === 0).map((p) => p.label).join(' and ');
    alerts.push({
      level: 'warn',
      title: `Only part of the inbox was collected — ${missing} was skipped`,
      body: `${coveredPlatforms.map((p) => p.label).join(', ')} synced normally, but nothing came in from ${missing} yesterday.`,
      fix: `Most often a session issue: open ${missing} in the browser, confirm you are signed in and the inbox loads, then run Sync Now.`,
    });
  }

  if (extOutdated) {
    alerts.push({
      level: 'warn',
      title: `Chrome extension is out of date — v${installedExt} installed, v${latestExt} available`,
      body: 'An older collector can miss fields the dashboard expects (profile and thread links, language, grade) and will not have current fixes.',
      fix: 'Download the current build from the dashboard Extension page, then in chrome://extensions remove the old unpacked folder and load the new one.',
    });
  } else if (extUnknown && scansYesterday.length > 0) {
    alerts.push({
      level: 'warn',
      title: 'Collector did not report its version',
      body: 'Syncs are arriving, but without a version stamp — which means a build older than v1.6.0, predating version reporting.',
      fix: 'Update to the current build from the dashboard Extension page.',
    });
  }
  if (versionsSeen.length > 1) {
    alerts.push({
      level: 'warn',
      title: `Two different extension versions synced yesterday (${versionsSeen.join(', ')})`,
      body: 'More than one browser or machine is running the collector, and they are not on the same build.',
      fix: 'Update every machine to the current build so classification stays consistent.',
    });
  }

  // --- Is Pulse itself up to date? -----------------------------------------
  // Two separate questions that both live under "up to date", answered separately:
  // is the SOFTWARE current (extension build), and is the DATA current (last sync).
  const dataStale = hoursSinceLastScan === null || hoursSinceLastScan > 36;
  const softwareCurrent = !!installedExt && !extOutdated;
  const systemStatus = {
    dataFresh: !dataStale,
    hoursSinceLastScan,
    softwareCurrent,
    extInstalled: installedExt,
    extLatest: latestExt,
    dashboardVersion: opts.appVersion || null,
    overall: (scansYesterday.length === 0 || dataStale) ? 'critical'
      : (extOutdated || extUnknown || versionsSeen.length > 1 || coveredPlatforms.length < PLATFORMS.length) ? 'warn'
      : 'ok',
  };

  // --- Verdict -------------------------------------------------------------
  let verdict;
  if (scansYesterday.length === 0) {
    verdict = { tone: 'critical', headline: 'No — the system did not run', detail: 'Nothing was collected yesterday, so there is no progress to measure.' };
  } else if (backlogDelta === null && yRoll.partial) {
    const missing = platforms.filter((p) => p.scans === 0).map((p) => p.label).join(' and ');
    verdict = {
      tone: 'warn',
      headline: 'Cannot be measured &mdash; collection was incomplete',
      detail: `${handled.length} handled, ${newFires.length} new fires and ${arrivals.length} new conversations were recorded from what did sync. The backlog is not comparable to the previous day because ${missing} did not run.`,
    };
  } else if (backlogDelta === null) {
    verdict = { tone: 'neutral', headline: 'No comparable prior day', detail: `${moves.length} status changes and ${arrivals.length} new conversations recorded. Nothing earlier with matching coverage to measure against yet.` };
  } else if (backlogDelta < 0) {
    verdict = { tone: 'good', headline: `Yes — follow-up backlog down ${Math.abs(backlogDelta)}`, detail: `${prevRoll.red} → ${yRoll.red} needing action. ${handled.length} handled against ${newFires.length} new.` };
  } else if (backlogDelta === 0) {
    verdict = { tone: 'neutral', headline: 'Held even — backlog unchanged', detail: `Still ${yRoll.red} needing action. ${handled.length} handled, ${newFires.length} new — they cancelled out.` };
  } else {
    verdict = { tone: 'bad', headline: `Backlog grew by ${backlogDelta}`, detail: `${prevRoll.red} → ${yRoll.red} needing action. ${newFires.length} new against ${handled.length} handled.` };
  }

  // --- The four questions, answered in four lines ---------------------------
  // These mirror, one for one, the tiles on the dashboard's Health & Progress
  // panel — same inputs, same wording, so the email and the app never disagree.
  const tone2icon = { ok: '&#9989;', warn: '&#9888;', bad: '&#9888;', critical: '&#10060;', neutral: '&#9679;', good: '&#9989;' };
  const glance = [
    {
      q: 'Is Pulse up to date?',
      // "Up to date" is about the SOFTWARE build and the FRESHNESS of the data —
      // deliberately NOT about whether yesterday's run succeeded, which is the next
      // row's job. Conflating them makes a current extension read as broken.
      tone: (dataStale || !installedExt) ? 'critical'
        : (extOutdated || extUnknown || versionsSeen.length > 1) ? 'warn' : 'ok',
      answer: !installedExt ? 'Unknown — collector reports no version'
        : extOutdated ? `No — extension v${installedExt} installed, v${latestExt} available`
        : `Yes — extension v${installedExt}, the current build`,
      detail: hoursSinceLastScan === null ? 'No sync has ever been recorded.'
        : `Data last refreshed ${fmtTime(lastScanEver.timestamp, tz)} (${Math.floor(hoursSinceLastScan)}h ago).`,
    },
    {
      q: 'Did the daily collection succeed?',
      tone: scansYesterday.length === 0 ? 'critical' : (coveredPlatforms.length < PLATFORMS.length ? 'warn' : 'ok'),
      answer: scansYesterday.length === 0 ? 'No — nothing ran'
        : coveredPlatforms.length < PLATFORMS.length
          ? `Partly — only ${coveredPlatforms.map((p) => p.short).join(', ')} ran`
          : `Yes — ${syncRuns} sync run${syncRuns === 1 ? '' : 's'}, both inboxes`,
      detail: scansYesterday.length === 0
        ? 'No scan was written for this day.'
        : `${platforms.reduce((n, p) => n + p.conversations, 0)} conversations seen, last at ${fmtTime(scansYesterday[scansYesterday.length - 1].timestamp, tz)}.`,
    },
    {
      q: 'Was progress made since last week?',
      tone: weekVerdict.tone,
      answer: weekVerdict.headline.replace(/&mdash;/g, '\u2014'),
      detail: `${thisWeek.handled} handled vs ${priorWeek.handled} the week before &middot; ${thisWeek.arrivals} new conversations vs ${priorWeek.arrivals} &middot; ${thisWeek.collectedDays}/7 days collected.`,
    },
    {
      q: 'Which campaign performs best?',
      tone: bestCampaign ? 'ok' : 'neutral',
      answer: bestCampaign
        ? `${bestCampaign.name} — ${bestCampaign.responseRate}% reply rate`
        : (campaigns.length ? 'Not enough volume to rank yet' : 'No campaign codes found'),
      detail: bestCampaign
        ? `${bestCampaign.replied} replies from ${bestCampaign.total} contacts${runnerUp ? `; next best ${runnerUp.name} at ${runnerUp.responseRate}%` : ''}.`
        : (campaigns.length
            ? `Every campaign is under ${MIN_CAMPAIGN_N} contacts — too small for a rate to mean anything.`
            : 'Campaign codes (BD18, BD20…) are read off the outreach message; none were detected.'),
    },
  ];

  return {
    generatedAt: now.toISOString(),
    tz, day: dayYmd, dayLabel: prettyDay(dayYmd, tz),
    ran: scansYesterday.length > 0,
    verdict,
    alerts,
    activity: {
      syncRuns,
      scans: scansYesterday.length,
      platforms,
      conversationsScanned: platforms.reduce((n, p) => n + p.conversations, 0),
      firstSyncAt: scansYesterday.length ? scansYesterday[0].timestamp : null,
      lastSyncAt: scansYesterday.length ? scansYesterday[scansYesterday.length - 1].timestamp : null,
    },
    progress: {
      handled: handled.length,
      newFires: newFires.length,
      otherMoves: otherMoves.length,
      arrivals: arrivals.length,
      closed: closed.length,
      backlogDelta,
      backlogComparable,
      backlogYesterday: yRoll.red,
      backlogPrevious: prevRoll ? prevRoll.red : null,
      backlogPreviousAnyCoverage: prevAny ? prevAny.red : null,
      partialCoverage: !!yRoll.partial,
    },
    period: opts.period === 'week' ? 'week' : 'day',
    glance,
    glanceIcons: tone2icon,
    systemStatus,
    week: { ...thisWeek, verdict: weekVerdict },
    priorWeek,
    weekOverWeek: {
      handled: wow(thisWeek.handled, priorWeek.handled),
      newFires: wow(thisWeek.newFires, priorWeek.newFires),
      arrivals: wow(thisWeek.arrivals, priorWeek.arrivals),
      closed: wow(thisWeek.closed, priorWeek.closed),
    },
    campaigns: {
      minN: MIN_CAMPAIGN_N,
      all: campaigns,
      best: bestCampaign,
      runnerUp,
      worst: worstCampaign,
      hottestThisWeek,
    },
    trend: trend.map((d) => ({ ...d, label: shortDay(d.ymd, tz) })),
    trendNote: trend.some((d) => d.partial && d.red !== null)
      ? 'Days marked "partial" only had one of the two inboxes collected, so their totals undercount.'
      : null,
    detail: {
      handled: handled.slice(0, 15),
      newFires: newFires.slice(0, 15),
      arrivals: arrivals.slice(0, 15),
      closed: closed.slice(0, 15),
    },
    standing: {
      followUpNeeded: followUpNeeded.length,
      starred: starred.length,
      totalTracked: messages.length,
      followUps,
    },
    extension: {
      installed: installedExt,
      latest: latestExt,
      outdated: extOutdated,
      unknown: extUnknown,
      versionsSeen,
    },
    lastScan: lastScanEver
      ? { timestamp: lastScanEver.timestamp, source: lastScanEver.source, count: lastScanEver.count, version: lastScanEver.version || null }
      : null,
    hoursSinceLastScan,
  };
}

// ---------------------------------------------------------------------------
// Email rendering
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TONE = {
  critical: { bg: '#7f1d1d', fg: '#ffffff', accent: '#fecaca' },
  bad: { bg: '#fef2f2', fg: '#991b1b', accent: '#dc2626' },
  warn: { bg: '#fffbeb', fg: '#92400e', accent: '#d97706' },
  neutral: { bg: '#f3f4f6', fg: '#374151', accent: '#6b7280' },
  good: { bg: '#f0fdf4', fg: '#166534', accent: '#16a34a' },
};

function moveRows(list, tz) {
  return list.map((m) => `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#111827;">${esc(m.name)}${m.campaign ? ` <span style="color:#9ca3af;font-size:12px;">(${esc(m.campaign)})</span>` : ''}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#6b7280;white-space:nowrap;">${esc(m.from || 'new')} → <strong>${esc(m.to)}</strong></td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#9ca3af;white-space:nowrap;">${esc(fmtTime(m.at, tz))}</td>
    </tr>`).join('');
}

function section(title, inner, color) {
  return `<div style="background:#ffffff;padding:18px 20px;border-bottom:1px solid #e5e7eb;">
      <h2 style="margin:0 0 10px;font-size:15px;font-weight:600;color:${color || '#374151'};">${title}</h2>
      ${inner}
    </div>`;
}

function glanceBlock(r) {
  const rows = r.glance.map((g) => {
    const t = TONE[g.tone] || TONE.neutral;
    return `<tr>
        <td style="padding:11px 12px 11px 0;vertical-align:top;width:22px;font-size:15px;">${r.glanceIcons[g.tone] || '&#9679;'}</td>
        <td style="padding:11px 0;border-bottom:1px solid #f0f0f0;">
          <div style="font-size:12px;color:#6b7280;">${esc(g.q)}</div>
          <div style="font-size:15px;font-weight:700;color:${t.fg === '#ffffff' ? '#991b1b' : t.fg};line-height:1.35;margin-top:2px;">${esc(g.answer)}</div>
          <div style="font-size:12px;color:#9ca3af;margin-top:3px;line-height:1.45;">${g.detail}</div>
        </td>
      </tr>`;
  }).join('');
  return `<table width="100%" style="border-collapse:collapse;">${rows}</table>`;
}

function weekBlock(r) {
  const w = r.week, pw = r.priorWeek, wow = r.weekOverWeek;
  // The arrow always points the way the NUMBER moved; the colour says whether that
  // direction is good. Pointing a green arrow up at a number that fell reads as a
  // typo, however well-meant.
  const arrow = (n, goodUp) => {
    if (n === null) return '';
    if (n === 0) return ' <span style="color:#9ca3af;font-size:11px;">even</span>';
    const up = n > 0;
    const color = up === goodUp ? '#16a34a' : '#dc2626';
    return ` <span style="color:${color};font-size:11px;">${up ? '&#9650;' : '&#9660;'}${Math.abs(n)}%</span>`;
  };
  const row = (label, a, b, delta, goodUp) => `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#374151;">${label}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:15px;font-weight:700;text-align:right;color:#111827;">${a}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#9ca3af;">${b}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;">${arrow(delta, goodUp)}</td>
    </tr>`;
  const t = TONE[w.verdict.tone] || TONE.neutral;
  return `<div style="background:${t.bg};border-radius:8px;padding:12px 14px;margin-bottom:12px;">
      <div style="font-size:15px;font-weight:700;color:${t.fg === '#ffffff' ? '#991b1b' : t.fg};line-height:1.3;">${w.verdict.headline}</div>
      <div style="font-size:13px;color:${t.fg === '#ffffff' ? '#991b1b' : t.fg};opacity:.85;margin-top:4px;line-height:1.5;">${esc(w.verdict.detail)}</div>
    </div>
    <table width="100%" style="border-collapse:collapse;">
      <tr style="background:#f8f9fa;">
        <th style="padding:6px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;">Last 7 days</th>
        <th style="padding:6px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">${esc(w.label)}</th>
        <th style="padding:6px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">${esc(pw.label)}</th>
        <th style="padding:6px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Change</th>
      </tr>
      ${row('Handled &mdash; moved off Red', w.handled, pw.handled, wow.handled, true)}
      ${row('New fires &mdash; turned Red', w.newFires, pw.newFires, wow.newFires, false)}
      ${row('New conversations', w.arrivals, pw.arrivals, wow.arrivals, true)}
      ${row('Ticked off', w.closed, pw.closed, wow.closed, true)}
      ${row('Days collected', w.collectedDays + '/7' + (w.fullDays < w.collectedDays ? ` <span style="color:#d97706;font-size:11px;font-weight:400;">${w.fullDays} full</span>` : ''), pw.collectedDays + '/7', null, true)}
    </table>
    ${w.missedDays ? `<p style="margin:9px 0 0;font-size:12px;color:#d97706;">${w.missedDays} day${w.missedDays === 1 ? '' : 's'} this week had no sync at all &mdash; the counts above only cover the days that ran.</p>` : ''}
    ${(!w.missedDays && w.fullDays < w.collectedDays) ? `<p style="margin:9px 0 0;font-size:12px;color:#d97706;">${w.collectedDays - w.fullDays} day${w.collectedDays - w.fullDays === 1 ? '' : 's'} only collected one of the two inboxes. The backlog move is measured between ${esc(w.backlogFrom || '')} and ${esc(w.backlogTo || '')} &mdash; the days that covered both.</p>` : ''}`;
}

function campaignBlock(r) {
  const c = r.campaigns;
  if (!c.all.length) {
    return `<p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">No campaign codes detected. Pulse reads codes like <strong>BD18</strong> or <strong>BD20</strong> off the outreach message &mdash; if your sequences carry one, the leaderboard fills itself in on the next sync.</p>`;
  }
  const best = c.best;
  const head = best
    ? `<div style="background:#f0fdf4;border-radius:8px;padding:12px 14px;margin-bottom:12px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#16a34a;font-weight:700;">Best performing</div>
        <div style="font-size:18px;font-weight:700;color:#166534;margin-top:3px;">&#127942; ${esc(best.name)} &mdash; ${best.responseRate}% reply rate</div>
        <div style="font-size:13px;color:#166534;opacity:.85;margin-top:3px;line-height:1.5;">${best.replied} of ${best.total} contacts have replied${best.highFit ? `, ${best.highFit} rated High FIT` : ''}. ${best.liveRed} still waiting on you.</div>
      </div>`
    : `<div style="background:#f3f4f6;border-radius:8px;padding:12px 14px;margin-bottom:12px;font-size:13px;color:#374151;">Every campaign is under ${c.minN} contacts, which is too small for a reply rate to mean anything. Ranking starts once one crosses ${c.minN}.</div>`;

  const rows = c.all.map((x) => `<tr${x.ranked ? '' : ' style="opacity:.55;"'}>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;font-weight:700;color:#0077b5;">${esc(x.name)}${x === c.best ? ' &#127942;' : ''}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#374151;">${x.total}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#374151;">${x.replied}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;text-align:right;font-weight:700;color:${x.ranked ? '#111827' : '#9ca3af'};">${x.ranked ? x.responseRate + '%' : '&mdash;'}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#dc2626;">${x.liveRed}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#2563eb;">${x.repliesThisWeek || '&mdash;'}</td>
    </tr>`).join('');

  return `${head}
    <table width="100%" style="border-collapse:collapse;">
      <tr style="background:#f8f9fa;">
        <th style="padding:6px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;">Campaign</th>
        <th style="padding:6px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Contacts</th>
        <th style="padding:6px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Replied</th>
        <th style="padding:6px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Rate</th>
        <th style="padding:6px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Awaiting</th>
        <th style="padding:6px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">New reply 7d</th>
      </tr>${rows}
    </table>
    <p style="margin:10px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;">
      <strong>Replied</strong> counts every contact the collector has ever classified Red &mdash; answering someone turns them Green but their reply still counts here.
      <strong>Awaiting</strong> is how many are Red right now, waiting on you.
      Campaigns under ${c.minN} contacts are listed but not ranked.${c.hottestThisWeek ? ` Most new replies this week: <strong>${esc(c.hottestThisWeek.name)}</strong> (${c.hottestThisWeek.repliesThisWeek}).` : ''}
    </p>`;
}

export function renderEmail(r) {
  const tz = r.tz;
  const v = TONE[r.verdict.tone] || TONE.neutral;
  const isWeek = r.period === 'week';

  const alertBlocks = r.alerts.map((a) => {
    const isCrit = a.level === 'critical';
    const t = isCrit ? TONE.critical : TONE.warn;
    return `<div style="background:${t.bg};color:${t.fg};padding:${isCrit ? '20px' : '16px'} 20px;border-bottom:1px solid ${isCrit ? '#7f1d1d' : '#fde68a'};">
        <div style="font-size:${isCrit ? '19px' : '15px'};font-weight:700;line-height:1.35;">
          ${isCrit ? '&#9888;&#65039; ' : '&#9888; '}${esc(a.title)}
        </div>
        <div style="margin-top:7px;font-size:${isCrit ? '14px' : '13px'};line-height:1.5;${isCrit ? 'color:#fecaca;' : ''}">${esc(a.body)}</div>
        <div style="margin-top:7px;font-size:13px;line-height:1.5;${isCrit ? 'color:#fca5a5;' : 'color:#78350f;'}"><strong>What to do:</strong> ${esc(a.fix)}</div>
      </div>`;
  }).join('');

  const p = r.progress;
  const deltaTxt = p.backlogDelta === null ? '—'
    : p.backlogDelta === 0 ? 'even'
    : (p.backlogDelta < 0 ? '&#9660; ' : '&#9650; ') + Math.abs(p.backlogDelta);
  const deltaColor = p.backlogDelta === null ? '#6b7280'
    : p.backlogDelta < 0 ? '#16a34a' : p.backlogDelta > 0 ? '#dc2626' : '#6b7280';

  const cell = (val, label, color) => `<td style="text-align:center;padding:12px 6px;background:#f9fafb;border-radius:8px;">
      <div style="font-size:24px;font-weight:700;color:${color};line-height:1.1;">${val}</div>
      <div style="font-size:10px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.4px;">${label}</div>
    </td>`;
  const gap = '<td style="width:6px;"></td>';

  const scorecard = `<table width="100%" style="border-collapse:separate;border-spacing:0;">
      <tr>
        ${cell(p.handled, 'Handled', '#16a34a')}${gap}
        ${cell(p.newFires, 'New fires', '#dc2626')}${gap}
        ${cell(p.arrivals, 'New convos', '#2563eb')}${gap}
        ${cell(p.closed, 'Ticked off', '#7c3aed')}${gap}
        ${cell(deltaTxt, 'Backlog', deltaColor)}
      </tr>
    </table>`;

  const platRows = r.activity.platforms.map((pl) => `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;">${esc(pl.label)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;text-align:center;color:${pl.scans ? '#16a34a' : '#dc2626'};font-weight:600;">${pl.scans ? `${pl.scans} sync${pl.scans > 1 ? 's' : ''}` : 'none'}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;text-align:center;">${pl.scans ? pl.conversations : '—'}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#9ca3af;white-space:nowrap;">${esc(fmtTime(pl.lastAt, tz))}</td>
    </tr>`).join('');

  const maxRed = Math.max(1, ...r.trend.map((d) => d.red || 0));
  const trendRows = r.trend.map((d) => {
    const isDay = d.ymd === r.day;
    if (d.red === null) {
      return `<tr style="${isDay ? 'background:#fafafa;' : ''}">
        <td style="padding:5px 12px;font-size:13px;color:#9ca3af;${isDay ? 'font-weight:700;' : ''}">${esc(d.label)}</td>
        <td colspan="4" style="padding:5px 12px;font-size:12px;color:#dc2626;">no sync recorded</td>
      </tr>`;
    }
    const w = Math.max(2, Math.round((d.red / maxRed) * 100));
    return `<tr style="${isDay ? 'background:#f9fafb;' : ''}">
      <td style="padding:5px 12px;font-size:13px;color:#374151;${isDay ? 'font-weight:700;' : ''}">${esc(d.label)}${d.partial ? ' <span style="color:#d97706;font-size:11px;font-weight:600;">partial</span>' : ''}</td>
      <td style="padding:5px 12px;font-size:13px;text-align:right;color:#dc2626;font-weight:600;">${d.red}</td>
      <td style="padding:5px 12px;font-size:13px;text-align:right;color:#d97706;">${d.orange}</td>
      <td style="padding:5px 12px;font-size:13px;text-align:right;color:#16a34a;">${d.green}</td>
      <td style="padding:5px 12px;width:110px;">
        <div style="background:#f3f4f6;border-radius:3px;height:8px;width:100px;">
          <div style="background:#dc2626;border-radius:3px;height:8px;width:${w}px;"></div>
        </div>
      </td>
    </tr>`;
  }).join('');

  const followRows = r.standing.followUps.map((f) => `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">
        <strong style="font-size:14px;color:#111827;">${f.focus ? '&#9733; ' : ''}${esc(f.name)}</strong>${f.campaign ? ` <span style="color:#9ca3af;font-size:12px;">(${esc(f.campaign)})</span>` : ''}
        ${f.snippet ? `<br><span style="color:#6b7280;font-size:13px;">${esc(f.snippet)}</span>` : ''}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center;font-size:11px;color:#9ca3af;">${f.source === 'sales-navigator' ? 'SN' : 'LI'}</td>
    </tr>`).join('');

  const arrivalRows = r.detail.arrivals.map((a) => `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#111827;">${esc(a.name)}${a.campaign ? ` <span style="color:#9ca3af;font-size:12px;">(${esc(a.campaign)})</span>` : ''}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;text-align:center;color:#6b7280;">${esc(a.status)}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-size:11px;text-align:center;color:#9ca3af;">${a.source === 'sales-navigator' ? 'SN' : 'LI'}</td>
    </tr>`).join('');

  const ext = r.extension;
  const extLine = ext.outdated
    ? `<span style="color:#d97706;font-weight:600;">Extension v${esc(ext.installed)} &#8212; v${esc(ext.latest)} available</span>`
    : ext.unknown
      ? '<span style="color:#d97706;">Extension version not reported</span>'
      : `Extension v${esc(ext.installed)} (current)`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:20px;">

    <div style="background:linear-gradient(135deg,#0077b5,#005885);color:#ffffff;padding:22px 24px;border-radius:12px 12px 0 0;">
      <h1 style="margin:0;font-size:22px;font-weight:700;">${isWeek ? 'Pulse Weekly Review' : 'Pulse Daily Report'}</h1>
      <p style="margin:5px 0 0;opacity:.85;font-size:14px;">${isWeek ? esc(r.week.label) + ' &middot; week ending ' + esc(r.dayLabel) : esc(r.dayLabel)}</p>
    </div>

    ${alertBlocks}

    ${section('At a glance', glanceBlock(r), '#0077b5')}

    <div style="background:${v.bg};padding:18px 20px;border-bottom:1px solid #e5e7eb;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:${v.accent};font-weight:700;">Did we make progress?</div>
      <div style="margin-top:5px;font-size:19px;font-weight:700;color:${v.fg};line-height:1.3;">${r.verdict.headline}</div>
      <div style="margin-top:5px;font-size:14px;color:${v.fg};opacity:.85;line-height:1.5;">${esc(r.verdict.detail)}</div>
    </div>

    ${isWeek ? section('The week &mdash; and the week before', weekBlock(r), '#0077b5') : ''}

    ${section(isWeek ? 'Final day movement' : 'Yesterday&rsquo;s movement', scorecard)}

    ${section('Collection', `<table width="100%" style="border-collapse:collapse;">
        <tr style="background:#f8f9fa;">
          <th style="padding:6px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;">Platform</th>
          <th style="padding:6px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;">Synced</th>
          <th style="padding:6px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;">Convos</th>
          <th style="padding:6px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;">Last run</th>
        </tr>${platRows}
      </table>
      <p style="margin:10px 0 0;font-size:12px;color:#9ca3af;">${r.activity.syncRuns} sync run${r.activity.syncRuns === 1 ? '' : 's'} &middot; ${r.activity.conversationsScanned} conversations seen &middot; ${extLine}</p>`)}

    ${section('Follow-up backlog &mdash; last 7 days', `<table width="100%" style="border-collapse:collapse;">
        <tr style="background:#f8f9fa;">
          <th style="padding:6px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;">Day</th>
          <th style="padding:6px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Red</th>
          <th style="padding:6px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Orange</th>
          <th style="padding:6px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;">Green</th>
          <th></th>
        </tr>${trendRows}
      </table>${r.trendNote ? `<p style="margin:9px 0 0;font-size:12px;color:#9ca3af;">${esc(r.trendNote)}</p>` : ''}`)}

    ${isWeek ? '' : section('Since last week', weekBlock(r), '#0077b5')}

    ${section('Campaign performance', campaignBlock(r), '#7c3aed')}

    ${r.detail.handled.length ? section('Handled &mdash; moved off Red', `<table width="100%" style="border-collapse:collapse;">${moveRows(r.detail.handled, tz)}</table>`, '#166534') : ''}
    ${r.detail.newFires.length ? section('New fires &mdash; turned Red', `<table width="100%" style="border-collapse:collapse;">${moveRows(r.detail.newFires, tz)}</table>`, '#991b1b') : ''}
    ${r.detail.arrivals.length ? section('New conversations', `<table width="100%" style="border-collapse:collapse;">${arrivalRows}</table>`, '#1d4ed8') : ''}

    ${r.standing.followUps.length ? section(`Needs follow-up today (${r.standing.followUpNeeded} total${r.standing.starred ? `, ${r.standing.starred} starred` : ''})`, `<table width="100%" style="border-collapse:collapse;">${followRows}</table>${r.standing.followUpNeeded > r.standing.followUps.length ? `<p style="margin:10px 0 0;font-size:12px;color:#9ca3af;">+ ${r.standing.followUpNeeded - r.standing.followUps.length} more on the dashboard</p>` : ''}`, '#991b1b') : ''}

    <div style="background:#ffffff;padding:18px 20px;border-radius:0 0 12px 12px;text-align:center;">
      <a href="https://pulse.gershoncrm.com/app.html" style="display:inline-block;background:#0077b5;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:8px;">Open Pulse Dashboard</a>
      <p style="margin:12px 0 0;font-size:11px;color:#9ca3af;line-height:1.6;">
        Tracking ${r.standing.totalTracked} conversations &middot; last sync ${esc(fmtTime(r.lastScan && r.lastScan.timestamp, tz))}<br>
        Times in ${esc(tz)} &middot; generated ${esc(fmtTime(r.generatedAt, tz))}
      </p>
    </div>
  </div>
</body></html>`;
}

export function renderText(r) {
  const L = [];
  L.push(r.period === 'week' ? `PULSE WEEKLY REVIEW — ${r.week.label}` : `PULSE DAILY REPORT — ${r.dayLabel}`, '');
  L.push('AT A GLANCE');
  for (const g of r.glance) {
    L.push(`  ${g.q}`, `    ${g.answer}`, `    ${String(g.detail).replace(/&middot;/g, '·').replace(/&[a-z]+;/g, '')}`);
  }
  L.push('');
  for (const a of r.alerts) L.push(`${a.level === 'critical' ? '!! CRITICAL' : '! WARNING'}: ${a.title}`, `   ${a.body}`, `   What to do: ${a.fix}`, '');
  L.push(`PROGRESS: ${r.verdict.headline.replace(/&mdash;/g, '—')}`, `  ${r.verdict.detail}`, '');
  L.push(`Handled ${r.progress.handled} · New fires ${r.progress.newFires} · New conversations ${r.progress.arrivals} · Ticked off ${r.progress.closed}`);
  L.push(`Collection: ${r.activity.syncRuns} sync run(s), ${r.activity.conversationsScanned} conversations seen`);
  for (const p of r.activity.platforms) L.push(`  - ${p.label}: ${p.scans ? `${p.scans} sync(s), ${p.conversations} convos` : 'NO SYNC'}`);
  L.push(`Extension: v${r.extension.installed || 'unknown'}${r.extension.outdated ? ` (OUTDATED — v${r.extension.latest} available)` : ''}`);
  L.push('');
  L.push(`LAST 7 DAYS (${r.week.label}) vs (${r.priorWeek.label})`);
  L.push(`  ${r.week.verdict.headline.replace(/&mdash;/g, '—')}`);
  L.push(`  Handled ${r.week.handled} (was ${r.priorWeek.handled}) · New fires ${r.week.newFires} (was ${r.priorWeek.newFires}) · New convos ${r.week.arrivals} (was ${r.priorWeek.arrivals})`);
  L.push(`  Days collected ${r.week.collectedDays}/7`);
  L.push('');
  L.push('CAMPAIGNS');
  if (!r.campaigns.all.length) L.push('  no campaign codes detected');
  for (const c of r.campaigns.all) {
    L.push(`  ${c.name}: ${c.total} contacts · ${c.replied} replied · ${c.ranked ? c.responseRate + '%' : 'not ranked (<' + r.campaigns.minN + ')'} · ${c.liveRed} awaiting${c === r.campaigns.best ? '   <== best' : ''}`);
  }
  L.push('', `Needs follow-up: ${r.standing.followUpNeeded} of ${r.standing.totalTracked} tracked`, '', 'https://pulse.gershoncrm.com/app.html');
  return L.join('\n');
}

export function buildSubject(r) {
  const day = new Date(dayStartMs(r.day, r.tz) + 43200000)
    .toLocaleDateString('en-US', { timeZone: r.tz, month: 'long', day: 'numeric', year: 'numeric' });

  // Weekly edition: the convention wants the platform name and the DATE RANGE.
  if (r.period === 'week') {
    const fmt = (ymd) => new Date(dayStartMs(ymd, r.tz) + 43200000)
      .toLocaleDateString('en-US', { timeZone: r.tz, month: 'short', day: 'numeric' });
    const wbase = `Pulse LinkedIn Weekly Report — ${fmt(r.week.startYmd)}–${fmt(r.week.endYmd)}, ${new Date(dayStartMs(r.day, r.tz) + 43200000).toLocaleDateString('en-US', { timeZone: r.tz, year: 'numeric' })}`;
    if (r.week.collectedDays === 0) return `⚠ NO SYNC — ${wbase}`;
    if (r.alerts.some((a) => a.level === 'critical')) return `⚠ ${wbase}`;
    if (r.week.backlogDelta !== null && r.week.backlogDelta < 0) return `${wbase} (backlog -${Math.abs(r.week.backlogDelta)})`;
    if (r.week.backlogDelta !== null && r.week.backlogDelta > 0) return `⚠ Backlog up ${r.week.backlogDelta} — ${wbase}`;
    return wbase;
  }

  const base = `Pulse LinkedIn Report — ${day}`;
  if (!r.ran) return `⚠ NO SYNC — ${base}`;
  const crit = r.alerts.some((a) => a.level === 'critical');
  if (crit) return `⚠ ${base}`;
  if (r.alerts.length) return `⚠ Action needed — ${base}`;
  if (r.progress.backlogDelta !== null && r.progress.backlogDelta < 0) {
    return `${base} (backlog -${Math.abs(r.progress.backlogDelta)})`;
  }
  return base;
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
  if (supplied !== expected) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const dateParam = body.date || url.searchParams.get('date') || null;
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return json({ ok: false, error: 'bad_date', message: 'date must be YYYY-MM-DD' }, 400);
  }
  const periodRaw = String(body.period || url.searchParams.get('period') || 'day').toLowerCase();
  if (!['day', 'week'].includes(periodRaw)) {
    return json({ ok: false, error: 'bad_period', message: "period must be 'day' or 'week'" }, 400);
  }

  const dryRaw = body.dry != null ? body.dry : url.searchParams.get('dry');
  const dry = dryRaw === true || dryRaw === 1 || dryRaw === '1' || dryRaw === 'true';

  const tenantParam = (body.tenant || url.searchParams.get('tenant') || '').trim() || null;
  const tenants = await resolveTenants(env, tenantParam);

  if (!tenants.length) {
    return json({ ok: false, error: 'no_tenants', message: tenantParam
      ? `No tenant matched '${tenantParam}'.`
      : 'The client registry is empty and no default recipient is configured.' }, 404);
  }

  const opts = {
    tz: body.tz || url.searchParams.get('tz') || env.REPORT_TZ || DEFAULT_TZ,
    date: dateParam,
    period: periodRaw,
    latestExt: latestExtVersion(env),
  };

  if (!dry && !env.RESEND_API_KEY) {
    return json({ ok: false, sent: false, error: 'no_resend_key' }, 500);
  }

  // Sequential on purpose. A handful of tenants is not worth the fan-out, and one
  // tenant's failure (bad address, KV hiccup) must not abort the others' mail.
  const results = [];
  for (const t of tenants) {
    const row = { tenant: t.id || '__default', name: t.name, to: t.to, sent: false, error: null };
    try {
      const data = await readData(env.PULSE_KV, t.id);
      const report = buildReport(data, opts);
      row.subject = buildSubject(report);
      row.ran = report.ran;
      row.period = report.period;
      row.day = report.day;
      row.alerts = report.alerts.map((a) => ({ level: a.level, title: a.title }));
      row.progress = report.progress;
      if (dry) { row.report = report; results.push(row); continue; }

      // A tenant with nobody registered has no one to send to. Say so rather than
      // silently falling back to an ops address — a client with no users is a
      // registry problem to fix, not a report to reroute.
      if (!t.to.length) { row.error = 'no_recipient'; results.push(row); continue; }

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.EMAIL_FROM || 'Pulse <pulse@gershon.ai>',
          to: t.to,
          subject: row.subject,
          html: renderEmail(report),
          text: renderText(report),
        }),
      });
      if (res.ok) {
        row.sent = true;
      } else {
        const err = await res.json().catch(() => ({}));
        row.error = err.message || `HTTP ${res.status}`;
      }
    } catch (e) {
      row.error = e.message || String(e);
    }
    results.push(row);
  }

  const failures = results.filter((r) => !r.sent && !dry);
  return json({
    ok: dry || failures.length === 0,
    dry,
    period: periodRaw,
    tenants: results.length,
    sent: results.filter((r) => r.sent).length,
    failed: failures.length,
    results,
  }, (dry || failures.length === 0) ? 200 : 502);
}

/**
 * Who gets a digest, and at which address.
 *
 * The DEFAULT tenant is Gershon's own store — the original `data` key, which has no
 * registry record. Its registered addresses are the ALLOWLIST emails: the exact set
 * that can sign in to it. REPORT_EMAIL still overrides, so an ops-only address can be
 * forced without touching the registry.
 *
 * Every registry client contributes its own `users[].email` — the address that person
 * signs in with, so a client can never be mailed at an address that cannot open the
 * dashboard the mail links to. SUSPENDED clients are skipped: an expired trial should
 * not keep receiving weekly mail about an account it can no longer open.
 */
export async function resolveTenants(env, only) {
  const split = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const list = [];

  list.push({
    id: null,
    name: env.DEFAULT_TENANT_NAME || 'Gershon Consulting',
    status: 'active',
    to: split(env.REPORT_EMAIL || env.ALLOWLIST).filter((e) => e !== '*'),
  });

  let store = null;
  try {
    store = await readAdminStore(env);
  } catch (e) {
    store = null;   // no registry yet — the default tenant alone is a valid run
  }
  for (const c of (store && store.clients) || []) {
    if (c.status === 'suspended') continue;
    list.push({
      id: c.id,
      name: c.name || c.id,
      status: c.status,
      to: (c.users || []).map((u) => u && u.email).filter(Boolean),
    });
  }

  if (only) return list.filter((t) => (t.id || '__default') === only);
  return list;
}

export const onRequestPost = ({ request, env }) => handle(request, env);
export const onRequestGet = ({ request, env }) => handle(request, env);
