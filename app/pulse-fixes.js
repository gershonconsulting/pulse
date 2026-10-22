/* =====================================================================
   Pulse v5.15.0 (2026-10-22 nightly) - Olivier's 2026-10-04 feedback
   Loaded into /app.html by functions/_middleware.js (themeInject), after
   the page's own script, so app.html (244 KB) is not re-uploaded.

   1. "Open in Sales Nav" links: one link builder (window.PulseLinks) that
      always lands in the right product:
        Sales Navigator record -> the captured SN thread (/sales/inbox/<id>)
                               -> else the SN lead page (/sales/lead/<id>)
                               -> else an SN people search by name (+ company)
        LinkedIn record        -> the captured thread -> profile -> search
      It also repairs stored links: doubled hosts ("linkedin.comhttps://..."),
      relative paths, tracking query strings, and an SN inbox URL without a
      usable thread id. It never sends a Sales Navigator record to a
      LinkedIn Messaging search (that was the old last-resort fallback).
      Overrides the page's global threadLink() / personLink(), so every
      link (Conversations, hot leads, Suggested replies) uses it.
   2. Reports page rebuilt from data the app already loads (allMessages,
      allScans): period switch, totals vs the previous period, weekly
      trend, triage breakdown, platform and campaign tables, top items,
      month-by-month history.
   3. Settings: Diagnostics + About sit in a collapsed "Advanced" section
      (the wrapping is done server-side in _middleware.js; nothing deleted).
   ===================================================================== */
(function () {
  'use strict';
  var LI = 'https://www.linkedin.com';

  /* ------------------------------------------------------------------ *
   * 1. LINKS
   * ------------------------------------------------------------------ */
  function cleanUrl(u) {
    if (!u) return '';
    u = String(u).trim();
    // "https://www.linkedin.comhttps://www.linkedin.com/sales/..." -> last absolute URL wins
    var i = u.lastIndexOf('https://');
    if (i > 0) u = u.slice(i);
    if (u.indexOf('//') === 0) u = 'https:' + u;
    if (u.charAt(0) === '/') u = LI + u;
    if (!/^https?:\/\/([a-z0-9-]+\.)*linkedin\.com(\/|$)/i.test(u)) return '';
    return u.replace(/^http:/i, 'https:');
  }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  // Sales Navigator thread id from any stored inbox URL. LinkedIn thread ids are
  // URL-safe base64 ("2-ZTk0...==" style); anything else (an empty path, a
  // "?" fragment, an internal list key) is not a deep link.
  function snThreadId(u) {
    var m = cleanUrl(u).match(/\/sales\/inbox\/([^/?#]+)/);
    if (!m) return '';
    var id = safeDecode(m[1]);
    return (/^[A-Za-z0-9_-]{8,}={0,2}$/.test(id)) ? id : '';
  }
  function liThreadId(u) {
    var m = cleanUrl(u).match(/\/messaging\/thread\/([^/?#]+)/);
    if (!m) return '';
    var id = safeDecode(m[1]);
    return (/^[A-Za-z0-9_:%.=-]{6,}$/.test(id)) ? id : '';
  }
  // Sales Navigator lead: /sales/lead/<id>[,<authType>,<authToken>] (also /sales/people/).
  // Keep the auth triplet when it was captured: Sales Navigator uses it to open
  // out-of-network leads.
  function snLeadPath(u) {
    var m = cleanUrl(u).match(/\/sales\/(?:lead|people)\/([^/?#]+)/);
    if (!m) return '';
    var seg = safeDecode(m[1]);
    var id = seg.split(',')[0];
    if (!/^AC[A-Za-z0-9_-]{10,}$/.test(id)) return '';
    return '/sales/lead/' + seg;
  }
  function liProfile(u) {
    var c = cleanUrl(u);
    var m = c.match(/\/in\/([^/?#]+)/);
    return m ? LI + '/in/' + m[1] + '/' : '';
  }
  function companyOf(m) {
    return String(m.company || m.companyName || m.organization || '').trim();
  }
  // Sales Navigator people search, in the URL shape Sales Navigator itself writes
  // (query=(spellCorrectionEnabled:true,keywords:...) with the keywords double-encoded).
  function snSearch(name, company) {
    var kw = [name, company].filter(Boolean).join(' ')
      .replace(/['’]/g, '').replace(/[(),:"!*]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!kw) return LI + '/sales/search/people';
    return LI + '/sales/search/people?query=(spellCorrectionEnabled%3Atrue%2Ckeywords%3A' +
      encodeURIComponent(encodeURIComponent(kw)) + ')';
  }
  function liSearch(name, company) {
    var kw = [name, company].filter(Boolean).join(' ').trim();
    return LI + '/search/results/people/?keywords=' + encodeURIComponent(kw);
  }
  function platformOfRec(m) {
    if (m.platform === 'sales-navigator' || m.platform === 'linkedin') return m.platform;
    var c = String(m.conversationLink || '') + ' ' + String(m.snConversationLink || '');
    return c.indexOf('/sales/') > -1 ? 'sales-navigator' : 'linkedin';
  }

  // Returns { platform, thread: {href, kind, label}, profile: {href, kind, label} }.
  function linksFor(m) {
    m = m || {};
    var pf = platformOfRec(m);
    var name = String(m.name || '').trim();
    var company = companyOf(m);
    var snT = snThreadId(m.snConversationLink) || snThreadId(m.conversationLink);
    var snL = snLeadPath(m.snProfileUrl) || snLeadPath(m.profileUrl);
    var liT = liThreadId(m.conversationLink);
    var liP = liProfile(m.profileUrl);
    var thread, profile;

    if (pf === 'sales-navigator') {
      if (snT) thread = { href: LI + '/sales/inbox/' + snT, kind: 'sn-thread', label: 'Sales Navigator conversation' };
      else if (snL) thread = { href: LI + snL, kind: 'sn-lead', label: 'Sales Navigator lead page (no thread captured)' };
      else thread = { href: snSearch(name, company), kind: 'sn-search', label: 'Sales Navigator search by name' + (company ? ' + company' : '') };
      if (snL) profile = { href: LI + snL, kind: 'sn-lead', label: 'Sales Navigator lead page' };
      else if (liP) profile = { href: liP, kind: 'li-profile', label: 'LinkedIn profile' };
      else profile = { href: snSearch(name, company), kind: 'sn-search', label: 'Sales Navigator search by name' + (company ? ' + company' : '') };
    } else {
      if (liT) thread = { href: LI + '/messaging/thread/' + liT + '/', kind: 'li-thread', label: 'LinkedIn conversation' };
      else if (liP) thread = { href: liP, kind: 'li-profile', label: 'LinkedIn profile (no thread captured)' };
      else thread = { href: LI + '/messaging/?searchString=' + encodeURIComponent(name), kind: 'li-search', label: 'LinkedIn Messaging search by name' };
      if (liP) profile = { href: liP, kind: 'li-profile', label: 'LinkedIn profile' };
      else if (liT) profile = { href: LI + '/messaging/thread/' + liT + '/', kind: 'li-thread', label: 'LinkedIn conversation' };
      else profile = { href: liSearch(name, company), kind: 'li-search', label: 'LinkedIn people search by name' };
    }
    return { platform: pf, thread: thread, profile: profile };
  }

  window.PulseLinks = {
    linksFor: linksFor, cleanUrl: cleanUrl, snThreadId: snThreadId, snLeadPath: snLeadPath,
    snSearch: snSearch, liThreadId: liThreadId,
  };
  // The page calls these globals by name at render time, so replacing them
  // re-points every existing link builder.
  window.threadLink = function (m) { return linksFor(m).thread.href; };
  window.personLink = function (m) { return linksFor(m).profile.href; };

  // Add a plain-language tooltip to the "Open in Sales Nav" chip when it falls
  // back to the lead page or a search, so a click never surprises.
  function titleChips(root) {
    if (!root || !root.querySelectorAll || typeof allMessages === 'undefined') return;
    var byName = null;
    root.querySelectorAll('.message-item[data-name]').forEach(function (row) {
      var chip = row.querySelector('.msg-link-chip--chat');
      if (!chip || chip.title) return;
      if (!byName) { byName = {}; allMessages.forEach(function (m) { byName[m.name] = m; }); }
      var m = byName[row.getAttribute('data-name')];
      if (!m) return;
      var l = linksFor(m).thread;
      chip.title = 'Opens: ' + l.label;
      chip.setAttribute('data-link-kind', l.kind);
    });
  }
  function watchList() {
    var list = document.getElementById('message-list');
    if (!list || !window.MutationObserver) return;
    new MutationObserver(function () { titleChips(list); }).observe(list, { childList: true });
    titleChips(list);
  }

  /* ------------------------------------------------------------------ *
   * 2. REPORTS
   * ------------------------------------------------------------------ */
  var DAY = 86400000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var PERIODS = [
    { key: '7d', label: 'Last 7 days' },
    { key: 'month', label: 'This month' },
    { key: 'lastmonth', label: 'Last month' },
    { key: 'year', label: 'This year' },
    { key: 'all', label: 'All time' },
  ];
  var repPeriod = 'month';
  try { var saved = localStorage.getItem('pulse_report_period'); if (saved && PERIODS.some(function (p) { return p.key === saved; })) repPeriod = saved; } catch (e) { /* storage blocked */ }

  function h(s) { return (typeof esc === 'function') ? esc(s == null ? '' : String(s)) : String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ha(s) { return (typeof escapeAttr === 'function') ? escapeAttr(s == null ? '' : String(s)) : h(s); }
  function toDate(v) { if (!v) return null; var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function msgDate(v) {
    if (!v) return null;
    if (typeof parseMsgDate === 'function') return parseMsgDate(v);
    return toDate(v);
  }
  function stOf(m) { return (typeof normalizeStatus === 'function') ? normalizeStatus(m.status) : String(m.status || 'Red'); }

  // When did the conversation last move? The list date LinkedIn shows ("Oct 3"),
  // else when the collector saw it. A bare clock time ("10:42 AM") means today.
  function lastActivity(m) {
    var s = String(m.date || '');
    var d = null;
    if (s && !/^\d{1,2}:\d{2}/.test(s) && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/i.test(s)) d = msgDate(s);
    return d || toDate(m.collectedAt) || toDate(m.updatedAt) || toDate(m.firstSeenAt);
  }
  function firstSeen(m) { return toDate(m.firstSeenAt) || lastActivity(m); }
  // The lead has written back at some point: they spoke last, they declined
  // (Orange = a reply), or the record was Red at any time in its history.
  function replied(m) {
    var st = stOf(m);
    if (m.lastSender === 'them') return true;
    if (st === 'Red' || st === 'Orange') return true;
    return (m.statusHistory || []).some(function (x) { return x.from === 'Red' || x.to === 'Red' || x.to === 'Orange'; });
  }
  // When it was handled: the check (doneAt) or a scan that moved it off Red.
  function handledAt(m) {
    var t = m.done ? toDate(m.doneAt) : null;
    (m.statusHistory || []).forEach(function (x) {
      if (x.from === 'Red' && (x.to === 'Green' || x.to === 'Orange')) {
        var d = toDate(x.timestamp);
        if (d && (!t || d > t)) t = d;
      }
    });
    return t;
  }

  function periodRange(key, now) {
    now = now || new Date();
    var y = now.getFullYear(), mo = now.getMonth();
    var end = new Date(now.getTime() + 1);
    if (key === '7d') {
      var s7 = new Date(now.getTime() - 7 * DAY);
      return { start: s7, end: end, prev: { start: new Date(s7.getTime() - 7 * DAY), end: s7 }, prevLabel: 'previous 7 days' };
    }
    if (key === 'month') {
      var sm = new Date(y, mo, 1);
      var ps = new Date(y, mo - 1, 1);
      var pe = new Date(Math.min(new Date(y, mo, 1).getTime(), ps.getTime() + (end - sm)));
      return { start: sm, end: end, prev: { start: ps, end: pe }, prevLabel: 'same days of ' + MONTHS[ps.getMonth()] };
    }
    if (key === 'lastmonth') {
      var s = new Date(y, mo - 1, 1), e = new Date(y, mo, 1);
      var p = new Date(y, mo - 2, 1);
      return { start: s, end: e, prev: { start: p, end: s }, prevLabel: MONTHS[p.getMonth()] + ' ' + p.getFullYear() };
    }
    if (key === 'year') {
      var sy = new Date(y, 0, 1);
      var py = new Date(y - 1, 0, 1);
      return { start: sy, end: end, prev: { start: py, end: new Date(py.getTime() + (end - sy)) }, prevLabel: 'same period of ' + (y - 1) };
    }
    return { start: new Date(0), end: end, prev: null, prevLabel: '' };
  }
  function inR(d, r) { return !!d && d >= r.start && d < r.end; }

  function metricsFor(msgs, scans, r) {
    var active = msgs.filter(function (m) { return inR(lastActivity(m), r); });
    var fresh = msgs.filter(function (m) { return inR(firstSeen(m), r); });
    var rep = active.filter(replied);
    var handled = msgs.filter(function (m) { return inR(handledAt(m), r); });
    var declined = active.filter(function (m) { return stOf(m) === 'Orange'; });
    var syncs = (scans || []).filter(function (s) { return inR(toDate(s.timestamp), r); });
    return {
      active: active, fresh: fresh, replies: rep, handled: handled, declined: declined, syncs: syncs,
      rate: active.length ? Math.round(rep.length / active.length * 100) : 0,
    };
  }

  function delta(cur, prev, opts) {
    opts = opts || {};
    if (prev == null) return '<span class="rep-foot-txt">' + h(opts.none || 'no earlier period') + '</span>';
    var d = cur - prev;
    var unit = opts.pct ? ' pts' : '';
    if (d === 0) return '<span class="kpi-delta flat">&#8722; 0' + unit + '</span><span class="rep-foot-txt">vs ' + h(opts.label) + '</span>';
    var good = opts.downIsGood ? d < 0 : d > 0;
    return '<span class="kpi-delta ' + (good ? 'good' : 'bad') + '">' + (d > 0 ? '&#9650; ' : '&#9660; ') + Math.abs(d) + unit + '</span>' +
      '<span class="rep-foot-txt">vs ' + h(opts.label) + ' (' + prev + (opts.pct ? '%' : '') + ')</span>';
  }

  function tile(label, value, foot, color, hint) {
    return '<div class="kpi rep-tile" style="--kpi-c:' + color + '"' + (hint ? ' title="' + ha(hint) + '"' : '') + '>' +
      '<span class="kpi-label">' + h(label) + '</span>' +
      '<span class="kpi-num">' + value + '</span>' +
      '<span class="kpi-foot">' + foot + '</span></div>';
  }

  // Monday-start week key for the trend chart.
  function weekStart(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var wd = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - wd);
    return x;
  }

  function trendChart(msgs) {
    var W = 12, now = new Date();
    var start = weekStart(new Date(now.getTime() - (W - 1) * 7 * DAY));
    var weeks = [];
    for (var i = 0; i < W; i++) {
      var s = new Date(start.getTime() + i * 7 * DAY);
      weeks.push({ start: s, end: new Date(s.getTime() + 7 * DAY), fresh: 0, replies: 0 });
    }
    msgs.forEach(function (m) {
      var f = firstSeen(m), a = lastActivity(m);
      weeks.forEach(function (w) {
        if (f && f >= w.start && f < w.end) w.fresh++;
        if (a && a >= w.start && a < w.end && replied(m)) w.replies++;
      });
    });
    var max = Math.max.apply(null, weeks.map(function (w) { return w.fresh; }).concat([1]));
    var nice = max <= 5 ? 5 : max <= 10 ? 10 : Math.ceil(max / 10) * 10;
    var vbW = 640, vbH = 200, padL = 30, padB = 26, padT = 10, plotW = vbW - padL - 8, plotH = vbH - padB - padT;
    var bw = plotW / W, barW = Math.max(8, bw * 0.56);
    var grid = '';
    [0, 0.5, 1].forEach(function (f) {
      var y = padT + plotH - f * plotH, v = Math.round(nice * f);
      grid += '<line x1="' + padL + '" x2="' + (vbW - 8) + '" y1="' + y + '" y2="' + y + '" stroke="#e5e7eb" stroke-width="1"/>' +
        '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10" fill="#6e6e73">' + v + '</text>';
    });
    var bars = weeks.map(function (w, i) {
      var x = padL + i * bw + (bw - barW) / 2;
      var bh = w.fresh / nice * plotH;
      var y = padT + plotH - bh;
      var lbl = 'Week of ' + MONTHS[w.start.getMonth()] + ' ' + w.start.getDate() + ' - ' + w.replies + ' with a lead reply';
      var r = Math.min(4, barW / 2, bh);
      var path = bh > 0
        ? '<path d="M' + x + ' ' + (y + bh) + 'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + 'H' + (x + barW - r) + 'Q' + (x + barW) + ' ' + y + ' ' + (x + barW) + ' ' + (y + r) + 'V' + (y + bh) + 'Z" fill="#2a78d6"/>'
        : '';
      var hit = '<rect x="' + (padL + i * bw) + '" y="' + padT + '" width="' + bw + '" height="' + plotH + '" fill="transparent"' +
        markAttrsSafe(w.fresh + ' new', lbl, '#2a78d6') + '/>';
      var tick = (i % 2 === 0 || i === W - 1)
        ? '<text x="' + (x + barW / 2) + '" y="' + (vbH - 8) + '" text-anchor="middle" font-size="10" fill="#6e6e73">' + MONTHS[w.start.getMonth()] + ' ' + w.start.getDate() + '</text>' : '';
      var val = (i === W - 1 || w.fresh === max) && w.fresh > 0
        ? '<text x="' + (x + barW / 2) + '" y="' + (y - 4) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#1d1d1f">' + w.fresh + '</text>' : '';
      return path + val + tick + hit;
    }).join('');
    var total = weeks.reduce(function (a, w) { return a + w.fresh; }, 0);
    var last4 = weeks.slice(-4).reduce(function (a, w) { return a + w.fresh; }, 0);
    var prev4 = weeks.slice(-8, -4).reduce(function (a, w) { return a + w.fresh; }, 0);
    var insight = total === 0 ? 'No new conversations in the last 12 weeks.'
      : 'Last 4 weeks: <b>' + last4 + '</b> new conversations, against <b>' + prev4 + '</b> in the 4 weeks before.';
    return '<svg class="rep-trend" viewBox="0 0 ' + vbW + ' ' + vbH + '" role="img" aria-label="New conversations per week, last 12 weeks">' + grid + bars + '</svg>' +
      '<div class="insight-box">' + insight + '</div>';
  }
  function markAttrsSafe(v, l, key) {
    if (typeof markAttrs === 'function') return markAttrs(v, l, { key: key, cls: 'mark' });
    return ' data-tv="' + ha(v) + '" data-tl="' + ha(l) + '"';
  }

  function stackBar(parts) {
    var total = parts.reduce(function (a, p) { return a + p.n; }, 0);
    if (!total) return '<div class="rep-empty">Nothing in this period.</div>';
    var segs = parts.filter(function (p) { return p.n > 0; }).map(function (p) {
      var pct = Math.round(p.n / total * 100);
      return '<span class="rep-seg" style="flex:' + p.n + ';background:' + p.color + '"' + markAttrsSafe(p.n + ' (' + pct + '%)', p.label, p.color) + '></span>';
    }).join('');
    var legend = parts.map(function (p) {
      return '<span class="rep-leg"><i style="background:' + p.color + '"></i>' + h(p.label) + ' <b>' + p.n + '</b></span>';
    }).join('');
    return '<div class="rep-stack">' + segs + '</div><div class="rep-legend">' + legend + '</div>';
  }

  function personRow(m, extra) {
    var L = linksFor(m);
    var isSN = L.platform === 'sales-navigator';
    var st = stOf(m);
    return '<div class="rep-person">' +
      '<span class="rep-dot ' + st.toLowerCase() + '" title="' + ha(st) + '"></span>' +
      '<div class="rep-person-main"><a class="msg-name-link" href="' + ha(L.profile.href) + '" target="_blank" rel="noopener">' + h(m.name) + '</a>' +
      '<div class="rep-person-sub">' + h(String(m.snippet || '').slice(0, 110)) + '</div></div>' +
      '<span class="rep-person-extra">' + extra + '</span>' +
      '<a class="msg-link-chip msg-link-chip--chat" href="' + ha(L.thread.href) + '" target="_blank" rel="noopener" title="Opens: ' + ha(L.thread.label) + '">' + (isSN ? 'Open in Sales Nav' : 'Open chat') + ' &rarr;</a>' +
      '</div>';
  }

  function renderReportsV2() {
    var container = document.getElementById('reports-container');
    if (!container) return;
    var msgs = (typeof allMessages !== 'undefined' && allMessages) || [];
    var scans = (typeof allScans !== 'undefined' && allScans) || [];
    paintHeader();
    if (!msgs.length) {
      container.innerHTML = '<div class="empty-state"><h3>No data for reports yet</h3><p>Run a sync with the Pulse Chrome extension. Reports fill in from the conversations it collects.</p></div>';
      return;
    }
    var now = new Date();
    var R = periodRange(repPeriod, now);
    var cur = metricsFor(msgs, scans, R);
    var prev = R.prev ? metricsFor(msgs, scans, R.prev) : null;
    var pl = R.prevLabel;
    var followNow = msgs.filter(function (m) { return stOf(m) === 'Red' && !m.done; });
    var waitDays = followNow.map(function (m) { var a = lastActivity(m); return a ? Math.max(0, Math.floor((now - a) / DAY)) : 0; });
    var oldest = waitDays.length ? Math.max.apply(null, waitDays) : 0;
    var periodName = PERIODS.filter(function (p) { return p.key === repPeriod; })[0].label;

    // ---- tiles
    var tiles =
      tile('Conversations active', cur.active.length, delta(cur.active.length, prev && prev.active.length, { label: pl }), 'var(--gx-series,#475569)', 'Conversations with a message in this period') +
      tile('New conversations', cur.fresh.length, delta(cur.fresh.length, prev && prev.fresh.length, { label: pl }), '#2a78d6', 'First collected by Pulse in this period') +
      tile('Lead replies', cur.replies.length, delta(cur.replies.length, prev && prev.replies.length, { label: pl }), 'var(--green)', 'Active conversations where the lead has written back (including declines)') +
      tile('Reply rate', cur.rate + '%', delta(cur.rate, prev && prev.rate, { label: pl, pct: true }), 'var(--green)', 'Lead replies / conversations active') +
      tile('Handled', cur.handled.length, delta(cur.handled.length, prev && prev.handled.length, { label: pl }), 'var(--gx-series,#475569)', 'Checked as done, or answered so it left the follow-up list') +
      tile('Follow-up needed now', followNow.length, '<span class="rep-foot-txt">' + (followNow.length ? 'oldest waiting ' + oldest + ' day' + (oldest === 1 ? '' : 's') : 'nobody is waiting on you') + '</span>', 'var(--red)', 'Red and not checked, right now');

    // ---- triage of the period's conversations
    var c = { red: 0, orange: 0, green: 0, done: 0 };
    cur.active.forEach(function (m) {
      var st = stOf(m);
      if (m.done) c.done++;
      else if (st === 'Red') c.red++;
      else if (st === 'Orange') c.orange++;
      else c.green++;
    });
    var triage = stackBar([
      { label: 'Your turn (Red)', n: c.red, color: 'var(--red)' },
      { label: 'Declined / not now (Orange)', n: c.orange, color: 'var(--orange)' },
      { label: 'Their turn (Green)', n: c.green, color: 'var(--green)' },
      { label: 'Checked as done', n: c.done, color: '#94a3b8' },
    ]);
    var reasons = {};
    cur.declined.forEach(function (m) { var k = String(m.reason || 'Declined').replace(/\s*\(.*\)$/, ''); reasons[k] = (reasons[k] || 0) + 1; });
    var reasonRows = Object.keys(reasons).sort(function (a, b) { return reasons[b] - reasons[a]; }).slice(0, 5).map(function (k) {
      return '<li><span>' + h(k) + '</span><b>' + reasons[k] + '</b></li>';
    }).join('');

    // ---- platform
    function platRow(key, label) {
      var a = cur.active.filter(function (m) { return linksFor(m).platform === key; });
      var r = a.filter(replied).length;
      var f = a.filter(function (m) { return stOf(m) === 'Red' && !m.done; }).length;
      return '<tr><td><span class="platform-badge ' + (key === 'sales-navigator' ? 'pb-sn' : 'pb-li') + '">' + label + '</span></td>' +
        '<td class="num">' + a.length + '</td><td class="num">' + r + '</td><td class="num">' + (a.length ? Math.round(r / a.length * 100) : 0) + '%</td><td class="num">' + f + '</td></tr>';
    }
    var platTable = '<div class="rep-table-wrap"><table class="rep-table"><thead><tr><th>Platform</th><th class="num">Active</th><th class="num">Replies</th><th class="num">Reply rate</th><th class="num">Follow-up</th></tr></thead><tbody>' +
      platRow('linkedin', 'LinkedIn') + platRow('sales-navigator', 'Sales Nav') + '</tbody></table></div>';

    // ---- campaigns
    var camps = {};
    cur.active.forEach(function (m) {
      var k = m.campaign || '(no campaign)';
      var o = camps[k] || (camps[k] = { n: 0, r: 0, hi: 0, f: 0 });
      o.n++; if (replied(m)) o.r++;
      if (String(m.interest || '').toLowerCase() === 'high' || String(m.fit || '').toLowerCase() === 'high') o.hi++;
      if (stOf(m) === 'Red' && !m.done) o.f++;
    });
    var campKeys = Object.keys(camps).sort(function (a, b) { return camps[b].n - camps[a].n; });
    var bestRate = -1, best = '';
    campKeys.forEach(function (k) { if (k !== '(no campaign)' && camps[k].n >= 3) { var rr = camps[k].r / camps[k].n; if (rr > bestRate) { bestRate = rr; best = k; } } });
    var campTable = campKeys.length ? '<div class="rep-table-wrap"><table class="rep-table"><thead><tr><th>Campaign</th><th class="num">Active</th><th class="num">Replies</th><th class="num">Reply rate</th><th class="num">High FIT/INT</th><th class="num">Follow-up</th></tr></thead><tbody>' +
      campKeys.slice(0, 8).map(function (k) {
        var o = camps[k];
        return '<tr' + (k === best ? ' class="rep-best"' : '') + '><td>' + h(k) + (k === best ? ' <span class="rep-pill">best reply rate</span>' : '') + '</td><td class="num">' + o.n + '</td><td class="num">' + o.r + '</td><td class="num">' + Math.round(o.r / o.n * 100) + '%</td><td class="num">' + o.hi + '</td><td class="num">' + o.f + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="rep-empty">No campaigns in this period.</div>';

    // ---- top items
    var waiting = followNow.slice().sort(function (a, b) { return (lastActivity(a) || 0) - (lastActivity(b) || 0); }).slice(0, 5);
    var waitingHtml = waiting.length ? waiting.map(function (m) {
      var a = lastActivity(m), d = a ? Math.max(0, Math.floor((now - a) / DAY)) : 0;
      return personRow(m, '<b>' + d + 'd</b> waiting');
    }).join('') : '<div class="rep-empty">Nobody is waiting on you. Nice.</div>';
    var hotScore = function (m) {
      var s = 0, i = String(m.interest || '').toLowerCase(), f = String(m.fit || '').toLowerCase();
      if (i === 'high') s += 3; else if (i === 'medium') s += 1;
      if (f === 'high') s += 3; else if (f === 'medium') s += 1;
      if (stOf(m) === 'Red') s += 2;
      return s;
    };
    var hot = cur.active.filter(function (m) { return !m.done && stOf(m) !== 'Orange' && hotScore(m) >= 3; })
      .sort(function (a, b) { return hotScore(b) - hotScore(a) || ((lastActivity(b) || 0) - (lastActivity(a) || 0)); }).slice(0, 5);
    var hotHtml = hot.length ? hot.map(function (m) {
      var tags = [];
      if (m.fit) tags.push('FIT ' + h(m.fit));
      if (m.interest) tags.push('INT ' + h(m.interest));
      return personRow(m, tags.join(' &middot; '));
    }).join('') : '<div class="rep-empty">No high-FIT or high-interest conversations in this period. Grade FIT and INTEREST on Conversations to see them here.</div>';

    // ---- month by month (last 6 months)
    var rows = '';
    for (var i = 0; i < 6; i++) {
      var ms = new Date(now.getFullYear(), now.getMonth() - i, 1), me = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      var mm = metricsFor(msgs, scans, { start: ms, end: me });
      if (!mm.active.length && !mm.fresh.length && i > 0) continue;
      rows += '<tr><td>' + MONTHS[ms.getMonth()] + ' ' + ms.getFullYear() + (i === 0 ? ' <span class="rep-muted">(to date)</span>' : '') + '</td>' +
        '<td class="num">' + mm.fresh.length + '</td><td class="num">' + mm.active.length + '</td><td class="num">' + mm.replies.length + '</td>' +
        '<td class="num">' + mm.rate + '%</td><td class="num">' + mm.declined.length + '</td><td class="num">' + mm.handled.length + '</td></tr>';
    }
    var history = '<div class="rep-table-wrap"><table class="rep-table"><thead><tr><th>Month</th><th class="num">New</th><th class="num">Active</th><th class="num">Replies</th><th class="num">Reply rate</th><th class="num">Declined</th><th class="num">Handled</th></tr></thead><tbody>' + rows + '</tbody></table></div>';

    var syncNote = cur.syncs.length
      ? cur.syncs.length + ' sync' + (cur.syncs.length === 1 ? '' : 's') + ' in this period' + (scans.length >= 20 ? ' (only the 20 most recent syncs are counted)' : '')
      : 'No sync recorded in this period';
    var rangeTxt = repPeriod === 'all' ? 'All conversations Pulse has collected'
      : fmtDay(R.start) + ' &ndash; ' + fmtDay(new Date(R.end.getTime() - 1));

    container.innerHTML =
      '<div class="rep-head"><div><div class="rep-period-name">' + h(periodName) + '</div><div class="rep-range">' + rangeTxt + ' &middot; ' + h(syncNote) + '</div></div></div>' +
      '<div class="kpi-strip rep-kpis">' + tiles + '</div>' +
      '<div class="analysis-grid">' +
        '<div class="analysis-card full-width"><h3>New conversations per week</h3><div class="rep-sub">Last 12 weeks, by the week Pulse first collected them. Hover a week for its lead replies.</div>' + trendChart(msgs) + '</div>' +
      '</div>' +
      '<div class="analysis-grid">' +
        '<div class="analysis-card"><h3>Where the period’s conversations stand</h3>' + triage +
          (reasonRows ? '<h4 class="rep-h4">Why the Orange ones closed</h4><ul class="rep-reasons">' + reasonRows + '</ul>' : '') + '</div>' +
        '<div class="analysis-card"><h3>LinkedIn vs Sales Navigator</h3>' + platTable + '</div>' +
      '</div>' +
      '<div class="analysis-grid">' +
        '<div class="analysis-card full-width"><h3>Campaigns</h3>' + campTable + '</div>' +
      '</div>' +
      '<div class="analysis-grid">' +
        '<div class="analysis-card"><h3>Waiting on you the longest</h3>' + waitingHtml + '</div>' +
        '<div class="analysis-card"><h3>Best leads this period</h3>' + hotHtml + '</div>' +
      '</div>' +
      '<div class="analysis-grid">' +
        '<div class="analysis-card full-width"><h3>Month by month</h3>' + history +
          '<div class="rep-sub" style="margin-top:10px">Replies count conversations where the lead has written back, declines included. Handled counts checks and conversations that left the follow-up list.</div></div>' +
      '</div>';
  }
  function fmtDay(d) { return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); }

  function paintHeader() {
    var page = document.getElementById('page-reports');
    if (!page) return;
    var sub = page.querySelector('.header-sub');
    if (sub) sub.textContent = 'Your outreach results, compared with the previous period';
    var actions = page.querySelector('.header-actions');
    if (actions && !document.getElementById('rep-period')) {
      var seg = document.createElement('div');
      seg.className = 'seg';
      seg.id = 'rep-period';
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Report period');
      seg.innerHTML = PERIODS.map(function (p) {
        return '<button type="button" class="seg-btn" data-period="' + p.key + '">' + p.label + '</button>';
      }).join('');
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('.seg-btn');
        if (!b) return;
        repPeriod = b.getAttribute('data-period');
        try { localStorage.setItem('pulse_report_period', repPeriod); } catch (er) { /* storage blocked */ }
        renderReportsV2();
      });
      actions.insertBefore(seg, actions.firstChild);
    }
    document.querySelectorAll('#rep-period .seg-btn').forEach(function (b) {
      var on = b.getAttribute('data-period') === repPeriod;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  window.renderReports = renderReportsV2;
  window.PulseReports = { periodRange: periodRange, metricsFor: metricsFor, lastActivity: lastActivity, replied: replied, handledAt: handledAt };

  function boot() {
    watchList();
    paintHeader();
    var page = document.getElementById('page-reports');
    if (page && page.classList.contains('active')) renderReportsV2();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
