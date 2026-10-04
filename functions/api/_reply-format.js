// functions/api/_reply-format.js  (2026-10-04)
// Olivier's rule for Suggested replies: ALWAYS based on the conversation —
//   ONE sentence tied to the previous exchange, then the CTA:
//   "Let's discuss this further. My calendar is at <calendar link>"
// The calendar link comes from the tenant's settings (kb.calendarLink).
// Sentence tiers: Workers AI (70B, 8B fallback) → Anthropic only if a key is ever set →
// built-in one-liners per intent/language. The CTA is appended by code, never by the AI,
// so it is always exactly the same.

import { detectIntent, detectLanguage, firstName, INTENT_LABEL } from './_suggest-engine.js';

const CTA = {
  en: "Let's discuss this further. My calendar is at ",
  fr: 'Échangeons-en plus en détail. Mon agenda est ici : ',
};
const NO_LINK = {
  en: '[add your calendar link in Settings]',
  fr: '[ajoutez votre lien d’agenda dans les Réglages]',
};
const HELLO = { en: (f) => (f ? `Hi ${f},` : 'Hi,'), fr: (f) => (f ? `Bonjour ${f},` : 'Bonjour,') };

// Fallback one-liners (no AI available). {m} = market.
const LINES = {
  en: {
    follow_up: ['Following up on my previous message about {m}.', 'I wanted to come back to my note about your plans for {m}.', 'Circling back on my last message in case it got buried.'],
    ooo: ['Thanks for letting me know you are away — no rush at all.', 'Noted that you are out of the office, I will keep this short.', 'Hope you are enjoying the time away.'],
    decline: ['Thanks for the honest answer, I appreciate it.', 'Understood, and thanks for taking the time to reply.', 'Fair enough — thank you for letting me know.'],
    defer: ['Thanks, the timing makes sense and I am happy to pick this up when it suits you.', 'Understood that now is not the right moment.', 'Thanks for the heads-up on timing.'],
    referral: ['Thank you for pointing me to the right person.', 'Much appreciated that you thought of a colleague for this.', 'Thanks for the referral, that is very helpful.'],
    meeting: ['Great to hear you are open to a conversation.', 'Happy to find a time that works for you.', 'Thanks — a quick conversation is the best next step.'],
    info: ['Good question — the short answer depends on your goals for {m}.', 'Happy to share more detail on how this would work for you.', 'Thanks for asking — easier to answer properly in a quick conversation.'],
    positive: ['Glad this resonates with you.', 'Great to hear there is interest on your side.', 'Thanks for the positive reply.'],
    thanks: ['You are very welcome.', 'My pleasure, and thanks for getting back to me.', 'Thank you for the kind reply.'],
    generic: ['Thanks for your reply.', 'Thanks for getting back to me.', 'Appreciate you taking the time to respond.'],
  },
  fr: {
    follow_up: ['Je reviens vers vous suite à mon précédent message sur {m}.', 'Je me permets de relancer mon dernier message sur vos projets pour {m}.', 'Je reviens vers vous au cas où mon message serait passé inaperçu.'],
    ooo: ['Merci de m’avoir prévenu de votre absence, rien ne presse.', 'Bien noté que vous êtes absent, je serai bref.', 'Profitez bien de votre absence.'],
    decline: ['Merci pour votre réponse franche, je l’apprécie.', 'Bien compris, et merci d’avoir pris le temps de répondre.', 'Entendu, merci de me l’avoir indiqué.'],
    defer: ['Merci, je comprends tout à fait le timing.', 'Bien compris que ce n’est pas le bon moment.', 'Merci pour la précision sur le calendrier.'],
    referral: ['Merci de m’orienter vers la bonne personne.', 'Merci d’avoir pensé à un collègue.', 'Merci pour la mise en relation, c’est très utile.'],
    meeting: ['Ravi de voir que vous êtes ouvert à un échange.', 'Avec plaisir pour trouver un créneau qui vous convient.', 'Merci, un court échange est la meilleure prochaine étape.'],
    info: ['Bonne question, la réponse dépend de vos objectifs pour {m}.', 'Avec plaisir pour vous en dire plus.', 'Merci pour votre question, plus simple d’y répondre de vive voix.'],
    positive: ['Ravi que cela vous parle.', 'Content de voir de l’intérêt de votre côté.', 'Merci pour votre retour positif.'],
    thanks: ['Avec plaisir.', 'Merci à vous pour votre retour.', 'Merci pour votre aimable réponse.'],
    generic: ['Merci pour votre réponse.', 'Merci de votre retour.', 'Merci d’avoir pris le temps de répondre.'],
  },
};

function oneSentence(s) {
  let t = String(s || '').replace(/https?:\/\/\S+/g, '').replace(/^["'“”\s-]+|["'“”\s]+$/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(hi|hello|dear|bonjour)\b[^,]*,\s*/i, '');            // no greeting — added by code
  const m = t.match(/^.*?[.!?](\s|$)/);                                   // first sentence only
  if (m) t = m[0].trim();
  if (t && !/[.!?]$/.test(t)) t += '.';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function buildPrompt(msg, lang, kb) {
  const weLast = msg.lastSender === 'you';
  const system = [
    `You write ONE sentence of a LinkedIn reply on behalf of ${kb.sender || 'the sender'} at ${kb.company || 'our company'}.`,
    kb.pitch ? `What we do: ${lang === 'fr' && kb.pitchFr ? kb.pitchFr : kb.pitch}` : '',
    `Language: ${lang === 'fr' ? 'French' : 'English'}. Tone: ${kb.tone || 'warm, concise, professional'}.`,
    weLast
      ? 'We wrote last and got no answer: the sentence must refer back specifically to what OUR last message said (a gentle follow-up).'
      : 'The sentence must respond specifically to what THEIR last message said (acknowledge or answer its actual content).',
    'Rules: exactly one sentence, at most 30 words; no greeting, no sign-off, no question, no link, no call to action, no meeting request — a fixed call to action is added after your sentence.',
    'Return ONLY JSON: {"sentences":["...","...","..."]} with 3 different options.',
  ].filter(Boolean).join('\n');
  const user = (weLast ? 'Our last message:\n"""\n' : 'Their last message:\n"""\n') + String(msg.snippet || '').slice(0, 1500) + '\n"""';
  return { system, user };
}

function parseSentences(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const arr = (JSON.parse(m[0]).sentences || []).map(oneSentence).filter((s) => s.length > 8);
    return arr.length ? arr.slice(0, 3) : null;
  } catch (e) { return null; }
}

async function aiSentences(msg, lang, kb, env, fetchFn) {
  const p = buildPrompt(msg, lang, kb);
  if (env.AI) {
    for (const model of ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct']) {
      try {
        const r = await env.AI.run(model, { messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }], max_tokens: 300 });
        const out = parseSentences(r && (typeof r.response === 'string' ? r.response : JSON.stringify(r.response || r.result || '')));
        if (out) return { sentences: out, engine: 'workers-ai' };
      } catch (e) { /* next */ }
    }
  }
  if (env.ANTHROPIC_API_KEY && fetchFn) {
    try {
      const res = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 300, system: p.system, messages: [{ role: 'user', content: p.user }] }),
      });
      if (res.ok) {
        const j = await res.json();
        const out = parseSentences((j.content || []).map((c) => c.text || '').join(''));
        if (out) return { sentences: out, engine: 'claude' };
      }
    } catch (e) { /* templates */ }
  }
  return null;
}

export function assemble(sentence, first, lang, link) {
  const l = lang === 'fr' ? 'fr' : 'en';
  return `${HELLO[l](first)}\n\n${sentence} ${CTA[l]}${link || NO_LINK[l]}`;
}

export async function suggestFormatted({ msg, kb, env, fetchFn }) {
  const intent = detectIntent(msg);
  const lang = detectLanguage(msg);
  const first = firstName(msg.name);
  const link = String((kb && kb.calendarLink) || '').trim();
  let engine = 'templates';
  let sentences = null;
  const ai = await aiSentences(msg, lang, kb || {}, env || {}, fetchFn);
  if (ai) { sentences = ai.sentences; engine = ai.engine; }
  if (!sentences) {
    const m = lang === 'fr' ? (kb && kb.marketFr) || 'le marché américain' : (kb && kb.market) || 'the US market';
    sentences = (LINES[lang][intent] || LINES[lang].generic).map((s) => s.replace('{m}', m));
  }
  const labels = lang === 'fr' ? ['Option 1', 'Option 2', 'Option 3'] : ['Option 1', 'Option 2', 'Option 3'];
  return {
    intent, intentLabel: INTENT_LABEL[intent], language: lang, firstName: first,
    engine,
    engineNote: link ? '' : 'Add your calendar link in Settings so it appears in every reply.',
    calendarLinkSet: !!link,
    pastRepliesAvailable: 0, pastRepliesUsed: 0,
    kbConfigured: !!(kb && (kb.pitch || kb.company)),
    suggestions: sentences.map((s, i) => ({ label: labels[i] || 'Option', text: assemble(s, first, lang, link), basis: engine === 'templates' ? 'template' : 'ai' })),
  };
}
