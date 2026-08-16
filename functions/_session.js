// functions/_session.js
// HMAC-SHA-256 signed session tokens + cookie helpers for Pulse.
// No dependencies — Web Crypto only (Cloudflare Pages Functions / Workers).
// Underscore-prefixed files inside functions/ are NOT routed, so this is a private helper.

const enc = new TextEncoder();

export const COOKIE_NAME = 'pulse_session';
export const STATE_COOKIE = 'pulse_li_state';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlFromString(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function stringFromB64url(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(pad)));
}

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64url(new Uint8Array(sig));
}

/** Constant-time-ish string compare (avoids early-exit timing leaks). */
export function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Sign a payload object into a `body.signature` token. */
export async function sign(payload, secret) {
  const body = b64urlFromString(JSON.stringify(payload));
  return body + '.' + (await hmac(body, secret));
}

/** Verify a token; returns the payload object, or null when invalid/expired. */
export async function verify(token, secret) {
  if (!token || !secret || token.indexOf('.') === -1) return null;
  const idx = token.lastIndexOf('.');
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  let expected;
  try { expected = await hmac(body, secret); } catch (e) { return null; }
  if (!safeEqual(expected, sig)) return null;
  let payload;
  try { payload = JSON.parse(stringFromB64url(body)); } catch (e) { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

export function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  });
  return out;
}

export function buildCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Read + verify the Pulse session from a request. Returns payload or null. */
export async function getSession(request, env) {
  if (!env || !env.SESSION_SECRET) return null;
  const cookies = parseCookies(request.headers.get('Cookie'));
  return verify(cookies[COOKIE_NAME], env.SESSION_SECRET);
}

/** Comma-separated ALLOWLIST of LinkedIn account emails permitted to sign in. */
export function allowlistEmails(env) {
  return String((env && env.ALLOWLIST) || '')
    .toLowerCase()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export function isAllowed(email, env) {
  const list = allowlistEmails(env);
  if (!list.length) return false;             // fail CLOSED: no allowlist = nobody gets in
  if (list.indexOf('*') !== -1) return true;  // explicit opt-out escape hatch
  return !!email && list.indexOf(String(email).toLowerCase()) !== -1;
}
