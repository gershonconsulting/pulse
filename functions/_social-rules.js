// functions/_social-rules.js
// 2026-10-02 — Social pleasantries (birthday wishes, work-anniversary wishes) are NOT
// business conversations. They have no business value and need no reply, so they
// must never land in "Follow-up needed" (Red). Applied server-side so it takes
// effect without an extension update: on every POST /api/messages (incoming AND
// already-stored records) and on GET (so the dashboard is correct immediately).
//
// A conversation is reclassified only when ALL of these hold:
//   - the last message is from them (if you replied last it is already Green),
//   - the last message reads as birthday / work-anniversary wishes,
//   - it carries no business intent (a call, meeting, proposal, project...).
// A manual status override set by the user always wins (handled by the caller).

const PLEASANTRY = new RegExp([
  'happy\\s+(belated\\s+)?b(irth)?-?day', '\\bh\\.?b\\.?d\\b', 'happy\\s+bday',
  'many\\s+happy\\s+returns', 'best\\s+wishes\\s+(on|for)\\s+your\\s+birthday',
  'birthday\\s+wishes', 'have\\s+a\\s+(great|wonderful|fantastic|lovely|nice)\\s+birthday',
  'joyeux\\s+anniv', 'bon(ne)?\\s+anniv', 'bel\\s+anniv', 'heureux\\s+anniv',
  'feliz\\s+(cumplea|anivers)', 'feliz\\s+cumple', 'buon\\s+compleanno', 'tanti\\s+auguri',
  'alles\\s+gute\\s+zum\\s+geburtstag', 'herzlichen\\s+gl[uü]ckwunsch\\s+zum\\s+geburtstag',
  'gefeliciteerd\\s+met\\s+je\\s+verjaardag', 'fijne\\s+verjaardag',
  'yom\\s+hul[ae]det', 'с\\s+днём\\s+рождения', 'с\\s+днем\\s+рождения',
  'happy\\s+work\\s+anniversary', 'congrat\\w*\\s+on\\s+your\\s+work\\s+anniversary',
  'joyeux\\s+anniversaire\\s+professionnel', '🎂',
].join('|'), 'i');

const BUSINESS = /\b(call|meeting|meet\s+up|rdv|rendez|demo|proposal|propos|quote|devis|pricing|price|tarif|budget|contract|contrat|collab\w*|partner\w*|opportunit\w*|project|projet|discuss\w*|discut\w*|schedule|calendly|zoom|teams|appel|r[ée]union|offre|offer|service|client|lead|introduc\w*|intro)\b/i;

export function isSocialPleasantry(msg) {
  if (!msg || msg.lastSender === 'you') return false;
  const text = String(msg.snippet || '');
  if (!text || !PLEASANTRY.test(text)) return false;
  if (BUSINESS.test(text)) return false;
  return true;
}

// Returns the record reclassified as "no reply needed", or the record unchanged.
export function applySocialRule(msg) {
  if (!msg || msg.manualStatus) return msg;
  if (!isSocialPleasantry(msg)) return msg;
  return {
    ...msg,
    status: 'Green',
    ball: 'closed',
    interest: msg.interest && msg.interest !== 'Medium' && msg.interest !== 'High' ? msg.interest : 'N/A',
    category: 'social',
    reason: 'Birthday / anniversary wishes — no reply needed',
  };
}
