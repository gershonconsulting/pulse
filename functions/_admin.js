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

// SELF-ENROLLMENT (2026-08-21): signing in with LinkedIn creates the tenant. There is
// no invite step — the first sign-in for an unknown email provisions a client, marks it
// `trial`, stamps trialEndsAt TRIAL_DAYS out and issues its own collector token.
// Set the env var SELF_ENROLL=off to close the door again (existing clients keep working).
export const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** True once a `trial` client is past its trialEndsAt. Other statuses never expire. */
export function isTrialExpired(client) {
  if (!client || client.status !== 'trial' || !client.trialEndsAt) return false;
  const ends = Date.parse(client.trialEndsAt);
  return Number.isFinite(ends) && Date.now() > ends;
}

/** Whole days left in the trial (0 once it lapses, null when there is no trial clock). */
export function trialDaysLeft(client) {
  if (!client || client.status !== 'trial' || !client.trialEndsAt) return null;
  const ends = Date.parse(client.trialEndsAt);
  if (!Number.isFinite(ends)) return null;
  return Math.max(0, Math.ceil((ends - Date.now()) / DAY_MS));
}

/**
 * The client an extension bearer token belongs to. Suspended clients AND lapsed
 * trials are refused, so collection stops at the same moment dashboard access does.
 */
export function findClientByToken(store, token) {
  const t = String(token || '').trim();
  if (!t) return null;
  return (store.clients || []).find(
    c => c.extensionToken && c.status !== 'suspended' && !isTrialExpired(c) && safeEqual(c.extensionToken, t)
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
    if (isTrialExpired(client)) {
      return { allowed: false, admin: false, client, reason: 'trial-expired' };
    }
    return { allowed: true, admin: false, client, reason: 'client' };
  }

  // Unknown email. `not-invited` is what tells functions/callback.js to self-enroll.
  return { allowed: false, admin: false, client: null, reason: 'not-invited' };
}

/** Is open self-enrollment switched on? Default ON; env SELF_ENROLL=off closes it. */
export function selfEnrollEnabled(env) {
  const v = String((env && env.SELF_ENROLL) || 'on').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false' && v !== 'no';
}

/**
 * Provision a brand-new tenant for someone signing in with LinkedIn for the first time.
 * Idempotent: if a client already holds this email (a double-click, or a race between
 * two tabs) the existing one is returned untouched. Returns null when self-enrollment
 * is off, the email is unusable, or KV is unavailable — the caller then denies access.
 */
export async function enrollUser(env, profile) {
  const email = lc(profile && profile.email);
  if (!email || !EMAIL_RE.test(email)) return null;
  if (!env || !env.PULSE_KV) return null;
  if (!selfEnrollEnabled(env)) return null;

  const store = await readAdminStore(env);
  const existing = findClientByEmail(store, email);
  if (existing) return existing;

  const now = new Date();
  const label = String((profile && profile.name) || '').trim() || email.split('@')[0];
  const client = {
    id: newClientId(label, store),
    name: label,
    status: 'trial',
    plan: 'trial',
    createdAt: now.toISOString(),
    trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString(),
    notes: '',
    // Their own reports go to them, not to the Gershon reporting address.
    reportEmail: email,
    extensionToken: newExtensionToken(),
    tokenRotatedAt: now.toISOString(),
    users: [{ email, role: 'owner', addedAt: now.toISOString(), lastSeenAt: now.toISOString() }],
  };
  store.clients.push(client);
  audit(store, email, 'client.self-enroll', client.id, { trialDays: TRIAL_DAYS, trialEndsAt: client.trialEndsAt });
  await writeAdminStore(env, store);
  return normalizeClient(client);
}

/** Issue a fresh collector token for a client. Returns the new token, or null. */
export async function rotateClientToken(env, clientId, actor) {
  const store = await readAdminStore(env);
  const client = findClient(store, clientId);
  if (!client) return null;
  client.extensionToken = newExtensionToken();
  client.tokenRotatedAt = new Date().toISOString();
  audit(store, actor, 'client.token-rotate', client.id, null);
  await writeAdminStore(env, store);
  return client.extensionToken;
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
