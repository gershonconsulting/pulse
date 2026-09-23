// ─── SUGGESTED REPLIES (v5.10.0) ───
// "✨ Suggest reply" on a conversation -> POST /api/suggest -> 2-4 editable drafts with
// Copy. Drafts are grounded in Company knowledge + Past replies (Replies page). Copying a
// draft stores it in the library (source 'copied'), so suggestions learn from what you
// actually send. State survives the list re-render that loadAllData() triggers.
var suggState = {};   // name -> {loading} | {error} | result from /api/suggest

function suggFind(name) {
  for (var i = 0; i < allMessages.length; i++) if (allMessages[i].name === name) return allMessages[i];
  return null;
}

var SUGG_ENGINE = { claude: 'Claude AI', 'workers-ai': 'Cloudflare AI', templates: 'Smart templates' };
var SUGG_BASIS = { ai: 'AI draft', template: 'Template', past: 'Past reply' };

function suggPanelHtml(m, st) {
  if (st.loading) return '<div class="sugg-loading">&#10024; Writing suggestions for ' + esc(m.name) + '&hellip;</div>';
  if (st.error) return '<div class="sugg-loading" style="color:var(--red)">Could not get suggestions: ' + esc(st.error) +
    ' <button type="button" class="sugg-link" data-sugg-act="refresh" data-sugg-name="' + escapeAttr(m.name) + '">Try again</button></div>';
  var nm = escapeAttr(m.name);
  var head = '<div class="sugg-head">' +
    '<span class="sugg-pill">' + esc(st.intentLabel || st.intent) + '</span>' +
    '<span class="sugg-pill grey">' + (st.language === 'fr' ? 'Fran&ccedil;ais' : 'English') + '</span>' +
    '<span>Based on <b>' + (st.kbConfigured ? 'company knowledge' : 'no company knowledge yet') + '</b> &middot; <b>' +
      st.pastRepliesUsed + '</b> of ' + st.pastRepliesAvailable + ' past repl' + (st.pastRepliesAvailable === 1 ? 'y' : 'ies') + ' &middot; ' + esc(SUGG_ENGINE[st.engine] || st.engine) + '</span>' +
    '<span class="sugg-sp"></span>' +
    (st.engine !== 'templates' ? '<button type="button" class="sugg-link" data-sugg-act="refresh" data-sugg-name="' + nm + '">&#8635; New suggestions</button>' : '') +
    '<button type="button" class="sugg-link" data-sugg-act="kb">Edit knowledge</button>' +
    '<button type="button" class="sugg-link" data-sugg-act="close" data-sugg-name="' + nm + '">Close</button>' +
  '</div>';
  var cards = (st.suggestions || []).map(function (s, i) {
    return '<div class="sugg-card">' +
      '<div class="sugg-card-top"><span>' + esc(s.label) + '</span><span class="sugg-basis ' + escapeAttr(s.basis || '') + '">' + esc(SUGG_BASIS[s.basis] || s.basis || '') + '</span></div>' +
      '<textarea class="sugg-text" data-sugg-i="' + i + '" aria-label="Suggested reply ' + (i + 1) + '">' + esc(s.text) + '</textarea>' +
      '<div class="sugg-actions">' +
        '<button type="button" class="sugg-copy" data-sugg-act="copy" data-sugg-name="' + nm + '" data-sugg-i="' + i + '">&#128203; Copy</button>' +
        '<a class="sugg-open" href="' + escapeAttr(threadLink(m)) + '" target="_blank" rel="noopener">Open chat &#8599;</a>' +
      '</div>' +
    '</div>';
  }).join('');
  var note = '';
  if (!st.kbConfigured) note = 'Tip: fill in <b>Company knowledge</b> on the Replies page so drafts describe what you actually do.';
  else if (st.engineNote) note = esc(st.engineNote);
  else if (st.engine === 'templates') note = 'Edit any draft before copying &mdash; what you copy is saved to your library and shapes future suggestions.';
  return head + '<div class="sugg-grid">' + cards + '</div>' + (note ? '<div class="sugg-note">' + note + '</div>' : '');
}

function suggPaint(name) {
  var panels = document.querySelectorAll('.sugg-panel');
  var m = suggFind(name);
  var done = false;
  panels.forEach(function (p) {
    if (p.getAttribute('data-sugg-panel') === name && m && suggState[name]) { p.innerHTML = suggPanelHtml(m, suggState[name]); done = true; }
  });
  if (!done) renderMessages(filterMessages());
}

async function suggLoad(name) {
  suggState[name] = { loading: true };
  suggPaint(name);
  try {
    var res = await fetch(API_BASE + '/api/suggest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }),
    });
    var j = await res.json().catch(function () { return {}; });
    if (!suggState[name]) return; // closed while loading
    suggState[name] = res.ok ? j : { error: j.error || ('HTTP ' + res.status) };
  } catch (e) {
    if (!suggState[name]) return;
    suggState[name] = { error: e.message || 'network error' };
  }
  suggPaint(name);
}

function suggCopyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () { return suggCopyFallback(text); });
  }
  return Promise.resolve(suggCopyFallback(text));
}
function suggCopyFallback(text) {
  var ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

async function suggCopy(btn) {
  var name = btn.getAttribute('data-sugg-name');
  var i = btn.getAttribute('data-sugg-i');
  var card = btn.closest('.sugg-card');
  var ta = card && card.querySelector('.sugg-text');
  var text = ta ? ta.value : '';
  if (!text.trim()) return;
  await suggCopyText(text);
  btn.classList.add('done'); btn.innerHTML = '&#10003; Copied';
  setTimeout(function () { btn.classList.remove('done'); btn.innerHTML = '&#128203; Copy'; }, 2000);
  // Remember what was actually used (edited text included) so the library learns.
  var st = suggState[name] || {};
  var m = suggFind(name) || {};
  var s = (st.suggestions || [])[+i] || {};
  if (s) s.text = text;
  try {
    fetch(API_BASE + '/api/replies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text, source: 'copied', leadName: m.name || name,
        context: m.lastSender === 'you' ? '' : (m.snippet || ''),
        intent: st.intent, language: st.language,
      }),
    });
  } catch (e) {}
}

document.getElementById('message-list').addEventListener('click', function (e) {
  var chip = e.target.closest('[data-sugg]');
  if (chip) {
    var n = chip.getAttribute('data-sugg');
    if (suggState[n]) { delete suggState[n]; renderMessages(filterMessages()); }
    else { suggState[n] = { loading: true }; renderMessages(filterMessages()); suggLoad(n); }
    return;
  }
  var act = e.target.closest('[data-sugg-act]');
  if (!act) return;
  var a = act.getAttribute('data-sugg-act');
  var nm = act.getAttribute('data-sugg-name');
  if (a === 'copy') suggCopy(act);
  else if (a === 'refresh') suggLoad(nm);
  else if (a === 'close') { delete suggState[nm]; renderMessages(filterMessages()); }
  else if (a === 'kb') { var nav = document.querySelector('.nav-item[data-page="replies"]'); if (nav) nav.click(); }
});
// Keep edits typed into a draft when the list re-renders (loadAllData after a star/check).
document.getElementById('message-list').addEventListener('input', function (e) {
  var ta = e.target.closest('.sugg-text');
  if (!ta) return;
  var panel = ta.closest('.sugg-panel');
  var st = panel && suggState[panel.getAttribute('data-sugg-panel')];
  var s = st && st.suggestions && st.suggestions[+ta.getAttribute('data-sugg-i')];
  if (s) s.text = ta.value;
});

// ─── REPLIES PAGE: company knowledge + reply library ───
var KB_FIELDS = ['company', 'sender', 'pitch', 'pitchFr', 'proof', 'proofFr', 'market', 'marketFr', 'cta', 'calendarLink', 'tone', 'notes'];
var libData = { replies: [], sent: [] };
var libCurrent = 'library';
var LIB_INTENT = { follow_up: 'Follow-up', ooo: 'Out of office', decline: 'Not interested', defer: 'Later', referral: 'Referral', meeting: 'Wants to talk', info: 'Info request', positive: 'Interested', thanks: 'Thank-you', generic: 'Reply' };

async function renderReplies() {
  var st = document.getElementById('kb-state');
  try {
    var r = await Promise.all([fetch(API_BASE + '/api/knowledge'), fetch(API_BASE + '/api/replies')]);
    var kbj = await r[0].json();
    libData = await r[1].json();
    var kb = kbj.kb || {};
    KB_FIELDS.forEach(function (f) { var el = document.getElementById('kb-' + f); if (el) el.value = kb[f] || ''; });
    if (st) {
      var ok = !!(kb.pitch || kb.pitchFr);
      st.className = 'diag-badge ' + (ok ? 'ok' : 'warn');
      st.textContent = ok ? (kb.updatedAt ? 'Saved ' + formatDate(kb.updatedAt) : 'Default') : 'Needs your pitch';
    }
  } catch (e) {
    if (st) { st.className = 'diag-badge error'; st.textContent = 'Could not load'; }
    libData = { replies: [], sent: [] };
  }
  libPaint();
}

async function kbSave() {
  var body = {};
  KB_FIELDS.forEach(function (f) { var el = document.getElementById('kb-' + f); body[f] = el ? el.value : ''; });
  var hint = document.getElementById('kb-hint');
  hint.textContent = 'Saving…';
  try {
    var res = await fetch(API_BASE + '/api/knowledge', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kb: body }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    hint.textContent = 'Saved. New suggestions will use it.';
    suggState = {};
    renderReplies();
  } catch (e) { hint.textContent = 'Could not save: ' + e.message; }
}

function libTab(t) {
  libCurrent = t;
  document.querySelectorAll('[data-lib]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-lib') === t); });
  libPaint();
}

function libPaint() {
  var list = document.getElementById('lib-list');
  if (!list) return;
  var lib = libData.replies || [], sent = libData.sent || [];
  document.getElementById('lib-count-library').textContent = '(' + lib.length + ')';
  document.getElementById('lib-count-sent').textContent = '(' + sent.length + ')';
  var rows = libCurrent === 'sent' ? sent : lib;
  if (!rows.length) {
    list.innerHTML = '<div class="lib-empty">' + (libCurrent === 'sent'
      ? 'No sent messages captured yet. After each sync, your last message in every LinkedIn conversation where you spoke last shows up here.'
      : 'No saved replies yet. Copy a suggestion from Conversations, or add one above.') + '</div>';
    return;
  }
  list.innerHTML = rows.map(function (r) {
    var meta = [];
    if (r.intent) meta.push('<span class="sugg-pill">' + esc(LIB_INTENT[r.intent] || r.intent) + '</span>');
    meta.push('<span class="sugg-pill grey">' + (r.language === 'fr' ? 'FR' : 'EN') + '</span>');
    if (r.source === 'copied') meta.push('<span>Copied from a suggestion</span>');
    if (r.source === 'manual') meta.push('<span>Added by you</span>');
    if (r.uses) meta.push('<span>Used ' + r.uses + '&times;</span>');
    if (r.leadName) meta.push('<span>' + (r.source === 'sent' ? 'Sent to ' : 'For ') + esc(r.leadName) + '</span>');
    if (r.context) meta.push('<span class="lib-ctx">In reply to &ldquo;' + esc(r.context.slice(0, 90)) + (r.context.length > 90 ? '&hellip;' : '') + '&rdquo;</span>');
    return '<div class="lib-row"><div style="flex:1;min-width:0"><div class="lib-text">' + esc(r.text) + '</div><div class="lib-meta">' + meta.join('') + '</div></div>' +
      '<div style="display:flex;flex-direction:column;gap:6px">' +
        '<button type="button" class="lib-btn" data-lib-copy="' + escapeAttr(r.id) + '">&#128203; Copy</button>' +
        (r.source !== 'sent' ? '<button type="button" class="lib-btn danger" data-lib-del="' + escapeAttr(r.id) + '">Remove</button>' : '') +
      '</div></div>';
  }).join('');
}

document.getElementById('lib-list').addEventListener('click', function (e) {
  var c = e.target.closest('[data-lib-copy]');
  var d = e.target.closest('[data-lib-del]');
  var pool = (libData.replies || []).concat(libData.sent || []);
  if (c) {
    var r = pool.find(function (x) { return x.id === c.getAttribute('data-lib-copy'); });
    if (r) suggCopyText(r.text).then(function () { c.innerHTML = '&#10003; Copied'; setTimeout(function () { c.innerHTML = '&#128203; Copy'; }, 2000); });
  } else if (d) {
    var id = d.getAttribute('data-lib-del');
    d.disabled = true;
    fetch(API_BASE + '/api/replies?id=' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () { libData.replies = (libData.replies || []).filter(function (x) { return x.id !== id; }); libPaint(); });
  }
});

async function libAdd() {
  var ta = document.getElementById('lib-new');
  var text = (ta.value || '').trim();
  if (text.length < 5) { ta.focus(); return; }
  var res = await fetch(API_BASE + '/api/replies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, source: 'manual' }) });
  if (res.ok) { ta.value = ''; renderReplies(); }
}
