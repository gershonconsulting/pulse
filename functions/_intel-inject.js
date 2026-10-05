// functions/_intel-inject.js — adds the Intelligence menu to the dashboard (v5.13.0, 2026-10-05)
// Runs after the auth gate (see the onRequest array in _middleware.js). For the dashboard
// HTML only, it appends the Intelligence config + /intelligence.js before </body> with
// HTMLRewriter, so app.html itself stays untouched.
// The menu: AI Analysis · AI Suggestions · AI Chat — all on Cloudflare Workers AI (/api/intelligence).

const SNIPPET = `<script>
window.GERSHON_INTEL = {
  app: 'Pulse (LinkedIn message triage)',
  nav: '.sidebar-nav', before: '[data-page="settings"]', navClass: 'nav-item', pageClass: 'page-view',
  collect: function () {
    var msgs = (typeof allMessages !== 'undefined' && allMessages) || [];
    function count(k) { var o = {}; msgs.forEach(function (m) { var v = m[k] == null ? 'unknown' : String(m[k]); o[v] = (o[v] || 0) + 1; }); return o; }
    var recent = msgs.slice().sort(function (a, b) { return String(b.timestamp || b.date || '').localeCompare(String(a.timestamp || a.date || '')); })
      .slice(0, 60).map(function (m) { return { name: m.name, status: m.status, interest: m.interest, fit: m.fit, campaign: m.campaign,
        country: m.country, done: !!m.done, date: m.timestamp || m.date, snippet: String(m.snippet || '').slice(0, 160) }; });
    return { totalConversations: msgs.length, stats: (typeof statsData !== 'undefined') ? statsData : null,
      byStatus: count('status'), byInterest: count('interest'), byFit: count('fit'), byCampaign: count('campaign'),
      byCountry: count('country'), byPlatform: count('platform'), done: msgs.filter(function (m) { return m.done; }).length, recent: recent };
  }
};
</script>
<script src="/intelligence.js?v=1.0" defer></script>`;

const DASHBOARD = new Set(['/app', '/app.html']);

export async function intelInject({ request, next }) {
  const res = await next();
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const type = res.headers.get('content-type') || '';
  if (!DASHBOARD.has(path) || !type.includes('text/html') || res.status !== 200) return res;
  return new HTMLRewriter()
    .on('body', { element(el) { el.append(SNIPPET, { html: true }); } })
    .transform(res);
}
