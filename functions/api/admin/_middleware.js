// functions/api/admin/_middleware.js
// Second lock on the control plane. The root middleware already refuses bearer tokens
// on /api/admin/* and 403s non-admin sessions; this repeats the check right next to the
// handlers so a future change to routing or a new public path can never silently expose
// the client registry. Defence in depth is cheap here — one cookie verify.

import { getSession } from '../../_session.js';
import { isAdminEmail } from '../../_admin.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export async function onRequest(context) {
  const { request, env, next } = context;

  if (request.method === 'OPTIONS') return next();

  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: NO_STORE });
  }
  if (!isAdminEmail(session.email, env)) {
    return new Response(
      JSON.stringify({ ok: false, error: 'forbidden', message: 'Administrator access required.' }),
      { status: 403, headers: NO_STORE }
    );
  }

  context.data = Object.assign({}, context.data, { adminEmail: String(session.email).toLowerCase(), session });
  return next();
}
