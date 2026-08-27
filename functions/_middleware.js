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
//   - A COHOST (see functions/_admin.js) is an internal operator with no tenant of
//     their own. They pick which client they are looking at; that choice rides in the
//     `pulse_view` cookie and is re-validated against the registry on EVERY request,
//     so the cookie is a preference, not a permission. Only a super-admin or an
//     active CoHost can make it mean anything.
//   - `/admin` and `/api/admin/*` are the control plane: signed-in SUPER-ADMINS only
//     (ADMIN_EMAILS env var). A bearer token can never reach them, by design — a
//     leaked collector token must not be able to create clients or read the registry.
//
// Fails CLOSED: with SESSION_SECRET unset no session can ever verify, so protected
// routes stay locked rather than falling through to the data.

import { getSession, safeEqual, parseCookies } from './_session.js';
import {
  readAdminStore, findClient, findClientByToken, findClientByEmail,
  findCohostByEmail, isAdminEmail, VIEW_COOKIE, VIEW_DEFAULT,
} from './_admin.js';

// Paths anyone may reach without a session.
const PUBLIC_PATHS = new Set([
  '/',
  '/index.html',
  '/callback',          // LinkedIn OAuth redirect target (registered in the LinkedIn app)
  '/invite',            // CoHost invite link — the recipient is not signed in yet, by definition
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
    const isAdmin = isAdminEmail(session.email, env);

    // 3a. The control plane needs more than a session — it needs super-admin.
    //     A CoHost is NOT a super-admin: the registry, the tokens and the audit log
    //     stay out of reach no matter which tenant they are viewing.
    if (isAdminSurface && !isAdmin) {
      if (isApi) return forbiddenJson();
      return new Response(null, {
        status: 302,
        headers: { Location: new URL('/app.html', url).toString(), 'Cache-Control': 'no-store' },
      });
    }

    // The cookie carries the clientId stamped at sign-in. If someone was added to
    // a client AFTER they signed in, that cookie still says null — which would have
    // pointed them at the DEFAULT tenant (Gershon's own data). Re-resolve from the
    // registry in that case so a 30-day-old cookie can never cross tenants.
    let clientId = session.clientId || null;
    let store = null;
    if (!clientId) {
      store = await readAdminStore(env);
      const c = findClientByEmail(store, session.email);
      if (c && c.status !== 'suspended') clientId = c.id;
    }

    // 3b. CoHost / super-admin tenant switching.
    //     `session.cohost` is only a hint from a 30-day-old cookie — authority is the
    //     LIVE registry. If the record was revoked or deleted since sign-in, the
    //     session is refused here rather than quietly falling back to the default
    //     tenant, which is Gershon's own data.
    let cohost = null;
    if (!isAdmin) {
      if (!store) store = await readAdminStore(env);
      cohost = findCohostByEmail(store, session.email);
      if (session.cohost && !cohost) {
        if (isApi) return unauthorizedJson();
        return new Response(null, {
          status: 302,
          headers: { Location: new URL('/?denied=1&reason=cohost-revoked', url).toString(), 'Cache-Control': 'no-store' },
        });
      }
    }

    let viewingAs = null;
    if (isAdmin || cohost) {
      const wanted = String(parseCookies(request.headers.get('Cookie'))[VIEW_COOKIE] || '').trim();
      if (wanted === VIEW_DEFAULT) {
        clientId = null;
        viewingAs = isAdmin ? 'admin' : 'cohost';
      } else if (wanted) {
        if (!store) store = await readAdminStore(env);
        const target = findClient(store, wanted);
        // An unknown or stale id falls back to the caller's own tenant rather than
        // erroring — a deleted client must never strand an operator on a blank app.
        if (target) {
          clientId = target.id;
          viewingAs = isAdmin ? 'admin' : 'cohost';
        }
      } else if (cohost) {
        // A CoHost has no tenant of their own; with nothing selected they land on the
        // default store, and the dashboard's switcher says so in as many words.
        clientId = null;
      }
    }

    context.data = Object.assign({}, context.data, {
      auth: 'session',
      session,
      clientId,
      isAdmin,
      cohostId: cohost ? cohost.id : null,
      // True when this tenant came from the view switcher rather than from the
      // caller's own membership. Routes that hand out a tenant's own credentials
      // (see functions/api/my-token.js) refuse in that case.
      viewingAs,
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
