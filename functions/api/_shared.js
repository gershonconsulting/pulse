// functions/api/_shared.js
// Shared helpers for Pulse API functions.

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

// Read the entire data store from KV (single key, mirrors old JSON file).
export async function readData(kv) {
  const raw = await kv.get('data', 'json');
  return raw || { scans: [], messages: [] };
}

// Write the entire data store back to KV.
export async function writeData(kv, data) {
  await kv.put('data', JSON.stringify(data));
}
