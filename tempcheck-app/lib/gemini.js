/**
 * gemini.js — the things a model is asked to do, on Vertex AI under the runner's own Google login:
 *
 *   writeLines   the write-up's Summary, Negativity Drivers and Themes, from the numbers and the posts read
 *   suggestQuery a broad first-draft Boolean query for an issue that has no Brandwatch query yet: a suggestion the
 *                analyst sees and can change before anything runs
 *   tightQuery   a query for an alert that nobody will see before it is counted with (a temp check asked for in
 *                Chat): it has to catch the issue and nothing else
 *   aboutIssue   reads posts a query found and says which are about the issue: the check on a query nobody saw
 *   narrowQuery  the tight query again, told what it wrongly caught
 *
 * The model never touches the numbers and never converts a query to SQL (bwquery.js does that by fixed rules). It
 * names lists of words; the query is put together from them here, by fixed rules.
 */
'use strict';

const { PROJECT, gfetch } = require('./gcp');
const tc = require('./tempcheck');

const MODEL = process.env.TEMPCHECK_GEMINI_MODEL || 'gemini-3.8-flash';  // the model the chat bot uses
const LOCATION = process.env.TEMPCHECK_GEMINI_LOCATION || 'global';

function url() {
  const host = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
}

/** A generateContent answer -> the JSON object the model returned (thought parts skipped). Throws when there is none. */
function parseJson(body) {
  const cand = ((body && body.candidates) || [])[0];
  if (!cand) {
    const blocked = body && body.promptFeedback && body.promptFeedback.blockReason;
    throw new Error('Gemini returned no answer' + (blocked ? ` (blocked: ${blocked})` : ''));
  }
  if (/MAX_TOKENS$/.test(String(cand.finishReason || ''))) throw new Error('Gemini\'s answer was cut off');
  const text = ((cand.content && cand.content.parts) || []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('').trim();
  if (!text) throw new Error(`Gemini returned no text (${cand.finishReason || 'no reason given'})`);
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch (e) {
    throw new Error('Gemini returned something that is not JSON');
  }
}

/** The request for one call. `quick`: without the model's long thinking (for sorting a list, where it adds half a minute and changes nothing). Pure. */
function requestBody(system, prompt, schema, quick) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: Object.assign({ temperature: 0.1, responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 8192 },
      quick ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  };
}

/**
 * One call that must return JSON matching `schema`. Tried twice when Vertex is busy (429 or 5xx). `o.quick`: asked
 * without the model's long thinking; a model that refuses that setting (a 400) is asked again in the ordinary way.
 */
async function generateJson(system, prompt, schema, o) {
  let quick = !!(o && o.quick);
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return parseJson(await gfetch(url(), { method: 'POST', body: requestBody(system, prompt, schema, quick), timeoutMs: 90000 }));
    } catch (e) {
      last = e;
      if (quick && e && e.status === 400) { quick = false; attempt--; continue; }
      if (!(e && (e.status === 429 || Number(e.status) >= 500))) break;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw last;
}

/**
 * The write-up's qualitative lines for temp check `d` from `posts` (with their words): {summary, drivers, themes}, or
 * {why} when there is nothing to read or Gemini fails (the write-up then keeps the template's placeholders). Never throws.
 */
async function writeLines(d, posts) {
  if (!posts || !posts.length) return { why: 'no posts with words to read' };
  try {
    const out = (await generateJson(tc.SYSTEM, tc.prompt(d, posts), tc.SCHEMA)) || {};
    const clean = v => tc.truncate(String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim(), 900);
    const g = { summary: clean(out.summary), drivers: clean(out.negativity_drivers), themes: clean(out.themes) };
    return g.summary || g.drivers || g.themes ? g : { why: 'Gemini gave no answer' };
  } catch (e) {
    return { why: `Gemini: ${tc.truncate(String((e && e.message) || e), 160)}` };
  }
}

const SUGGEST_SYSTEM = 'You help Google\'s Brand Safety social listening team gather posts about an emerging issue. An alert ' +
  'has just fired and nobody has written a search query yet. What you return is used to gather every post that could ' +
  'be part of the conversation; an analyst narrows it afterwards. So it must be broad: missing posts is the failure, ' +
  'catching extra ones is fine. Return two lists.\n' +
  'subject: what the issue is about (the product, company, person or event) as its names, spellings, handles and ' +
  'hashtags, joined with OR. Example: "Google Maps" OR GoogleMaps OR #GoogleMaps OR gmaps OR "G Maps".\n' +
  'angle: the words people would use about what happened, joined with OR: 15 to 30 single words, each cut to its ' +
  'stem with a * where it has endings (trust*, distrust*, lie*, wrong*, scam*, mislead*, fake*), covering synonyms, ' +
  'slang and both sides of the argument. Single words only, no phrases: a phrase misses every other way of saying it.\n' +
  'Use only words, "quoted names" (in subject only), OR, and the * wildcard. No AND, NOT, NEAR, brackets, field ' +
  'operators or line breaks in either list.';
const SUGGEST_SCHEMA = { type: 'OBJECT', properties: { subject: { type: 'STRING' }, angle: { type: 'STRING' }, why: { type: 'STRING' } },
  required: ['subject', 'angle'] };

/**
 * A list Gemini returned ("a OR b OR \"c d\"") as clean terms: split at any operator, brackets dropped, several words
 * kept as one quoted phrase, each term once (in any case), 40 at most. Pure.
 */
function terms(list) {
  const seen = new Set();
  return String(list || '').replace(/[()\[\]{}]/g, ' ').split(/\s+(?:OR|AND|NOT|NEAR\/\d+f?)\s+|\n|,/)
    .map(t => t.replace(/(?:^|\s)(?:OR|AND|NOT|NEAR\/\d+f?)(?=\s|$)/g, ' ').replace(/"/g, '').replace(/\s+/g, ' ').trim().replace(/:+$/, ''))
    .map(t => (/\s/.test(t) ? `"${t}"` : t))
    .filter(t => { const k = t.toLowerCase(); if (!t || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
}

/**
 * Gemini's two lists as queries, put together by fixed rules: {subject, angle, boolean ("(subject) AND (angle)": about
 * it, and using any of the words), wide ("(subject)" alone: everything about it), why}. Throws when there is no
 * subject. Pure.
 */
function draftFrom(out) {
  const subject = terms(out && out.subject);
  const angle = terms(out && out.angle);
  if (!subject.length) throw new Error('Gemini named nothing to search for');
  const wide = `(${subject.join(' OR ')})`;
  return { subject: subject.join(' OR '), angle: angle.join(' OR '), boolean: angle.length ? `${wide} AND (${angle.join(' OR ')})` : wide, wide,
    why: tc.truncate(String((out && out.why) || '').replace(/\s+/g, ' ').trim(), 300) };
}

/**
 * A broad draft query for an issue described by `text` (its name and, when there is one, the alert post): {subject,
 * angle, boolean, wide, why} (draftFrom). The model only names the two lists; the query is assembled here. Throws.
 */
async function suggestQuery(text) {
  const src = tc.truncate(String(text || '').replace(/\s+/g, ' ').trim(), 3000);
  if (!src) throw new Error('there is nothing to draft a query from');
  return draftFrom(await generateJson(SUGGEST_SYSTEM, `The issue:\n${src}\n\nReturn JSON: subject, angle, and why (one sentence on what the two lists catch).`, SUGGEST_SCHEMA));
}

// ---------------------------------------------------------------------------------------------------------------
// A query nobody sees before it is counted with: tight, checked against what it finds, narrowed once when it must be
// ---------------------------------------------------------------------------------------------------------------

const BRAND_ALONE = /^[@#]?(?:google|alphabet)$/i;  // the company on its own: every mention there is

const TIGHT_SYSTEM = 'You help Google\'s Brand Safety social listening team count the posts about one issue. An alert has ' +
  'just fired: one post an analyst flagged. The issue is the conversation that post belongs to, the one the issue name ' +
  'names: everyone posting about the same event, claim or complaint. Nobody has written a search query for it yet. ' +
  'Your three lists are put together into the query that is counted with, and the count is given to analysts as it ' +
  'stands. So the query must catch that conversation and nothing else. Two failures to avoid: a query that also ' +
  'catches other talk about the same product (the count is too high), and a query written for the one post instead ' +
  'of the conversation (the count is far too low). Never list the account that posted, the outlet that published, a ' +
  'headline, a link or a video id, unless the issue is about them.\n' +
  'subject: who or what the issue is about, as its names, spellings, handles and hashtags, joined with OR. When it is ' +
  'about a product, a feature or a person, name that and not the company: "Google Calendar" OR GoogleCalendar OR ' +
  'gcal. When it is about the company itself (a lawsuit, its stock, a policy, its staff), name the company: Google OR ' +
  'Alphabet. Do not add a product the alert does not name.\n' +
  'specifics: 2 to 8 names, figures or short phrases that a post in this conversation would almost surely contain and ' +
  'that other talk about the subject would not, joined with OR: the other person or company involved, the thing it ' +
  'happened to, the event, the sum ("425 million" OR 425M). For a scam that uses calendar invites: invite* OR ' +
  'invitation*. For a row over a creator: "Russell Brand". No everyday words (phone, people, new, ad, video), and ' +
  'nothing the subject already says. Leave it empty when the issue is a general complaint about the subject with ' +
  'nothing of the kind to name.\n' +
  'angle: 8 to 20 single words people use about what happened, joined with OR, each cut to its stem with a * where ' +
  'it has endings (scam*, phish*, ban*, censor*), with synonyms and both sides of the argument. Single words only.\n' +
  'A post is counted only when it matches all three lists.\n' +
  'Use only words, "quoted names or phrases" (not in angle), OR and the * wildcard. No AND, NOT, NEAR, brackets, ' +
  'commas, field operators or line breaks in any list.';
const TIGHT_SCHEMA = { type: 'OBJECT', properties: { subject: { type: 'STRING' }, specifics: { type: 'STRING' }, angle: { type: 'STRING' }, why: { type: 'STRING' } },
  required: ['subject', 'specifics', 'angle'] };

/**
 * Gemini's three lists as the query to count with, put together by fixed rules: {subject, specifics, angle, boolean
 * ("(subject) AND (specifics) AND (angle)", a list that is empty left out), wide (the same without the angle, for
 * when the first matches nothing; '' when there is nothing to drop), why}. The company's name alone is taken out of
 * the subject when anything more specific is there. Throws when there is no subject, or nothing but a subject (that
 * would count everything said about it). Pure.
 */
function tightFrom(out) {
  const list = v => terms(String(v || '').replace(/(\d),(?=\d{3})/g, '$1')).filter(t => !/^\W*(?:\d{1,3}|\w)\W*$/.test(t));  // "425,000" is one figure; "000" or "a" says nothing
  let subject = list(out && out.subject);
  const specifics = list(out && out.specifics);
  const angle = list(out && out.angle);
  if (subject.some(t => !BRAND_ALONE.test(t.replace(/"/g, '')))) subject = subject.filter(t => !BRAND_ALONE.test(t.replace(/"/g, '')));
  if (!subject.length) throw new Error('Gemini named nothing to search for');
  if (!specifics.length && !angle.length) throw new Error('Gemini named a subject and nothing about the issue: that would count everything said about the subject');
  const part = l => `(${l.join(' OR ')})`;
  return { subject: subject.join(' OR '), specifics: specifics.join(' OR '), angle: angle.join(' OR '),
    boolean: [subject, specifics, angle].filter(l => l.length).map(part).join(' AND '),
    wide: specifics.length && angle.length ? `${part(subject)} AND ${part(specifics)}` : '',
    why: tc.truncate(String((out && out.why) || '').replace(/\s+/g, ' ').trim(), 300) };
}

function issueText(text) {
  const src = tc.truncate(String(text || '').replace(/\s+/g, ' ').trim(), 3000);
  if (!src) throw new Error('there is nothing to draft a query from');
  return src;
}

/**
 * A tight query for the issue described by `text` (an alert's issue name on its first line, then the alert's words
 * and link): tightFrom's. Throws.
 */
async function tightQuery(text, o) {
  return tightFrom(await generateJson(TIGHT_SYSTEM, `The issue name, then the alert:\n${issueText(text)}\n\nReturn JSON: subject, specifics, angle, and why (one sentence on what the query catches).`, TIGHT_SCHEMA, o));
}

const ABOUT_SYSTEM = 'You check a search query for Google\'s Brand Safety social listening team. You are given an issue (its ' +
  'name, then the alert: the one post that set it off) and a numbered list of posts the query found. The issue is the ' +
  'conversation the alert belongs to: everyone posting about the same event, claim or complaint. Sort the posts. ' +
  'about: the posts that take part in that conversation, whether or not they mention the alert\'s own post, author ' +
  'or article: news of it, reactions to it, the same complaint made by someone else, jokes about it. other: the posts ' +
  'about something else, even when they mention the same product, company or person: promotions, how-tos, other ' +
  'news, other complaints. A post too short or unclear to tell goes in neither list. Also say in a few words what ' +
  'the other posts are mostly about (empty when there are none).';
const ABOUT_SCHEMA = { type: 'OBJECT', properties: { about: { type: 'ARRAY', items: { type: 'INTEGER' } }, other: { type: 'ARRAY', items: { type: 'INTEGER' } },
  others_are_about: { type: 'STRING' } }, required: ['about', 'other'] };

/**
 * Gemini's sorting of `n` numbered posts, counted: {read (the posts it could tell), about, share (about / read; 0
 * when it could tell none), off (the other posts, as 0-based places in the list), others (what they are mostly
 * about)}. A number named in both lists, or not on the list at all, counts for nothing. Pure.
 */
function aboutFrom(out, n) {
  const pick = list => new Set((Array.isArray(list) ? list : []).map(Number).filter(i => Number.isInteger(i) && i >= 1 && i <= n));
  const yes = pick(out && out.about);
  const no = pick(out && out.other);
  Array.from(yes).forEach(i => { if (no.has(i)) { yes.delete(i); no.delete(i); } });
  const read = yes.size + no.size;
  return { read, about: yes.size, share: read ? yes.size / read : 0, off: Array.from(no).sort((a, b) => a - b).map(i => i - 1),
    others: tc.truncate(String((out && out.others_are_about) || '').replace(/\s+/g, ' ').trim(), 160) };
}

const numbered = posts => posts.map((p, i) => `${i + 1}. ${tc.truncate(String((p && p.text) || '').replace(/\s+/g, ' ').trim(), 400)}`).join('\n');

/**
 * Which of `posts` ([{text}], 60 at most) are about the issue described by `text`: aboutFrom's, or {read: 0, why}
 * when there is nothing to read or Gemini fails. Never throws.
 */
async function aboutIssue(text, posts) {
  const list = (posts || []).filter(p => p && String(p.text || '').trim()).slice(0, 60);
  if (!list.length) return { read: 0, about: 0, share: 0, off: [], others: '', why: 'no posts with words to read' };
  try {
    return aboutFrom(await generateJson(ABOUT_SYSTEM, `The issue name, then the alert:\n${issueText(text)}\n\nThe posts the query found:\n${numbered(list)}\n\nReturn JSON: about, other, others_are_about.`, ABOUT_SCHEMA, { quick: true }), list.length);
  } catch (e) {
    return { read: 0, about: 0, share: 0, off: [], others: '', why: `Gemini: ${tc.truncate(String((e && e.message) || e), 160)}` };
  }
}

/**
 * The tight query again, told what it wrongly caught: `draft` (tightFrom's), `check` (aboutIssue's), `offPosts` (some
 * of the posts that were not about the issue). tightFrom's. Throws.
 */
async function narrowQuery(text, draft, check, offPosts) {
  const dr = draft || {};
  const some = (offPosts || []).filter(p => p && p.text).slice(0, 8);
  const prompt = `The issue name, then the alert:\n${issueText(text)}\n\nThe query tried:\nsubject: ${dr.subject || ''}\nspecifics: ${dr.specifics || ''}\nangle: ${dr.angle || ''}\n\n` +
    `It also caught posts that are not about the issue${check && check.read ? ` (${check.read - check.about} of the ${check.read} read)` : ''}` +
    `${check && check.others ? `, mostly about: ${check.others}` : ''}.${some.length ? ` Some of them:\n${numbered(some)}` : ''}\n\n` +
    'Return the three lists again, changed so that posts like those are left out and posts about the issue are still caught. ' +
    'Return JSON: subject, specifics, angle, and why (one sentence on what was changed).';
  return tightFrom(await generateJson(TIGHT_SYSTEM, prompt, TIGHT_SCHEMA));
}

module.exports = { MODEL, LOCATION, writeLines, suggestQuery, draftFrom, parseJson, requestBody, tightQuery, tightFrom, aboutIssue, aboutFrom, narrowQuery };
