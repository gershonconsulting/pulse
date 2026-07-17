// functions/api/messages/stats.js
// GET /api/messages/stats — aggregated stats + recent scans

import { json, readData } from '../_shared.js';

export async function onRequestGet({ env }) {
  try {
    const data = await readData(env.PULSE_KV);
    return json({
      red: data.messages.filter(m => m.status === 'Red').length,
      orange: data.messages.filter(m => m.status === 'Orange').length,
      green: data.messages.filter(m => m.status === 'Green').length,
      total: data.messages.length,
      scans: data.scans.slice(0, 10),
      lastScan: data.scans.length > 0 ? data.scans[0] : null,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
