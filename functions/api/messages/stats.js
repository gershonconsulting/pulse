// functions/api/messages/stats.js
// GET /api/messages/stats — aggregated stats + recent scans

import { json, readData, clientIdOf } from '../_shared.js';

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const data = await readData(env.PULSE_KV, clientIdOf(context));

    // Compute progress metrics from message statusHistory
    let totalTransitions = 0;
    let treatedCount = 0;  // Red→Green or Red→Orange = "treated"
    let regressedCount = 0; // Green→Red = needs attention again
    const allTransitions = {};

    for (const m of data.messages) {
      if (m.statusHistory && m.statusHistory.length > 0) {
        totalTransitions += m.statusHistory.length;
        for (const h of m.statusHistory) {
          const key = h.from + '→' + h.to;
          allTransitions[key] = (allTransitions[key] || 0) + 1;
          if (h.from === 'Red' && (h.to === 'Green' || h.to === 'Orange')) treatedCount++;
          if ((h.from === 'Green' || h.from === 'Orange') && h.to === 'Red') regressedCount++;
        }
      }
    }

    return json({
      red: data.messages.filter(m => m.status === 'Red').length,
      orange: data.messages.filter(m => m.status === 'Orange').length,
      green: data.messages.filter(m => m.status === 'Green').length,
      total: data.messages.length,
      scans: data.scans.slice(0, 20),
      lastScan: data.scans.length > 0 ? data.scans[0] : null,
      progress: {
        totalTransitions,
        treatedCount,
        regressedCount,
        allTransitions,
      },
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
