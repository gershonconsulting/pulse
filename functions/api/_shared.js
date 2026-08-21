// functions/api/_shared.js
// Shared helpers for Pulse API functions.
//
// ── MULTI-TENANCY (2026-08-21) ────────────────────────────────────────────────
// Every client gets its OWN KV key. The root middleware (functions/_middleware.js)
// stamps `context.data.clientId` on each request — from the signed LinkedIn session
// cookie for humans, or from the per-client collector token for the extension.
// Pass that id to readData/writeData and two clients can never read, overwrite or
// DELETE each other's conversations.
//
//   clientId null / absent  ->  'data'        (Gershon's own store: the original key,
//                                              also what the legacy shared
//                                              EXTENSION_TOKEN and super-admins use)
//   clientId 'acme'         ->  'data:acme'
//
// NO MIGRATION NEEDED: the existing store keeps the bare `data` key, so Olivier's
// records stay exactly where they are and a new client simply starts empty.

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const DEFAULT_DATA_KEY = 'data';

/** Pull the tenant off a Pages Functions context (safe when unset). */
export function clientIdOf(context) {
  return (context && context.data && context.data.clientId) || null;
}

/** `data` for the default tenant, `data:<clientId>` for a registry client. */
export function dataKey(clientId) {
  const id = String(clientId || '').trim();
  return id ? DEFAULT_DATA_KEY + ':' + id : DEFAULT_DATA_KEY;
}

/** Same scoping rule for any other per-tenant key (e.g. scan-status). */
export function scopedKey(prefix, clientId) {
  const id = String(clientId || '').trim();
  return id ? prefix + ':' + id : prefix;
}

// Read one tenant's store from KV.
export async function readData(kv, clientId) {
  const raw = await kv.get(dataKey(clientId), 'json');
  return raw || { scans: [], messages: [] };
}

// Write one tenant's store back to KV.
export async function writeData(kv, clientId, data) {
  // Tolerate the pre-2026-08-21 two-argument shape writeData(kv, data): a call site
  // that was missed writes to the DEFAULT tenant rather than corrupting KV with an
  // object used as a key.
  if (data === undefined && clientId && typeof clientId === 'object') {
    data = clientId;
    clientId = null;
  }
  await kv.put(dataKey(clientId), JSON.stringify(data));
}
