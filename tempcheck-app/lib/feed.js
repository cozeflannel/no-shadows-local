/**
 * feed.js — where incoming alerts are read from. Today that is one place: the chat bot's Alert log tab, which holds
 * the fields the bot parsed out of each alert message in the Burson chat space (issue name, summary, post link,
 * engagement count). It is read, never written: the app has no way to change the sheet from here.
 *
 * The same tab holds the bot's Early Detection story cards (its `ingested` column says "Early detection"): one card
 * tells a story several posts are telling, and its row keeps the story's title, the bot's draft temp-check query for
 * it and the Chat thread the card was posted in. An alert that is a story card carries them as `story`.
 *
 * `control` reads the bot's Control tab (also read-only) for which Chat space is the bot's Auto-correct space, where
 * the story cards are posted, and which spaces are S-F Burson's (never to be posted in).
 *
 * This is the one file that knows about the bot's sheet. Another feed (the alert web app's own table, a dataset)
 * does not need it: it hands each alert to watch.incoming, or a second reader is added beside `newest` here.
 */
'use strict';

const { gfetch } = require('./gcp');

const SHEET = process.env.TEMPCHECK_ALERT_SHEET || '1dVGeQjLOfEYoCm_iIOmXd5hLM3rOTY_71IF-J8Hl2AI';  // the bot's Control workbook
const TAB = process.env.TEMPCHECK_ALERT_TAB || 'Alert log';
const CONTROL_TAB = 'Control';
const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const STORY_SOURCE = 'Early detection';
const THREAD_RX = /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+$/;
const MESSAGE_RX = /^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+$/;

function parse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

/** The story a card's row tells, or null when the row is not a story card: {title, narrative, query, posts, updateOf}. */
function storyOf(source, f) {
  const ed = f && f.early_detection;
  if (source !== STORY_SOURCE || !ed || typeof ed !== 'object') return null;
  return { title: String(ed.story_title || f.issue_name || '').replace(/\s+/g, ' ').trim(),
    narrative: String(ed.narrative || f.summary || '').replace(/\s+/g, ' ').trim(),
    query: String(ed.temp_check_query || '').trim(), posts: Array.isArray(ed.post_keys) ? ed.post_keys.length : 0,
    updateOf: String(ed.update_of || '').trim() };
}

/**
 * The tab's rows as alerts: [{id, at (ms), issue, eng, url, text, network, status, source, thread, message, story}],
 * oldest first. `header`: the row of column names; a row with no issue name (or no time) is left out. The fields come
 * from the bot's own parse of the chat message (forwarded_fields, else the email's input). `source` is the row's
 * `ingested` value ('' for an alert from the Burson chat); `thread` and `message` are the Chat thread and message the
 * alert stands in ('' when the row's value is not shaped like one); `threads` is every thread it stands in (where it
 * came from, where the bot put its corrected copy, its live one); `story` is storyOf's, for a story card. Pure.
 */
function alertsFromRows(header, rows) {
  const col = name => (header || []).indexOf(name);
  const out = [];
  (rows || []).forEach(r => {
    const f = parse(r[col('forwarded_fields')]) || ((parse(r[col('email_input')]) || {}).fields) || null;
    if (!f) return;
    const source = String(r[col('ingested')] || '').trim();
    const story = storyOf(source, f);
    const issue = String(f.issue_name || (story && story.title) || '').trim();
    if (!issue) return;
    const at = Number(r[col('source_at')]) || Date.parse(r[col('source_at')] || r[col('created_at')] || '') || 0;
    const id = String(r[col('alert_id')] || '').trim();
    if (!at || !id) return;
    const thread = String(r[col('source_thread')] || '').trim();
    const message = String(r[col('source_message')] || '').trim();
    const threads = Array.from(new Set(['source_thread', 'forward_thread', 'live_thread'].map(c => String(r[col(c)] || '').trim()).filter(t => THREAD_RX.test(t))));
    out.push({ id, at, issue, eng: Number(f.total_engagement) || 0, url: String(f.post_url || ''),
      text: String(f.summary || f.post_content || ''), network: String(f.social_network || ''), status: String(f.issue_status || ''),
      source, thread: THREAD_RX.test(thread) ? thread : '', message: MESSAGE_RX.test(message) ? message : '', threads, story });
  });
  return out.sort((a, b) => a.at - b.at);
}

/** The newest `n` alerts of the tab (its last rows with anything in them), oldest first. Two reads; nothing is written. */
async function newest(n) {
  const want = Math.max(1, Math.min(1000, Number(n) || 80));
  const tab = `'${TAB.replace(/'/g, '\'\'')}'`;
  const head = await gfetch(`${BASE}/${encodeURIComponent(SHEET)}/values:batchGet?ranges=${encodeURIComponent(`${tab}!A1:AP3`)}&ranges=${encodeURIComponent(`${tab}!A:A`)}`);
  const top = ((head.valueRanges || [])[0] || {}).values || [];
  const header = top.find(r => r.filter(Boolean).length > 8) || [];
  if (header.indexOf('alert_id') < 0) throw new Error(`the "${TAB}" tab has no alert_id column where it was looked for`);
  const last = (((head.valueRanges || [])[1] || {}).values || []).length;  // column A has a value on every alert's row
  const from = Math.max(top.indexOf(header) + 2, last - want + 1);
  if (last < from) return [];
  const body = await gfetch(`${BASE}/${encodeURIComponent(SHEET)}/values/${encodeURIComponent(`${tab}!A${from}:AP${last}`)}`);
  return alertsFromRows(header, body.values || []);
}

/**
 * A Chat space written as a link, "spaces/X" or a bare id -> "spaces/X"; '' for anything else (a space's name can't be
 * told apart from another's here, so it is not taken). The same forms the bot takes on its Control tab. Pure.
 */
function spaceId(value) {
  const v = String(value === undefined || value === null ? '' : value).trim();
  let m = v.match(/(?:^|\/)spaces\/([A-Za-z0-9_-]+)/);
  if (m) return `spaces/${m[1]}`;
  m = v.match(/^https?:\/\/\S*?(?:\/space\/|\/room\/|\/chat\/|#chat\/space\/)([A-Za-z0-9_-]{6,})/i);
  if (m) return `spaces/${m[1]}`;
  return /^[A-Za-z0-9_-]{11}$/.test(v) ? `spaces/${v}` : '';
}

/**
 * What the Control tab's rows (label, value, the bot's note) say about the Chat spaces: {autocorrect ("spaces/X", or
 * ''), checked (the bot's note beside it starts with its tick: the bot opened that space and it passed the bot's own
 * checks), never (the spaces that are S-F Burson's side: the S-F Burson space, its test copy, the Burson source
 * space)}. The rows are found by their labels, not their numbers. Pure.
 */
function controlFromRows(rows) {
  const cell = label => {
    const r = (rows || []).find(x => String((x && x[0]) || '').trim().toLowerCase() === label) || [];
    return { value: String(r[1] || '').trim(), note: String(r[2] || '').trim() };
  };
  const ac = cell('auto-correct space');
  return { autocorrect: spaceId(ac.value), checked: ac.note.indexOf('\u2713') === 0,
    never: ['s-f burson space', 'burson test copy', 'burson space'].map(l => spaceId(cell(l).value)).filter(Boolean) };
}

/** controlFromRows of the bot's Control tab as it is now. One read; nothing is written. */
async function control() {
  const body = await gfetch(`${BASE}/${encodeURIComponent(SHEET)}/values/${encodeURIComponent(`'${CONTROL_TAB}'!A1:C80`)}`);
  return controlFromRows(body.values || []);
}

function describe() { return { what: `The chat bot's "${TAB}" tab (read only)`, tab: TAB }; }

module.exports = { newest, alertsFromRows, storyOf, spaceId, controlFromRows, control, describe, STORY_SOURCE };
