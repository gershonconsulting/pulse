// functions/api/admin/token.js
// POST /api/admin/token  { clientId } — issue or rotate the client's collector token.
//
// Rotation is IMMEDIATE and BREAKING by design: the old token stops authenticating the
// moment this returns, so the client's Chrome extension must be given the new value.
// The plaintext token is returned exactly once, here.

import {
  readAdminStore, writeAdminStore, audit, findClient, publicClient, newExtensionToken,
} from '../../_admin.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: NO_STORE });

export async function onRequestPost({ request, env, data }) {
  let body = {};
  try { body = await request.json(); } catch (e) { /* clientId may also arrive as a query param */ }
  const id = (body && body.clientId) || new URL(request.url).searchParams.get('clientId');

  const store = await readAdminStore(env);
  const client = findClient(store, id);
  if (!client) return json({ ok: false, error: 'not-found' }, 404);

  const had = !!client.extensionToken;
  client.extensionToken = newExtensionToken();
  client.tokenRotatedAt = new Date().toISOString();

  audit(store, data.adminEmail, had ? 'token.rotate' : 'token.issue', client.id, null);
  await writeAdminStore(env, store);

  return json({ ok: true, client: publicClient(client), extensionToken: client.extensionToken });
}
