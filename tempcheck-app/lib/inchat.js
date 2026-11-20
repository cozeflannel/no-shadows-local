/**
 * inchat.js — temp checks in Google Chat, as the person running the app. Two things, each OFF until it is switched on
 * in the page, and neither ever acting on what was already there when it was switched on:
 *
 *   story cards   for each Early Detection story card the bot posts: a temp check from the card's own draft query, kept
 *                 as a Google Doc (docs.js), and the Doc's link posted as a reply in the card's thread;
 *   on request    "temp check" typed in the same space by the person running the app is answered in its thread: in a
 *                 story card's thread with that card's query; in an alert's thread with a query drafted from the
 *                 alert; again in either, an update of the last one; anywhere, with a Brandwatch query's name or
 *                 link, or a Boolean, after the words.
 *
 * Where it posts: only as a reply in an existing thread of the bot's Auto-correct space, as the bot's Control tab names
 * it (chat.mayReply), never in a space the Control tab gives to S-F Burson, at most MAX_PER_DAY replies a day, and never
 * twice for the same card or request (the reply's id is made from what it answers, so Chat refuses a second copy even
 * if this app's own record were lost).
 *
 * In an ordinary alert's thread nobody has written a query, so one is drafted from the alert (gemini.tightQuery) and
 * counted with, and then it is checked: Gemini reads posts the query found and says which are about the issue. A
 * query that caught other posts too is narrowed once and the better of the two is used. The reply names the query and
 * says how many of the posts read were about the issue; when most were not, no count is given at all, only the
 * query that was tried.
 *
 * The page can also do one card by hand: `prepare` makes its temp check and Doc and shows the reply's words, `post`
 * posts them. Everything it did, and why it did not, is kept in data/inchat.json and shown in the page.
 *
 * `make(d)` builds it on the parts it is given (the feed, the temp check, Docs, Chat, the store, the clock), so the
 * tests run the whole flow on stand-ins; the module itself is `make` on the real ones.
 */
'use strict';

const tc = require('./tempcheck');

const FILE = 'inchat.json';
const HEAD = '\uD83C\uDF21\uFE0F *Temp check';
const MAX_PER_DAY = 30;
const LOG_MAX = 200;
const JOBS_MAX = 400;
const FRESH_MS = 7 * 24 * tc.HOUR;   // an alert older than this no longer sets where a request's count starts
const OVERLAP_MS = 2 * 60 * 1000;    // each look at the space reaches this far back before the last message seen
const CHECK_POSTS = 40;              // how many of the posts a drafted query found are read to check it
const GOOD = 0.8;                    // this share of them about the issue: the query is taken as it is
const POOR = 0.5;                    // under this share: the query did not single the issue out, and no count is given

// ---------------------------------------------------------------------------------------------------------------
// The words of a reply (pure). Every one starts as the bot's own temp check posts do, so the bot knows it is no question.
// ---------------------------------------------------------------------------------------------------------------

/** A query as Chat shows it letter for letter (its * and quotes left as they are). */
function code(query) {
  const q = tc.truncate(String(query || '').replace(/`/g, '\'').replace(/\s+/g, ' ').trim(), 700);
  return '`' + q + '`';
}

/** Gemini's few words on what the off-topic posts were about, made safe to put in a Chat message. */
function othersNote(c) {
  const t = String((c && c.others) || '').replace(/[*_~`<>|\s]+/g, ' ').trim();
  return t ? ` (the others: ${tc.truncate(t, 120)})` : '';
}

/** What the check of a drafted query found, in a sentence. `c`: {read, about, share, others}; null when it could not be made. Pure. */
function checkLine(c) {
  if (!c || !c.read) return 'It could not be checked against the posts it found.';
  const n = `${tc.num(c.about)} of the ${tc.num(c.read)} posts read are about this issue`;
  return c.share >= GOOD ? `${n}.` : `Only ${n}${othersNote(c)}, so the count runs high.`;
}

/**
 * The posts of temp check `rec` that the check of a drafted query reads ([{text}], CHECK_POSTS at most): the ones read
 * for the write-up (the most engaged), then an even spread of what our own tables found, each post once. Pure.
 */
function sample(rec) {
  const seen = new Set();
  const out = [];
  const add = p => {
    const text = String((p && p.text) || '').replace(/\s+/g, ' ').trim();
    const key = String((p && (p.key || p.url)) || text.slice(0, 80));
    if (!text || seen.has(key) || out.length >= CHECK_POSTS) return;
    seen.add(key);
    out.push({ text });
  };
  ((rec && rec.readPosts) || []).forEach(add);
  const ours = ((rec && rec.own && rec.own.posts) || []).filter(p => p && p.text);
  const every = Math.max(1, Math.floor(ours.length / 15));
  for (let i = 0; i < ours.length; i += every) add(ours[i]);
  return out;
}

/** The reply that carries a finished temp check: its Doc's link, what was counted, Gemini's summary, what it is. */
function replyText(o) {
  const rec = o.rec;
  const n = Number(rec.total) || 0;
  const since = tc.when(rec.window.from, rec.at);
  const many = (k, one, more) => `${tc.num(k)} ${Number(k) === 1 ? one : more}`;
  let counted;
  if (rec.basis === 'own') counted = `${many(n, 'matching post', 'matching posts')} in our own tables since ${since} (posts, not Brandwatch mentions)`;
  else if (rec.query) counted = `${many(n, 'mention', 'mentions')} in Brandwatch since ${since} (${rec.query.name})`;
  else counted = `${many(n, 'mention', 'mentions')} in Brandwatch since ${since}, counted in its standing Google queries`;
  const ours = rec.basis !== 'own' && rec.own && !rec.own.error ? `; ${many(rec.own.total, 'post', 'posts')} in our own tables` : '';
  const summary = rec.gem && rec.gem.summary ? tc.richText(rec.gem.summary, rec.readPosts || []).text.replace(/\s+/g, ' ').trim() : '';
  const level = rec.level && rec.level.label ? `Volume is currently ${rec.level.label}. ` : rec.query ? '' : 'No concern level until the issue has a Brandwatch query of its own. ';
  const drafted = o.drafted ? `Query drafted from the alert: ${code(o.drafted.query)} ${checkLine(o.drafted.check)}` : '';
  return [`${HEAD} draft${o.update ? ' (update)' : ''}:* <${o.docUrl}|open the Google Doc>`, `${counted}${ours}.`, drafted, summary ? tc.truncate(summary, 500) : '',
    `${level}A first look made automatically: check it before it is used.`].filter(Boolean).join('\n');
}

function needsQueryText() {
  return `${HEAD}:* this thread has no recent alert to draft a query from. Send \`temp check\` followed by a Brandwatch query's name or link, or by a Boolean ` +
    '(words joined by AND / OR, phrases in quotes).';
}

/** A drafted query that mostly caught other posts: no count, the query that was tried, and what to send instead. */
function offTopicText(query, c) {
  return `${HEAD}:* no count for this one. The query drafted from the alert mostly caught other posts: only ${tc.num(c.about)} of the ${tc.num(c.read)} read were about the issue${othersNote(c)}. ` +
    `The query tried: ${code(query)} Send \`temp check\` followed by a Boolean of your own, or by a Brandwatch query's name or link.`;
}

function noMatchText(ref, needs) {
  const names = ((needs && needs.choices) || []).concat((needs && needs.near) || []).map(q => q && q.name).filter(Boolean).slice(0, 5);
  return `${HEAD}:* no Brandwatch query in the team's project matches "${tc.truncate(String(ref || ''), 80)}".` +
    (names.length ? ` Close ones: ${names.join('; ')}.` : '') + ' To count without one, send `temp check` followed by a Boolean (words joined by AND / OR, phrases in quotes).';
}

function emptyText(rec, drafted) {
  return `${HEAD}:* nothing matched between ${tc.when(rec.window.from, rec.at)} and ${tc.when(rec.window.to, rec.at)}, in Brandwatch or in our own tables. ` +
    (drafted ? `The query drafted from the alert: ${code(drafted)} Send \`temp check\` followed by a Boolean of your own to count with that instead.`
      : 'A wider query (fewer words that must all be there) may find it.');
}

function failedText(why) { return `${HEAD}:* couldn't do it${why ? `: ${why}` : ''}. Send it again to try again.`; }

/** A message as a request this app answers: chat.ask's reading of it when the person running the app typed it; else null. */
function heard(m, me, ask) {
  if (!m || !me || m.senderType !== 'HUMAN' || m.sender !== me || m.clientId || !m.thread) return null;
  if (String(m.text || '').trim().indexOf(HEAD) === 0) return null;
  return ask(m.text);
}

/** The Chat thread's web address ("spaces/S/threads/T" -> …/room/S/T), or ''. */
function threadUrl(thread) {
  const m = /^spaces\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_.-]+)$/.exec(String(thread || ''));
  return m ? `https://chat.google.com/room/${m[1]}/${m[2]}` : '';
}

// ---------------------------------------------------------------------------------------------------------------

function make(d) {
  const now = () => (d.now ? d.now() : Date.now());
  const today = () => new Date(now()).toISOString().slice(0, 10);
  let line = Promise.resolve();
  /** One thing at a time: the timer's look and what the page asks for never write over each other. */
  const serial = fn => { const next = line.then(fn, fn); line = next.catch(() => {}); return next; };

  function load() {
    return Object.assign({ cards: false, cardsPrimed: false, listen: false, since: 0, listenFrom: 0, me: '', seenCards: [], jobs: {}, threads: {}, day: '', posted: 0,
      log: [], lastTick: 0, lastError: '', folderUrl: '' }, d.store.readFile(FILE, null) || {});
  }

  function save(st) {
    const keys = Object.keys(st.jobs);
    if (keys.length > JOBS_MAX) keys.sort((a, b) => (st.jobs[a].at || 0) - (st.jobs[b].at || 0)).slice(0, keys.length - JOBS_MAX).forEach(k => { delete st.jobs[k]; });
    st.seenCards = st.seenCards.slice(-1000);
    if (st.log.length > LOG_MAX) st.log = st.log.slice(-LOG_MAX);
    d.store.writeFile(FILE, st);
  }

  function note(st, job, what) {
    st.log.push({ at: now(), key: job.key || '', kind: job.kind || '', title: job.title || job.asked || '', state: job.state || '', what: what || job.why || '', checkId: job.checkId || '',
      docUrl: job.docUrl || '', thread: threadUrl(job.thread) });
  }

  /**
   * The temp check for an alert nobody has written a query for: a query is drafted from the alert and counted with;
   * when it matches nothing it is tried once without its words about what happened; then Gemini reads posts it found,
   * and a query that caught other posts too is narrowed once (the narrower one is kept only when more of what it
   * found is about the issue). At most two temp checks are run. Sets the query used and the check on the job.
   */
  async function drafted(job, say) {
    const about = [job.title, job.alertText].filter(Boolean).join('\n');
    const count = (draft, boolean) => d.service.run({ issue: job.title, trigger: 'alert', alertAt: job.alertAt, alertText: job.alertText || '', own: { on: true, boolean, drafted: draft } }, say);
    say('Drafting a query from the alert');
    let draft;
    try { draft = await d.draft.query(about); } catch (e) {
      const err = new Error('no query could be drafted from the alert');
      err.user = true;
      throw err;
    }
    let used = draft.boolean;
    let rec = await count(draft, used);
    let again = true;
    if (!(Number(rec.total) > 0) && draft.wide) {
      say('Nothing matched: counting again without the words about what happened');
      used = draft.wide;
      rec = await count(draft, used);
      again = false;
    }
    let check = null;
    if (Number(rec.total) > 0) {
      say('Checking that the posts found are about the issue');
      const posts = sample(rec);
      check = await d.draft.check(about, posts);
      if (again && check.read && check.share < GOOD) {
        say('The query caught other posts too: narrowing it');
        try {
          const next = await d.draft.narrow(about, draft, check, (check.off || []).map(i => posts[i]).filter(Boolean));
          if (next.boolean !== used) {
            const rec2 = await count(next, next.boolean);
            const check2 = Number(rec2.total) > 0 ? await d.draft.check(about, sample(rec2)) : null;
            if (check2 && check2.read && check2.share > check.share) { rec = rec2; check = check2; used = next.boolean; job.narrowed = true; }
          }
        } catch (e) { /* the first query stands */ }
      }
    }
    job.query = used;
    job.check = check ? { read: check.read, about: check.about, share: check.share, others: check.others || '', why: check.why || '' } : null;
    return rec;
  }

  /** The temp check for `job`, and its Doc: sets what came of it on the job (ready | empty | told). Throws what fails. */
  async function work(st, job, step) {
    const say = typeof step === 'function' ? step : () => {};
    let out;
    if (job.ref) out = await d.service.run({ query: job.ref, trigger: 'alert', alertAt: job.alertAt, alertText: job.alertText || '' }, say);
    else if (job.updateOf) out = await d.service.run({ updateOf: job.updateOf, trigger: 'alert', own: { on: true, reuse: job.updateOf } }, say);
    else if (job.draft) out = await drafted(job, say);
    else out = await d.service.run({ issue: job.title, trigger: 'alert', alertAt: job.alertAt, alertText: job.alertText || '', own: { on: true, boolean: job.boolean } }, say);
    if (out && out.needs) { job.state = 'told'; job.why = 'No Brandwatch query matches what was named.'; job.text = noMatchText(job.ref, out.needs === 'query' ? out : null); return job; }
    job.checkId = out.id;
    job.total = Number(out.total) || 0;
    job.basis = out.basis;
    if (!(job.total > 0)) { job.state = 'empty'; job.why = 'Nothing matched, in Brandwatch or in our own tables.'; job.text = emptyText(out, job.draft ? job.query : ''); return job; }
    if (job.draft && job.check && job.check.read && job.check.share < POOR) {  // the drafted query did not single the issue out: no count is given
      job.state = 'told';
      job.why = `The query drafted from the alert mostly caught other posts (${job.check.about} of the ${job.check.read} read were about the issue).`;
      job.text = offTopicText(job.query, job.check);
      return job;
    }
    const how = job.draft ? { query: job.query, check: job.check, note: checkLine(job.check) } : null;
    say('Saving it as a Google Doc');
    const doc = await d.docs.create(out, Object.assign({ why: job.kind, title: job.title || out.issue, threadUrl: threadUrl(job.thread) }, how ? { drafted: how } : {}));
    job.docUrl = doc.url;
    st.folderUrl = doc.folderUrl || st.folderUrl;
    job.text = replyText({ rec: out, docUrl: doc.url, update: !!job.updateOf || !!job.update, drafted: how });
    job.state = 'ready';
    job.why = '';
    st.threads[job.thread] = { checkId: out.id, at: now() };
    return job;
  }

  /** Posts the job's words in its thread, if the app may: the job becomes 'replied', or says why it was held back. */
  async function send(st, job) {
    const hold = why => { job.held = why; return job; };
    if (job.reply) return job;
    const no = d.chat.mayReply(await d.feed.control(), job.thread);
    if (no) return hold(no);
    const who = await d.chat.status();
    if (!who.canPost) return hold(who.why || 'The app is not signed in to Chat.');
    if (st.day !== today()) { st.day = today(); st.posted = 0; }
    if (st.posted >= MAX_PER_DAY) return hold(`Not posted: ${MAX_PER_DAY} replies were already posted today.`);
    const sent = await d.chat.reply({ thread: job.thread, text: job.text, key: job.key });
    if (!sent.already) st.posted++;
    if (sent.sender) st.me = sent.sender;  // Chat's own name for this account: whose typed requests are heard
    job.reply = { name: sent.name || '', at: now(), already: !!sent.already };
    job.posted = job.state;
    job.state = 'replied';
    job.held = '';
    return job;
  }

  function cardJob(c) {
    return { key: `card:${c.id}`, kind: 'card', id: c.id, thread: c.thread, title: (c.story && c.story.title) || c.issue, boolean: (c.story && c.story.query) || '',
      alertAt: c.at, alertText: [c.story && c.story.narrative, c.url].filter(Boolean).join('\n'), update: !!(c.story && c.story.updateOf), at: now() };
  }

  const problem = e => String((e && e.message) || e).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'an address').replace(/\s+/g, ' ').slice(0, 300);

  /** The story cards that came since the last look: each gets its temp check, its Doc and its reply. */
  async function doCards(st, alerts) {
    const cards = (alerts || []).filter(a => a.story && a.thread).sort((a, b) => a.at - b.at);
    if (!st.cardsPrimed) {  // just switched on: the cards already there are noted, never answered
      st.seenCards = Array.from(new Set(st.seenCards.concat(cards.map(c => String(c.id)))));
      st.cardsPrimed = true;
      return;
    }
    const seen = new Set(st.seenCards);
    for (const c of cards.filter(x => !seen.has(String(x.id)))) {
      st.seenCards.push(String(c.id));
      if (st.jobs[`card:${c.id}`] && st.jobs[`card:${c.id}`].reply) continue;  // answered by hand from the page already
      const job = cardJob(c);
      try {
        if (!job.boolean) { job.state = 'skipped'; job.why = 'The card came without a draft temp-check query, so there is nothing to count with.'; }
        else {
          await work(st, job);
          if (job.state === 'ready') await send(st, job);
        }
      } catch (e) {
        job.state = 'failed';
        job.why = problem(e);
      }
      st.jobs[job.key] = job;
      note(st, job, job.state === 'replied' ? 'Replied in the card\'s thread with the Doc\'s link.' : job.held || job.why);
      save(st);
    }
  }

  /** The job a typed request asks for, from the thread it was typed in. `alerts`: the feed's newest. */
  function askJob(st, m, a, alerts) {
    const job = { key: `ask:${m.name}`, kind: 'ask', message: m.name, thread: m.thread, at: m.at || now(), asked: String(m.text || '').slice(0, 300) };
    const inThread = (alerts || []).filter(x => (x.threads || []).indexOf(m.thread) >= 0 || x.thread === m.thread).sort((x, y) => x.at - y.at);
    const card = inThread.filter(x => x.story && x.story.query).pop() || null;
    const alert = card || inThread[inThread.length - 1] || null;
    job.title = alert ? ((alert.story && alert.story.title) || alert.issue) : '';
    job.alertAt = alert && now() - alert.at < FRESH_MS ? alert.at : now();
    job.alertText = alert ? [alert.story ? alert.story.narrative : alert.text, alert.url].filter(Boolean).join('\n') : '';
    const before = st.threads[m.thread] && d.store.read(st.threads[m.thread].checkId) ? st.threads[m.thread] : null;
    if (a.ref) { job.ref = a.ref; job.alertAt = alert ? alert.at : 0; }
    else if (a.boolean) { job.boolean = a.boolean; job.title = job.title || tc.truncate(a.boolean, 80); }
    else if (before) job.updateOf = before.checkId;                 // "temp check" again where there is one: its update
    else if (card) job.boolean = card.story.query;                  // in a story card's thread: the card's own query
    else if (alert && job.title) job.draft = true;                  // in an alert's thread: a query drafted from the alert, then checked
    else { job.state = 'told'; job.why = 'The thread has no recent alert to draft a query from.'; job.text = needsQueryText(); }
    return job;
  }

  /** What the person running the app typed in the space since the last look: each request is answered in its thread. */
  async function doAsks(st, getAlerts) {
    const control = await d.feed.control();
    if (!control.autocorrect) throw new Error('The bot\'s Control tab names no Auto-correct space to listen in.');
    const who = await d.chat.status();
    if (!who.canRead) throw new Error(who.why || 'The app is not signed in to Chat.');
    const me = st.me || who.me;
    if (!me) throw new Error('The Chat sign-in does not say whose account it is, so the app cannot tell which messages are yours.');
    const msgs = await d.chat.list(control.autocorrect, Math.max(0, (st.since || now()) - OVERLAP_MS));
    for (const m of msgs) {
      st.since = Math.max(st.since || 0, m.at || 0);
      if ((m.at || 0) < (st.listenFrom || 0) || st.jobs[`ask:${m.name}`]) continue;  // typed before listening was switched on: left alone
      const a = heard(m, me, d.chat.ask);
      if (!a) {
        // A request typed from another account is never answered, and its words are not kept. The page says it was
        // left alone: that is also how a sign-in made with a different account than the one typing shows up.
        if (m.senderType === 'HUMAN' && m.sender !== me && !m.clientId && String(m.text || '').trim().indexOf(HEAD) !== 0 && d.chat.ask(m.text)) {
          const other = { key: `ask:${m.name}`, kind: 'ask', thread: m.thread, at: m.at, title: '"temp check" typed from another account', state: 'left alone',
            why: 'Only requests typed from the account this app is signed in to Chat as are answered.' };
          st.jobs[other.key] = other;
          note(st, other);
          save(st);
        }
        continue;
      }
      let job = { key: `ask:${m.name}`, kind: 'ask', thread: m.thread, at: m.at, asked: String(m.text || '').slice(0, 300) };
      try {
        job = askJob(st, m, a, await getAlerts());
        if (!job.state) await work(st, job);
      } catch (e) {
        job.state = 'failed';
        job.why = problem(e);
        job.text = failedText(e && e.user ? problem(e) : 'the app\'s page says why');  // the app's own errors stay in the app
      }
      st.jobs[job.key] = job;  // kept before the reply goes: a request is never worked twice
      save(st);
      try {
        await send(st, job);
      } catch (e) {
        job.held = `The reply could not be posted: ${problem(e)}`;
      }
      note(st, job, job.state === 'replied' ? `Answered in its thread${job.docUrl ? ' with the Doc\'s link' : ''}${job.why ? ` (${job.why})` : ''}.` : job.held || job.why);
      save(st);
    }
  }

  /** One look: new story cards, and new requests. Called by the app's timer; does nothing while both are off. */
  function tick() {
    return serial(async () => {
      const st = load();
      if (!st.cards && !st.listen) return;
      let alerts = null;
      const getAlerts = async n => (alerts && alerts.n >= n ? alerts.list : (alerts = { n, list: await d.feed.newest(n) }).list);
      try {
        if (st.cards) await doCards(st, await getAlerts(120));
        if (st.listen) await doAsks(st, () => getAlerts(400));
        st.lastError = '';
      } catch (e) {
        st.lastError = problem(e);
      }
      st.lastTick = now();
      save(st);
    });
  }

  /** Switches either on or off: {cards, listen}. Switching on never acts on what is already there. */
  function configure(o) {
    return serial(async () => {
      const st = load();
      if (o && typeof o.cards === 'boolean' && o.cards !== st.cards) {
        st.cards = o.cards;
        st.cardsPrimed = false;
        st.log.push({ at: now(), kind: 'card', state: o.cards ? 'switched on' : 'switched off', what: o.cards ? 'From now on each new story card gets a temp check, a Doc and a reply. Cards already there are left alone.' : 'New story cards are no longer answered.' });
      }
      if (o && typeof o.listen === 'boolean' && o.listen !== st.listen) {
        st.listen = o.listen;
        st.since = now();
        st.listenFrom = now();
        st.log.push({ at: now(), kind: 'ask', state: o.listen ? 'switched on' : 'switched off', what: o.listen ? 'From now on "temp check" typed by you in the space is answered in its thread. Messages already there are left alone.' : '"temp check" typed in the space is no longer answered.' });
      }
      save(st);
      return { cards: st.cards, listen: st.listen };
    });
  }

  /** Whether the timer is needed, and whether story cards are this module's to answer (the watcher then leaves them). */
  function active() { const st = load(); return !!(st.cards || st.listen); }
  function cardsOn() { return !!load().cards; }

  /** By hand, from the page: the temp check and Doc for story card `id`, and the reply's words, without posting. */
  function prepare(id, step) {
    return serial(async () => {
      const st = load();
      const had = st.jobs[`card:${id}`];
      if (had && (had.reply || (had.state === 'ready' && had.docUrl))) return { id: had.checkId || '' };  // answered, or made and waiting: never a second Doc
      const card = (await d.feed.newest(400)).filter(a => a.story && a.thread && String(a.id) === String(id)).pop();
      if (!card) { const e = new Error('That story card is not among the bot\'s newest alerts.'); e.user = true; throw e; }
      const job = cardJob(card);
      if (!job.boolean) { job.state = 'skipped'; job.why = 'The card came without a draft temp-check query, so there is nothing to count with.'; }
      else await work(st, job, step);
      st.jobs[job.key] = job;
      note(st, job, job.state === 'ready' ? 'Made by hand from the page; not posted yet.' : job.why);
      save(st);
      return { id: job.checkId || '' };
    });
  }

  /** By hand, from the page: posts what `prepare` made for `key` ("card:<id>"). Once. */
  function post(key) {
    return serial(async () => {
      const st = load();
      const job = st.jobs[String(key)];
      if (!job || !job.text || (job.state !== 'ready' && job.state !== 'replied')) { const e = new Error('Make its temp check first.'); e.user = true; throw e; }
      if (!job.reply) {
        await send(st, job);
        note(st, job, job.state === 'replied' ? 'Replied in the card\'s thread with the Doc\'s link (posted from the page).' : job.held);
        save(st);
      }
      if (!job.reply) { const e = new Error(job.held || 'It was not posted.'); e.user = true; throw e; }
      return job;
    });
  }

  /** What the page shows: the two switches, the sign-in, where it may post, the newest story cards and what was done. */
  async function overview() {
    const st = load();
    const out = { cards: !!st.cards, listen: !!st.listen, postedToday: st.day === today() ? st.posted : 0, maxPerDay: MAX_PER_DAY, lastTick: st.lastTick, lastError: st.lastError,
      folderUrl: st.folderUrl || '', log: st.log.slice(-40).reverse(), chat: null, where: { ok: false, why: '' }, stories: [], problem: '' };
    out.chat = await d.chat.status();
    try {
      const control = await d.feed.control();
      const why = control.autocorrect ? d.chat.mayReply(control, `${control.autocorrect}/threads/x`) : 'The bot\'s Control tab names no Auto-correct space.';
      out.where = { ok: !why, why };
      out.stories = (await d.feed.newest(200)).filter(a => a.story && a.thread).sort((a, b) => b.at - a.at).slice(0, 8).map(c => {
        const j = st.jobs[`card:${c.id}`] || {};
        return { id: c.id, at: c.at, title: c.story.title || c.issue, update: !!c.story.updateOf, hasQuery: !!c.story.query, thread: threadUrl(c.thread), state: j.state || '',
          why: j.held || j.why || '', checkId: j.checkId || '', total: j.total === undefined ? null : j.total, basis: j.basis || '', docUrl: j.docUrl || '', text: j.text || '',
          repliedAt: j.reply ? j.reply.at : 0 };
      });
    } catch (e) {
      out.problem = problem(e);
    }
    return out;
  }

  return { tick, configure, active, cardsOn, prepare, post, overview };
}

const gemini = require('./gemini');
const real = make({ feed: require('./feed'), service: require('./service'), docs: require('./docs'), chat: require('./chat'), store: require('./store'),
  draft: { query: gemini.tightQuery, check: gemini.aboutIssue, narrow: gemini.narrowQuery } });

module.exports = Object.assign(real, { make, replyText, needsQueryText, noMatchText, emptyText, failedText, offTopicText, checkLine, sample, heard, threadUrl,
  HEAD, MAX_PER_DAY, CHECK_POSTS, GOOD, POOR });
