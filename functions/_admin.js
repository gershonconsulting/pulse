// functions/_admin.js
// Client registry ("admin store") for Pulse — the multi-tenant control plane.
// Underscore-prefixed files inside functions/ are NOT routed, so this is a private helper.
//
// WHY KV AND NOT ENV VARS: the original access model was a single comma-separated
// ALLOWLIST env var, which meant onboarding a client required a Cloudflare dashboard
// edit + a redeploy. The registry below lives in KV under the key `admin`, so
// /admin can create clients, add users and rotate tokens with zero deploys.
//
// The env vars are deliberately KEPT as escape hatches that KV can never break:
//   ADMIN_EMAILS — super-admins who may reach /admin  (falls back to ALLOWLIST)
//   ALLOWLIST    — emails that may always sign in, registry or not
//   EXTENSION_TOKEN — the legacy single shared collector token
//
// Store shape (KV key `admin`):
// {
//   version: 1,
//   clients: [{
//     id, name, status: 'trial'|'active'|'suspended', plan,
//     createdAt, trialEndsAt, notes, reportEmail,
//     extensionToken, tokenRotatedAt,
//     users: [{ email, role: 'owner'|'member', addedAt, lastSeenAt }]
//   }],
//   audit: [{ ts, actor, action, target, detail }],   // newest first, capped
//   updatedAt
// }

import { safeEqual } from './_session.js';

export const ADMIN_KEY = 'admin';
const AUDIT_MAX = 500;

export const CLIENT_STATUSES = ['trial', 'active', 'suspended'];
export const USER_ROLES = ['owner', 'member'];

const lc = (s) => String(s || '').trim().toLowerCase();

function emptyStore() {
  return { version: 1, clients: [], audit: [], updatedAt: null };
}

/** Normalise anything KV hands back into a well-formed store. */
export function normalizeStore(raw) {
  const store = (raw && typeof raw === 'object') ? raw : {};
  return {
    version: 1,
    clients: Array.isArray(store.clients) ? store.clients.map(normalizeClient) : [],
    audit: Array.isArray(store.audit) ? store.audit.slice(0, AUDIT_MAX) : [],
    updatedAt: store.updatedAt || null,
  };
}

function normalizeClient(c) {
  const client = (c && typeof c === 'object') ? c : {};
  return {
    id: String(client.id || ''),
    name: String(client.name || client.id || ''),
    status: CLIENT_STATUSES.indexOf(client.status) !== -1 ? client.status : 'trial',
    plan: String(client.plan || 'trial'),
    createdAt: client.createdAt || null,
    trialEndsAt: client.trialEndsAt || null,
    notes: String(client.notes || ''),
    reportEmail: String(client.reportEmail || ''),
    extensionToken: String(client.extensionToken || ''),
    tokenRotatedAt: client.tokenRotatedAt || null,
    users: Array.isArray(client.users) ? client.users.map(u => ({
      email: lc(u && u.email),
      role: (u && USER_ROLES.indexOf(u.role) !== -1) ? u.role : 'member',
      addedAt: (u && u.addedAt) || null,
      lastSeenAt: (u && u.lastSeenAt) || null,
    })).filter(u => u.email) : [],
  };
}

/** Read the registry. Never throws — a missing/corrupt key yields an empty store. */
export async function readAdminStore(env) {
  try {
    if (!env || !env.PULSE_KV) return emptyStore();
    const raw = await env.PULSE_KV.get(ADMIN_KEY, 'json');
    return normalizeStore(raw);
  } catch (e) {
    return emptyStore();
  }
}

export async function writeAdminStore(env, store) {
  const clean = normalizeStore(store);
  clean.updatedAt = new Date().toISOString();
  await env.PULSE_KV.put(ADMIN_KEY, JSON.stringify(clean));
  return clean;
}

/** Append an audit entry (mutates + returns the store; caller still writes it). */
export function audit(store, actor, action, target, detail) {
  store.audit = Array.isArray(store.audit) ? store.audit : [];
  store.audit.unshift({
    ts: new Date().toISOString(),
    actor: lc(actor) || 'system',
    action: String(action || ''),
    target: String(target || ''),
    detail: detail === undefined ? null : detail,
  });
  if (store.audit.length > AUDIT_MAX) store.audit = store.audit.slice(0, AUDIT_MAX);
  return store;
}

/** `pls_` + 40 hex chars. Long enough that guessing is hopeless, short enough to paste. */
export function newExtensionToken() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return 'pls_' + hex;
}

/** Slug a client name into a stable id, de-duplicated against the existing store. */
export function newClientId(name, store) {
  let base = lc(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!base) base = 'client';
  const taken = new Set((store.clients || []).map(c => c.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i++) {
    const candidate = base + '-' + i;
    if (!taken.has(candidate)) return candidate;
  }
  return base + '-' + Date.now().toString(36);
}

export function findClient(store, id) {
  return (store.clients || []).find(c => c.id === String(id)) || null;
}

/** The client a signed-in email belongs to (first match wins). */
export function findClientByEmail(store, email) {
  const e = lc(email);
  if (!e) return null;
  return (store.clients || []).find(c => c.users.some(u => u.email === e)) || null;
}

/** The client an extension bearer token belongs to. Suspended clients are refused. */
export function findClientByToken(store, token) {
  const t = String(token || '').trim();
  if (!t) return null;
  return (store.clients || []).find(
    c => c.extensionToken && c.status !== 'suspended' && safeEqual(c.extensionToken, t)
  ) || null;
}

/** Emails from a comma-separated env var, lower-cased. */
function envList(value) {
  return String(value || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Super-admins: ADMIN_EMAILS when set, otherwise ALLOWLIST as a bootstrap fallback so
 * the very first deploy is never locked out of /admin. `*` never grants admin.
 */
export function isAdminEmail(email, env) {
  const e = lc(email);
  if (!e) return false;
  const raw = (env && env.ADMIN_EMAILS) ? env.ADMIN_EMAILS : (env && env.ALLOWLIST);
  const list = envList(raw).filter(x => x !== '*');
  return list.indexOf(e) !== -1;
}

/**
 * The single source of truth for "may this email use Pulse?".
 *
 * Order: super-admin → env ALLOWLIST (legacy/escape hatch) → client registry.
 * Suspended clients are refused. Fails CLOSED: unknown email, no match, no access.
 *
 * Returns { allowed, admin, client, reason }.
 */
export async function resolveAccess(email, env) {
  const e = lc(email);
  const admin = isAdminEmail(e, env);
  const store = await readAdminStore(env);
  const client = findClientByEmail(store, e);

  if (admin) return { allowed: true, admin: true, client, reason: 'admin' };

  const envAllow = envList(env && env.ALLOWLIST);
  if (e && (envAllow.indexOf('*') !== -1 || envAllow.indexOf(e) !== -1)) {
    return { allowed: true, admin: false, client, reason: 'allowlist' };
  }

  if (client) {
    if (client.status === 'suspended') {
      return { allowed: false, admin: false, client, reason: 'suspended' };
    }
    return { allowed: true, admin: false, client, reason: 'client' };
  }

  return { allowed: false, admin: false, client: null, reason: 'not-invited' };
}

/** Best-effort last-seen stamp. Never blocks or throws on the request path. */
export async function touchUser(env, email) {
  try {
    const e = lc(email);
    if (!e || !env || !env.PULSE_KV) return;
    const store = await readAdminStore(env);
    let changed = false;
    for (const c of store.clients) {
      for (const u of c.users) {
        if (u.email === e) {
          const today = new Date().toISOString().slice(0, 10);
          if (String(u.lastSeenAt || '').slice(0, 10) !== today) {
            u.lastSeenAt = new Date().toISOString();
            changed = true;
          }
        }
      }
    }
    if (changed) await writeAdminStore(env, store);
  } catch (e) { /* never let telemetry break sign-in */ }
}

/** Tokens are shown in full exactly once (at creation/rotation); every read masks them. */
export function maskToken(t) {
  if (!t) return null;
  return t.length <= 12 ? '••••' : t.slice(0, 8) + '…' + t.slice(-4);
}

/** The shape the admin UI receives — never carries a live token. */
export function publicClient(c) {
  return {
    id: c.id, name: c.name, status: c.status, plan: c.plan,
    createdAt: c.createdAt, trialEndsAt: c.trialEndsAt,
    notes: c.notes, reportEmail: c.reportEmail,
    hasToken: !!c.extensionToken,
    tokenMasked: maskToken(c.extensionToken),
    tokenRotatedAt: c.tokenRotatedAt,
    users: c.users,
    userCount: c.users.length,
  };
}

export const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;
