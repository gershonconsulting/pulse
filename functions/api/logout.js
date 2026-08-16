// functions/api/logout.js
// GET /api/logout — clear the session cookie and return to the public homepage.

import { clearCookie, COOKIE_NAME, STATE_COOKIE } from '../_session.js';

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const headers = new Headers({
    Location: new URL('/?signedout=1', url).toString(),
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', clearCookie(COOKIE_NAME));
  headers.append('Set-Cookie', clearCookie(STATE_COOKIE));
  headers.append('Set-Cookie', clearCookie('pulse_next'));
  return new Response(null, { status: 302, headers });
}

export const onRequestPost = onRequestGet;
