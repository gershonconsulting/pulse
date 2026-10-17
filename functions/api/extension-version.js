// functions/api/extension-version.js
// GET /api/extension-version — public, exposes no data.
//
// Returns the newest shipped Pulse Chrome extension version (same source of truth
// as the daily/weekly/monthly reports: functions/_ext-version.js). The Gershon
// release watcher (NexaShare Worker) polls this to email report@gershonconsulting.com
// once per new extension release so every client computer gets updated.

import { latestExtVersion } from '../_ext-version.js';

export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({
    latest: latestExtVersion(env),
    downloadUrl: 'https://pulse.gershoncrm.com/pulse-extension.zip',
  }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  });
}
