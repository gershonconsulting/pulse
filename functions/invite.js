// functions/invite.js
// GET /invite?t=<token> — the CoHost invite link.
//
// WHY THIS ROUTE EXISTS: /admin identifies a CoHost by their LinkedIn PROFILE URL,
// but LinkedIn's OpenID `userinfo` response carries sub / name / email and never the
// vanity URL — so a profile URL alone can never be matched at sign-in. This link
// closes that gap. It parks the invite token in a short-lived cookie and hands the
// visitor straight to the normal LinkedIn sign-in; /callback then binds whatever
// email LinkedIn reports to the invited record, once.
//
// The link is the credential, so it is treated like one: single use, expiring, and
// validated here BEFORE the OAuth round trip so a dead link fails fast with a clear
// message instead of after a confusing detour through LinkedIn.
//
// PUBLIC BY NECESSITY — the whole point is that the recipient is not signed in yet.
// Holding the token proves nothing beyond "an admin sent me this"; it grants a
// CoHost seat that an admin explicitly created, and nothing else.

import { buildCookie, clearCookie } from './_session.js';
import { readAdminStore, findCohostByInvite } from './_admin.js';

export const INVITE_COOKIE = 'pulse_cohost_invite';
const INVITE_COOKIE_TTL = 900; // 15 min — long enough for the LinkedIn consent screen

function bounceHome(url, params) {
  const dest = new URL('/', url);
  Object.keys(params).forEach(k => dest.searchParams.set(k, params[k]));
  const headers = new Headers({ Location: dest.toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearCookie(INVITE_COOKIE));
  return new Response(null, { status: 302, headers });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = String(url.searchParams.get('t') || '').trim();

  if (!token) return bounceHome(url, { error: 'invite' });

  // Validate up front: expired, already-claimed and unknown tokens all land here.
  const store = await readAdminStore(env);
  const cohost = findCohostByInvite(store, token);
  if (!cohost) return bounceHome(url, { error: 'invite-expired' });

  const headers = new Headers({
    Location: new URL('/api/login?next=%2Fapp.html', url).toString(),
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', buildCookie(INVITE_COOKIE, token, INVITE_COOKIE_TTL));
  return new Response(null, { status: 302, headers });
}
