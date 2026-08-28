// functions/api/messages/[name].js
// PATCH /api/messages/:name — manually override a message status

import { json, readData, writeData, clientIdOf } from '../_shared.js';

export async function onRequestPatch(context) {
  const { params, request, env } = context;
  const clientId = clientIdOf(context);
  try {
    const name = decodeURIComponent(params.name);
    const body = await request.json();
    const { status, note, focus, done } = body;

    if (status && !['Red', 'Orange', 'Green'].includes(status)) {
      return json({ error: 'Status must be Red, Orange, or Green' }, 400);
    }

    const data = await readData(env.PULSE_KV, clientId);
    const msg = data.messages.find(m => m.name === name);

    if (!msg) {
      return json({ error: 'Message not found' }, 404);
    }

    if (status) {
      msg.manualStatus = status;
      msg.status = status;
    }
    if (note !== undefined) {
      msg.note = note;
    }
    if (focus !== undefined) {
      msg.focus = !!focus;
    }
    if (done !== undefined) {
      msg.done = !!done;
      msg.doneAt = done ? new Date().toISOString() : null;
      // Checking a conversation clears its star: a handled lead is no longer a
      // focus item. An explicit focus in the same request still wins.
      if (msg.done && focus === undefined) {
        msg.focus = false;
      }
    }
    msg.updatedAt = new Date().toISOString();

    await writeData(env.PULSE_KV, clientId, data);
    return json({ success: true, message: msg });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
