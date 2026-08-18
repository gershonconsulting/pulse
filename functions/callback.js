// functions/callback.js
// GET /callback — LinkedIn OpenID Connect redirect target.
// This exact path is what's registered in the LinkedIn app
// ("Authorized redirect URLs" → https://pulse.gershoncrm.com/callback).
//
// 1. Validate the CSRF state cookie.
// 2. Exchange the authorization code for an access token (client secret used ONLY here).
// 3. Read the identity from LinkedIn's userinfo endpoint.
// 4. Check the email against the client registry + ALLOWLIST env var (invite-only,
//    fails closed). See functions/_admin.js — /admin manages the registry.
// 5. Issue the signed HMAC session cookie and land the user on the dashboard.

import {
  sign, parseCookies, buildCookie, clearCookie, safeEqual,
  COOKIE_NAME, STATE_COOKIE, SESSION_MAX_AGE,
} from './_session.js';
import { resolveAccess, touchUser } from './_admin.js';

function bounce(url, params, extraHeaders) {
  const dest = new URL('/', url);
  Object.keys(params).forEach(k => dest.searchParams.set(k, params[k]));
  const headers = new Headers({ Location: dest.toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearCookie(STATE_COOKIE));
  headers.append('Set-Cookie', clearCookie('pulse_next'));
  (extraHeaders || []).forEach(h => headers.append('Set-Cookie', h));
  return new Response(null, { status: 302, headers });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get('Cookie'));

  // The user hit "Cancel" on LinkedIn's consent screen.
  const oauthError = url.searchParams.get('error');
  if (oauthError) return bounce(url, { error: oauthError });

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state || !cookies[STATE_COOKIE] || !safeEqual(state, cookies[STATE_COOKIE])) {
    return bounce(url, { error: 'state' });
  }

  if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET || !env.SESSION_SECRET) {
    return bounce(url, { error: 'config' });
  }

  const redirectUri = env.LINKEDIN_REDIRECT_URI || new URL('/callback', url).toString();

  // --- 2. Code → token (server-side only) ---
  let tok;
  try {
    const resp = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: env.LINKEDIN_CLIENT_ID,
        client_secret: env.LINKEDIN_CLIENT_SECRET,
      }),
    });
    tok = await resp.json();
  } catch (e) {
    return bounce(url, { error: 'token' });
  }
  if (!tok || !tok.access_token) return bounce(url, { error: 'token' });

  // --- 3. Identity ---
  let who;
  try {
    const resp = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tok.access_token },
    });
    who = await resp.json();
  } catch (e) {
    return bounce(url, { error: 'userinfo' });
  }
  if (!who || !who.sub) return bounce(url, { error: 'userinfo' });

  const email = String(who.email || '').toLowerCase();

  // --- 4. Invite-only gate (client registry, then ALLOWLIST escape hatch) ---
  const access = await resolveAccess(email, env);
  if (!access.allowed) {
    // Echo the rejected address back so the admin knows exactly who to add in /admin.
    return bounce(url, { denied: '1', e: email || 'unknown', reason: access.reason });
  }
  // Best-effort last-seen stamp for the admin console.
  await touchUser(env, email);

  // --- 5. Session ---
  const now = Date.now();
  const token = await sign({
    sub: who.sub,
    email,
    clientId: access.client ? access.client.id : null,
    admin: !!access.admin,
    name: who.name || [who.given_name, who.family_name].filter(Boolean).join(' ') || email,
    picture: who.picture || null,
    iat: now,
    exp: now + SESSION_MAX_AGE * 1000,
  }, env.SESSION_SECRET);

  let next = '/app.html';
  if (cookies.pulse_next) {
    try {
      const raw = decodeURIComponent(cookies.pulse_next);
      if (raw.startsWith('/') && !raw.startsWith('//')) next = raw;
    } catch (e) { /* keep default */ }
  }

  const headers = new Headers({ Location: new URL(next, url).toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearCookie(STATE_COOKIE));
  headers.append('Set-Cookie', clearCookie('pulse_next'));
  headers.append('Set-Cookie', buildCookie(COOKIE_NAME, token, SESSION_MAX_AGE));
  return new Response(null, { status: 302, headers });
}
