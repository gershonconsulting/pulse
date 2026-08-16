// functions/api/login.js
// GET /api/login — starts the LinkedIn OpenID Connect sign-in flow.
//
// Generates a CSRF `state`, parks it (plus the post-login destination) in a short-lived
// HttpOnly cookie, then 302s to LinkedIn. The client secret is NEVER used here — only
// in /callback, server-side. This repo is PUBLIC: no credential may ever appear in source.

import { STATE_COOKIE, buildCookie } from '../_session.js';

function configError(missing) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Pulse — sign-in not configured</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial,sans-serif;background:#0b1120;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
.b{max-width:520px;background:#111c33;border:1px solid #1e3a5f;border-radius:16px;padding:28px 30px}
h1{font-size:1.25rem;margin:0 0 .6rem}code{background:#0b1120;border:1px solid #1e3a5f;border-radius:6px;padding:2px 6px;font-size:.85rem}
ul{margin:.8rem 0 0;padding-left:1.1rem;line-height:1.9}a{color:#38bdf8}</style></head>
<body><div class="b"><h1>LinkedIn sign-in isn't configured yet</h1>
<p>Pulse is deployed, but these Cloudflare Pages environment variables are still missing:</p>
<ul>${missing.map(m => `<li><code>${m}</code></li>`).join('')}</ul>
<p style="margin-top:1rem">Add them in Cloudflare → Pages → <b>gershon-pulse</b> → Settings → Environment variables (Production), then redeploy.</p>
<p><a href="/">← Back to pulse.gershoncrm.com</a></p></div></body></html>`,
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

export async function onRequestGet({ request, env }) {
  const missing = [];
  if (!env.LINKEDIN_CLIENT_ID) missing.push('LINKEDIN_CLIENT_ID');
  if (!env.LINKEDIN_CLIENT_SECRET) missing.push('LINKEDIN_CLIENT_SECRET');
  if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (!env.ALLOWLIST) missing.push('ALLOWLIST');
  if (missing.length) return configError(missing);

  const url = new URL(request.url);
  const redirectUri = env.LINKEDIN_REDIRECT_URI || new URL('/callback', url).toString();

  // Keep the intended destination so a deep link survives the round trip.
  let next = url.searchParams.get('next') || '/app.html';
  if (!next.startsWith('/') || next.startsWith('//')) next = '/app.html';

  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.LINKEDIN_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    state,
  });

  const headers = new Headers({
    Location: 'https://www.linkedin.com/oauth/v2/authorization?' + params.toString(),
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', buildCookie(STATE_COOKIE, state, 600));
  headers.append('Set-Cookie', buildCookie('pulse_next', encodeURIComponent(next), 600));

  return new Response(null, { status: 302, headers });
}
