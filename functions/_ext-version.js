// functions/_ext-version.js
// Single source of truth (server side) for the newest shipped Chrome extension.
//
// WHY THIS FILE EXISTS: app/app.html has its own `LATEST_EXT_VERSION` used for the
// in-page "update available" banner, but that check only fires when Olivier happens
// to open the dashboard in the browser that has the extension installed. The daily
// email needs the same answer server-side, where the only evidence available is the
// version the collector stamped onto its last sync (`scanMeta.version`).
//
// KEEPING IT IN SYNC: when you bump the extension (always bump it — see the standing
// rule), update THREE places together: the extension's manifest.json, the
// LATEST_EXT_VERSION constant in app/app.html, and the constant below. If they ever
// drift, set the `LATEST_EXT_VERSION` env var in Cloudflare Pages — it wins over the
// constant, so a drift can be corrected without a redeploy.

// 1.19.0 = the build that honours Collecting Session (a collector on a computer set
// to viewing only stands down instead of syncing), and what app/app.html declares.
// The copy committed under linkedin-pulse-extension/ is older than the shipped
// app/pulse-extension.zip — do not take it as the truth.
export const LATEST_EXT_VERSION = '1.19.0';

export function latestExtVersion(env) {
  const override = ((env && env.LATEST_EXT_VERSION) || '').trim();
  return /^\d+(\.\d+)*$/.test(override) ? override : LATEST_EXT_VERSION;
}

// Numeric-segment compare. Returns <0 if a is older, 0 if equal, >0 if a is newer.
// Non-numeric / missing input sorts as oldest so an unknown version reads as stale.
export function cmpVer(a, b) {
  const parse = (v) => String(v || '0').trim().split('.').map((n) => parseInt(n, 10) || 0);
  const A = parse(a);
  const B = parse(b);
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}
