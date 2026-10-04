// functions/_decline-rules.js
// 2026-10-04 — A polite refusal ("No thank you", "not for us", "maybe later") is NOT a
// follow-up. The collector's decline list was too narrow (aucun besoin / ne m'intéresse /
// not interested / declined), so "No thank you" landed in Red ("your turn").
//
// Colour code after this rule:
//   Orange = the lead said no OR not now ("no thanks", "not for us", "maybe later",
//            "next quarter"...). Interest Low; Fit Low if it was blank. No reply needed.
//   Red    = the lead replied with anything else and it is your turn.
//   Green  = no reply yet, or you replied last.
//
// Two tiers:
//   1. Keywords (EN/FR/ES/DE) — always on, applied on GET and POST so existing records
//      are fixed immediately, without an extension update.
//   2. AI fallback — only for lead replies the keywords did NOT catch, only on POST (sync),
//      cached on the record (aiIntent + aiIntentFor) so each message is classified once.
//      Uses Cloudflare Workers AI (env.AI binding) — free at our volume. An ANTHROPIC_API_KEY,
//      if ever set, takes precedence (not configured on purpose: too expensive for this).
// A manual status override set by the user always wins.

const HARD_NO = new RegExp([
  // English
  'no,?\\s+thank(s| you)', '\\bno\\s+thx\\b', 'thanks?,?\\s+but\\s+no', 'thank you,?\\s+but\\s+(no|we|i)',
  'not interested', 'not for (us|me|now)', 'not (a|the) (good |right )?fit', "doesn'?t fit", 'not relevant',
  'no need', 'no interest', "we'?re (all )?set", "we are (all )?set", "i'?m (all )?set", "we'?re good",
  'not looking', 'not in the market', 'no budget', "(i|we)(\\s+will|'ll)\\s+pass", 'pass on this',
  'not at this (time|stage|point)', 'not right now', "don'?t (need|want)", 'do not (need|want)',
  'please remove', 'remove me', 'unsubscribe', 'stop (messaging|contacting)', 'not the right person',
  'already (have|work with|working with) (a|an|our)', 'we (have|handle) (this|that) (in-house|internally)',
  'declin', 'politely decline', 'have to decline',
  // French
  'non,?\\s+merci', 'merci,?\\s+mais\\s+(non|nous|je)', 'pas int[ée]ress', 'ne m.int[ée]resse', 'ne nous int[ée]resse',
  'aucun besoin', 'pas (de|le) besoin', 'pas besoin', 'pas pour (nous|moi)', 'pas le bon moment',
  'pas pertinent', 'pas d.actualit[ée]', 'nous avons d[ée]j[àa]', 'on a d[ée]j[àa]', 'je passe mon tour',
  'pas de budget', 'merci de ne plus', 'ne plus me contacter', 'pas concern[ée]',
  // Spanish / German / Italian / Dutch (common short refusals)
  'no,?\\s+gracias', 'no me interesa', 'nein,?\\s+danke', 'kein interesse', 'no,?\\s+grazie', 'non mi interessa',
  'nee,?\\s+dank', 'geen interesse',
].join('|'), 'i');

const LATER = new RegExp([
  'maybe later', 'perhaps later', 'later this year', 'later in the year', 'not now', 'not yet',
  'next (quarter|year|month)', 'in a few (months|weeks)', 'circle back', 'reconnect (later|in)',
  'reach out (again )?(later|in|next)', 'get back to you (later|in|next)', 'keep (you|your details) in mind',
  'on file', 'down the (road|line)', 'in the future', 'timing is(n.t| not) right',
  'peut-[êe]tre plus tard', 'plus tard', 'pas maintenant', 'pas pour l.instant', "pas pour le moment",
  'dans quelques (mois|semaines)', 'l.ann[ée]e prochaine', 'le trimestre prochain', 'revenir vers (moi|nous) (plus tard|dans)',
  'je garde (vos|votre)', 'quizás más adelante', 'vielleicht später',
].join('|'), 'i');

// A refusal phrase next to a real ask is NOT a refusal ("No thanks for the deck — can we talk Tuesday?").
const ASK = /\?|would love|happy to (chat|talk|connect|meet)|interested in (learning|hearing|knowing)|send (me|us)|let'?s (talk|chat|meet|connect)|call me|book a|schedule|calendly|zoom|teams|appel|rdv|rendez|envoyez|on peut (se )?(parler|appeler)|disponible|available (on|for|next)/i;

function text(msg) { return String((msg && msg.snippet) || '').trim(); }

function eligible(msg) {
  if (!msg || msg.manualStatus) return false;
  if (msg.lastSender === 'you') return false;           // you replied last → already Green
  if (msg.category === 'social') return false;           // birthday rule owns these
  const t = text(msg);
  if (!t || /^\(no (reply|preview)/i.test(t)) return false;
  return true;
}

// Pure keyword verdict: 'decline' | 'later' | null
export function keywordVerdict(msg) {
  if (!eligible(msg)) return null;
  const t = text(msg);
  const no = HARD_NO.test(t), later = LATER.test(t);
  if (!no && !later) return null;
  if (ASK.test(t) && !/remove me|unsubscribe|stop (messaging|contacting)|ne plus me contacter/i.test(t)) return null;
  return later ? 'later' : 'decline';
}

function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

function toOrange(msg, verdict, source) {
  return {
    ...msg,
    status: 'Orange',
    ball: 'closed',
    interest: 'Low',
    fit: msg.fit ? msg.fit : 'Low',
    category: verdict === 'later' ? 'later' : 'decline',
    reason: (verdict === 'later' ? 'Not now / maybe later' : 'Declined (no thanks / not for us)') + (source === 'ai' ? ' — AI' : ''),
  };
}

// Sync rule (GET + POST): keywords, then any cached AI verdict for this exact snippet.
export function applyDeclineRule(msg) {
  if (!eligible(msg)) return msg;
  const kw = keywordVerdict(msg);
  if (kw) return toOrange(msg, kw, 'kw');
  if (msg.aiIntent && msg.aiIntentFor === hash(text(msg)) && (msg.aiIntent === 'decline' || msg.aiIntent === 'later')) {
    return toOrange(msg, msg.aiIntent, 'ai');
  }
  return msg;
}

// ── AI fallback (POST only) ───────────────────────────────────────────────────
const SYSTEM = 'You classify the LAST message a sales prospect sent in reply to LinkedIn outreach. ' +
  'Answer with exactly one word: decline (any refusal, however polite: no thanks, not for us, not interested, already have a provider, remove me), ' +
  'later (not now, maybe later, contact me next quarter/year, timing not right), ' +
  'or other (anything else: interest, a question, a meeting request, a referral, out-of-office, thanks, small talk). ' +
  'If the message both refuses and asks for something concrete, answer other.';

async function classifyAI(t, env, fetchFn) {
  const user = 'Message:\n"""\n' + t.slice(0, 1200) + '\n"""\nOne word:';
  let out = '';
  if (env.ANTHROPIC_API_KEY) {
    // Never the Fable model (Olivier's standing rule) — Haiku first, Sonnet as fallback.
    const models = [env.ANTHROPIC_CLASSIFY_MODEL, 'claude-haiku-4-5', 'claude-sonnet-4-5']
      .filter((v, i, a) => v && !/fable/i.test(v) && a.indexOf(v) === i);
    for (const model of models) {
      const res = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 5, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
      });
      if (!res.ok) { if (res.status === 400 || res.status === 404) continue; return null; }
      const j = await res.json();
      out = (j.content || []).map(c => c.text || '').join('');
      break;
    }
  } else if (env.AI) {
    // Cloudflare Workers AI (binding "AI", added 2026-10-04) — free daily allocation covers our volume.
    // 70B for accuracy (a classification costs a few neurons); 8B as fallback.
    for (const model of ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct']) {
      try {
        const r = await env.AI.run(model, {
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], max_tokens: 5,
        });
        out = (r && (r.response || r.result)) || '';
        if (out) break;
      } catch (e) { /* try next model */ }
    }
  } else {
    return null;
  }
  const w = String(out).toLowerCase();
  if (/\bdecline/.test(w)) return 'decline';
  if (/\blater/.test(w)) return 'later';
  if (/\bother/.test(w)) return 'other';
  return null;
}

// Classifies lead replies the keywords missed; reuses the cached verdict from the stored
// record when the snippet is unchanged. Best-effort: any failure leaves the record as-is.
export async function applyDeclineRulesAsync(conversations, prevByName, env, fetchFn = fetch, maxCalls = 25) {
  let calls = 0;
  const out = [];
  for (const c of conversations) {
    let m = c;
    if (eligible(m) && !keywordVerdict(m) && m.status === 'Red') {
      const h = hash(text(m));
      const prev = prevByName && prevByName.get(m.name);
      if (prev && prev.aiIntentFor === h && prev.aiIntent) {
        m = { ...m, aiIntent: prev.aiIntent, aiIntentFor: h };
      } else if (calls < maxCalls && (env.ANTHROPIC_API_KEY || env.AI)) {
        calls++;
        try {
          const v = await classifyAI(text(m), env, fetchFn);
          if (v) m = { ...m, aiIntent: v, aiIntentFor: h };
        } catch (e) { /* ignore — keyword tier still applies */ }
      }
    }
    out.push(applyDeclineRule(m));
  }
  return out;
}
