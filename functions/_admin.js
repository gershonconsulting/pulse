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
//   cohosts: [{
//     id, name, linkedinUrl, linkedinSlug,
//     email,                       // null until the invite is claimed
//     status: 'invited'|'active'|'revoked',
//     invite: { token, createdAt, expiresAt, usedAt } | null,
//     createdAt, claimedAt, lastSeenAt, notes
//   }],
//   audit: [{ ts, actor, action, target, detail }],   // newest first, capped
//   updatedAt
// }
//
// ── COHOSTS (2026-08-27) ──────────────────────────────────────────────────────
// A CoHost is an INTERNAL operator (e.g. Aina) who verifies the state of the
// conversations our users manage. Unlike a client user, a CoHost belongs to NO
// tenant of their own — they can switch their view to ANY client and work the
// queue there. They can never reach /admin: the control plane stays super-admin
// only, so a CoHost cannot create clients, read tokens or edit the registry.
//
// WHY AN INVITE LINK AND NOT AN EMAIL FIELD: admins identify people by their
// LinkedIn profile URL, but LinkedIn's OpenID `userinfo` returns sub/name/email
// and NEVER the vanity URL — the two cannot be matched server-side. So /admin
// takes the profile URL for identification and mints a one-time invite link.
// The FIRST LinkedIn sign-in through that link binds whatever email LinkedIn
// reports to this record, permanently. That also side-steps the trap that locked
// Olivier out in August: nobody has to guess which email a LinkedIn account uses.

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
export const COHOST_STATUSES = ['invited', 'active', 'revoked'];

// How long an unclaimed CoHost invite link stays valid.
export const INVITE_TTL_DAYS = 14;

// Which tenant a CoHost (or a super-admin) is currently looking at. NOT a permission:
// the root middleware only honours it after confirming the caller really is one of
// those two, and re-validates the id against the registry on every request. Plain
// (unsigned) on purpose — forging it gets an ordinary user precisely nothing.
export const VIEW_COOKIE = 'pulse_view';
export const VIEW_DEFAULT = '__default';

const lc = (s) => String(s || '').trim().toLowerCase();

function emptyStore() {
  return { version: 1, clients: [], cohosts: [], audit: [], updatedAt: null };
}

/** Normalise anything KV hands back into a well-formed store. */
export function normalizeStore(raw) {
  const store = (raw && typeof raw === 'object') ? raw : {};
  return {
    version: 1,
    clients: Array.isArray(store.clients) ? store.clients.map(normalizeClient) : [],
    // Absent on every store written before 2026-08-27 — normalise to [] so the
    // registry keeps working without a migration.
    cohosts: Array.isArray(store.cohosts) ? store.cohosts.map(normalizeCohost) : [],
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

/** LinkedIn vanity slug out of any profile URL shape. '' when it is not one. */
export function linkedinSlugOf(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  // Accept linkedin.com/in/<slug>, with or without scheme, www, locale subdomain,
  // trailing slash or query string — admins paste all of these.
  const m = raw.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (m) return decodeURIComponent(m[1]).toLowerCase();
  // A bare slug typed on its own is fine too.
  if (/^[a-z0-9\-_%]+$/i.test(raw)) return decodeURIComponent(raw).toLowerCase();
  return '';
}

/** Canonical profile URL, so two pastes of the same person store identically. */
export function normalizeLinkedInUrl(url) {
  const slug = linkedinSlugOf(url);
  return slug ? 'https://www.linkedin.com/in/' + slug + '/' : '';
}

function normalizeCohost(c) {
  const h = (c && typeof c === 'object') ? c : {};
  const inv = (h.invite && typeof h.invite === 'object') ? h.invite : null;
  return {
    id: String(h.id || ''),
    name: String(h.name || h.id || ''),
    linkedinUrl: String(h.linkedinUrl || ''),
    linkedinSlug: String(h.linkedinSlug || linkedinSlugOf(h.linkedinUrl) || ''),
    email: lc(h.email) || null,
    status: COHOST_STATUSES.indexOf(h.status) !== -1 ? h.status : 'invited',
    invite: inv && inv.token ? {
      token: String(inv.token),
      createdAt: inv.createdAt || null,
      expiresAt: inv.expiresAt || null,
      usedAt: inv.usedAt || null,
    } : null,
    createdAt: h.createdAt || null,
    claimedAt: h.claimedAt || null,
    lastSeenAt: h.lastSeenAt || null,
    notes: String(h.notes || ''),
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

/* ══ COHOSTS ══════════════════════════════════════════════════════════════════
   Cross-tenant operators. See the store-shape note at the top of this file. */

export function findCohost(store, id) {
  return (store.cohosts || []).find(h => h.id === String(id)) || null;
}

/** The ACTIVE CoHost a signed-in email belongs to. Revoked records never match. */
export function findCohostByEmail(store, email) {
  const e = lc(email);
  if (!e) return null;
  return (store.cohosts || []).find(h => h.status === 'active' && h.email === e) || null;
}

/** A CoHost record for this email at ANY status — including revoked. Used to tell a
 *  revoked operator apart from a stranger, so signing in denies them instead of
 *  cheerfully provisioning them a brand-new trial tenant. */
export function findCohostRecordByEmail(store, email) {
  const e = lc(email);
  if (!e) return null;
  return (store.cohosts || []).find(h => h.email === e) || null;
}

/** Already-taken slug check, so the same person cannot be invited twice. */
export function findCohostBySlug(store, slug) {
  const sl = lc(slug);
  if (!sl) return null;
  return (store.cohosts || []).find(h => h.linkedinSlug === sl) || null;
}

/** True once an invite has been used or has passed its expiry. */
export function isInviteSpent(invite) {
  if (!invite || !invite.token) return true;
  if (invite.usedAt) return true;
  const ends = Date.parse(invite.expiresAt);
  return Number.isFinite(ends) && Date.now() > ends;
}

/**
 * The CoHost record a raw invite token belongs to — only while the invite is live
 * and the record is still waiting to be claimed. Constant-time compare, because the
 * token alone is enough to bind an identity.
 */
export function findCohostByInvite(store, token) {
  const t = String(token || '').trim();
  if (!t) return null;
  return (store.cohosts || []).find(
    h => h.status === 'invited' && h.invite && !isInviteSpent(h.invite) && safeEqual(h.invite.token, t)
  ) || null;
}

/** `pci_` + 32 hex — a Pulse CoHost Invite. Single-use, expiring, unguessable. */
export function newInviteToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return 'pci_' + hex;
}

/** A fresh invite object (used at creation and whenever an admin re-issues a link). */
export function newInvite() {
  const now = Date.now();
  return {
    token: newInviteToken(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_DAYS * DAY_MS).toISOString(),
    usedAt: null,
  };
}

/** Slug a CoHost name into a stable id, de-duplicated against existing CoHosts. */
export function newCohostId(name, store) {
  let base = lc(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!base) base = 'cohost';
  const taken = new Set((store.cohosts || []).map(h => h.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i++) {
    const candidate = base + '-' + i;
    if (!taken.has(candidate)) return candidate;
  }
  return base + '-' + Date.now().toString(36);
}

/**
 * Bind a LinkedIn identity to an invited CoHost. This is the whole point of the
 * invite link: it is the ONLY moment we learn which email the person's LinkedIn
 * account actually uses.
 *
 * Refuses when the token is spent/expired, or when that email is already spoken
 * for — one email is one identity, exactly as it is for client users.
 * Returns { ok, cohost, reason }.
 */
export async function claimCohostInvite(env, token, profile) {
  const email = lc(profile && profile.email);
  if (!env || !env.PULSE_KV) return { ok: false, reason: 'no-kv' };
  if (!email || !EMAIL_RE.test(email)) return { ok: false, reason: 'bad-email' };

  const store = await readAdminStore(env);
  const cohost = findCohostByInvite(store, token);
  if (!cohost) return { ok: false, reason: 'invalid-invite' };

  // Already a CoHost under another record, or a member of a client? Refuse rather
  // than give one email two identities that resolveAccess would have to guess between.
  const otherCohost = (store.cohosts || []).find(h => h.id !== cohost.id && h.email === email);
  if (otherCohost) return { ok: false, reason: 'email-taken' };
  if (findClientByEmail(store, email)) return { ok: false, reason: 'email-is-client' };

  const now = new Date().toISOString();
  cohost.email = email;
  cohost.status = 'active';
  cohost.claimedAt = now;
  cohost.lastSeenAt = now;
  cohost.invite.usedAt = now;          // single use — the link is dead from here on
  if (!cohost.name || cohost.name === cohost.id) {
    cohost.name = String((profile && profile.name) || '').trim() || cohost.name;
  }
  audit(store, email, 'cohost.claim', cohost.id, { email });
  await writeAdminStore(env, store);
  return { ok: true, cohost: normalizeCohost(cohost) };
}

/** Best-effort last-seen stamp for a CoHost (mirrors touchUser for client users). */
export async function touchCohost(env, email) {
  try {
    const e = lc(email);
    if (!e || !env || !env.PULSE_KV) return;
    const store = await readAdminStore(env);
    const h = findCohostByEmail(store, e);
    if (!h) return;
    const today = new Date().toISOString().slice(0, 10);
    if (String(h.lastSeenAt || '').slice(0, 10) === today) return;
    h.lastSeenAt = new Date().toISOString();
    await writeAdminStore(env, store);
  } catch (e) { /* never let telemetry break sign-in */ }
}

/** The shape /admin receives. The live invite TOKEN is never included — only whether
 *  a link is outstanding. Handing the raw token back on every list would turn a
 *  read of the registry into a way to seize someone else's identity. */
export function publicCohost(h) {
  const live = h.invite && !isInviteSpent(h.invite);
  return {
    id: h.id,
    name: h.name,
    linkedinUrl: h.linkedinUrl,
    linkedinSlug: h.linkedinSlug,
    email: h.email,
    status: h.status,
    createdAt: h.createdAt,
    claimedAt: h.claimedAt,
    lastSeenAt: h.lastSeenAt,
    notes: h.notes,
    invitePending: !!live,
    inviteExpiresAt: live ? h.invite.expiresAt : null,
    inviteUsedAt: (h.invite && h.invite.usedAt) || null,
  };
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
 * Order: super-admin → CoHost → env ALLOWLIST (legacy/escape hatch) → client registry.
 * Suspended clients are refused. Fails CLOSED: unknown email, no match, no access.
 *
 * Returns { allowed, admin, cohost, client, reason }.
 */
export async function resolveAccess(email, env) {
  const e = lc(email);
  const admin = isAdminEmail(e, env);
  const store = await readAdminStore(env);
  const client = findClientByEmail(store, e);
  const cohost = findCohostByEmail(store, e);

  if (admin) return { allowed: true, admin: true, cohost: null, client, reason: 'admin' };

  // A CoHost has no tenant of their own — they view whichever client they select.
  // Checked BEFORE the not-invited fall-through below so signing in can never
  // self-enroll an operator as a client and strand them in an empty store.
  if (cohost) {
    return { allowed: true, admin: false, cohost, client: null, reason: 'cohost' };
  }

  // A REVOKED CoHost is not a stranger. Without this, `not-invited` below would send
  // them down the self-enrollment path and hand the person we just cut off a shiny
  // new trial tenant. Deny explicitly instead.
  const revoked = findCohostRecordByEmail(store, e);
  if (revoked && revoked.status === 'revoked') {
    return { allowed: false, admin: false, cohost: null, client: null, reason: 'cohost-revoked' };
  }

  const envAllow = envList(env && env.ALLOWLIST);
  if (e && (envAllow.indexOf('*') !== -1 || envAllow.indexOf(e) !== -1)) {
    return { allowed: true, admin: false, cohost: null, client, reason: 'allowlist' };
  }

  if (client) {
    if (client.status === 'suspended') {
      return { allowed: false, admin: false, cohost: null, client, reason: 'suspended' };
    }
    if (isTrialExpired(client)) {
      return { allowed: false, admin: false, cohost: null, client, reason: 'trial-expired' };
    }
    return { allowed: true, admin: false, cohost: null, client, reason: 'client' };
  }

  // Unknown email. `not-invited` is what tells functions/callback.js to self-enroll.
  return { allowed: false, admin: false, cohost: null, client: null, reason: 'not-invited' };
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
