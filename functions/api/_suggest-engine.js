// functions/api/_suggest-engine.js
// Suggested-reply engine for Pulse (app v5.10.0).
//
// Three inputs, one output:
//   1. the conversation (lead's last message, status, language, who spoke last)
//   2. the tenant's COMPANY KNOWLEDGE  (kb:<clientId> in KV — edited on the Replies page)
//   3. the tenant's PAST REPLIES       (replies:<clientId> library + the "you sent last"
//                                       messages the collector already captured)
// -> 2-4 ready-to-send drafts, each with a Copy button in the dashboard.
//
// Generation tiers, best first — the feature works with NONE of the optional ones set:
//   a. env.ANTHROPIC_API_KEY  -> Claude writes the drafts (grounded in 2 + 3)
//   b. env.AI (Workers AI)    -> Llama writes the drafts
//   c. built-in templates     -> intent x language templates filled from the knowledge
//                                base, plus the closest real past reply, adapted
// Any AI failure falls through to (c) so the button never comes back empty.
//
// Pure module: no KV, no fetch except inside generateWithAnthropic / generateWithWorkersAI,
// which take the fetch/AI binding as arguments so it can be unit-tested in node.

export const MAX_LIBRARY = 300;

// ── Default knowledge (Gershon's own tenant) ──────────────────────────────────
export const DEFAULT_KB = {
  company: 'Gershon Consulting',
  sender: 'Olivier',
  pitch: 'We help international B2B companies enter and grow in the US market — LinkedIn outbound, lead generation and on-the-ground commercial representation.',
  proof: 'US-based (Delaware) since 2013, working with European and global companies.',
  pitchFr: 'Nous aidons les entreprises B2B internationales à se lancer et se développer aux États-Unis — prospection LinkedIn, génération de leads et représentation commerciale sur place.',
  proofFr: 'Basés aux États-Unis (Delaware) depuis 2013, nous accompagnons des entreprises européennes et internationales.',
  market: 'the US market',
  marketFr: 'le marché américain',
  cta: 'a short 15-minute call',
  calendarLink: '',
  tone: 'Warm, concise, professional. No hard sell. One clear next step.',
  notes: '',
};

export function emptyKb(clientName) {
  return {
    company: clientName || '',
    sender: '',
    pitch: '',
    proof: '',
    pitchFr: '',
    proofFr: '',
    market: 'the US market',
    marketFr: 'le marché américain',
    cta: 'a short 15-minute call',
    calendarLink: '',
    tone: 'Warm, concise, professional. One clear next step.',
    notes: '',
  };
}

// ── Intent detection ──────────────────────────────────────────────────────────
const RX = {
  ooo: /out of (the )?office|on vacation|on holiday|on leave|\bo\.?o\.?o\b|en cong[ée]|en vacances|absent|limited (internet|connectivity|access)|currently (traveling|travelling|away)|de retour le|back on/i,
  decline: /pas int[ée]ress|aucun besoin|ne m.int[ée]resse|not interested|no need|no thanks?|not a (good )?fit|pas (le bon moment|pour nous)|d[ée]clin|unsubscribe|remove me|pas de besoin|not at this time|not right now/i,
  defer: /get back to you|at a later time|circle back|reconnect later|later this year|next (quarter|year|month)|plus tard|je reviens vers vous|dans quelques (mois|semaines)|pas maintenant/i,
  referral: /(right|best) person|colleague|coll[èe]gue|reach out to|contact (him|her|them)|in charge of|responsable|s.occupe|je transf[èe]re|forward(ed)? (this|your)|cc'?d|mettre en relation/i,
  meeting: /\bcall\b|meeting|\bmeet\b|schedule|calendar|calendly|availability|available|\bslot\b|zoom|teams|visio|rendez[- ]vous|\brdv\b|disponib|cr[ée]neau|appel|[ée]changer|discuter|when (are|would)|quand/i,
  info: /more (info|information|details)|tell me more|what (do|exactly)|how (does|do|much)|pricing|price|cost|rates?|brochure|deck|presentation|case stud|en savoir plus|plus d.informations|comment|combien|tarif|prix|pr[ée]sentation|\?/i,
  positive: /interested|sounds (good|great|interesting)|happy to|would love|let.s (talk|chat)|yes\b|sure\b|absolutely|int[ée]ress[ée]|avec plaisir|volontiers|oui\b|pourquoi pas|bonne id[ée]e/i,
  thanks: /\bthanks?\b|thank you|merci|appreciate/i,
};

export function detectIntent(msg) {
  const text = String((msg && msg.snippet) || '').trim();
  const noReply = !text || /^\(no (reply|preview)/i.test(text);
  if (noReply || (msg && msg.lastSender === 'you')) return 'follow_up';
  if (RX.ooo.test(text)) return 'ooo';
  if (RX.decline.test(text)) return 'decline';
  if (RX.defer.test(text)) return 'defer';
  if (RX.referral.test(text)) return 'referral';
  if (RX.meeting.test(text)) return 'meeting';
  if (RX.info.test(text)) return 'info';
  if (RX.positive.test(text)) return 'positive';
  if (RX.thanks.test(text)) return 'thanks';
  return 'generic';
}

export const INTENT_LABEL = {
  follow_up: 'Follow-up (no answer yet)',
  ooo: 'Out of office',
  decline: 'Not interested',
  defer: 'Later / not now',
  referral: 'Referred to someone else',
  meeting: 'Wants to talk',
  info: 'Asked for information',
  positive: 'Interested',
  thanks: 'Thank-you',
  generic: 'Replied',
};

export function detectLanguage(msg) {
  const l = String((msg && msg.language) || '').toLowerCase();
  if (l.startsWith('fr')) return 'fr';
  if (l.startsWith('en')) return 'en';
  const t = String((msg && msg.snippet) || '').toLowerCase();
  const fr = (t.match(/\b(bonjour|merci|vous|votre|nous|je|suis|avec|pour|bonne|journée|très|besoin|cordialement)\b/g) || []).length;
  const en = (t.match(/\b(hi|hello|the|you|your|we|thanks|would|could|please|regards)\b/g) || []).length;
  return fr > en ? 'fr' : 'en';
}

export function firstName(name) {
  const n = String(name || '').trim().replace(/\s*\(.*?\)\s*/g, ' ').replace(/,.*$/, '').trim();
  const f = n.split(/\s+/)[0] || '';
  // "Dr." / "M." style prefixes -> take the next token
  if (/^(dr|mr|mrs|ms|m|mme)\.?$/i.test(f) && n.split(/\s+/)[1]) return n.split(/\s+/)[1];
  return f;
}

// ── Templates (tier c) ────────────────────────────────────────────────────────
// {first} {company} {pitch} {proof} {market} {marketFr} {cta} {cal} {sender}. Lines whose placeholders
// resolve to empty are dropped, so a sparse knowledge base still reads cleanly.
const T = {
  en: {
    follow_up: [
      ['Gentle nudge', 'Hi {first},\n\nJust bringing my note back to the top of your inbox. {pitch}\n\nWould {cta} next week make sense?{cal}\n\nBest,\n{sender}'],
      ['Value-first', 'Hi {first},\n\nI know LinkedIn inboxes get busy, so briefly:\n\n{pitch} {proof}\n\nIf {market} is on your radar this year, happy to share what is working for companies like yours — {cta}?\n\n{sender}'],
    ],
    positive: [
      ['Book the call', 'Hi {first},\n\nGreat to hear — thank you! The easiest next step is {cta} so I can understand your goals for {market} and show you how we would approach them.{cal}\n\nWhich days work best for you?\n\n{sender}'],
      ['Two questions first', 'Thanks {first}!\n\nTo make our call useful, two quick questions: which segment or region are you targeting, and do you already have anyone on the ground?\n\nThen let\'s find a time for {cta}.{cal}\n\n{sender}'],
    ],
    meeting: [
      ['Propose times', 'Hi {first},\n\nWith pleasure. Would Tuesday or Thursday afternoon (US Eastern) work for {cta}?{cal}\n\nLooking forward to it,\n{sender}'],
      ['Confirm + agenda', 'Hi {first},\n\nPerfect, let\'s talk. I suggest 15 minutes: your objectives, how we work, and whether there is a fit.{cal}\n\nWhat time suits you?\n\n{sender}'],
    ],
    info: [
      ['Short answer + call', 'Hi {first},\n\nGood question. {pitch} {proof}\n\nThe right setup depends on your target market and sales cycle, so the fastest way to give you a precise answer is {cta}.{cal}\n\n{sender}'],
      ['Offer a summary', 'Hi {first},\n\nHappy to explain. {pitch}\n\nI can send a one-page overview, or walk you through it in {cta} — whichever you prefer.\n\n{sender}'],
    ],
    referral: [
      ['Ask for the intro', 'Thank you {first}, much appreciated!\n\nWould you be comfortable making a quick introduction, or sharing the best way to reach them? I will mention that you pointed me their way.\n\n{sender}'],
    ],
    defer: [
      ['Agree a date', 'Thanks {first}, completely understood.\n\nWhen would be a better moment to reconnect — should I reach out again next quarter?\n\n{sender}'],
    ],
    ooo: [
      ['After their return', 'Thanks {first} — enjoy the time away! I will follow up when you are back.\n\n{sender}'],
    ],
    decline: [
      ['Leave the door open', 'Thanks for letting me know, {first} — I appreciate the reply.\n\nIf {market} comes back on the agenda, feel free to reach out anytime. Wishing you a great quarter.\n\n{sender}'],
    ],
    thanks: [
      ['Keep it moving', 'My pleasure, {first}!\n\nOut of curiosity, is {market} a priority for you this year? If so, {cta} could be worthwhile.\n\n{sender}'],
    ],
    generic: [
      ['Engage', 'Thanks for your reply, {first}!\n\n{pitch}\n\nWould {cta} be useful to see whether we can help?{cal}\n\n{sender}'],
      ['Ask a question', 'Thanks {first}.\n\nWhat are your main priorities for {market} over the next 6-12 months? Happy to share how we typically help.\n\n{sender}'],
    ],
  },
  fr: {
    follow_up: [
      ['Relance douce', 'Bonjour {first},\n\nJe me permets de remonter mon message. {pitch}\n\nSeriez-vous disponible pour {cta} la semaine prochaine ?{cal}\n\nBien à vous,\n{sender}'],
      ['Valeur d\'abord', 'Bonjour {first},\n\nEn deux mots :\n\n{pitch} {proof}\n\nSi {marketFr} fait partie de vos objectifs cette année, je serais ravi d\'en parler — {cta} ?\n\n{sender}'],
    ],
    positive: [
      ['Caler l\'appel', 'Bonjour {first},\n\nMerci pour votre retour ! Le plus simple serait {cta} pour comprendre vos objectifs et vous présenter notre approche.{cal}\n\nQuels jours vous conviendraient ?\n\n{sender}'],
      ['Deux questions', 'Merci {first} !\n\nPour que notre échange soit utile : quel segment ou quelle région visez-vous, et avez-vous déjà quelqu\'un sur place ?\n\nTrouvons ensuite un créneau pour {cta}.{cal}\n\n{sender}'],
    ],
    meeting: [
      ['Proposer des créneaux', 'Bonjour {first},\n\nAvec plaisir. Mardi ou jeudi après-midi (heure de Paris) vous conviendrait pour {cta} ?{cal}\n\nAu plaisir,\n{sender}'],
      ['Confirmer + ordre du jour', 'Bonjour {first},\n\nParfait, échangeons. Je propose 15 minutes : vos objectifs, notre façon de travailler, et si cela correspond.{cal}\n\nQuel horaire vous arrange ?\n\n{sender}'],
    ],
    info: [
      ['Réponse courte + appel', 'Bonjour {first},\n\nBonne question. {pitch} {proof}\n\nLa bonne formule dépend de votre marché cible et de votre cycle de vente — le plus rapide pour vous répondre précisément serait {cta}.{cal}\n\n{sender}'],
      ['Proposer un résumé', 'Bonjour {first},\n\nVolontiers. {pitch}\n\nJe peux vous envoyer une présentation d\'une page, ou vous l\'expliquer lors d\'{cta} — comme vous préférez.\n\n{sender}'],
    ],
    referral: [
      ['Demander la mise en relation', 'Merci beaucoup {first} !\n\nPourriez-vous nous mettre en relation, ou m\'indiquer la meilleure façon de la/le joindre ? Je préciserai que c\'est de votre part.\n\n{sender}'],
    ],
    defer: [
      ['Fixer une date', 'Merci {first}, je comprends tout à fait.\n\nQuel serait le bon moment pour en reparler — je reviens vers vous au prochain trimestre ?\n\n{sender}'],
    ],
    ooo: [
      ['Après le retour', 'Merci {first}, bon repos ! Je reviendrai vers vous à votre retour.\n\n{sender}'],
    ],
    decline: [
      ['Laisser la porte ouverte', 'Merci pour votre réponse, {first}, c\'est apprécié.\n\nSi {marketFr} revient à l\'ordre du jour, n\'hésitez pas à me recontacter. Excellente continuation !\n\n{sender}'],
    ],
    thanks: [
      ['Relancer l\'échange', 'Avec plaisir, {first} !\n\nPar curiosité, {marketFr} fait-il partie de vos priorités cette année ? Si oui, {cta} pourrait être utile.\n\n{sender}'],
    ],
    generic: [
      ['Engager', 'Merci pour votre réponse, {first} !\n\n{pitch}\n\nUn {cta} pour voir si nous pouvons vous aider ?{cal}\n\n{sender}'],
      ['Poser une question', 'Merci {first}.\n\nQuelles sont vos priorités sur {marketFr} pour les 6 à 12 prochains mois ? Je vous partagerai volontiers comment nous aidons habituellement.\n\n{sender}'],
    ],
  },
};

const CTA_FR = { 'a short 15-minute call': 'un court échange de 15 minutes' };

export function fillTemplate(tpl, vars, lang) {
  let out = tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
  const punct = lang === 'fr' ? / ([.,])/g : / ([.,!?])/g; // French keeps the space before ? ! :
  out = out
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(punct, '$1').trimEnd())
    .join('\n')
    .replace(/Hi ,/g, 'Hi,').replace(/Bonjour ,/g, 'Bonjour,')
    .replace(/Thanks ([.!—-])/g, 'Thanks$1').replace(/Merci ([.!—-])/g, 'Merci$1')
    .replace(/, \./g, '.').replace(/ ,/g, ',')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out;
}

function kbVars(kb, lang, first) {
  kb = kb || {};
  let cta = (kb.cta || '').trim() || (lang === 'fr' ? 'un court échange de 15 minutes' : 'a short 15-minute call');
  if (lang === 'fr' && CTA_FR[cta]) cta = CTA_FR[cta];
  const cal = (kb.calendarLink || '').trim();
  return {
    first: first || '',
    company: kb.company || '',
    // French drafts use the French pitch when there is one; an English pitch inside a
    // French message reads worse than no pitch, so it is dropped instead.
    pitch: (lang === 'fr' ? (kb.pitchFr || '') : (kb.pitch || '')).trim(),
    proof: (lang === 'fr' ? (kb.proofFr || '') : (kb.proof || '')).trim(),
    cta,
    cal: cal ? (lang === 'fr' ? '\nMon agenda : ' : '\nMy calendar: ') + cal : '',
    sender: (kb.sender || '').trim(),
    market: (kb.market || '').trim() || 'the US market',
    marketFr: (kb.marketFr || '').trim() || 'le marché américain',
  };
}

export function templateSuggestions(intent, lang, kb, first) {
  const set = (T[lang] || T.en)[intent] || (T[lang] || T.en).generic;
  const vars = kbVars(kb, lang, first);
  return set.map(([label, tpl]) => ({ label, text: fillTemplate(tpl, vars, lang), basis: 'template' }));
}

// ── Past replies: harvest + rank ──────────────────────────────────────────────
const STOP = new Set('the a an and or to of in on for with you your we our is are be it this that i me my at as by from have has will would could can do not no yes hi hello thanks thank le la les un une des et ou de du en pour avec vous votre nous je est sont être ce cette mon ma mes au aux par sur pas oui bonjour merci'.split(' '));
export function tokens(s) {
  return new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let i = 0; for (const w of a) if (b.has(w)) i++;
  return i / (a.size + b.size - i);
}

/** Your own messages the collector already has: LinkedIn records where YOU sent last. */
export function harvestSent(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || m.lastSender !== 'you') continue;
    const pf = m.platform || (/\/sales\//.test(m.conversationLink || '') ? 'sales-navigator' : 'linkedin');
    if (pf !== 'linkedin') continue; // SN snippet is the LEAD's text, never yours
    const t = String(m.snippet || '').trim();
    if (t.length < 25 || /^\(no (reply|preview)/i.test(t)) continue;
    out.push({
      id: 'sent:' + (m.name || ''),
      text: t,
      intent: null,
      language: detectLanguage(m),
      leadName: m.name || '',
      source: 'sent',
      uses: 0,
    });
  }
  return out;
}

/** Swap the original lead's first name for the new one when re-using a past reply. */
export function adaptReply(text, fromName, toFirst) {
  let t = String(text || '');
  const f = firstName(fromName);
  if (f && toFirst && f.length > 1) t = t.replace(new RegExp('\\b' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), toFirst);
  return t;
}

export function rankPastReplies(msg, intent, lang, pool, limit = 5) {
  const q = tokens(msg && msg.snippet);
  const scored = [];
  for (const r of pool || []) {
    if (!r || !r.text) continue;
    if (r.leadName && msg && r.leadName === msg.name) continue; // don't suggest their own thread back
    let s = 0;
    if (r.intent && r.intent === intent) s += 3;
    if ((r.language || 'en') === lang) s += 2; else s -= 3;
    s += 4 * jaccard(q, tokens(r.context || ''));
    s += 1.5 * jaccard(q, tokens(r.text));
    s += Math.min(2, (r.uses || 0) * 0.4);
    if (r.source === 'manual') s += 0.5;
    scored.push({ r, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).filter((x) => x.s > 0).map((x) => x.r);
}

// ── AI tiers ──────────────────────────────────────────────────────────────────
export function buildPrompt(msg, intent, lang, kb, examples) {
  const first = firstName(msg.name);
  const k = kb || {};
  const sys = [
    `You draft LinkedIn direct-message replies on behalf of ${k.sender || 'the account owner'}${k.company ? ' of ' + k.company : ''}.`,
    'Company knowledge (only state facts found here — never invent clients, numbers or prices):',
    k.pitch ? '- What we do: ' + k.pitch : '',
    k.proof ? '- Credibility: ' + k.proof : '',
    (lang === 'fr' && k.pitchFr) ? '- In French: ' + k.pitchFr + ' ' + (k.proofFr || '') : '',
    k.market ? '- Market we focus on: ' + k.market : '',
    k.cta ? '- Preferred next step: ' + k.cta : '',
    k.calendarLink ? '- Booking link (include when proposing a call): ' + k.calendarLink : '',
    k.notes ? '- Extra notes: ' + k.notes : '',
    'Tone: ' + (k.tone || 'warm, concise, professional'),
    'Rules: write in ' + (lang === 'fr' ? 'French (vouvoiement)' : 'English') + '; 40-110 words; plain text, no markdown, no subject line; address the person by first name; one clear next step; sign with the sender first name if known; no placeholders like [X].',
    examples.length ? 'Match the voice of these real past replies by the same sender:\n' + examples.map((e, i) => `(${i + 1}) ${e.text}`).join('\n') : '',
    'Return ONLY JSON: {"suggestions":[{"label":"2-4 word angle","text":"..."}]} with exactly 3 different angles.',
  ].filter(Boolean).join('\n');
  const user = [
    `Lead: ${msg.name || 'unknown'}${first ? ' (first name ' + first + ')' : ''}`,
    `Situation: ${INTENT_LABEL[intent] || intent}; conversation status ${msg.status || '?'}; last message sent by ${msg.lastSender === 'you' ? 'us (they have not answered)' : 'them'}.`,
    msg.lastSender === 'you'
      ? `Our last message to them: """${msg.snippet || ''}"""\nWrite a follow-up.`
      : `Their last message: """${msg.snippet || ''}"""\nWrite our reply.`,
  ].join('\n');
  return { system: sys, user };
}

export function parseAiJson(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const arr = (j.suggestions || []).filter((s) => s && typeof s.text === 'string' && s.text.trim().length > 10);
    return arr.length ? arr.slice(0, 4).map((s) => ({ label: String(s.label || 'Suggestion').slice(0, 40), text: s.text.trim() })) : null;
  } catch (e) { return null; }
}

export async function generateWithAnthropic(fetchFn, apiKey, model, prompt) {
  const models = [model, 'claude-sonnet-4-5', 'claude-haiku-4-5'].filter((v, i, a) => v && a.indexOf(v) === i);
  let lastErr = null;
  for (const mdl of models) {
    const res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: mdl, max_tokens: 1200, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] }),
    });
    if (!res.ok) { lastErr = 'anthropic ' + res.status; if (res.status === 404 || res.status === 400) continue; break; }
    const j = await res.json();
    const txt = (j.content || []).map((c) => c.text || '').join('');
    const parsed = parseAiJson(txt);
    if (parsed) return { suggestions: parsed, model: mdl };
    lastErr = 'unparseable';
  }
  throw new Error(lastErr || 'anthropic failed');
}

export async function generateWithWorkersAI(ai, prompt) {
  const r = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    max_tokens: 900,
  });
  const parsed = parseAiJson(r && (r.response || r.result || ''));
  if (!parsed) throw new Error('workers-ai unparseable');
  return { suggestions: parsed, model: 'llama-3.1-8b' };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
export async function suggest({ msg, kb, library, allMessages, env, fetchFn }) {
  const intent = detectIntent(msg);
  const lang = detectLanguage(msg);
  const first = firstName(msg.name);
  const pool = (library || []).concat(harvestSent(allMessages));
  const examples = rankPastReplies(msg, intent, lang, pool, 5);

  let suggestions = null, engine = 'templates', engineNote = '';
  const prompt = buildPrompt(msg, intent, lang, kb, examples);
  if (env && env.ANTHROPIC_API_KEY && fetchFn) {
    try {
      const r = await generateWithAnthropic(fetchFn, env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL, prompt);
      suggestions = r.suggestions.map((s) => Object.assign(s, { basis: 'ai' })); engine = 'claude';
    } catch (e) { engineNote = 'AI unavailable (' + e.message + ') — used templates.'; }
  }
  if (!suggestions && env && env.AI) {
    try {
      const r = await generateWithWorkersAI(env.AI, prompt);
      suggestions = r.suggestions.map((s) => Object.assign(s, { basis: 'ai' })); engine = 'workers-ai';
      engineNote = '';
    } catch (e) { engineNote = engineNote || ('AI unavailable (' + e.message + ') — used templates.'); }
  }
  if (!suggestions) suggestions = templateSuggestions(intent, lang, kb, first);

  // Always offer the closest REAL past reply, adapted to this lead, when it is a good match.
  // Library entries must match the situation; harvested "you sent last" messages are
  // follow-ups by nature, so they are only offered for a follow-up.
  const q = tokens(msg && msg.snippet);
  const best = examples.find((e) => (e.language || 'en') === lang && (
    e.intent ? e.intent === intent
      : (e.source === 'sent' ? intent === 'follow_up'
        : jaccard(q, tokens((e.context || '') + ' ' + e.text)) >= 0.12)));
  if (best) {
    const text = adaptReply(best.text, best.leadName, first);
    if (!suggestions.some((s) => s.text === text)) {
      suggestions.push({ label: best.source === 'sent' ? 'Your past message' : 'From your library', text, basis: 'past', pastId: best.id });
    }
  }

  return {
    intent, intentLabel: INTENT_LABEL[intent], language: lang, firstName: first,
    engine, engineNote,
    pastRepliesAvailable: pool.length,
    pastRepliesUsed: examples.length,
    kbConfigured: !!(kb && (kb.pitch || kb.company)),
    suggestions: suggestions.slice(0, 4),
  };
}
