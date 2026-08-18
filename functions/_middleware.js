// functions/_middleware.js
// Single root gate for pulse.gershoncrm.com — runs on EVERY request.
//
// WHY A ROOT MIDDLEWARE: Cloudflare Pages serves the SPA fallback (app/index.html)
// for any unknown path, so per-page checks always leave holes. One middleware closes
// them all at once.
//
// Access model (2026-08-16): sign-in is LinkedIn OAuth ONLY. There is no password.
//   - `/` is the public marketing homepage — the only way in is "Sign in with LinkedIn".
//   - `/app.html` (the dashboard) and every `/api/*` route require a signed session
//     cookie issued by /callback after LinkedIn confirms the identity AND the email
//     is on the ALLOWLIST env var.
//   - The Chrome extension cannot hold a cookie, so it authenticates with a bearer
//     token (header `X-Pulse-Token`, or `Authorization: Bearer …`): either the legacy
//     shared EXTENSION_TOKEN, or a per-client token issued from /admin.
//   - `/admin` and `/api/admin/*` are the control plane: signed-in SUPER-ADMINS only
//     (ADMIN_EMAILS env var). A bearer token can never reach them, by design — a
//     leaked collector token must not be able to create clients or read the registry.
//
// Fails CLOSED: with SESSION_SECRET unset no session can ever verify, so protected
// routes stay locked rather than falling through to the data.

import { getSession, safeEqual } from './_session.js';
import { readAdminStore, findClientByToken, isAdminEmail } from './_admin.js';

// Paths anyone may reach without a session.
const PUBLIC_PATHS = new Set([
  '/',
  '/index.html',
  '/callback',          // LinkedIn OAuth redirect target (registered in the LinkedIn app)
  '/api/login',         // starts the OAuth dance
  '/api/logout',        // clearing a cookie needs no cookie
  '/api/me',            // returns 401 by design when signed out — the homepage/app both poll it
  '/api/health',        // liveness only, exposes no data
  '/api/health-check',  // watchdog endpoint — carries its own HEALTH_CHECK_SECRET
  '/favicon.ico',
  '/favicon.svg',
  '/robots.txt',
  '/sitemap.xml',
]);

// Static assets the marketing page may reference.
const PUBLIC_ASSET_RE = /\.(css|js|mjs|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|map|txt|webmanifest)$/i;

// Ingest endpoints the Chrome extension writes to.
const INGEST_PATHS = new Set(['/api/messages', '/api/report']);

function normalize(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '') || '/';
  return pathname;
}

function bearerToken(request) {
  const direct = request.headers.get('X-Pulse-Token');
  if (direct) return direct.trim();
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function forbiddenJson() {
  return new Response(
    JSON.stringify({ ok: false, error: 'forbidden', message: 'Administrator access required.' }),
    { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
}

function unauthorizedJson() {
  return new Response(
    JSON.stringify({ ok: false, error: 'unauthorized', message: 'Sign in with LinkedIn at https://pulse.gershoncrm.com/' }),
    { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = normalize(url.pathname);
  const isAdminSurface = path === '/admin' || path === '/admin.html' || path.startsWith('/api/admin/') || path === '/api/admin';

  // 1. Public surface — homepage, OAuth entry/exit, static assets.
  if (PUBLIC_PATHS.has(path) || PUBLIC_ASSET_RE.test(path)) return next();

  const isApi = path.startsWith('/api/');

  // 2. Chrome extension: bearer token (API access only — never unlocks the UI, and
  //    never the admin control plane).
  if (isApi && !isAdminSurface) {
    const token = bearerToken(request);
    if (token) {
      // 2a. Legacy shared token from the env var.
      if (env.EXTENSION_TOKEN && safeEqual(token, env.EXTENSION_TOKEN)) {
        context.data = Object.assign({}, context.data, { auth: 'token', clientId: null });
        return next();
      }
      // 2b. Per-client token issued from /admin (suspended clients are refused).
      const store = await readAdminStore(env);
      const client = findClientByToken(store, token);
      if (client) {
        context.data = Object.assign({}, context.data, { auth: 'token', clientId: client.id });
        return next();
      }
    }
  }

  // 3. Human: signed LinkedIn session cookie.
  const session = await getSession(request, env);
  if (session) {
    // 3a. The control plane needs more than a session — it needs super-admin.
    if (isAdminSurface && !isAdminEmail(session.email, env)) {
      if (isApi) return forbiddenJson();
      return new Response(null, {
        status: 302,
        headers: { Location: new URL('/app.html', url).toString(), 'Cache-Control': 'no-store' },
      });
    }
    context.data = Object.assign({}, context.data, {
      auth: 'session',
      session,
      clientId: session.clientId || null,
    });
    return next();
  }

  // 4. Transition grace: until EXTENSION_TOKEN is configured, let the already-installed
  //    collector keep POSTing so data collection never silently dies mid-rollout.
  //    Reads stay locked either way — this only covers write-only ingest.
  if (!env.EXTENSION_TOKEN && request.method === 'POST' && INGEST_PATHS.has(path)) {
    return next();
  }

  if (isApi) return unauthorizedJson();

  // 5. Anything else (the dashboard, unknown HTML paths) → back to the sign-in homepage.
  const home = new URL('/', url);
  if (path !== '/' && path !== '/index.html') home.searchParams.set('next', path);
  return new Response(null, { status: 302, headers: { Location: home.toString(), 'Cache-Control': 'no-store' } });
}
