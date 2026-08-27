// functions/api/admin/cohosts.js
// CoHost registry CRUD. Flat routes, same convention as clients.js — no [id] path
// segments, so the whole control plane still deploys as ONE directory upload.
//
//   GET    /api/admin/cohosts                 → list (invite tokens NEVER included)
//   POST   /api/admin/cohosts                 → invite  { name, linkedinUrl, notes? }
//                                               returns the invite URL, once
//   PATCH  /api/admin/cohosts                 → { id, action: 'reissue'|'revoke'|'restore' }
//                                               or { id, name?, linkedinUrl?, notes? }
//   DELETE /api/admin/cohosts?id=…            → remove the record entirely
//
// WHY THE INVITE URL IS RETURNED ONCE: the token in it is a bearer credential — it
// binds whoever opens it to this CoHost seat. Listing it on every GET would make a
// read of the registry enough to take someone else's identity. Lost link → reissue,
// which mints a new token and kills the old one.
//
// Revoking is INSTANT: the root middleware re-reads this registry on every request,
// so a revoked CoHost is signed out on their very next click — no waiting for the
// 30-day session cookie to lapse.

import {
  readAdminStore, writeAdminStore, audit, findCohost, findCohostBySlug,
  findClientByEmail, newCohostId, newInvite, publicCohost,
  normalizeLinkedInUrl, linkedinSlugOf, isInviteSpent,
} from '../../_admin.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: NO_STORE });

/** The link an admin actually sends. Built from the request origin so it is correct
 *  on preview deployments too, rather than hard-coding the production host. */
function inviteUrl(request, token) {
  return new URL('/invite?t=' + encodeURIComponent(token), new URL(request.url).origin).toString();
}

export async function onRequestGet({ env }) {
  const store = await readAdminStore(env);
  return json({
    ok: true,
    cohosts: (store.cohosts || []).map(publicCohost),
    updatedAt: store.updatedAt,
  });
}

export async function onRequestPost({ request, env, data }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad-json' }, 400); }

  const name = String((body && body.name) || '').trim();
  if (!name) return json({ ok: false, error: 'name-required' }, 400);
  if (name.length > 80) return json({ ok: false, error: 'name-too-long' }, 400);

  const linkedinUrl = normalizeLinkedInUrl(body && body.linkedinUrl);
  if (!linkedinUrl) return json({ ok: false, error: 'bad-linkedin-url' }, 400);
  const slug = linkedinSlugOf(linkedinUrl);

  const store = await readAdminStore(env);

  // One profile is one CoHost — a second invite for the same person would create two
  // records racing to claim the same email.
  const clash = findCohostBySlug(store, slug);
  if (clash) return json({ ok: false, error: 'already-invited', cohostId: clash.id, cohostName: clash.name }, 409);

  const now = new Date().toISOString();
  const cohost = {
    id: newCohostId(name, store),
    name,
    linkedinUrl,
    linkedinSlug: slug,
    email: null,
    status: 'invited',
    invite: newInvite(),
    createdAt: now,
    claimedAt: null,
    lastSeenAt: null,
    notes: String((body && body.notes) || '').slice(0, 2000),
  };

  store.cohosts = store.cohosts || [];
  store.cohosts.push(cohost);
  // Free-text notes are never copied into the audit log, and neither is the token.
  audit(store, data.adminEmail, 'cohost.invite', cohost.id, { linkedin: slug });
  await writeAdminStore(env, store);

  return json({
    ok: true,
    cohost: publicCohost(cohost),
    inviteUrl: inviteUrl(request, cohost.invite.token),
    inviteExpiresAt: cohost.invite.expiresAt,
  }, 201);
}

export async function onRequestPatch({ request, env, data }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad-json' }, 400); }

  const store = await readAdminStore(env);
  const cohost = findCohost(store, body && body.id);
  if (!cohost) return json({ ok: false, error: 'not-found' }, 404);

  const action = String((body && body.action) || '').trim();

  // --- Re-issue the invite link (lost it, or it expired) ---
  if (action === 'reissue') {
    if (cohost.status === 'revoked') return json({ ok: false, error: 'revoked' }, 409);
    if (cohost.email) return json({ ok: false, error: 'already-claimed' }, 409);
    cohost.invite = newInvite();
    cohost.status = 'invited';
    audit(store, data.adminEmail, 'cohost.reissue', cohost.id, null);
    await writeAdminStore(env, store);
    return json({
      ok: true, cohost: publicCohost(cohost),
      inviteUrl: inviteUrl(request, cohost.invite.token),
      inviteExpiresAt: cohost.invite.expiresAt,
    });
  }

  // --- Revoke: takes effect on their next request, not in 30 days ---
  if (action === 'revoke') {
    cohost.status = 'revoked';
    // Kill any outstanding link at the same time — otherwise revoking a CoHost who
    // never signed in would leave a live invite lying in somebody's inbox.
    if (cohost.invite && !isInviteSpent(cohost.invite)) cohost.invite.usedAt = new Date().toISOString();
    audit(store, data.adminEmail, 'cohost.revoke', cohost.id, { email: cohost.email || null });
    await writeAdminStore(env, store);
    return json({ ok: true, cohost: publicCohost(cohost) });
  }

  // --- Restore a revoked CoHost ---
  if (action === 'restore') {
    if (cohost.email) {
      // Their email must still be free — they may have been added to a client since.
      const clash = findClientByEmail(store, cohost.email);
      if (clash) return json({ ok: false, error: 'email-is-client', clientName: clash.name }, 409);
      cohost.status = 'active';
    } else {
      // Never claimed: put them back to invited and mint a fresh link.
      cohost.status = 'invited';
      cohost.invite = newInvite();
    }
    audit(store, data.adminEmail, 'cohost.restore', cohost.id, null);
    await writeAdminStore(env, store);
    return json({
      ok: true, cohost: publicCohost(cohost),
      inviteUrl: cohost.email ? null : inviteUrl(request, cohost.invite.token),
    });
  }

  // --- Plain field edits ---
  const changes = {};
  if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== cohost.name) {
    changes.name = [cohost.name, body.name.trim().slice(0, 80)];
    cohost.name = body.name.trim().slice(0, 80);
  }
  if (typeof body.linkedinUrl === 'string' && body.linkedinUrl.trim()) {
    const url = normalizeLinkedInUrl(body.linkedinUrl);
    if (!url) return json({ ok: false, error: 'bad-linkedin-url' }, 400);
    const slug = linkedinSlugOf(url);
    const clash = findCohostBySlug(store, slug);
    if (clash && clash.id !== cohost.id) {
      return json({ ok: false, error: 'already-invited', cohostId: clash.id, cohostName: clash.name }, 409);
    }
    if (url !== cohost.linkedinUrl) {
      changes.linkedin = [cohost.linkedinSlug, slug];
      cohost.linkedinUrl = url;
      cohost.linkedinSlug = slug;
    }
  }
  if (typeof body.notes === 'string' && body.notes !== cohost.notes) {
    cohost.notes = body.notes.slice(0, 2000);
    changes.notes = true;   // the text itself never reaches the audit log
  }

  if (!Object.keys(changes).length) return json({ ok: true, cohost: publicCohost(cohost), unchanged: true });

  audit(store, data.adminEmail, 'cohost.update', cohost.id, changes);
  await writeAdminStore(env, store);
  return json({ ok: true, cohost: publicCohost(cohost) });
}

export async function onRequestDelete({ request, env, data }) {
  const id = new URL(request.url).searchParams.get('id');
  const store = await readAdminStore(env);
  const cohost = findCohost(store, id);
  if (!cohost) return json({ ok: false, error: 'not-found' }, 404);

  store.cohosts = (store.cohosts || []).filter(h => h.id !== cohost.id);
  audit(store, data.adminEmail, 'cohost.delete', cohost.id, { email: cohost.email || null });
  await writeAdminStore(env, store);
  return json({ ok: true, deleted: cohost.id });
}
