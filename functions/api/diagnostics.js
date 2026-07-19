// functions/api/diagnostics.js
// GET /api/diagnostics — system health checks for Settings page

import { json, readData } from './_shared.js';

export async function onRequestGet({ env }) {
  const checks = {};
  const now = Date.now();

  // 1. API Health
  checks.api = { name: 'Pulse API', status: 'ok', detail: 'v3.0.0 — Cloudflare Pages' };

  // 2. KV Storage
  try {
    const data = await readData(env.PULSE_KV);
    checks.kv = {
      name: 'KV Storage',
      status: 'ok',
      detail: `${data.messages.length} messages, ${data.scans.length} scans stored`,
    };
  } catch (err) {
    checks.kv = { name: 'KV Storage', status: 'error', detail: err.message };
  }

  // 3. Last Scan
  try {
    const data = await readData(env.PULSE_KV);
    if (data.scans.length > 0) {
      const lastScan = data.scans[0];
      const scanTime = new Date(lastScan.timestamp).getTime();
      const ageMs = now - scanTime;
      const ageHours = Math.round(ageMs / 3600000);
      const ageDays = Math.round(ageMs / 86400000);

      let ageLabel;
      if (ageHours < 1) ageLabel = 'less than 1 hour ago';
      else if (ageHours < 24) ageLabel = `${ageHours} hour${ageHours > 1 ? 's' : ''} ago`;
      else ageLabel = `${ageDays} day${ageDays > 1 ? 's' : ''} ago`;

      // Warn if no scan in 24h, error if none in 7 days
      let status = 'ok';
      if (ageMs > 7 * 86400000) status = 'error';
      else if (ageMs > 86400000) status = 'warn';

      checks.lastScan = {
        name: 'Last Scan',
        status,
        detail: `${ageLabel} — ${lastScan.count} conversations (${lastScan.red} red, ${lastScan.orange} orange, ${lastScan.green} green)`,
        timestamp: lastScan.timestamp,
      };
    } else {
      checks.lastScan = {
        name: 'Last Scan',
        status: 'error',
        detail: 'No scans recorded yet — install the Chrome extension and run your first scan',
      };
    }
  } catch (err) {
    checks.lastScan = { name: 'Last Scan', status: 'error', detail: err.message };
  }

  // 4. Chrome Extension (expected version — actual check done client-side)
  checks.extension = {
    name: 'Chrome Extension',
    status: 'pending',
    detail: 'Checked client-side — install Pulse LinkedIn Collector v1.2.0',
    expectedVersion: '1.2.0',
  };

  // 5. LinkedIn Connection (checked client-side via extension)
  checks.linkedin = {
    name: 'LinkedIn Connection',
    status: 'pending',
    detail: 'Checked client-side via extension — requires active LinkedIn session',
  };

  // Overall status
  const statuses = Object.values(checks).map(c => c.status);
  const overall = statuses.includes('error') ? 'error' : statuses.includes('warn') ? 'warn' : 'ok';

  return json({ overall, checks, timestamp: new Date().toISOString() });
}
