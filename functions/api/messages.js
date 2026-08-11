// functions/api/messages.js
// GET  /api/messages  — list stored messages (with filter/search/sort)
// POST /api/messages  — receive classified conversations from Chrome extension
// DELETE /api/messages — clear all data

import { json, readData, writeData } from './_shared.js';

export async function onRequestGet({ request, env }) {
  try {
    const data = await readData(env.PULSE_KV);
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

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { conversations, scanMeta } = body;

    if (!conversations || !Array.isArray(conversations)) {
      return json({ error: 'Missing conversations array' }, 400);
    }

    const data = await readData(env.PULSE_KV);
    const now = new Date().toISOString();

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

    // Upsert messages by name (latest scan wins, preserve manual overrides)
    // Track status transitions for progress tracking
    const existingByName = new Map(data.messages.map(m => [m.name, m]));
    const incomingNames = new Set(conversations.map(c => c.name));
    const transitions = [];  // { name, from, to }
    let newCount = 0;
    let unchangedCount = 0;

    for (const conv of conversations) {
      const prev = existingByName.get(conv.name);
      const prevStatus = prev ? prev.status : null;
      const newStatus = conv.status;

      // Track transition
      if (!prev) {
        newCount++;
      } else if (prevStatus !== newStatus) {
        transitions.push({ name: conv.name, from: prevStatus, to: newStatus });
      } else {
        unchangedCount++;
      }

      // Build status history
      let statusHistory = (prev && prev.statusHistory) ? [...prev.statusHistory] : [];
      if (prev && prevStatus !== newStatus) {
        statusHistory.push({ from: prevStatus, to: newStatus, timestamp: now, scanId: scan.id });
        // Keep last 20 transitions per message
        if (statusHistory.length > 20) statusHistory = statusHistory.slice(-20);
      }

      const merged = {
        ...conv,
        scanId: scan.id,
        updatedAt: now,
        previousStatus: prevStatus,
        statusHistory,
        firstSeenAt: prev ? (prev.firstSeenAt || prev.updatedAt || now) : now,
      };
      if (prev) {
        // Preserve the user's manual work across re-syncs — a fresh scan must
        // never wipe a manual status override, star (focus), check (done), or note.
        if (prev.manualStatus) { merged.manualStatus = prev.manualStatus; merged.status = prev.manualStatus; }
        if (prev.focus !== undefined) merged.focus = prev.focus;
        if (prev.done !== undefined) merged.done = prev.done;
        if (prev.doneAt !== undefined) merged.doneAt = prev.doneAt;
        if (prev.note !== undefined) merged.note = prev.note;
        // Keep a previously-captured location if this scan didn't find one.
        if (!merged.city && prev.city) merged.city = prev.city;
        if (!merged.country && prev.country) merged.country = prev.country;
      }
      existingByName.set(conv.name, merged);
    }
    data.messages = Array.from(existingByName.values());

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

    await writeData(env.PULSE_KV, data);

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

export async function onRequestDelete({ request, env }) {
  try {
    const url = new URL(request.url);
    const name = url.searchParams.get('name');

    if (name) {
      // Delete a single message by name
      const data = await readData(env.PULSE_KV);
      const before = data.messages.length;
      data.messages = data.messages.filter(m => m.name !== name);
      await writeData(env.PULSE_KV, data);
      return json({ success: true, deleted: before - data.messages.length, remaining: data.messages.length });
    }

    // No name param = clear all (dangerous, keep for admin)
    await writeData(env.PULSE_KV, { scans: [], messages: [] });
    return json({ success: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
