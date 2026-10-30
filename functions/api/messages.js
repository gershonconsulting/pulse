// functions/api/messages.js
// GET  /api/messages  — list stored messages (with filter/search/sort)
// POST /api/messages  — receive classified conversations from Chrome extension
// DELETE /api/messages — clear all data

import { json, readData, writeData, clientIdOf } from './_shared.js';

// v5.13.0 — LinkedIn appends presence text to names ("Anne Dupont is online",
// "… was last active 2 hours ago"); strip it so one person is one record.
const PRESENCE_RE = /\s+(is online|is reachable|was (last )?active.*|status is .*|active now.*|est en ligne|en ligne)$/i;
function cleanName(s) {
  return String(s || '').split('\n')[0].replace(PRESENCE_RE, '').replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
}
function cmpVersion(a, b) {
  const A = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const B = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d; }
  return 0;
}
import { recordDailySnapshot } from '../_daily-snapshot.js';
import { applySocialRule } from '../_social-rules.js';
import { applyDeclineRule, applyDeclineRulesAsync } from '../_decline-rules.js';

// v5.15.0 — a link that opens the actual conversation / person (not a name search).
function isDeepLink(u) {
  return /\/messaging\/thread\/[^/?#]{6,}|\/sales\/inbox\/[^/?#]{8,}/.test(String(u || ''));
}
function isProfileLink(u) {
  return /\/in\/[^/?#]+|\/sales\/(lead|people)\/AC/.test(String(u || ''));
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const clientId = clientIdOf(context);
  try {
    const data = await readData(env.PULSE_KV, clientId);
    // 2026-10-02 — birthday/anniversary wishes never count as follow-up (read-time view).
    data.messages = data.messages.map(applySocialRule);
    // 2026-10-04 — polite refusals / "maybe later" are Orange, never Red (read-time view).
    data.messages = data.messages.map(applyDeclineRule);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const search = url.searchParams.get('search');
    const sort = url.searchParams.get('sort');

    let messages = [...data.messages];

    // Filter by status
    if (status && status !== 'all') {
      messages = messages.filter(m => m.status === status);
    }

    // Search by name or snippet
    if (search) {
      const q = search.toLowerCase();
      messages = messages.filter(m =>
        (m.name && m.name.toLowerCase().includes(q)) ||
        (m.snippet && m.snippet.toLowerCase().includes(q))
      );
    }

    // Sort
    if (sort === 'name') {
      messages.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sort === 'date') {
      messages.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    } else {
      // Default: Red first, then Orange, then Green
      const order = { Red: 0, Orange: 1, Green: 2 };
      messages.sort((a, b) => (order[a.status] || 3) - (order[b.status] || 3));
    }

    return json({
      messages,
      total: messages.length,
      stats: {
        red: data.messages.filter(m => m.status === 'Red').length,
        orange: data.messages.filter(m => m.status === 'Orange').length,
        green: data.messages.filter(m => m.status === 'Green').length,
        total: data.messages.length,
      },
      lastScan: data.scans.length > 0 ? data.scans[0] : null,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = clientIdOf(context);
  try {
    const body = await request.json();
    const { scanMeta } = body;
    // 2026-10-02 — reclassify birthday/anniversary wishes before anything is counted.
    let conversations = Array.isArray(body.conversations) ? body.conversations.map(applySocialRule) : body.conversations;

    if (!conversations || !Array.isArray(conversations)) {
      return json({ error: 'Missing conversations array' }, 400);
    }

    const data = await readData(env.PULSE_KV, clientId);
    const now = new Date().toISOString();

    // v5.13.0 — a tenant that was reset to a clean, mirrored store only accepts
    // VERIFIED crawls. An older collector (<= 1.19.0) could file one person's thread
    // under another person's name, so its data is refused instead of stored wrong.
    if (data.settings && data.settings.mirror && cmpVersion((scanMeta || {}).version, '1.20.0') < 0) {
      return json({ error: 'Pulse extension update required: install v1.20.0 from Pulse → Extension, then sync again.', updateRequired: '1.20.0' }, 426);
    }

    // 2026-10-04 — "No thank you" / "not for us" / "maybe later" → Orange (keywords + cached AI fallback).
    try {
      conversations = await applyDeclineRulesAsync(conversations, new Map(data.messages.map(m => [m.name, m])), env);
    } catch (e) { conversations = conversations.map(applyDeclineRule); }

    // Record the scan
    const scan = {
      id: Date.now().toString(36),
      timestamp: now,
      count: conversations.length,
      red: conversations.filter(c => c.status === 'Red').length,
      orange: conversations.filter(c => c.status === 'Orange').length,
      green: conversations.filter(c => c.status === 'Green').length,
      ...(scanMeta || {}),
    };
    data.scans.unshift(scan);
    if (data.scans.length > 100) data.scans = data.scans.slice(0, 100);

    // ── v5.13.0 (2026-10-28) — identity is the THREAD, not the name ───────────
    // Before this, records were upserted by display name. Collector <= 1.19.0 could
    // store one person's thread under another person's name, LinkedIn adds presence
    // text to names ("X is online"), and two people can share a name — so the same
    // conversation ended up under several names and different people got merged.
    // Now: key = threadId (or the thread part of conversationLink); name is only a
    // fallback for legacy records that never had a thread id. A re-crawl therefore
    // HEALS a crossed record: the thread arrives with its real name and replaces it.
    const keyOf = (m) => {
      if (m.threadId) return 't:' + m.threadId;
      const l = String(m.conversationLink || '');
      const mt = l.match(/\/(?:messaging\/thread|sales\/inbox)\/([^/?#]+)/);
      return mt ? 't:' + mt[1] : 'n:' + m.name;
    };
    for (const c of conversations) {
      c.name = cleanName(c.name);
      if (!c.threadId) { const k = keyOf(c); if (k.startsWith('t:')) c.threadId = k.slice(2); }
    }
    data.messages = (data.messages || []).map((m) => ({ ...m, name: cleanName(m.name) }));

    const existingByKey = new Map();
    const legacyByName = new Map();
    for (const m of data.messages) {
      const k = keyOf(m);
      const prevSame = existingByKey.get(k);
      // duplicates of one thread (e.g. "X" and "X is online"): keep the newest,
      // but never lose manual work that sits on the older copy.
      if (!prevSame) existingByKey.set(k, m);
      else {
        const newer = String(m.updatedAt || '') > String(prevSame.updatedAt || '') ? m : prevSame;
        const older = newer === m ? prevSame : m;
        const keep = { ...newer };
        for (const f of ['manualStatus', 'focus', 'done', 'doneAt', 'note', 'manualGrade', 'fit', 'interest']) {
          if ((keep[f] === undefined || keep[f] === null || keep[f] === '' || keep[f] === false) && older[f] !== undefined && older[f] !== null && older[f] !== '' && older[f] !== false) keep[f] = older[f];
        }
        existingByKey.set(k, keep);
      }
      if (k.startsWith('n:')) legacyByName.set(m.name, m);
    }
    const carry = data.manualCarry || {};
    const touched = new Set();
    const transitions = [];  // { name, from, to }
    let newCount = 0;
    let unchangedCount = 0;

    for (const conv of conversations) {
      const k = keyOf(conv);
      let prev = existingByKey.get(k);
      let prevKey = k;
      if (!prev && legacyByName.has(conv.name)) { prev = legacyByName.get(conv.name); prevKey = 'n:' + conv.name; }
      if (prev && prevKey !== k) existingByKey.delete(prevKey);
      const prevStatus = prev ? prev.status : null;
      const newStatus = conv.status;

      if (!prev) {
        newCount++;
      } else if (prevStatus !== newStatus) {
        transitions.push({ name: conv.name, from: prevStatus, to: newStatus });
      } else {
        unchangedCount++;
      }

      let statusHistory = (prev && prev.statusHistory) ? [...prev.statusHistory] : [];
      if (prev && prevStatus !== newStatus) {
        statusHistory.push({ from: prevStatus, to: newStatus, timestamp: now, scanId: scan.id });
        if (statusHistory.length > 20) statusHistory = statusHistory.slice(-20);
      }

      const merged = {
        ...conv,
        scanId: scan.id,
        updatedAt: now,
        lastSeenAt: now,
        previousStatus: prevStatus,
        statusHistory,
        firstSeenAt: prev ? (prev.firstSeenAt || prev.updatedAt || now) : now,
      };
      if (prev && prev.name && prev.name !== conv.name) merged.renamedFrom = prev.name;
      const manualSrc = prev || (conv.threadId && carry[conv.threadId]) || null;
      if (manualSrc) {
        // Preserve the user's manual work across re-syncs — a fresh scan must
        // never wipe a manual status override, star (focus), check (done), or note.
        if (manualSrc.manualStatus) { merged.manualStatus = manualSrc.manualStatus; merged.status = manualSrc.manualStatus; }
        if (manualSrc.focus !== undefined) merged.focus = manualSrc.focus;
        if (manualSrc.done !== undefined) merged.done = manualSrc.done;
        if (manualSrc.doneAt !== undefined) merged.doneAt = manualSrc.doneAt;
        if (manualSrc.note !== undefined) merged.note = manualSrc.note;
        if (manualSrc.manualGrade) { merged.manualGrade = true; if (manualSrc.fit !== undefined) merged.fit = manualSrc.fit; if (manualSrc.interest !== undefined) merged.interest = manualSrc.interest; }
      }
      if (prev) {
        if (!merged.city && prev.city) merged.city = prev.city;
        if (!merged.country && prev.country) merged.country = prev.country;
        // v5.15.0 — a scan that failed to capture a link (SN lead card slow to render,
        // row without an anchor) must not wipe a good link captured earlier.
        if (!isDeepLink(merged.conversationLink) && isDeepLink(prev.conversationLink)) merged.conversationLink = prev.conversationLink;
        if (!isProfileLink(merged.profileUrl) && isProfileLink(prev.profileUrl)) merged.profileUrl = prev.profileUrl;
        if (!merged.snConversationLink && prev.snConversationLink) merged.snConversationLink = prev.snConversationLink;
        if (!merged.snProfileUrl && prev.snProfileUrl) merged.snProfileUrl = prev.snProfileUrl;
      }
      // v5.15.0 — a person can be in BOTH inboxes, and the last inbox scanned used to
      // overwrite the other's links. Keep the Sales Navigator links in their own fields
      // so "Open in Sales Nav" survives a LinkedIn scan.
      if (/\/sales\/inbox\/[^/?#]{8,}/.test(conv.conversationLink || '')) merged.snConversationLink = conv.conversationLink;
      if (/\/sales\/(lead|people)\/AC/.test(conv.profileUrl || '')) merged.snProfileUrl = conv.profileUrl;
      if (conv.threadId && carry[conv.threadId]) { delete carry[conv.threadId]; data.manualCarry = carry; }
      existingByKey.set(k, merged);
      touched.add(k);
    }

    // Mirror mode (per tenant, set by /api/admin/reset-tenant): after a COMPLETE,
    // verified crawl (collector >= 1.20.0) of one inbox, conversations of that inbox
    // that were not seen are moved to `archived` — the dashboard then shows exactly
    // what is in the inbox. Records with manual work are kept.
    let archivedNow = 0;
    const meta = scanMeta || {};
    const platformOf = (m) => m.platform || (/\/sales\//.test(m.conversationLink || '') ? 'sales-navigator' : 'linkedin');
    const crawlPlatform = meta.source === 'sales-navigator' ? 'sales-navigator' : (meta.source === 'linkedin-messaging' ? 'linkedin' : null);
    if (data.settings && data.settings.mirror && meta.complete && crawlPlatform && cmpVersion(meta.version, '1.20.0') >= 0) {
      data.archived = data.archived || [];
      for (const [k, m] of Array.from(existingByKey.entries())) {
        if (touched.has(k) || platformOf(m) !== crawlPlatform) continue;
        if (m.manualStatus || m.focus || m.done || m.note || m.manualGrade) continue;
        existingByKey.delete(k);
        data.archived.unshift({ ...m, archivedAt: now, archivedBy: scan.id });
        archivedNow++;
      }
      if (data.archived.length > 1000) data.archived = data.archived.slice(0, 1000);
    }
    scan.archived = archivedNow;

    data.messages = Array.from(existingByKey.values()).map(applySocialRule).map(applyDeclineRule);

    // Compute transition summary for the scan record
    const transitionSummary = {};
    for (const t of transitions) {
      const key = t.from + '→' + t.to;
      transitionSummary[key] = (transitionSummary[key] || 0) + 1;
    }
    scan.diff = {
      newConversations: newCount,
      statusChanged: transitions.length,
      unchanged: unchangedCount,
      transitions: transitionSummary,
      details: transitions.slice(0, 50),  // store up to 50 individual transitions
    };

    await writeData(env.PULSE_KV, clientId, data);

    // v5.11.0 — fold this sync into the tenant's daily snapshot for the monthly report.
    // Best-effort by design: a snapshot failure must never fail the sync itself.
    try { await recordDailySnapshot(env.PULSE_KV, clientId, scan, data, env.REPORT_TZ); } catch (e) { /* ignore */ }

    return json({
      success: true,
      scanId: scan.id,
      received: conversations.length,
      totalStored: data.messages.length,
      diff: scan.diff,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const clientId = clientIdOf(context);
  try {
    const url = new URL(request.url);
    const name = url.searchParams.get('name');

    if (name) {
      // Delete a single message by name
      const data = await readData(env.PULSE_KV, clientId);
      const before = data.messages.length;
      data.messages = data.messages.filter(m => m.name !== name);
      await writeData(env.PULSE_KV, clientId, data);
      return json({ success: true, deleted: before - data.messages.length, remaining: data.messages.length });
    }

    // No name param = clear all. Scoped to the CALLER'S tenant only — before
    // 2026-08-21 this wiped the single shared store for everybody.
    await writeData(env.PULSE_KV, clientId, { scans: [], messages: [] });
    return json({ success: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
