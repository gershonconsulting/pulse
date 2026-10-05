/* Gershon "Intelligence" menu — client side (v1.0, 2026-10-05)
 * Drop-in: <script src="/intelligence.js" defer></script> + a config object:
 *   window.GERSHON_INTEL = {
 *     app: 'Pulse',                       // name shown to the model
 *     nav: '.sidebar-nav',                // where the menu entry goes
 *     before: '[data-page="settings"]',   // optional: insert before this nav entry
 *     navClass: 'nav-item',               // class of existing menu entries
 *     pageClass: 'page-view',             // class of existing pages (toggled with .active)
 *     container: null,                    // where to add the page (default: parent of first .page-view)
 *     sources: ['main'],                  // fallback data = visible text of these elements
 *     collect: async () => ({...}),       // optional: return the app's data (object or string)
 *     endpoint: '/api/intelligence'
 *   };
 * Three tabs: AI Analysis · AI Suggestions · AI Chat. Powered by Cloudflare Workers AI.
 */
(function () {
  'use strict';
  var C = Object.assign({ app: document.title, nav: 'nav', before: null, navClass: 'nav-item', pageClass: 'page-view',
    container: null, sources: ['main'], collect: null, endpoint: '/api/intelligence' }, window.GERSHON_INTEL || {});
  var chat = [], cache = {}, busy = false;

  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs || {}) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function md(s) {
    return esc(s).split('\n').map(function (l) {
      l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      if (/^#{1,3} /.test(l)) return '<h4>' + l.replace(/^#+ /, '') + '</h4>';
      if (/^\s*[-*•] /.test(l)) return '<li>' + l.replace(/^\s*[-*•] /, '') + '</li>';
      if (/^\s*\d+[.)] /.test(l)) return '<li>' + l.replace(/^\s*\d+[.)] /, '') + '</li>';
      return l.trim() ? '<p>' + l + '</p>' : '';
    }).join('').replace(/(<li>.*?<\/li>)+/g, function (m) { return '<ul>' + m + '</ul>'; });
  }

  async function data() {
    if (typeof C.collect === 'function') {
      try { var d = await C.collect(); if (d) return typeof d === 'string' ? d : JSON.stringify(d); } catch (e) { /* fall back */ }
    }
    return C.sources.map(function (s) {
      return Array.prototype.map.call(document.querySelectorAll(s), function (n) { return (n.innerText || '').replace(/\n{3,}/g, '\n\n'); }).join('\n');
    }).join('\n---\n').slice(0, 14000);
  }

  async function ask(mode, messages) {
    var r = await fetch(C.endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode, app: C.app, data: await data(), messages: messages }) });
    var j = await r.json().catch(function () { return { error: 'HTTP ' + r.status }; });
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    return j.text;
  }

  var CSS = '.gi-wrap{max-width:980px;margin:0 auto;padding:20px}.gi-head h2{font-size:20px;font-weight:700;margin:0}.gi-head p{color:#6b7280;font-size:12px;margin:4px 0 16px}' +
    '.gi-tabs{display:flex;gap:6px;border-bottom:1px solid #e5e7eb;margin-bottom:16px;flex-wrap:wrap}.gi-tab{border:0;background:none;padding:10px 14px;font-weight:600;font-size:14px;color:#6b7280;cursor:pointer;border-bottom:2px solid transparent}' +
    '.gi-tab.on{color:#111827;border-color:#6d28d9}.gi-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;color:#111827;font-size:14px;line-height:1.55}' +
    '.gi-card h4{margin:14px 0 6px;font-size:15px}.gi-card h4:first-child{margin-top:0}.gi-card ul{margin:4px 0 8px 18px;padding:0}.gi-card p{margin:6px 0}' +
    '.gi-btn{background:#6d28d9;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}.gi-btn:disabled{opacity:.5;cursor:wait}' +
    '.gi-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px}.gi-muted{color:#6b7280;font-size:12px}' +
    '.gi-log{max-height:52vh;overflow:auto;display:flex;flex-direction:column;gap:10px;margin-bottom:12px}.gi-msg{padding:10px 14px;border-radius:12px;max-width:85%}' +
    '.gi-msg.u{align-self:flex-end;background:#6d28d9;color:#fff}.gi-msg.a{align-self:flex-start;background:#f3f4f6}.gi-row{display:flex;gap:8px}' +
    '.gi-row textarea{flex:1;border:1px solid #d1d5db;border-radius:8px;padding:10px;font:inherit;resize:vertical;min-height:44px}.gi-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}' +
    '.gi-chip{border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer}.gi-err{color:#b91c1c}' +
    '@media (prefers-color-scheme:dark){.gi-card{background:#1f2937;border-color:#374151;color:#f3f4f6}.gi-msg.a{background:#374151;color:#f3f4f6}.gi-tab.on{color:#f3f4f6}}';

  function build() {
    var nav = document.querySelector(C.nav);
    if (!nav || document.getElementById('gi-nav')) return;
    document.head.appendChild(el('style', {}, CSS));

    var btn = el('button', { id: 'gi-nav', class: C.navClass, type: 'button', 'data-intel': '1' },
      '<span class="nav-icon">&#129504;</span><span>Intelligence</span>');
    var ref = C.before && nav.querySelector(C.before);
    ref ? nav.insertBefore(btn, ref) : nav.appendChild(btn);

    var firstPage = document.querySelector('.' + C.pageClass);
    var host = (C.container && document.querySelector(C.container)) || (firstPage && firstPage.parentNode) || document.querySelector('main') || document.body;
    var page = el('div', { id: 'page-intelligence', class: C.pageClass });
    if (!firstPage) page.style.display = 'none';
    page.innerHTML = '<div class="gi-wrap"><div class="gi-head"><h2>&#129504; Intelligence</h2><p>AI on your ' + esc(C.app) +
      ' data &middot; Cloudflare Workers AI</p></div><div class="gi-tabs">' +
      '<button class="gi-tab on" data-t="analyze">AI Analysis</button><button class="gi-tab" data-t="suggest">AI Suggestions</button><button class="gi-tab" data-t="chat">AI Chat</button></div>' +
      '<div data-p="analyze"></div><div data-p="suggest" hidden></div><div data-p="chat" hidden></div></div>';
    host.appendChild(page);

    ['analyze', 'suggest'].forEach(function (m) {
      page.querySelector('[data-p="' + m + '"]').innerHTML = '<div class="gi-bar"><span class="gi-muted" data-s="' + m + '">Not run yet</span>' +
        '<button class="gi-btn" data-run="' + m + '">' + (m === 'analyze' ? 'Analyse my data' : 'Suggest improvements') + '</button></div><div class="gi-card" data-o="' + m + '">' +
        '<p class="gi-muted">Click the button to run.</p></div>';
    });
    page.querySelector('[data-p="chat"]').innerHTML = '<div class="gi-chips">' +
      ['What are my 3 biggest problems?', 'Where am I losing the most?', 'What should I do this week?'].map(function (q) { return '<button class="gi-chip">' + q + '</button>'; }).join('') +
      '</div><div class="gi-log"></div><div class="gi-row"><textarea placeholder="Ask about your data or the suggested improvements…"></textarea><button class="gi-btn" data-send>Send</button></div>';

    page.addEventListener('click', function (e) {
      var t = e.target.closest('.gi-tab, [data-run], [data-send], .gi-chip'); if (!t) return;
      if (t.classList.contains('gi-tab')) {
        page.querySelectorAll('.gi-tab').forEach(function (x) { x.classList.toggle('on', x === t); });
        page.querySelectorAll('[data-p]').forEach(function (p) { p.hidden = p.getAttribute('data-p') !== t.dataset.t; });
        if (t.dataset.t !== 'chat' && !cache[t.dataset.t]) runMode(t.dataset.t);
      } else if (t.dataset.run) runMode(t.dataset.run, true);
      else if (t.classList.contains('gi-chip')) { page.querySelector('textarea').value = t.textContent; send(); }
      else send();
    });
    page.querySelector('textarea').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

    async function runMode(m, force) {
      if (busy && !force) return;
      var out = page.querySelector('[data-o="' + m + '"]'), st = page.querySelector('[data-s="' + m + '"]'), b = page.querySelector('[data-run="' + m + '"]');
      b.disabled = true; st.textContent = 'Thinking…'; out.innerHTML = '<p class="gi-muted">Reading your data…</p>';
      try { var txt = await ask(m); cache[m] = txt; out.innerHTML = md(txt); st.textContent = 'Updated ' + new Date().toLocaleTimeString(); }
      catch (err) { out.innerHTML = '<p class="gi-err">' + esc(err.message) + '</p>'; st.textContent = 'Failed'; }
      b.disabled = false;
    }
    function bubble(role, html) { var log = page.querySelector('.gi-log'); var d = el('div', { class: 'gi-msg ' + (role === 'user' ? 'u' : 'a') }, html); log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
    async function send() {
      var ta = page.querySelector('textarea'), q = ta.value.trim(); if (!q || busy) return;
      ta.value = ''; busy = true; chat.push({ role: 'user', content: q }); bubble('user', esc(q));
      var ctx = cache.suggest ? [{ role: 'assistant', content: 'Earlier suggestions:\n' + cache.suggest }] : [];
      var pending = bubble('assistant', '<span class="gi-muted">Thinking…</span>');
      try { var a = await ask('chat', ctx.concat(chat)); chat.push({ role: 'assistant', content: a }); pending.innerHTML = md(a); }
      catch (err) { chat.pop(); pending.innerHTML = '<span class="gi-err">' + esc(err.message) + '</span>'; }
      busy = false;
    }

    btn.addEventListener('click', function () {
      document.querySelectorAll('.' + C.navClass).forEach(function (n) { n.classList.remove('active'); });
      document.querySelectorAll('.' + C.pageClass).forEach(function (p) { p.classList.remove('active'); if (!firstPage) p.style.display = 'none'; });
      btn.classList.add('active'); page.classList.add('active'); if (!firstPage) page.style.display = '';
      var sb = document.querySelector('.sidebar'); if (sb) sb.classList.remove('open');
      if (!cache.analyze) runMode('analyze');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
  window.GershonIntelligence = { rebuild: build };
})();
