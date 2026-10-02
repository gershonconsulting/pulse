// functions/_daily-snapshot.js — one small KV row per tenant per local day.
//
// WHY: the monthly report needs the pipeline as it stood at the end of EVERY day of the
// month, but data.scans keeps only the last 100 scans (a few days to two weeks,
// depending on how often the collector syncs). So every sync also folds its counts into
//   daily:<ymd>            (Gershon's default store)
//   daily:<clientId>:<ymd> (a registry client)
// one entry per inbox, last sync of the day wins — the same "last scan of each
// platform that day" rule daily-report.js applies to data.scans. Rows expire after
// ~13 months so the store cannot grow without bound.
//
// Called from functions/api/messages.js AFTER the conversations are saved, inside a
// try/catch: a snapshot failure must never fail a sync.

const DEFAULT_TZ = 'America/New_York';
const TTL = 400 * 86400;

function localYmd(instant, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

export function snapshotKey(clientId, ymd) {
  const id = String(clientId || '').trim();
  return id ? `daily:${id}:${ymd}` : `daily:${ymd}`;
}

export async function recordDailySnapshot(kv, clientId, scan, data, tz) {
  const zone = tz || DEFAULT_TZ;
  const ymd = localYmd(new Date(scan.timestamp), zone);
  const key = snapshotKey(clientId, ymd);
  const row = (await kv.get(key, 'json')) || { ymd, sources: {} };
  const source = scan.source || 'linkedin-messaging';
  row.sources[source] = {
    red: scan.red || 0, orange: scan.orange || 0, green: scan.green || 0, count: scan.count || 0,
    timestamp: scan.timestamp, version: scan.version || null,
  };
  const msgs = (data && data.messages) || [];
  row.awaiting = msgs.filter((m) => m.status === 'Red' && !m.done).length;
  row.total = msgs.length;
  row.updatedAt = scan.timestamp;
  await kv.put(key, JSON.stringify(row), { expirationTtl: TTL });
  return row;
}

// All snapshots for the days of one month, as { 'YYYY-MM-DD': row }.
export async function readMonthSnapshots(kv, clientId, win) {
  const out = {};
  const days = [];
  for (let d = 1; d <= win.dim; d++) days.push(win.ymd(d));
  const rows = await Promise.all(days.map((ymd) => kv.get(snapshotKey(clientId, ymd), 'json').catch(() => null)));
  rows.forEach((r, i) => { if (r) out[days[i]] = r; });
  return out;
}
