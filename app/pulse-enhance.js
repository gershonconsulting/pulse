/* =====================================================================
   Pulse v5.15.0 (nightly 2026-10-22) - pulse-enhance.js (+ pulse-enhance.css)
   Linked into /app.html by functions/_middleware.js (themeInject), so the
   244 KB app.html is not re-uploaded. Loaded with `defer`, i.e. after the
   dashboard's inline script: it re-binds a few of that script's global
   functions (threadLink, personLink, platformOf, renderReports, ...). Every
   caller resolves those names at call time, so the new versions are used
   everywhere, and anything that throws here falls back to the original.

   1. Sales Navigator links (Olivier, 2026-10-04: "Open in Sales Nav" broken)
      - A Sales Navigator thread link is only used when its id looks like a
        real Sales Navigator thread id (the collector sometimes stored a
        placeholder value from a data attribute instead of the id).
      - Otherwise: the captured lead page, else a Sales Navigator people
        search for the name (+ company when known). Never a dead link.
      - Rows are recognised as Sales Navigator from their `source` too, not
        only from the link, so a row with a lost link still says Sales Nav.
      - Always opens in a new tab (target=_blank rel=noopener noreferrer).
   2. Reports page rebuilt: KPI tiles with period comparison, a monthly
      chart, a table view, campaigns + sources, empty / loading / error
      states, phone layout. Only data already in Pulse - nothing invented.
   3. Settings: "System Diagnostics" and "About" are kept, folded into a
      collapsed "Advanced" group at the bottom.
   ===================================================================== */
(function () {
  'use strict';
  var VERSION = '5.15.0';
  var LI = 'https://www.linkedin.com';

  /* ---------- small helpers (own copies: never depend on page internals) ---------- */
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function orig(name) { return typeof window[name] === 'function' ? window[name] : null; }

  /* =================================================================
     1. SALES NAVIGATOR LINKS
     ================================================================= */
  // Sales Navigator thread ids look like "2-YTI5ZjM0Nzkt...==" (base64-ish).
  var SN_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_\-=.]{5,}$/;
  var PLACEHOLDER = /^(true|false|null|undefined|nan|none|item|conversation|link|\d{1,3})$/i;

  function linkedinUrl(u) {
    if (!u) return '';
    try {
      var x = new URL(String(u), LI);
      if (x.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(x.hostname)) return '';
      return x.href;
    } catch (e) { return ''; }
  }

  function validThreadId(id) {
    if (!id) return '';
    var s = String(id).trim();
    try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
    if (PLACEHOLDER.test(s) || !SN_THREAD_ID.test(s)) return '';
    return s;
  }

  function snThreadUrl(m) {
    var link = linkedinUrl(m.conversationLink);
    var mm = link && new URL(link).pathname.match(/^\/sales\/inbox\/([^/?#]+)/);
    var id = validThreadId(mm && mm[1]) || validThreadId(m.snThreadId) ||
             (m.source === 'sales-navigator' ? validThreadId(m.threadId) : '');
    return id ? LI + '/sales/inbox/' + encodeURIComponent(id).replace(/%3D/g, '=') : '';
  }

  function snLeadUrl(m) {
    var c = [m.salesNavUrl, m.leadUrl, m.profileUrl];
    for (var i = 0; i < c.length; i++) {
      var u = linkedinUrl(c[i]);
      if (u && /^\/sales\/(lead|people)\/[^/]{6,}/.test(new URL(u).pathname)) return u;
    }
    var lid = m.leadId || m.salesNavLeadId;
    if (lid && /^[A-Za-z0-9_\-]{10,}$/.test(String(lid))) return LI + '/sales/lead/' + lid;
    return '';
  }

  // Rest.li value escaping: Sales Navigator's own search URLs carry
  // query=(keywords:<percent-encoded value>) - reserved ( ) , ' : must be escaped.
  function restli(s) {
    return encodeURIComponent(s).replace(/[!'()*~]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }
  function snSearchUrl(m) {
    var kw = [m.name, m.company].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!kw) return LI + '/sales/home';
    return LI + '/sales/search/people?query=' + encodeURIComponent('(keywords:' + restli(kw) + ')');
  }

  function isSalesNav(m) {
    if (m.platform) return m.platform === 'sales-navigator';
    if (m.source === 'sales-navigator') return true;
    return String(m.conversationLink || '').indexOf('/sales/') > -1;
  }

  var _platformOf = orig('platformOf');
  window.platformOf = function (m) {
    try { return isSalesNav(m) ? 'sales-navigator' : 'linkedin'; }
    catch (e) { return _platformOf ? _platformOf(m) : 'linkedin'; }
  };

  var _threadLink = orig('threadLink');
  window.threadLink = function (m) {
    try {
      if (isSalesNav(m)) return snThreadUrl(m) || snLeadUrl(m) || snSearchUrl(m);
    } catch (e) { /* fall through */ }
    return _threadLink ? _threadLink(m) : LI + '/messaging/';
  };

  var _personLink = orig('personLink');
  window.personLink = function (m) {
    try {
      if (isSalesNav(m)) return snLeadUrl(m) || linkedinUrl(m.profileUrl) || snSearchUrl(m);
    } catch (e) { /* fall through */ }
    return _personLink ? _personLink(m) : snSearchUrl(m);
  };

  // Label a fallback honestly: a search is "Find in Sales Nav", not "Open".
  function relabelLinks(root) {
    var as = (root || document).querySelectorAll('a[target="_blank"]');
    for (var i = 0; i < as.length; i++) {
      var a = as[i];
      a.setAttribute('rel', 'noopener noreferrer');
      var href = a.getAttribute('href') || '';
      if (a.classList.contains('msg-link-chip--chat') && href.indexOf('/sales/') > -1) {
        if (href.indexOf('/sales/inbox/') > -1) { a.innerHTML = 'Open in Sales Nav &rarr;'; a.title = 'Open this conversation in your Sales Navigator inbox'; }
        else if (href.indexOf('/sales/lead/') > -1 || href.indexOf('/sales/people/') > -1) { a.innerHTML = 'Open in Sales Nav &rarr;'; a.title = 'Open this lead in Sales Navigator'; }
        else { a.innerHTML = 'Find in Sales Nav &rarr;'; a.title = 'The exact thread was not captured - opens a Sales Navigator search for this person'; }
      }
    }
  }
  var _renderMessages = orig('renderMessages');
  if (_renderMessages) {
    window.renderMessages = function () {
      var r = _renderMessages.apply(this, arguments);
      try { relabelLinks(document.getElementById('message-list')); } catch (e) { /* cosmetic */ }
      return r;
    };
  }

  /* =================================================================
     2. REPORTS
     ================================================================= */
  var api = { loaded: false, ok: null };
  var _updateFooterStatus = orig('updateFooterStatus');
  window.updateFooterStatus = function (ok) {
    api.ok = !!ok; if (ok) api.loaded = true;
    if (!ok) { try { if (activePage() === 'reports') window.renderReports(); } catch (e) { /* ignore */ } }
    return _updateFooterStatus ? _updateFooterStatus.apply(this, arguments) : undefined;
  };
  function activePage() {
    var p = document.querySelector('.page-view.active');
    return p ? p.id.replace('page-', '') : '';
  }
  function messages() { try { return Array.isArray(allMessages) ? allMessages : []; } catch (e) { return []; } }
  function followupNow() { try { return statsData.followup || 0; } catch (e) { return null; } }

  var DAY = 86400000;
  var WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  function parseDate(d) {
    if (!d) return null;
    if (typeof parseMsgDate === 'function') { try { return parseMsgDate(d); } catch (e) { /* fall back */ } }
    var x = new Date(d); return isNaN(x.getTime()) ? null : x;
  }
  // Last-activity date. LinkedIn lists show "3:45 PM" for today, a weekday for
  // this week and "Oct 3" before that; resolve those against the capture time.
  function activityDate(m) {
    var d = parseDate(m.timestamp) || parseDate(m.date);
    if (d) return d;
    var base = parseDate(m.collectedAt) || parseDate(m.updatedAt);
    var s = String(m.date || '').trim().toLowerCase();
    if (!base || !s) return null;
    if (/^\d{1,2}:\d{2}/.test(s) || /\b(am|pm)\b/.test(s) || s === 'today' || s === 'now' || /^\d+\s*(m|min|h)\b/.test(s)) return base;
    if (s === 'yesterday') return new Date(base.getTime() - DAY);
    var w = WD.indexOf(s.slice(0, 3));
    if (w > -1) { var back = (base.getDay() - w + 7) % 7 || 7; return new Date(base.getTime() - back * DAY); }
    return null;
  }
  function st(m) { var s = String(m.status || 'Red'); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

  var PERIODS = { 30: 'Last 30 days', 90: 'Last 90 days' };
  var period = 30;
  try { var sp = Number(localStorage.getItem('pulse_reports_period')); if (PERIODS[sp]) period = sp; } catch (e) { /* default */ }
  window.pulseReportsPeriod = function (p) {
    if (!PERIODS[p]) return; period = p;
    try { localStorage.setItem('pulse_reports_period', String(p)); } catch (e) { /* not saved */ }
    window.renderReports();
  };

  function pctDelta(cur, prev, hasPrev) {
    if (!hasPrev) return { cls: 'flat', text: 'no earlier data to compare' };
    if (prev === 0) return cur === 0 ? { cls: 'flat', text: 'same as previous period' } : { cls: 'up', text: 'up from 0 in previous period' };
    var p = Math.round(((cur - prev) / prev) * 100);
    if (p === 0) return { cls: 'flat', text: 'same as previous period (' + prev + ')' };
    return { cls: p > 0 ? 'up' : 'down', text: (p > 0 ? '+' : '') + p + '% vs previous ' + period + ' days (' + prev + ')' };
  }
  function ptsDelta(cur, prev, hasPrev) {
    if (!hasPrev || prev == null || cur == null) return { cls: 'flat', text: 'no earlier data to compare' };
    var d = cur - prev;
    if (d === 0) return { cls: 'flat', text: 'same as previous period (' + prev + '%)' };
    return { cls: d > 0 ? 'up' : 'down', text: (d > 0 ? '+' : '') + d + ' pts vs previous ' + period + ' days (' + prev + '%)' };
  }

  function tile(label, value, sub, delta, hint) {
    return '<div class="pv-kpi"' + (hint ? ' title="' + h(hint) + '"' : '') + '>' +
      '<div class="pv-kpi-label">' + h(label) + '</div>' +
      '<div class="pv-kpi-value">' + value + '</div>' +
      (delta ? '<div class="pv-kpi-delta ' + delta.cls + '">' + h(delta.text) + '</div>' : '') +
      (sub ? '<div class="pv-kpi-sub">' + h(sub) + '</div>' : '') +
    '</div>';
  }

  function emptyCard(title, body, action) {
    return '<div class="pv-empty"><div class="pv-empty-ic" aria-hidden="true">&#9675;</div><h3>' + h(title) + '</h3><p>' + h(body) + '</p>' + (action || '') + '</div>';
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var COL = { Red: 'var(--c-red, #dc2626)', Orange: 'var(--c-orange, #f59e0b)', Green: 'var(--c-green, #16a34a)' };
  var KEY = { Red: '#dc2626', Orange: '#f59e0b', Green: '#16a34a' };

  function monthChart(rows, width) {
    // rows: [{label, Red, Orange, Green, total}] oldest -> newest. Drawn at the
    // card's real pixel width so labels stay 11px on a phone and on a desktop.
    var W = Math.max(280, Math.round(width || 640)), H = W < 500 ? 200 : 240, L = 30, R = 6, T = 22, B = 28;
    var max = Math.max.apply(null, rows.map(function (r) { return r.total; }).concat([1]));
    var step = max <= 5 ? 1 : Math.pow(10, Math.floor(Math.log10(max))) * (max / Math.pow(10, Math.floor(Math.log10(max))) > 5 ? 2 : 1);
    var top = Math.ceil(max / step) * step;
    var y = function (v) { return T + (H - T - B) * (1 - v / top); };
    var bw = (W - L - R) / rows.length, barW = Math.min(44, bw * 0.56);
    var g = '';
    for (var t = 0; t <= top; t += step) {
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '" class="pv-grid"/>' +
           '<text x="' + (L - 6) + '" y="' + (y(t) + 4) + '" class="pv-axis" text-anchor="end">' + t + '</text>';
    }
    var bars = '';
    rows.forEach(function (r, i) {
      var x = L + bw * i + (bw - barW) / 2, acc = 0;
      ['Red', 'Orange', 'Green'].forEach(function (k) {
        var v = r[k]; if (!v) return;
        var y1 = y(acc + v), y0 = y(acc), hgt = Math.max(0, y0 - y1 - 2);
        bars += '<rect x="' + x + '" y="' + y1 + '" width="' + barW + '" height="' + Math.max(hgt, 1) + '" rx="3" fill="' + COL[k] + '"' +
          ' data-tv="' + v + ' ' + k + '" data-tl="' + h(r.label) + ' - ' + (r.total ? Math.round(v / r.total * 100) : 0) + '% of ' + r.total + '" data-tk="' + KEY[k] + '"/>';
        acc += v;
      });
      bars += '<rect x="' + (L + bw * i) + '" y="' + T + '" width="' + bw + '" height="' + (H - T - B) + '" fill="transparent" data-tv="' + r.total + ' conversations" data-tl="' + h(r.label) + ': ' + r.Red + ' Red, ' + r.Orange + ' Orange, ' + r.Green + ' Green" style="pointer-events:' + (r.total ? 'none' : 'all') + '"/>';
      if (r.total) bars += '<text x="' + (x + barW / 2) + '" y="' + (y(r.total) - 6) + '" class="pv-val" text-anchor="middle">' + r.total + '</text>';
      bars += '<text x="' + (x + barW / 2) + '" y="' + (H - 10) + '" class="pv-axis" text-anchor="middle">' + h(r.short) + '</text>';
    });
    return '<svg class="pv-chart" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Conversations by month of last activity, split by Red, Orange and Green">' + g + bars + '</svg>';
  }

  function hbar(rows, unit) {
    var max = Math.max.apply(null, rows.map(function (r) { return r.n; }).concat([1]));
    return '<div class="pv-hbars">' + rows.map(function (r) {
      return '<div class="pv-hbar" data-tv="' + r.n + ' ' + unit + '" data-tl="' + h(r.label) + (r.extra ? ' - ' + h(r.extra) : '') + '">' +
        '<span class="pv-hbar-label">' + h(r.label) + '</span>' +
        '<span class="pv-hbar-track"><span class="pv-hbar-fill" style="width:' + Math.max(2, Math.round(r.n / max * 100)) + '%"></span></span>' +
        '<span class="pv-hbar-n">' + r.n + (r.extra ? '<small>' + h(r.extra) + '</small>' : '') + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  function header(sub) {
    var hs = document.querySelector('#page-reports .header-sub');
    if (hs) hs.textContent = sub;
  }

  function renderReportsV2() {
    var box = document.getElementById('reports-container');
    if (!box) return;
    var all = messages();
    if (api.ok === null) {
      // The first load can finish (or fail) before this deferred script runs:
      // read the outcome from the footer status the page already painted.
      var fs = (document.getElementById('footer-status-text') || {}).textContent || '';
      var done = false; try { done = lastSData != null; } catch (e) { /* not defined */ }
      if (/offline/i.test(fs)) api.ok = false;
      else if (done || all.length) { api.ok = true; api.loaded = true; }
    }

    if (!all.length) {
      if (api.ok === false) {
        header('Could not load');
        box.innerHTML = emptyCard("Couldn't load your report data",
          'Pulse could not reach its server just now, so there is nothing to show yet. Your data is safe - try again in a moment.',
          '<button class="refresh-btn pv-btn" onclick="loadAllData()">Try again</button>');
        return;
      }
      if (!api.loaded) { header('Loading'); box.innerHTML = '<div class="pv-skel"><div></div><div></div><div></div><div></div></div><div class="loading">Loading reports&hellip;</div>'; return; }
      header('No data yet');
      box.innerHTML = emptyCard('No conversations yet',
        'Reports fill in automatically once the Pulse Chrome extension has synced your LinkedIn and Sales Navigator inboxes from the collecting computer.',
        '<button class="refresh-btn pv-btn" onclick="var n=document.querySelector(\'.nav-item[data-page=extension]\');if(n)n.click()">Go to the Extension page</button>');
      return;
    }

    var now = Date.now(), P = period * DAY;
    var curStart = now - P, prevStart = now - 2 * P;
    var dated = [], undated = 0, earliest = Infinity, earliestSeen = Infinity;
    all.forEach(function (m) {
      var d = activityDate(m);
      if (d) { dated.push({ m: m, t: d.getTime() }); earliest = Math.min(earliest, d.getTime()); } else undated++;
      var fs = parseDate(m.firstSeenAt); if (fs) earliestSeen = Math.min(earliestSeen, fs.getTime());
    });
    var cur = dated.filter(function (x) { return x.t >= curStart && x.t <= now + DAY; });
    var prev = dated.filter(function (x) { return x.t >= prevStart && x.t < curStart; });
    var hasPrev = earliest < curStart;
    var redShare = function (arr) { return arr.length ? Math.round(arr.filter(function (x) { return st(x.m) === 'Red'; }).length / arr.length * 100) : null; };
    var seenIn = function (a, b) { return all.filter(function (m) { var t = parseDate(m.firstSeenAt); return t && t.getTime() >= a && t.getTime() < b; }).length; };
    var hasSeen = earliestSeen < Infinity;
    var newCur = hasSeen ? seenIn(curStart, now + DAY) : null;
    var newPrev = hasSeen ? seenIn(prevStart, curStart) : null;
    var fu = followupNow();

    var html = '';
    if (api.ok === false) html += '<div class="pv-warn">Pulse could not refresh just now - these figures are from the last successful load.</div>';

    html += '<div class="pv-toolbar"><div class="pv-seg" role="tablist" aria-label="Report period">' +
      Object.keys(PERIODS).map(function (k) {
        return '<button type="button" role="tab" aria-selected="' + (Number(k) === period) + '" class="' + (Number(k) === period ? 'on' : '') + '" onclick="pulseReportsPeriod(' + k + ')">' + PERIODS[k] + '</button>';
      }).join('') + '</div><span class="pv-toolbar-note">Compared with the ' + period + ' days before.</span></div>';

    html += '<div class="pv-kpis">' +
      tile('Active conversations', cur.length, 'last message in the period', pctDelta(cur.length, prev.length, hasPrev),
        'Conversations whose latest message falls in the period') +
      tile('New conversations', newCur == null ? '&mdash;' : newCur, 'first collected in the period',
        newCur == null ? { cls: 'flat', text: 'not recorded for older data' } : pctDelta(newCur, newPrev, earliestSeen < curStart),
        'Conversations Pulse saw for the first time in the period') +
      tile('Prospect replied', cur.length ? redShare(cur) + '%' : '&mdash;', 'share of active conversations that are Red',
        cur.length ? ptsDelta(redShare(cur), redShare(prev), hasPrev && prev.length > 0) : null,
        'Red = the prospect wrote last, so the next move is yours') +
      tile('Waiting on you now', fu == null ? '&mdash;' : fu, 'Red and not marked handled', null,
        'Live count, same as the Follow-up badge') +
    '</div>';

    // Monthly chart (last 6 months by last-activity month)
    var months = [], d0 = new Date(now);
    for (var i = 5; i >= 0; i--) {
      var md = new Date(d0.getFullYear(), d0.getMonth() - i, 1);
      months.push({ y: md.getFullYear(), mo: md.getMonth(), label: MONTHS[md.getMonth()] + ' ' + md.getFullYear(), short: MONTHS[md.getMonth()], Red: 0, Orange: 0, Green: 0, total: 0, high: 0 });
    }
    dated.forEach(function (x) {
      var dd = new Date(x.t);
      months.forEach(function (r) {
        if (r.y === dd.getFullYear() && r.mo === dd.getMonth()) {
          var s = st(x.m); if (r[s] != null) r[s]++; r.total++;
          if (String(x.m.fit || '').toLowerCase() === 'high') r.high++;
        }
      });
    });
    var anyMonth = months.some(function (r) { return r.total > 0; });
    html += '<div class="pv-card"><div class="pv-card-h"><h3>Conversations by month</h3><span class="pv-card-sub">by month of the latest message &middot; last 6 months</span></div>';
    if (anyMonth) {
      html += '<div class="pv-legend">' + ['Red', 'Orange', 'Green'].map(function (k) {
        return '<span><i style="background:' + KEY[k] + '"></i>' + k + (k === 'Red' ? ' &middot; prospect replied' : k === 'Orange' ? ' &middot; no action needed' : ' &middot; you sent last') + '</span>';
      }).join('') + '</div>' + monthChart(months, (box.clientWidth || 680) - 42);
      html += '<details class="pv-table-wrap"><summary>Show as a table</summary><div class="pv-scroll"><table class="pv-table"><thead><tr><th>Month</th><th>Total</th><th>Red</th><th>Orange</th><th>Green</th><th>Prospect replied</th><th>FIT High</th></tr></thead><tbody>' +
        months.slice().reverse().map(function (r) {
          return '<tr><td>' + h(r.label) + '</td><td>' + r.total + '</td><td>' + r.Red + '</td><td>' + r.Orange + '</td><td>' + r.Green + '</td><td>' + (r.total ? Math.round(r.Red / r.total * 100) + '%' : '&mdash;') + '</td><td>' + r.high + '</td></tr>';
        }).join('') + '</tbody></table></div></details>';
    } else {
      html += emptyCard('No dated activity in the last 6 months', 'Conversations are counted by the date of their latest message. Run a sync to bring in recent ones.');
    }
    if (undated) html += '<div class="pv-note">' + undated + ' conversation' + (undated === 1 ? ' has' : 's have') + ' no readable date and ' + (undated === 1 ? 'is' : 'are') + ' left out of the dated figures.</div>';
    html += '</div>';

    // Sources + campaigns (period)
    var bySrc = { 'LinkedIn': 0, 'Sales Navigator': 0 };
    var byCamp = {};
    cur.forEach(function (x) {
      bySrc[isSalesNav(x.m) ? 'Sales Navigator' : 'LinkedIn']++;
      var c = x.m.campaign; if (c) { byCamp[c] = byCamp[c] || { n: 0, red: 0 }; byCamp[c].n++; if (st(x.m) === 'Red') byCamp[c].red++; }
    });
    var camps = Object.keys(byCamp).map(function (k) { return { label: k, n: byCamp[k].n, extra: Math.round(byCamp[k].red / byCamp[k].n * 100) + '% replied' }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 6);
    html += '<div class="pv-grid2">' +
      '<div class="pv-card"><div class="pv-card-h"><h3>Where they come from</h3><span class="pv-card-sub">' + h(PERIODS[period].toLowerCase()) + '</span></div>' +
        (cur.length ? hbar([{ label: 'LinkedIn', n: bySrc['LinkedIn'] }, { label: 'Sales Navigator', n: bySrc['Sales Navigator'] }], 'conversations')
          : emptyCard('Nothing in this period', 'No conversation had a message in the ' + PERIODS[period].toLowerCase() + '. Try the longer period.')) +
      '</div>' +
      '<div class="pv-card"><div class="pv-card-h"><h3>Campaigns</h3><span class="pv-card-sub">top ' + camps.length + ' &middot; ' + h(PERIODS[period].toLowerCase()) + '</span></div>' +
        (camps.length ? hbar(camps, 'conversations')
          : emptyCard('No campaign codes found', 'Campaign codes (like BD18) are picked up from your messages. None of the conversations in this period carry one.')) +
      '</div>' +
    '</div>';

    // Top FIT: High leads in the period, with working links
    var top = cur.filter(function (x) { return String(x.m.fit || '').toLowerCase() === 'high'; })
      .sort(function (a, b) { return b.t - a.t; }).slice(0, 8);
    html += '<div class="pv-card"><div class="pv-card-h"><h3>FIT: High leads</h3><span class="pv-card-sub">most recent first &middot; ' + h(PERIODS[period].toLowerCase()) + '</span></div>';
    if (top.length) {
      html += '<div class="pv-leads">' + top.map(function (x) {
        var m = x.m, sn = isSalesNav(m), s = st(m);
        var tl = window.threadLink(m), pl = window.personLink(m);
        var tlLabel = sn ? (tl.indexOf('/sales/search/') > -1 ? 'Find in Sales Nav' : 'Open in Sales Nav') : 'Open chat';
        return '<div class="pv-lead"><span class="pv-dot ' + h(s.toLowerCase()) + '" title="' + h(s) + '"></span>' +
          '<a class="pv-lead-name" href="' + h(pl) + '" target="_blank" rel="noopener noreferrer">' + h(m.name) + '</a>' +
          '<span class="pv-lead-meta">' + (sn ? 'Sales Nav' : 'LinkedIn') + (m.campaign ? ' &middot; ' + h(m.campaign) : '') + (m.interest ? ' &middot; INT: ' + h(m.interest) : '') + '</span>' +
          '<a class="pv-lead-link" href="' + h(tl) + '" target="_blank" rel="noopener noreferrer">' + tlLabel + ' &rarr;</a></div>';
      }).join('') + '</div>';
    } else {
      html += emptyCard('No FIT: High leads in this period', 'Leads graded FIT: High show up here with a direct link to their conversation.');
    }
    html += '</div>';

    header(PERIODS[period] + ' · ' + all.length + ' conversations in Pulse');
    box.innerHTML = html;
  }

  var _renderReports = orig('renderReports');
  window.renderReports = function () {
    try { renderReportsV2(); }
    catch (e) {
      console.error('[Pulse] reports v2 failed, using the classic view', e);
      if (_renderReports) _renderReports();
    }
  };

  /* =================================================================
     3. SETTINGS: fold Diagnostics + About into a collapsed "Advanced" group
     ================================================================= */
  function foldAdvanced() {
    var page = document.getElementById('page-settings');
    if (!page || page.querySelector('.pv-adv')) return;
    var secs = page.querySelectorAll('.settings-section');
    var move = [];
    for (var i = 0; i < secs.length; i++) {
      var t = (secs[i].querySelector('.settings-section-header h3') || {}).textContent || '';
      if (/^\s*(System Diagnostics|About)\s*$/i.test(t)) move.push(secs[i]);
    }
    if (!move.length) return;
    var det = document.createElement('details');
    det.className = 'pv-adv';
    det.innerHTML = '<summary>Advanced <span>diagnostics &amp; app info</span></summary>';
    move[0].parentNode.appendChild(det);
    move.forEach(function (s) { det.appendChild(s); });
    var hs = page.querySelector('.header-sub');
    if (hs && /diagnostics/i.test(hs.textContent)) hs.textContent = 'Preferences for your account and this computer';
  }

  function boot() {
    try { foldAdvanced(); } catch (e) { /* cosmetic */ }
    try { relabelLinks(document.getElementById('message-list')); } catch (e) { /* cosmetic */ }
    try { if (activePage() === 'reports') window.renderReports(); } catch (e) { /* ignore */ }
    window.__pulseEnhance = VERSION;
    var rt = null, lastW = window.innerWidth;
    window.addEventListener('resize', function () {
      if (Math.abs(window.innerWidth - lastW) < 40) return;   // ignore phone toolbar jitter
      lastW = window.innerWidth; clearTimeout(rt);
      rt = setTimeout(function () { if (activePage() === 'reports') window.renderReports(); }, 250);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
