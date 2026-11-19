/**
 * AlertMemory.gs — one memory of the alerts the bot handled and the Social Alerts it sent, shared by every flow, so one
 * post or one story is never emailed twice, whichever flow or source met it. Always on, with no Control row and no
 * setting (like ApiGuard.gs): its tunables are the constants below.
 *
 * poll() starts it once a run (alertMemoryStart_) and every flow that run uses the same one: the Mirror space (B9), the
 * Auto-correct space (B10), the Other alerts space (B33), the Watch alerts, the Early wave and Direct BigQuery alerts.
 * It is read at most once a run, and only when a flow needs it: the bot's own hidden tab AM_TAB_ (a tab of that name the
 * bot didn't make is never read or written: isAlertMemoryTab_), the Alert log rows the flows read anyway (every space's:
 * Store.gs hands them over) and the sends noted before Gmail was asked (AM_CLAIMS_PROP_). What changed is written once,
 * in poll()'s finally (alertMemoryFlush_), every cell under AM_CELL_MAX_; emailed posts and stories are kept 14 days.
 * The memory stays out of the script cache: that cache holds about 1,000 items shared by every feature, and this tab is
 * small next to the Alert log every flow reads anyway.
 *
 * The rules (a suppression leaves its ❌ decision on the alert's Alert-log row and a note in its thread):
 *   post key    one post across link formats (amPostKey_: Speed.gs postKey_; else the link without tracking parameters
 *               such as ?xtok=, without www./m./mobile. or trailing slashes, in lower case; /reel and /reels are one)
 *   live        the same live S-F Burson message reviewed by two flows (the Mirror's copy, the Auto-correct space's
 *               original): only the first emails; the second still posts its corrected alert, with the decision
 *               "Social Alert sent by the other flow (QA-x)"
 *   post        a post emailed in the last 14 days (any flow, any source) is never emailed again, but for ONE update on
 *               the same email thread per stakes tier when the stakes really rise (amTriggers_: a new P0, a new Sensitive
 *               Topic, a first KOF author, the leadership protocol newly applying, engagement crossing 2,000 / 10,000 /
 *               50,000), each tier once
 *   seen        a post seen in the last 24 hours (any outcome, or a card a producer claimed) gets no second card from the
 *               Watch alerts or Direct BigQuery alerts (seenPost, claim)
 *   story       another post on a story with a Social Alert emailed in the last 24 hours: no new email; the post is
 *               folded into that alert's thread (a reply naming its author, network, engagement and link), and only a
 *               stakes tier sends ONE update on the story's email thread, one a story every 120 minutes at most unless
 *               it's a new P0, a first KOF author or a leadership case (all tags, always-alert Content tags included)
 *   same story  Vertex AI text-embedding-005 (Vectors.gs) of "issue name. product. exposure tag. summary" (amStoryText_):
 *               AM_SAME_STORY_SIM_ and up, or AM_GRAY_SIM_ and up with the same exposure tag and product; never when both
 *               texts name identifiers that differ (a CVE, a 4+ digit number, the @handle of the subject); no vector (the
 *               embedding failed, or an older story): the word check, as before (the same tag, issue words alike)
 *   novelty     a post on a story alerted in the last 14 days (by time, not the Alert log's last rows) is an Ongoing
 *               Issue under that story's exact name (Review.gs, OtherAlerts.gs, EarlyDetection.gs), so the Collection
 *               Requirements decide (an ongoing issue needs 2K+ or a KOF author unless its tag is always alerted)
 *   send gate   Drafts.gs tryDraft_ asks again right before any email or draft (amSendGate_): a retry, or the emails
 *               that waited while Control!B30 was blank, never send a second one. A send is noted before Gmail is asked
 *               (claimSend: durable at once) and once it's out (recordSend)
 * A test send (Testing: only the testers) never holds back a live one, and a live one holds back every test one. Never
 * held back: a new P0, a first KOF author, a leadership case (they're stakes tiers, and never wait out the 120 minutes).
 * A memory that can't be read: a warning, a note on the Control tab (amControlNote_), and every alert decided as before.
 *
 * The API (the flows, and BigQuery.gs):
 *   alertMemory_()               this run's memory; before poll() starts one (another entry point, a test), one that
 *                                knows nothing (every check answers as before)
 *   .seenPost(url, opts)         null when the post wasn't seen; else {why, alert_id, at, outcome ('emailed' | 'seen' |
 *                                'claimed')}: emailed in the last 14 days, or seen in the last 24 hours (opts.hours:
 *                                another window), a card a producer claimed included. A post seen or claimed also has
 *                                ids (the alerts that saw it, the latest AM_IDS_KEPT_ at most) and claim (the
 *                                producer whose card was posted for it, '' for none)
 *   .notePosts(row, urls)        the posts a story's card links besides its main post: each seen by the card's Alert-log
 *                                row as its main post is (noteRow), so every check that asks seenPost treats them alike
 *   .claim(url, flow, info)      a producer ('watch', 'bq', …) is about to post a card for the post: true when it's now
 *                                claimed for it, false when the post was already seen (don't post it). info: {author,
 *                                network, engagement}
 *   .storyMatch(fields, opts)    the story already alerted that `fields` tell (issue_name, product, exposure_tag,
 *                                summary, author, post_url): {story, issue_name, alert_id, sim, how ('vector' | 'words'),
 *                                emailed_at, alerted_at}, or null. opts.hours (14 days), opts.emailed (only stories
 *                                emailed in that window), opts.deadline
 *   .nearStories(vecs, opts)     for each vector (a post's text, embedded), the stories alerted since opts.hours ago
 *                                (14 days) closest to it in meaning, opts.k of them (3) from opts.minSim (0.7) up:
 *                                [{sid, name, alert_id, at, sim, kof, eng}]. Candidates for a judgement (the Watch
 *                                alerts' pre-read reads them), never a same-story verdict: that is storyMatch
 *   .sendCheck(row, ctx)         the send gate's answer for an Alert-log row: {ok: true}, {ok: true, update: {tiers,
 *                                ref, rel}} (its one update, on that email's thread), or {ok: false, why, kind, ref}
 *   .claimSend(row, ctx)         a Social Alert for `row` is about to go (or its draft be made): noted first
 *   .recordSend(row, ctx)        it went out
 *   .flush()                     writes what changed (poll()'s finally does it)
 */

const AM_TAB_ = 'Alert memory (bot)';
const AM_HEADER_ = ['Post or story', 'What the bot remembers (written by the Burson QA bot)', 'Story vector'];
const AM_CELL_MAX_ = 45000;                     // a cell's text at most (Sheets refuses 50,000; Sheets.gs caps at 49,000)
const AM_HOUR_MS_ = 3600 * 1000;
const AM_DAY_MS_ = 24 * AM_HOUR_MS_;
const AM_POST_EMAIL_MS_ = 14 * AM_DAY_MS_;      // post: no second email for a post emailed this recently
const AM_SEEN_MS_ = 24 * AM_HOUR_MS_;           // seen: no second card from a producer for a post seen this recently
const AM_STORY_FOLD_MS_ = 24 * AM_HOUR_MS_;     // story: a story emailed this recently folds its other posts
const AM_NOVELTY_MS_ = 14 * AM_DAY_MS_;         // novelty: a story alerted this recently makes a post an Ongoing Issue
const AM_UPDATE_GAP_MS_ = 120 * 60 * 1000;      // story: one update a story this often at most (but AM_EXEMPT_TIERS_)
const AM_KEEP_MS_ = 14 * AM_DAY_MS_;            // emailed posts and stories are kept this long
const AM_SEEN_KEEP_MS_ = 48 * AM_HOUR_MS_;      // a post only seen (never emailed) is kept this long (rule "seen": 24 h)
const AM_ENGAGEMENT_TIERS_ = [2000, 10000, 50000];
const AM_EXEMPT_TIERS_ = ['p0', 'kof', 'lead']; // never held back by the 120-minute gap (never suppress a new P0, a
                                                // first KOF author or a leadership case)
// The same story. calibrate_story.py (Nov 2026): 353 real alerts embedded as amStoryText_ writes them, pairs on
// different posts within 48 hours: same-name pairs median 0.895, p05 0.831; different-name pairs p99 0.797; the pairs
// at 0.85 and up are overwhelmingly the same story under name variants. So 0.85 and up is the same story; 0.80-0.85
// only with the same exposure tag and the same product.
const AM_SAME_STORY_SIM_ = 0.85;
const AM_GRAY_SIM_ = 0.80;
const AM_SUMMARY_CHARS_ = 400;                  // of the summary in a story's text (as calibrated)
const AM_EMBED_MAX_ = 40;                       // texts embedded a run at most (past it: the word check)
const AM_REWRITE_STALE_ = 200;                  // rows gone stale past which the tab is rewritten whole
const AM_REWRITE_DIRTY_ = 60;                   // rows changed past which the tab is rewritten whole (fewer writes)
const AM_CLAIMS_PROP_ = 'ALERT_MEMORY_CLAIMS';  // the sends noted before Gmail was asked, until the tab has them
const AM_CLAIMS_MAX_ = 20;
const AM_CLAIMS_MAX_CHARS_ = 8000;              // a script property holds 9 KB
const AM_PROBLEM_PROP_ = 'ALERT_MEMORY_PROBLEM';  // {at, text}: why the memory couldn't be read (Control tab, an hour)
const AM_PROBLEM_SHOWN_MS_ = 60 * 60 * 1000;
const AM_DAY_PROP_ = 'ALERT_MEMORY_TODAY';      // {day, held, folded, updates}: today's count, for the Control tab
const AM_TRACKING_RX_ = new RegExp('^(?:utm_|fbclid|gclid|igshid|igsh|si$|s$|t$|ref|feature|share|mibextid|xtok|' +
  'img_index|image_index|hl$|rdid|q$|is_from_webapp|sender_device|_r$|_t$|smid|cmpid|ocid)', 'i');
const AM_BOILER_RX_ = /Automated Alert via Burson[\s\S]*?(?:\n|$)|Note: This is an automated message[\s\S]*?(?:\n|$)/gi;
const AM_COUNT_RX_ = new RegExp('\\b\\d[\\d,.]*\\s*[kKmM]?\\+?\\s*(?:likes?|views?|engagements?|followers?|comments?|' +
  'shares?|retweets?|reposts?|repl(?:y|ies)|interactions?|impressions?|upvotes?|reactions?|subscribers?|votes?)\\b', 'gi');
const AM_OUTCOME_RANK_ = { s: 0, f: 1, p: 2, c: 3, e: 4 };  // seen < folded < pending < emailing < emailed
const AM_IDS_KEPT_ = 6;                           // the alerts kept on a post that saw it (its `ids`): the latest ones

let AM_RUN_ = null;  // this run's memory (alertMemoryStart_), or null

// ---------------------------------------------------------------------------------------------------------------
// The run's memory
// ---------------------------------------------------------------------------------------------------------------

/** The memory that knows nothing: before a run starts one, every check answers as the flows did without it. */
const AM_OFF_ = Object.freeze({
  active: false, ok: false, problem: '',
  seenPost: () => null, claim: () => true, storyMatch: () => null, facts: () => null,
  sendCheck: () => ({ ok: true }), claimSend: () => false, recordSend: () => false, releaseSend: () => false,
  noteRow: () => {}, notePosts: () => 0, seedRows: () => {}, noteHeld: () => {}, storyRec: () => null, recentStories: () => [],
  nearStories: vecs => (vecs || []).map(() => []),
  flush: () => null, counts: () => ({ held: 0, folded: 0, updates: 0 }),
});

/**
 * Starts this run's memory over the bot's sheet `ss` (opts {deadline}): nothing is read until a flow asks. Returns it.
 * Without `ss`, the memory that knows nothing.
 */
function alertMemoryStart_(ss, opts) {
  AM_RUN_ = ss ? makeAlertMemory_(ss, opts) : null;
  return AM_RUN_ || AM_OFF_;
}

/** This run's memory (alertMemoryStart_), else the memory that knows nothing (AM_OFF_). */
function alertMemory_() { return AM_RUN_ || AM_OFF_; }

/** Writes what this run's memory learned (poll()'s finally). Never throws. */
function alertMemoryFlush_() {
  const m = AM_RUN_;
  if (!m) return null;
  try {
    return m.flush();
  } catch (e) {
    console.warn('alert memory: couldn\'t write it: ' + ((e && e.message) || e));
    return null;
  }
}

/** Ends this run's memory (poll()'s finally, after alertMemoryFlush_): until the next run starts one, none. */
function alertMemoryEnd_() { AM_RUN_ = null; }

/** The memory a flow uses: its ctx's (ctx.memory: buildCtx_ sets it; a test can too), else this run's. */
function amOf_(ctx) {
  const m = ctx && ctx.memory;
  return m && typeof m.seenPost === 'function' ? m : alertMemory_();
}

/** The Store.gs observer that tells this run's memory about every Alert-log row a flow reads or adds. */
function amStoreObserver_() {
  return {
    loaded: rows => { try { alertMemory_().seedRows(rows); } catch (e) { console.warn('alert memory: ' + ((e && e.message) || e)); } },
    added: row => { try { alertMemory_().noteRow(row); } catch (e) { console.warn('alert memory: ' + ((e && e.message) || e)); } },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

/**
 * One post across link formats: Speed.gs postKey_ ("x:…", "ig:…" for /p/, /reel/, /reels/ and /tv/ with or without
 * the account, "tt:…", "yt:…", "bsky:…", "rd:…", "th:…", "li:…", "fb:…"); any other link without its tracking
 * parameters (?xtok=, utm_…, img_index, hl, q, …), without www./m./mobile. hosts and trailing slashes, in lower case.
 * A key already made (or a "msg:"/"id:" key) comes back as it is. '' without a link. Pure.
 */
function amPostKey_(url) {
  const raw = String(url === undefined || url === null ? '' : url).trim().replace(/^</, '').replace(/>$/, '')
    .split('|')[0].trim().split(/\s+/)[0];
  if (!raw) return '';
  if (/^(?:x|ig|tt|yt|bsky|rd|th|li|fb|msg|id):\S+$/.test(raw) && !/^[a-z]+:\/\//i.test(raw)) return raw;
  const k = typeof postKey_ === 'function' ? postKey_(raw) : '';
  if (/^(?:x|ig|tt|yt|bsky|rd|th|li|fb):/.test(k)) return k;
  const u = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  const m = u.match(/^https?:\/\/([^/?#:]+)(?::\d+)?([^?#]*)(?:\?([^#]*))?/i);
  if (!m) return '';
  let host = m[1].toLowerCase();
  for (let again = true; again;) {
    again = false;
    ['www.', 'm.', 'mobile.', 'amp.', 'old.', 'new.'].forEach(pre => {
      if (host.startsWith(pre) && host.length > pre.length + 3) { host = host.slice(pre.length); again = true; }
    });
  }
  if (!host.includes('.')) return '';
  if (host === 'twitter.com') host = 'x.com';
  if (host === 'threads.com') host = 'threads.net';
  const path = (m[2] || '').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
  const query = [];
  (m[3] || '').split('&').filter(Boolean).forEach(kv => {
    const i = kv.indexOf('=');
    const key = (i < 0 ? kv : kv.slice(0, i)).toLowerCase();
    const val = i < 0 ? '' : kv.slice(i + 1);
    if (!key || !val || AM_TRACKING_RX_.test(key) || query.some(q => q.indexOf(key + '=') === 0)) return;
    query.push(`${key}=${val}`);
  });
  query.sort();
  return host + path + (query.length ? '?' + query.join('&') : '');
}

/** The same post (amPostKey_ of both; a Reddit post and a comment under it too: Speed.gs samePost_)? Pure. */
function amSamePost_(a, b) {
  const x = amPostKey_(a);
  const y = amPostKey_(b);
  if (!x || !y) return false;
  return typeof samePost_ === 'function' ? samePost_(x, y) : x === y;
}

/** An exposure tag by its current name ('' for none). Pure (reads GEN). */
function amTag_(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  const t = s && typeof lookupTag_ === 'function' ? lookupTag_(s) : null;
  return t ? t.name : s;
}

/** A product by its distribution name ('' for none). Pure (reads GEN). */
function amProduct_(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  const p = s && typeof normalizeProposal_ === 'function' ? normalizeProposal_('product', s) : '';
  return p || s;
}

/**
 * A story's text, as calibrate_story.py embedded it: "<issue name>. <product>. <exposure tag>. <summary without
 * Burson's boilerplate ('Automated Alert via Burson (beta)…', 'Note: This is an automated message…'), its first 400
 * characters>". '' without an issue name or summary. Pure.
 */
function amStoryText_(fields) {
  const f = fields || {};
  const name = typeof issueNameText_ === 'function' ? issueNameText_(f.issue_name) : String(f.issue_name || '').trim();
  const summary = String(f.summary === undefined || f.summary === null ? '' : f.summary).replace(AM_BOILER_RX_, ' ').trim()
    .slice(0, AM_SUMMARY_CHARS_);
  if (!name && !summary) return '';
  return `${name}. ${amProduct_(f.product)}. ${amTag_(f.exposure_tag)}. ${summary}`;
}

/**
 * The identifiers a story's text names, which two different stories can't share: {c: CVE ids, n: numbers of 4+ digits
 * (an engagement count isn't one), a: @handles (the post's own author's left out: the subject is who it's about)}.
 * Pure.
 */
function amIdents_(text, authors) {
  const s = String(text || '').replace(/https?:\/\/\S+/gi, ' ');
  const uniq = list => Array.from(new Set(list)).slice(0, 8);
  const cve = (s.match(/\bCVE-\d{4}-\d{4,}\b/gi) || []).map(x => x.toUpperCase());
  const rest = s.replace(/\bCVE-\d{4}-\d{4,}\b/gi, ' ').replace(AM_COUNT_RX_, ' ');
  const num = rest.match(/\b\d{4,}\b/g) || [];
  const skip = new Set((authors || []).map(a => String(a || '').replace(/^@+/, '').trim().toLowerCase()).filter(Boolean));
  const at = [];
  const rx = /(?:^|[^\w.@])@([A-Za-z0-9_]{2,30})/g;
  for (let m = rx.exec(s); m; m = rx.exec(s)) {
    const h = m[1].toLowerCase();
    if (!skip.has(h)) at.push(h);
  }
  return { c: uniq(cve), n: uniq(num), a: uniq(at) };
}

/** True when both name identifiers of one kind and share none of them: never the same story. Pure. */
function amIdentsClash_(x, y) {
  const a = x || {};
  const b = y || {};
  return ['c', 'n', 'a'].some(k => {
    const p = Array.isArray(a[k]) ? a[k] : [];
    const q = Array.isArray(b[k]) ? b[k] : [];
    return p.length > 0 && q.length > 0 && !p.some(v => q.indexOf(v) >= 0);
  });
}

function amSameName_(x, y) {
  const p = String(x === undefined || x === null ? '' : x).trim().toLowerCase();
  return !!p && p === String(y === undefined || y === null ? '' : y).trim().toLowerCase();
}

/**
 * Same story by meaning? `sim`: the cosine of their vectors; `a`, `b`: {tag, prod, idt}. AM_SAME_STORY_SIM_ and up;
 * AM_GRAY_SIM_ and up with the same exposure tag and the same product; never with clashing identifiers. Pure.
 */
function amSameStory_(sim, a, b) {
  if (amIdentsClash_(a && a.idt, b && b.idt)) return false;
  if (sim >= AM_SAME_STORY_SIM_) return true;
  return sim >= AM_GRAY_SIM_ && amSameName_(a && a.tag, b && b.tag) && amSameName_(a && a.prod, b && b.prod);
}

/**
 * Same story by words (no vector to compare: the check from before): the same exposure tag and issue words at least
 * novelty_min_jaccard alike, never with clashing identifiers. Their likeness (0 when not). Pure.
 */
function amSameStoryWords_(a, b) {
  if (!a || !b || amIdentsClash_(a.idt, b.idt) || !amSameName_(a.tag, b.tag)) return 0;
  const ta = Array.isArray(a.tok) ? a.tok : [];
  const tb = Array.isArray(b.tok) ? b.tok : [];
  if (!ta.length || !tb.length) return 0;
  const j = jaccard_(ta, tb);
  return j >= (Number(GEN.novelty_min_jaccard) || 0.6) ? j : 0;
}

/** What raises the stakes of an alert (`esc`: Escalate.gs escalation_; `fields` for its count): {p, t, k, ld, g}. Pure. */
function amStakes_(esc, fields) {
  const e = esc || {};
  const f = fields || {};
  const total = Number.isFinite(Number(e.engagement_total)) && e.engagement_total !== null && e.engagement_total !== ''
    ? Number(e.engagement_total) : (Number.isFinite(Number(f.total_engagement)) ? Number(f.total_engagement) : 0);
  return { p: String(e.priority || ''), t: (Array.isArray(e.sensitive_topics) ? e.sensitive_topics : []).map(String).filter(Boolean),
    k: !!e.is_kof, ld: !!e.leadership, g: Math.max(0, Math.round(total || 0)) };
}

/** The highest stakes of two (P0 over the rest, every topic, KOF, leadership, the most engagements). Pure. */
function amMergeStakes_(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const topics = [];
  (a.t || []).concat(b.t || []).forEach(t => { if (!topics.some(x => amSameName_(x, t))) topics.push(t); });
  return { p: a.p === 'P0' || b.p === 'P0' ? 'P0' : (a.p || b.p || ''), t: topics.slice(0, 12), k: !!(a.k || b.k),
    ld: !!(a.ld || b.ld), g: Math.max(Number(a.g) || 0, Number(b.g) || 0) };
}

/**
 * The stakes tiers this alert (`now`: amStakes_) reaches that its earlier email (`had`, with the tiers its updates
 * used, `used`) didn't: 'p0' (a new P0), 't:<topic>' (a new Sensitive Topic), 'kof' (a first KOF author), 'lead' (the
 * leadership protocol newly applies), 'e2000' / 'e10000' / 'e50000' (engagement crossing it). Each tier once. None
 * when the earlier email's stakes aren't known. Pure.
 */
function amTriggers_(now, had, used) {
  if (!now || !had) return [];
  const u = new Set((used || []).map(x => String(x).toLowerCase()));
  const out = [];
  if (now.p === 'P0' && had.p !== 'P0' && !u.has('p0')) out.push('p0');
  (now.t || []).forEach(t => {
    const k = 't:' + String(t);
    if (!(had.t || []).some(x => amSameName_(x, t)) && !u.has(k.toLowerCase()) && !out.some(x => amSameName_(x, k))) out.push(k);
  });
  if (now.k && !had.k && !u.has('kof')) out.push('kof');
  if (now.ld && !had.ld && !u.has('lead')) out.push('lead');
  AM_ENGAGEMENT_TIERS_.forEach(n => {
    if ((Number(now.g) || 0) >= n && (Number(had.g) || 0) < n && !u.has('e' + n)) out.push('e' + n);
  });
  return out;
}

/** "a P0 tag, engagement past 10,000": the tiers in words. Pure. */
function amTierWords_(tiers) {
  return (tiers || []).map(t => {
    const s = String(t);
    if (s === 'p0') return 'a P0 tag';
    if (s === 'kof') return 'a KOF author';
    if (s === 'lead') return 'the leadership protocol';
    if (/^e\d+$/.test(s)) return `engagement past ${Number(s.slice(1)).toLocaleString('en-US')}`;
    if (/^t:/.test(s)) return `a new Sensitive Topic (${s.slice(2)})`;
    return s;
  }).join(', ');
}

/** The flow an Alert-log partition is (its `space`): 'M' Mirror (B9), 'A' Auto-correct (B10), 'O' Other (B33), 'S' main. Pure. */
function amFlowOf_(partition) {
  const p = String(partition || '');
  if (!p) return '';
  if (p.endsWith(' (auto-correct)')) return 'A';
  if (p.endsWith(' (other alerts)')) return 'O';
  if (p.indexOf(' > (isolated)') >= 0) return 'M';
  return 'S';
}

/** Non-empty synthetic source space ID when `partition` is a B3 test feed distinct from configured S-F Burson (B25). */
function amSyntheticFeedOf_(partition) {
  const p = String(partition || '');
  if (!p || amFlowOf_(p) !== 'S') return '';
  const sfb = typeof sfBursonId_ === 'function' ? sfBursonId_() : '';
  const src = p.split(' > ')[0] || '';
  return sfb && src && src !== sfb ? src : '';
}

/** The space an Alert-log partition's alerts (and their threads) are in. Pure. */
function amChatSpaceOf_(partition) {
  const p = String(partition || '').replace(/ \((?:auto-correct|other alerts)\)$/, '');
  const parts = p.split(' > ');
  if (parts.length < 2 || parts[1] === '(isolated)') return parts[0] || '';
  return parts[1];
}

/** The alert's reviewed fields on its Alert-log row (the Social Alert's, else the forwarded copy's). Pure. */
function amRowFields_(row) {
  const r = row || {};
  const input = r.email_input && typeof r.email_input === 'object' ? r.email_input : {};
  if (input.fields && typeof input.fields === 'object' && Object.keys(input.fields).length) return input.fields;
  return r.forwarded_fields && typeof r.forwarded_fields === 'object' ? r.forwarded_fields : {};
}

/**
 * The live S-F Burson message an Alert-log row is ('' for none): the Mirror's pair (live_message), or the message
 * itself in a flow that reads S-F Burson directly (the Auto-correct space's partition starts with it). Pure but for
 * this run's S-F Burson (Config.gs).
 */
function amRowLive_(row) {
  const r = row || {};
  if (r.live_message) return String(r.live_message);
  const src = String(r.source_message || '');
  if (!src) return '';
  const sp = String(r.space || '');
  if (sp.endsWith(' (auto-correct)')) return src.indexOf(sp.split(' > ')[0] + '/messages/') === 0 ? src : '';
  const sfb = typeof sfBursonId_ === 'function' ? sfBursonId_() : '';
  return sfb && src.indexOf(sfb + '/messages/') === 0 ? src : '';
}

/** The memory's key for an Alert-log row: its post, else its live S-F Burson message ("msg:…"), else ''. Pure. */
function amRowKey_(row) {
  const r = row || {};
  const f = amRowFields_(r);
  const ff = r.forwarded_fields && typeof r.forwarded_fields === 'object' ? r.forwarded_fields : {};
  const key = amPostKey_(f.post_url || ff.post_url || r.record_key || '');
  if (key) return key;
  const live = amRowLive_(r);
  return live ? 'msg:' + live : '';
}

/** This flow sends to the real distros (LIVE), not only to the testers. Pure. */
function amCtxLive_(ctx) {
  const D = (ctx && ctx.drafts) || {};
  return !!D.live && !(Array.isArray(D.testers) && D.testers.length) && !String(D.standIn || '').trim();
}

/** The email a row's Social Alert is (or will be), as the memory keeps it. Pure. */
function amEmailOfRow_(r, lv) {
  const sent = String(r.email_status || '') === 'sent';
  const f = amRowFields_(r);
  const tf = amSyntheticFeedOf_(r.space);
  const tms = Array.isArray((r.email_input || {}).team_emails)
    ? r.email_input.team_emails.filter(te => te && te.key && te.thread).slice(0, 6)
        .map(te => ({ k: String(te.key), th: truncate_(String(te.thread), 120), mid: truncate_(String(te.message_id || ''), 200),
          sub: truncate_(String(te.subject || ''), 200) }))
    : [];
  const out = {
    id: String(r.alert_id || ''), at: Number(r.email_sent_at) || Number(r.email_at) || Number(r.created_at) || 0,
    o: sent ? 'e' : 'c', lv: !!lv, fl: amFlowOf_(r.space), lm: amRowLive_(r),
    th: truncate_(String(r.email_thread || ''), 200), mid: truncate_(String(r.email_message_id || ''), 300),
    sub: truncate_(String(r.email_subject || ''), 300), cs: amChatSpaceOf_(r.space),
    ct: truncate_(String(r.forward_thread || ''), 200), cm: truncate_(String(r.forward_message || ''), 200),
    nm: truncate_(typeof issueNameText_ === 'function' ? issueNameText_(f.issue_name) : String(f.issue_name || ''), 200),
    pr: truncate_(String(f.product || ''), 80),
  };
  if (tms.length) out.tm = tms;
  if (tf) out.tf = tf;
  return out;
}

/**
 * Whether the memory holds a Social Alert back, and why, or allows its one update. `facts` (memory.facts: the post's
 * record, the live S-F Burson message's, the story's), `esc` (the alert's escalation: its stakes), `now` (ms). Returns
 * null (nothing to say: decided as before), {skip, kind: 'live' | 'post' | 'story', ref, fold, story}, or {skip: '',
 * update: {kind, tiers, ref, rel, story}}. Flows in the same delivery tier (both LIVE, or both Testing) share dedup;
 * synthetic B3 test feeds stay isolated from real S-F Burson flows. Pure (reads the records).
 */
function amVerdict_(facts, esc, now) {
  const F = facts;
  if (!F || !F.on) return null;
  const t = Number(now) || Date.now();
  const stakes = amStakes_(esc, F.fields);
  const sameScope = e => !!e && !!e.id && !(F.id && e.id === F.id) && !!e.lv === !!F.lv && String(e.tf || '') === String(F.tf || '');
  const rel = e => sameScope(e) ? 'same' : '';
  const L = F.liveRec;
  if (L && L.fl && L.fl !== F.flow && rel(L) && t - (Number(L.at) || 0) <= AM_POST_EMAIL_MS_) {
    return { skip: `Social Alert sent by the other flow (${L.id})`, kind: 'live', ref: L.id };
  }
  let update = null;
  const P = F.post;
  const pe = P && P.e;
  const pr = rel(pe);
  if (pr && t - Math.max(Number(P.le) || 0, Number(pe.at) || 0) <= AM_POST_EMAIL_MS_) {
    const trig = pr === 'same' ? amTriggers_(stakes, P.st, P.tg) : [];
    if (!trig.length) return { skip: `the same post was already emailed (${pe.id})`, kind: 'post', ref: pe.id };
    update = { kind: 'post', tiers: trig, ref: pe.id, rel: pe, story: P.s || '' };
  }
  const S = F.fold && F.fold.rec;
  const se = S && S.e;
  const sr = rel(se);
  if (sr && t - Math.max(Number(S.le) || 0, Number(se.at) || 0) <= AM_STORY_FOLD_MS_) {
    const name = S.name ? ` (the same story: "${truncate_(S.name, 90)}")` : ' (the same story)';
    const trig = sr === 'same' ? amTriggers_(stakes, S.st, S.tg) : [];
    if (!trig.length) return { skip: `folded into ${se.id}${name}`, kind: 'story', ref: se.id, fold: true, story: S.id };
    const exempt = trig.some(x => AM_EXEMPT_TIERS_.indexOf(x) >= 0);
    const last = Number(S.lu) || 0;
    if (!exempt && last && t - last < AM_UPDATE_GAP_MS_) {
      return { skip: `folded into ${se.id}${name}; its update went out ${Math.max(1, Math.round((t - last) / 60000))} min ago`,
        kind: 'story', ref: se.id, fold: true, story: S.id, held: trig };
    }
    if (update) {
      update.tiers = Array.from(new Set(update.tiers.concat(trig)));
      update.story = S.id;
    } else {
      update = { kind: 'story', tiers: trig, ref: se.id, rel: se, story: S.id };
    }
  }
  return update ? { skip: '', update } : null;
}

/** Why the shared memory holds this alert's Social Alert back ('' when it doesn't), from review.memory. Drafts.gs aiVeto_. */
function memorySkip_(review, esc) {
  const F = review && review.memory;
  if (!F || !F.on) return '';
  const v = amVerdict_(F, esc, F.at);
  F.verdict = v;
  return v && v.skip ? v.skip : '';
}

/** memorySkip_ for the same post's Social Alert only (a repeat: no T&S form either); '' for a story fold or cross-flow live pair. */
function memoryRepeat_(review, esc) {
  const why = memorySkip_(review, esc);
  const v = review && review.memory && review.memory.verdict;
  return why && v && v.kind !== 'story' && v.kind !== 'live' ? why : '';
}

/** The update the memory allows (the stakes rose over the earlier email), or null. */
function memoryUpdate_(review, esc) {
  if (memorySkip_(review, esc)) return null;
  const v = review && review.memory && review.memory.verdict;
  return (v && v.update) || null;
}

/** An earlier email the memory keeps, as the Alert-log row an update replies on (Drafts.gs escalationFor_). Pure. */
function amRelatedRow_(e, name, tag) {
  const row = { alert_id: e.id, email_status: 'sent', email_thread: e.th, email_message_id: e.mid || '', email_subject: e.sub || '',
    created_at: Number(e.at) || 0, exposure_tag: tag || '', fields: { issue_name: name || e.nm || '', product: e.pr || '' }, from_memory: true };
  if (Array.isArray(e.tm) && e.tm.length) {
    row.team_emails = e.tm.map(x => ({ key: x.k, thread: x.th, message_id: x.mid || '', subject: x.sub || '', status: 'sent' }));
  }
  return row;
}

/**
 * The earlier emails the memory knows for this alert (review.memory), as rows to reply on: {post: the same post's
 * Social Alert, story: its story's, ongoing: a story alerted in the last 14 days, or the post emailed}. Only an email
 * that went out on a thread, sent the same way (a live alert never replies on a test email, nor a test one on a live).
 */
function memoryRelated_(review) {
  const F = review && review.memory;
  const out = { post: null, story: null, ongoing: false };
  if (!F || !F.on) return out;
  const usable = e => !!e && e.o === 'e' && !!e.th && !!e.lv === !!F.lv &&
    String(e.tf || '') === String(F.tf || '') && (!F.id || e.id !== F.id);
  const pe = F.post && F.post.e;
  if (usable(pe) && F.at - Math.max(Number(F.post.le) || 0, Number(pe.at) || 0) <= AM_POST_EMAIL_MS_) {
    out.post = amRelatedRow_(pe, pe.nm, '');
  }
  const S = F.story && F.story.rec;
  if (S && usable(S.e)) out.story = amRelatedRow_(S.e, S.name || S.e.nm, S.tag);
  out.ongoing = !!F.story || !!(pe && pe.id);
  return out;
}

/** The issue an alert belongs to by the memory's story (rule novelty), as IssueNames.gs existingIssueOf_ gives one, or null. */
function memoryIssue_(story) {
  if (!story || !story.issue_name) return null;
  return { name: story.issue_name, by: 'story', why: 'the same story as an issue already alerted under that name',
    ref: story.alert_id || '' };
}

// ---------------------------------------------------------------------------------------------------------------
// The memory itself
// ---------------------------------------------------------------------------------------------------------------

/** Is this the tab the bot made for its memory? Its header row is the bot's own (a tab people made never matches). */
function isAlertMemoryTab_(sh) {
  if (!sh || sh.getLastRow() < 1) return false;
  return JSON.stringify(sh.getRange(1, 1, 1, AM_HEADER_.length).getValues()[0].map(v => String(v).trim())) ===
    JSON.stringify(AM_HEADER_);
}

function amNewPost_(key) {
  return { k: key, f: 0, l: 0, ids: [], fl: '', lm: [], o: 's', s: '', e: null, le: 0, tg: [], st: null, u: [], cl: null,
    url: '', a: '', n: '', g: null };
}

function amPostExpired_(p, t) {
  const emailed = p.e ? Math.max(Number(p.le) || 0, Number(p.e.at) || 0) : 0;
  if (emailed && t - emailed <= AM_KEEP_MS_) return false;
  return t - Math.max(Number(p.l) || 0, Number(p.cl && p.cl.at) || 0, emailed) > AM_SEEN_KEEP_MS_;
}

function amStoryExpired_(s, t) {
  return t - Math.max(Number(s.al) || 0, Number(s.le) || 0, Number(s.e && s.e.at) || 0, Number(s.f) || 0) > AM_KEEP_MS_;
}

/** A row's JSON, under the cell cap (its lists cut first). Pure. */
function amCellJson_(obj) {
  let s = JSON.stringify(obj);
  if (s.length <= AM_CELL_MAX_) return s;
  const o = JSON.parse(s);
  ['ids', 'lm', 'u', 'fk', 'tok'].forEach(k => { if (Array.isArray(o[k])) o[k] = o[k].slice(-2); });
  s = JSON.stringify(o);
  return s.length <= AM_CELL_MAX_ ? s : JSON.stringify({ f: o.f || 0, l: o.l || 0, o: o.o || 's', e: o.e || null });
}

function makeAlertMemory_(ss, opts) {
  const o = opts || {};
  const S = { loaded: false, ok: true, problem: '', tab: null, inTab: new Set(), stale: 0, seeded: false };
  const posts = new Map();      // post key -> post
  const stories = new Map();    // 'story:<lead post key>' -> story (vec: its vector, decoded)
  const liveIdx = new Map();    // live S-F Burson message -> the Social Alert it got {id, fl, lv, at, o}
  const dirty = new Set();      // keys to write
  const textVecs = new Map();   // story text -> vector | null, this run
  const claims = new Map();     // alert id -> its claim this run
  const updates = new Map();    // alert id -> the update its send check allowed (claimSend records its tiers)
  const counts = { held: 0, folded: 0, updates: 0 };
  let embeds = 0;
  const now = () => Date.now();
  const props = () => PropertiesService.getScriptProperties();
  const touch = key => { if (key) dirty.add(key); };
  const uniqPush = (list, v, max) => {
    const out = (Array.isArray(list) ? list : []).filter(x => x !== v);
    if (v) out.push(v);
    return out.slice(-(max || AM_IDS_KEPT_));
  };
  const outcome = (a, b) => ((AM_OUTCOME_RANK_[b] || 0) > (AM_OUTCOME_RANK_[a] || 0) ? b : (a || b || 's'));

  // -------------------------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------------------------

  function noteProblem(text) {
    console.warn(`alert memory: ${text}; every alert is decided as before until it can be read`);
    try { props().setProperty(AM_PROBLEM_PROP_, JSON.stringify({ at: now(), text: truncate_(text, 200) })); } catch (e) {}
  }

  function load() {
    if (S.loaded) return S.ok;
    S.loaded = true;
    try {
      const sh = ss.getSheetByName(AM_TAB_);
      if (sh) {
        if (!isAlertMemoryTab_(sh)) {
          throw new Error(`a tab named "${AM_TAB_}" that the bot didn't make is in its sheet (rename it, and the bot makes its own)`);
        }
        S.tab = sh;
        const last = sh.getLastRow();
        const t = now();
        if (last >= 2) {
          sh.getRange(2, 1, last - 1, AM_HEADER_.length).getValues().forEach(r => {
            const key = String(r[0] === undefined || r[0] === null ? '' : r[0]).trim();
            let data = null;
            try { data = JSON.parse(String(r[1] || '')); } catch (e) { data = null; }
            if (!key || !data || typeof data !== 'object' || Array.isArray(data)) { S.stale++; return; }
            if (key.indexOf('story:') === 0) {
              const vs = String(r[2] || '');
              const s = Object.assign(data, { id: key, vs, vec: vs && typeof vecDecode_ === 'function' ? vecDecode_(vs) : null });
              if (amStoryExpired_(s, t) || stories.has(key)) { S.stale++; return; }
              stories.set(key, s);
            } else {
              const p = Object.assign(amNewPost_(key), data, { k: key });
              if (amPostExpired_(p, t) || posts.has(key)) { S.stale++; return; }
              posts.set(key, p);
            }
            S.inTab.add(key);
          });
        }
      }
      posts.forEach(p => { if (p.e && p.e.lm) setLive(p.e.lm, p.e); });
      readClaims().forEach(c => applyClaim(c));
      try { props().deleteProperty(AM_PROBLEM_PROP_); } catch (e) {}
      const queued = S.queued || [];
      S.queued = null;
      queued.forEach(rows => applySeedSafe(rows));
      return true;
    } catch (e) {
      S.ok = false;
      S.problem = String((e && e.message) || e);
      S.queued = null;
      noteProblem(S.problem);
      return false;
    }
  }

  function setLive(name, e) {
    if (!name || !e || !e.id) return;
    const cur = liveIdx.get(name);
    if (cur && cur.id !== e.id && !(e.lv && !cur.lv) && (Number(cur.at) || 0) <= (Number(e.at) || 0)) return;  // the first stays
    liveIdx.set(name, { id: e.id, fl: e.fl || '', lv: !!e.lv, at: Number(e.at) || 0, o: e.o || 'c' });
  }

  function post(key, create) {
    let p = posts.get(key) || null;
    if (!p && create) {
      p = amNewPost_(key);
      posts.set(key, p);
    }
    return p;
  }

  /**
   * The Alert log's rows (every space's, as a flow's store read them): what they say the memory may not know yet (a
   * run that stopped before its memory was written; the alerts from before the memory). Kept until the memory is read.
   */
  function seedRows(rows) {
    if (!S.loaded) {
      (S.queued = S.queued || []).push(rows || []);
      return;
    }
    if (S.ok) applySeedSafe(rows);
  }

  function applySeedSafe(rows) {
    try {
      applySeed(rows);
    } catch (e) {
      console.warn('alert memory: couldn\'t read what the Alert log says: ' + ((e && e.message) || e));
    }
  }

  function applySeed(rows) {
    const t = now();
    const seen = S.seededIds || (S.seededIds = new Set());
    (rows || []).forEach(r => {
      if (!r || !r.alert_id || seen.has(String(r.alert_id))) return;
      if (typeof SHEET_TEST_INGESTED_ === 'string' && r.ingested === SHEET_TEST_INGESTED_) return;
      seen.add(String(r.alert_id));
      const at = Number(r.created_at) || 0;
      if (!at || t - at > AM_KEEP_MS_) return;
      const st = String(r.email_status || '');
      const emailed = st === 'sent' || st === 'drafted';
      const key = amRowKey_(r);
      let p = key ? posts.get(key) || null : null;
      if (key && !p && (emailed || st === 'pending' || t - at <= AM_SEEN_KEEP_MS_)) {
        p = amNewPost_(key);
        p.seed = true;
        posts.set(key, p);
      }
      const ff = r.forwarded_fields && typeof r.forwarded_fields === 'object' ? r.forwarded_fields : {};
      if (p) {
        p.f = p.f ? Math.min(p.f, at) : at;
        p.l = Math.max(Number(p.l) || 0, at);
        if (p.seed) {
          p.ids = uniqPush(p.ids, String(r.alert_id));
          const fl = amFlowOf_(r.space);
          if (fl && String(p.fl || '').indexOf(fl) < 0) p.fl = String(p.fl || '') + fl;
          p.lm = uniqPush(p.lm, amRowLive_(r), 4);
          if (!p.url && ff.post_url) p.url = truncate_(String(ff.post_url), 300);
          if (!p.a && ff.author) p.a = truncate_(String(ff.author), 80);
          if (!p.n && ff.social_network) p.n = truncate_(String(ff.social_network), 30);
          if (Number.isInteger(ff.total_engagement)) p.g = Math.max(Number(p.g) || 0, ff.total_engagement);
        }
        const lv = st === 'drafted' || String(r.email_status) === 'drafted' || String(r.email_sent_by || '') === 'bot' || !!r.email_draft;
        const mail = emailed ? amEmailOfRow_(r, lv) : null;
        const replaceSeed = Boolean(mail && p.seed && p.e && p.e.id !== mail.id && ((p.e.tf && !mail.tf) ||
          (String(p.e.tf || '') === String(mail.tf || '') && Number(p.e.at) > mail.at)));
        if (mail && (!p.e || replaceSeed)) {  // a seeded post: its first real email
          p.e = mail;
          p.le = Math.max(Number(p.le) || 0, p.e.at);
          p.st = amMergeStakes_(p.st, amStakes_((r.email_input || {}).escalation, amRowFields_(r)));
          p.o = outcome(p.o, p.e.o);
          if (p.e.lm) setLive(p.e.lm, p.e);
        } else if (st === 'pending') {
          p.o = outcome(p.o, 'p');
        }
      }
      if ((emailed || st === 'pending') && !(p && p.s && stories.has(p.s) &&
          String(stories.get(p.s).tf || '') === amSyntheticFeedOf_(r.space))) seedStory(r, key, p, emailed);
    });
  }

  /**
   * The story of an Alert-log row the memory has none for: one already known whose words match (the same tag, issue
   * words alike), else a story of its own (word check only: no vector; written once something touches it).
   */
  function seedStory(r, key, p, emailed) {
    const f = amRowFields_(r);
    const at = Number(r.created_at) || 0;
    const tf = amSyntheticFeedOf_(r.space);
    const view = storyView(f);
    let s = null;
    let best = 0;
    stories.forEach(x => {
      if (String(x.tf || '') !== tf) return;
      const j = amSameStoryWords_(view, x);
      if (j > best) { best = j; s = x; }
    });
    if (!s) {
      const id = 'story:' + (tf ? 'tf:' + tf + '|' : '') + (key || 'id:' + r.alert_id);
      s = stories.get(id) || null;
      if (!s) {
        s = newStory(id, key, String(r.alert_id), f, null, tf);
        s.seed = true;
        stories.set(id, s);
      }
    }
    s.al = Math.max(Number(s.al) || 0, at);
    const lv = String(r.email_status) === 'drafted' || String(r.email_sent_by || '') === 'bot' || !!r.email_draft;
    const mail = emailed ? amEmailOfRow_(r, lv) : null;
    if (mail && s.seed && (!s.e || Number(s.e.at) > mail.at)) {  // a seeded story: its first email
      s.e = mail;
      if (!s.name && mail.nm) s.name = mail.nm;
    }
    if (mail && s.seed) {
      s.le = Math.max(Number(s.le) || 0, mail.at);
      s.st = amMergeStakes_(s.st, amStakes_((r.email_input || {}).escalation, f));
    }
    if (p && !p.s) p.s = s.id;
  }

  function newStory(id, key, alertId, fields, vec, tf) {
    const f = fields || {};
    const view = storyView(f);
    const out = { id, f: now(), lead: key || '', lid: alertId || '', name: truncate_(typeof issueNameText_ === 'function'
      ? issueNameText_(f.issue_name) : String(f.issue_name || ''), 200), tag: view.tag, prod: view.prod,
    tok: view.tok.slice(0, 16), idt: view.idt, al: 0, e: null, le: 0, lu: 0, tg: [], st: null, fo: 0, fk: [], vec: vec || null,
    vs: vec && typeof vecEncode_ === 'function' ? vecEncode_(vec) : '' };
    if (tf) out.tf = tf;
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Stories
  // -------------------------------------------------------------------------------------------------------------

  function storyView(fields) {
    const f = fields || {};
    const text = amStoryText_(f);
    const authors = [f.author, f.post_url && typeof authorFromUrl_ === 'function' ? authorFromUrl_(String(f.post_url)) : ''];
    const name = typeof issueNameText_ === 'function' ? issueNameText_(f.issue_name) : String(f.issue_name || '');
    return { text, tag: amTag_(f.exposure_tag), prod: amProduct_(f.product), tok: issueTokens_(name || ''),
      idt: amIdents_(text, authors) };
  }

  function vecFor(text, deadline) {
    if (!text) return null;
    if (textVecs.has(text)) return textVecs.get(text);
    if (embeds >= AM_EMBED_MAX_ || typeof embedTexts_ !== 'function') return null;
    embeds++;
    let v = null;
    try { v = (embedTexts_([text], { deadline: Number(deadline) || Number(o.deadline) || 0 }) || [])[0] || null; } catch (e) { v = null; }
    textVecs.set(text, v);
    return v;
  }

  /** The story `fields` tell among those alerted (or, mo.emailed, emailed) since mo.since: {story, sim, how}, or null. */
  function match(fields, mo) {
    const view = storyView(fields);
    if (!view.text) return null;
    const since = Number(mo.since) || 0;
    const tf = String(mo.tf || '');
    const cands = [];
    stories.forEach(s => {
      if (String(s.tf || '') !== tf) return;
      const emailedAt = s.e ? Math.max(Number(s.le) || 0, Number(s.e.at) || 0) : 0;
      if (mo.emailed ? (emailedAt && emailedAt >= since) : Math.max(Number(s.al) || 0, emailedAt) >= since) cands.push(s);
    });
    if (!cands.length) return null;
    const vec = cands.some(s => s.vec) ? vecFor(view.text, mo.deadline) : null;
    let best = null;
    if (vec) {
      cands.forEach(s => {
        if (!s.vec) return;
        const sim = vecCos_(vec, s.vec);
        if (amSameStory_(sim, view, s) && (!best || sim > best.sim)) best = { story: s, sim, how: 'vector' };
      });
    }
    if (!best) {
      cands.forEach(s => {
        if (vec && s.vec) return;  // both have a vector: their meaning already said no
        const j = amSameStoryWords_(view, s);
        if (j && (!best || j > best.sim)) best = { story: s, sim: j, how: 'words' };
      });
    }
    if (best) best.view = view;
    return best;
  }

  function matchOut(m) {
    if (!m) return null;
    const s = m.story;
    const emailedAt = s.e ? Math.max(Number(s.le) || 0, Number(s.e.at) || 0) : 0;
    return { story: s.id, issue_name: s.name || (s.e && s.e.nm) || '', alert_id: (s.e && s.e.id) || s.lid || '',
      sim: Math.round(m.sim * 1000) / 1000, how: m.how, emailed_at: emailedAt, alerted_at: Number(s.al) || 0, id: s.id, rec: s };
  }

  /** A post whose Social Alert is decided (pending): the story it's on (a new one it leads, with its vector, when none). */
  function assignStory(key, row) {
    const p = posts.get(key);
    if (!p) return;
    const t = now();
    const tf = amSyntheticFeedOf_(row && row.space);
    if (p.s && stories.has(p.s) && String(stories.get(p.s).tf || '') === tf) {
      const s = stories.get(p.s);
      s.al = Math.max(Number(s.al) || 0, t);
      delete s.seed;
      touch(s.id);
      return;
    }
    const fields = amRowFields_(row);
    // the story emailed in the last 24 hours it tells first (the one its decision was checked against), else any alerted
    const m = match(fields, { since: t - AM_STORY_FOLD_MS_, emailed: true, tf }) || match(fields, { since: t - AM_NOVELTY_MS_, tf });
    if (m) {
      p.s = m.story.id;
      m.story.al = Math.max(Number(m.story.al) || 0, t);
      delete m.story.seed;
      touch(m.story.id);
      return;
    }
    const s = newStory('story:' + (tf ? 'tf:' + tf + '|' : '') + key, key, String(row.alert_id || ''), fields,
      vecFor(amStoryText_(fields)), tf);
    s.al = t;
    if (!s.name && !s.tok.length && !s.vec) return;  // nothing to tell its story by
    stories.set(s.id, s);
    p.s = s.id;
    touch(s.id);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Claims: a send noted before Gmail is asked (durable at once, in a script property, until the tab has it)
  // -------------------------------------------------------------------------------------------------------------

  function readClaims() {
    try {
      const v = JSON.parse(props().getProperty(AM_CLAIMS_PROP_) || '[]');
      return Array.isArray(v) ? v.filter(c => c && c.id) : [];
    } catch (e) {
      return [];
    }
  }

  function writeClaims() {
    try {
      const t = now();
      const mine = Array.from(claims.values());
      const old = readClaims().filter(c => !claims.has(c.id) && t - (Number(c.at) || 0) <= 2 * AM_DAY_MS_);
      let list = old.concat(mine).slice(-AM_CLAIMS_MAX_);
      let s = JSON.stringify(list);
      while (s.length > AM_CLAIMS_MAX_CHARS_ && list.length > 1) {
        list = list.slice(1);
        s = JSON.stringify(list);
      }
      props().setProperty(AM_CLAIMS_PROP_, s);
    } catch (e) {
      console.warn('alert memory: couldn\'t note a send first: ' + ((e && e.message) || e));
    }
  }

  function emailRec(c) {
    const out = { id: c.id, at: c.at, o: c.o || 'c', lv: !!c.lv, fl: c.fl || '', lm: c.l || '' };
    if (c.tf) out.tf = c.tf;
    return out;
  }

  function applyClaim(c) {
    const p = c.k ? post(c.k, true) : null;
    if (p) {
      delete p.seed;
      const e = p.e;
      if (!e || (c.lv && !e.lv) || (e.tf && !c.tf)) {  // the post's first email (a live or real-feed one replaces a synthetic test one)
        p.e = emailRec(c);
        p.st = c.st || null;
        p.tg = [];
        p.u = [];
        p.le = c.at;
      } else if (e.id === c.id) {
        e.o = outcome(e.o, c.o || 'c');
      } else if (!!e.lv === !!c.lv && String(e.tf || '') === String(c.tf || '')) {  // an update on it
        p.tg = Array.from(new Set((p.tg || []).concat(c.tg || [])));
        p.st = amMergeStakes_(p.st, c.st);
        p.le = Math.max(Number(p.le) || 0, c.at);
        if (!(p.u || []).some(x => x.id === c.id)) p.u = (p.u || []).concat([{ id: c.id, at: c.at, tg: c.tg || [] }]).slice(-6);
      }
      p.o = outcome(p.o, c.o || 'c');
      if ((!p.s || (stories.has(p.s) && stories.get(p.s).tf && !c.tf)) && c.s) p.s = c.s;
      touch(c.k);
    }
    if (c.l) setLive(c.l, emailRec(c));
    const s = c.s ? stories.get(c.s) : (p && p.s ? stories.get(p.s) : null);
    if (s && String(s.tf || '') === String(c.tf || '')) {
      delete s.seed;
      const e = s.e;
      if (!e || (c.lv && !e.lv)) {
        s.e = emailRec(c);
        s.st = c.st || null;
        s.tg = [];
        s.le = c.at;
        s.lu = 0;
      } else if (e.id === c.id) {
        e.o = outcome(e.o, c.o || 'c');
      } else if (!!e.lv === !!c.lv) {
        s.tg = Array.from(new Set((s.tg || []).concat(c.tg || [])));
        s.st = amMergeStakes_(s.st, c.st);
        s.le = Math.max(Number(s.le) || 0, c.at);
        if ((c.tg || []).length) s.lu = Math.max(Number(s.lu) || 0, c.at);
      }
      s.al = Math.max(Number(s.al) || 0, c.at);
      touch(s.id);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // The API
  // -------------------------------------------------------------------------------------------------------------

  const api = {
    active: true,
    get ok() { load(); return S.ok; },
    get problem() { return S.problem; },

    seenPost(url, opts) {
      const key = amPostKey_(url);
      if (!key || !load()) return null;
      const p = posts.get(key);
      if (!p) return null;
      const t = now();
      const hours = opts && Number(opts.hours) > 0 ? Number(opts.hours) : AM_SEEN_MS_ / AM_HOUR_MS_;
      const emailedAt = p.e && !p.e.tf ? Math.max(Number(p.le) || 0, Number(p.e.at) || 0) : 0;
      if (emailedAt && t - emailedAt <= AM_POST_EMAIL_MS_) {
        return { why: `its Social Alert already went out (${p.e.id})`, alert_id: p.e.id, at: emailedAt, outcome: 'emailed' };
      }
      const seenAt = Math.max(Number(p.l) || 0, Number(p.cl && p.cl.at) || 0);
      if (seenAt && t - seenAt <= hours * AM_HOUR_MS_) {
        const claimed = !!(p.cl && Number(p.cl.at) >= (Number(p.l) || 0) && !(p.ids || []).length);
        const id = (p.ids || [])[(p.ids || []).length - 1] || '';
        // ids: the alerts that saw the post (the latest ones it keeps); claim: the producer whose card was posted for it
        return { why: claimed ? `a ${p.cl.by || 'producer'} card was already posted for it` : `already seen${id ? ` (${id})` : ''}`,
          alert_id: id, at: seenAt, outcome: claimed ? 'claimed' : 'seen', ids: (p.ids || []).map(String),
          claim: p.cl ? String(p.cl.by || 'producer') : '' };
      }
      return null;
    },

    claim(url, flow, info) {
      const key = amPostKey_(url);
      if (!key || !load()) return true;
      if (api.seenPost(url)) return false;
      const t = now();
      const i = info || {};
      const p = post(key, true);
      delete p.seed;
      p.cl = { by: truncate_(String(flow || 'producer'), 20), at: t };
      p.f = p.f || t;
      if (!p.url) p.url = truncate_(String(url), 300);
      if (i.author && !p.a) p.a = truncate_(String(i.author), 80);
      if (i.network && !p.n) p.n = truncate_(String(i.network), 30);
      if (Number.isFinite(Number(i.engagement)) && i.engagement !== null && i.engagement !== '') p.g = Math.max(Number(p.g) || 0, Number(i.engagement));
      touch(key);
      return true;
    },

    storyMatch(fields, opts) {
      const q = opts || {};
      if (!load()) return null;
      const hours = Number(q.hours) > 0 ? Number(q.hours) : AM_NOVELTY_MS_ / AM_HOUR_MS_;
      return matchOut(match(fields || {}, { since: now() - hours * AM_HOUR_MS_, emailed: !!q.emailed,
        tf: String(q.tf || ''), deadline: q.deadline }));
    },

    /** What the memory knows for a decision (review.memory: amVerdict_). info {live, flow, lv, tf, id, deadline}. */
    facts(fields, info) {
      const i = info || {};
      if (!load()) return null;
      const f = fields || {};
      const t = now();
      const tf = String(i.tf || '');
      const key = amPostKey_(f.post_url) || (i.live ? 'msg:' + i.live : '');
      return {
        on: true, key, live: String(i.live || ''), flow: String(i.flow || ''), lv: !!i.lv, tf, id: String(i.id || ''), fields: f, at: t,
        post: key ? posts.get(key) || null : null,
        liveRec: i.live ? liveIdx.get(String(i.live)) || null : null,
        story: matchOut(match(f, { since: t - AM_NOVELTY_MS_, tf, deadline: i.deadline })),
        fold: matchOut(match(f, { since: t - AM_STORY_FOLD_MS_, emailed: true, tf, deadline: i.deadline })),
      };
    },

    /** The facts for an Alert-log row about to be emailed (its story: the one it's on, else the one its fields tell). */
    factsForRow(row, ctx) {
      if (!row || !load()) return null;
      const t = now();
      const key = amRowKey_(row);
      const p = key ? posts.get(key) || null : null;
      const fields = amRowFields_(row);
      const live = amRowLive_(row);
      const part = row.space || (ctx && ctx.partition) || '';
      const tf = amSyntheticFeedOf_(part);
      let fold = null;
      let story = null;
      const own = p && p.s && stories.has(p.s) && String(stories.get(p.s).tf || '') === tf ? stories.get(p.s) : null;
      if (own) {
        const emailedAt = own.e ? Math.max(Number(own.le) || 0, Number(own.e.at) || 0) : 0;
        story = { id: own.id, rec: own, issue_name: own.name, alert_id: (own.e && own.e.id) || own.lid || '' };
        if (emailedAt && t - emailedAt <= AM_STORY_FOLD_MS_) fold = story;
      }
      if (!own) {  // a row from before the memory knew it: the story its fields tell (one embedding, then remembered)
        story = matchOut(match(fields, { since: t - AM_NOVELTY_MS_, tf, deadline: ctx && ctx.deadline }));
        fold = matchOut(match(fields, { since: t - AM_STORY_FOLD_MS_, emailed: true, tf, deadline: ctx && ctx.deadline }));
        if (key && String(row.email_status || '') === 'pending') api.noteRow(row);
      }
      return { on: true, key, live, flow: amFlowOf_(part), lv: amCtxLive_(ctx), tf,
        id: String(row.alert_id || ''), fields, at: t, post: p, liveRec: live ? liveIdx.get(live) || null : null, story, fold };
    },

    sendCheck(row, ctx) {
      if (!row || !load()) return { ok: true };
      const F = api.factsForRow(row, ctx);
      const v = amVerdict_(F, (row.email_input || {}).escalation || {}, F && F.at);
      if (v && v.skip) return { ok: false, why: v.skip, kind: v.kind, ref: v.ref, fold: !!v.fold, story: v.story || '' };
      if (v && v.update) {
        updates.set(String(row.alert_id), v.update);
        return { ok: true, update: v.update };
      }
      updates.delete(String(row.alert_id));
      return { ok: true };
    },

    claimSend(row, ctx) {
      if (!row || !row.alert_id || !load()) return false;
      const id = String(row.alert_id);
      if (claims.has(id)) return true;
      const key = amRowKey_(row);
      const p = key ? posts.get(key) : null;
      const upd = updates.get(id) || null;
      const part = row.space || (ctx && ctx.partition) || '';
      const tf = amSyntheticFeedOf_(part);
      const c = { id, k: key, l: amRowLive_(row), at: now(), lv: amCtxLive_(ctx), fl: amFlowOf_(part),
        o: 'c', s: (upd && upd.story) || (p && p.s) || '', tg: upd ? upd.tiers.slice() : [],
        st: amStakes_((row.email_input || {}).escalation, amRowFields_(row)) };
      if (tf) c.tf = tf;
      applyClaim(c);
      claims.set(id, c);
      writeClaims();
      return true;
    },

    recordSend(row, ctx) {
      if (!row || !row.alert_id || !load()) return false;
      const id = String(row.alert_id);
      const key = amRowKey_(row);
      let p = key ? posts.get(key) : null;
      if (!claims.has(id) && !(p && p.e && p.e.id === id)) api.claimSend(row, ctx);
      p = key ? posts.get(key) : null;
      const info = amEmailOfRow_(row, amCtxLive_(ctx));
      const spaceId = ctx && ctx.spaces && ctx.spaces.analyst && ctx.spaces.analyst.id;
      if (spaceId) info.cs = String(spaceId);
      const sent = rec => {
        if (!rec || rec.id !== id) return;
        ['th', 'mid', 'sub', 'cs', 'ct', 'cm', 'nm', 'pr', 'tm'].forEach(k => { if (info[k]) rec[k] = info[k]; });
        rec.o = 'e';
      };
      if (p) {
        sent(p.e);
        p.o = outcome(p.o, 'e');
        touch(key);
      }
      const s = p && p.s ? stories.get(p.s) : null;
      if (s) {
        sent(s.e);
        if (!s.name && info.nm) s.name = info.nm;
        touch(s.id);
      }
      const L = info.lm ? liveIdx.get(info.lm) : null;
      if (L && L.id === id) L.o = 'e';
      const c = claims.get(id);
      if (c) {
        c.o = 'e';
        if ((c.tg || []).length) counts.updates++;
      }
      return true;
    },

    releaseSend(row) {
      if (!row || !row.alert_id || !load()) return false;
      const id = String(row.alert_id);
      const c = claims.get(id);
      const key = amRowKey_(row);
      const p = key ? posts.get(key) : null;
      const drop = (holder, k) => {
        if (holder[k] && holder[k].id === id && holder[k].o !== 'e') {
          holder[k] = null;
          holder.tg = [];
          holder.st = null;
          holder.le = 0;
          return true;
        }
        return false;
      };
      if (p) {
        if (!drop(p, 'e') && c && (c.tg || []).length) {
          p.tg = (p.tg || []).filter(x => c.tg.indexOf(x) < 0);
          p.u = (p.u || []).filter(x => x.id !== id);
        }
        touch(key);
      }
      const s = p && p.s ? stories.get(p.s) : null;
      if (s) {
        if (!drop(s, 'e') && c && (c.tg || []).length) s.tg = (s.tg || []).filter(x => c.tg.indexOf(x) < 0);
        touch(s.id);
      }
      const live = amRowLive_(row);
      if (live && liveIdx.get(live) && liveIdx.get(live).id === id) liveIdx.delete(live);
      if (c) {
        claims.delete(id);
        writeClaims();
      }
      return true;
    },

    seedRows,

    /** An Alert-log row a flow just added (Store.gs addAlert): seen; its story when its Social Alert is decided. */
    noteRow(row) {
      if (!row || !row.alert_id || !load()) return;
      const pending = String(row.email_status || '') === 'pending';
      const key = amRowKey_(row) || (pending ? 'id:' + row.alert_id : '');
      if (!key) return;
      const t = Number(row.created_at) || now();
      const p = post(key, true);
      delete p.seed;
      p.f = p.f || t;
      p.l = Math.max(Number(p.l) || 0, t);
      p.ids = uniqPush(p.ids, String(row.alert_id));
      const fl = amFlowOf_(row.space);
      if (fl && String(p.fl || '').indexOf(fl) < 0) p.fl = String(p.fl || '') + fl;
      p.lm = uniqPush(p.lm, amRowLive_(row), 4);
      const ff = row.forwarded_fields && typeof row.forwarded_fields === 'object' ? row.forwarded_fields : {};
      if (ff.post_url) p.url = truncate_(String(ff.post_url), 300);
      if (ff.author) p.a = truncate_(String(ff.author), 80);
      if (ff.social_network) p.n = truncate_(String(ff.social_network), 30);
      if (Number.isInteger(ff.total_engagement)) p.g = Math.max(Number(p.g) || 0, ff.total_engagement);
      if (pending) {
        p.o = outcome(p.o, 'p');
        assignStory(key, row);
      }
      touch(key);
    },

    /**
     * The posts a story's card links (step 3a of the new sources: EarlyDetection.gs edNoteMembers_), each seen by the
     * card's Alert-log row `row` exactly as its main post is (noteRow): the card's id among the alerts that saw it, its
     * time and its flow. So the Watch and the Direct BigQuery poll treat a linked post as they treat the main post: where
     * stories go first, a card that sent no Social Alert is still no post's own alert (BigQuery.gs bqOnlyStoryCards_),
     * and one that went out as a Social Alert is the alert on each. Not a producer's claim, which those checks would take
     * for the post's own card. `urls`: the card's post links (its main post and repeats are left out). How many were
     * noted. Never throws.
     */
    notePosts(row, urls) {
      try {
        if (!row || !row.alert_id || !load()) return 0;
        const own = amRowKey_(row);
        const t = Number(row.created_at) || now();
        const fl = amFlowOf_(row.space);
        const done = new Set();
        (Array.isArray(urls) ? urls : []).forEach(u => {
          const key = u ? amPostKey_(u) : '';
          if (!key || key === own || done.has(key)) return;
          done.add(key);
          const p = post(key, true);
          delete p.seed;
          p.f = p.f || t;
          p.l = Math.max(Number(p.l) || 0, t);
          p.ids = uniqPush(p.ids, String(row.alert_id));
          if (fl && String(p.fl || '').indexOf(fl) < 0) p.fl = String(p.fl || '') + fl;
          if (!p.url) p.url = truncate_(String(u), 300);
          touch(key);
        });
        return done.size;
      } catch (e) {
        return 0;
      }
    },

    /** A Social Alert the memory held back (v: amVerdict_'s): counted; a fold is listed on its story. */
    noteHeld(row, v) {
      if (!v || !load()) return;
      counts.held++;
      if (!v.fold) return;
      counts.folded++;
      const s = v.story ? stories.get(v.story) : null;
      const key = amRowKey_(row);
      const p = key ? posts.get(key) : null;
      if (p) {
        delete p.seed;
        p.o = outcome(p.o, 'f');
        if (!p.s && s) p.s = s.id;
        touch(key);
      }
      if (s) {
        s.fo = (Number(s.fo) || 0) + 1;
        s.fk = uniqPush(s.fk, key || String((row && row.alert_id) || ''), 10);
        delete s.seed;
        touch(s.id);
      }
    },

    storyRec(id) { return load() ? stories.get(String(id || '')) || null : null; },

    /** The stories emailed lately whose alert's thread is in `spaceId`, newest first (Watch alerts: a flag can join one). */
    recentStories(spaceId, hours, max) {
      if (!spaceId || !load()) return [];
      const t = now();
      const out = [];
      stories.forEach(s => {
        const e = s.e;
        if (!e || e.o !== 'e' || !e.ct || !e.cm || String(e.cs || '') !== String(spaceId)) return;
        if (t - Math.max(Number(s.le) || 0, Number(e.at) || 0) > (Number(hours) || 24) * AM_HOUR_MS_) return;
        const lead = s.lead ? posts.get(s.lead) : null;
        out.push({ m: e.cm, thread: e.ct, at: Number(e.at) || 0, story: s.name || '', id: e.id, kof: !!(s.st && s.st.k),
          eng: Number(s.st && s.st.g) || 0, author: (lead && lead.a) || '', network: (lead && lead.n) || '' });
      });
      return out.sort((a, b) => b.at - a.at).slice(0, Number(max) || 5);
    },

    /**
     * For each vector in `vecs` (a post's text, embedded; a missing one gets []), the stories alerted since q.hours ago
     * that are closest to it in meaning (q.k of them, from q.minSim up; only stories that have a vector): [{sid, name,
     * alert_id, at, sim, kof, eng (its alerts' highest stakes, false / 0 when unknown)}]. Candidates only: whether a
     * post tells one of them is storyMatch's test, or a reader's.
     */
    nearStories(vecs, opts) {
      const q = opts || {};
      const list = vecs || [];
      if (!load()) return list.map(() => []);
      const since = now() - (Number(q.hours) > 0 ? Number(q.hours) : AM_NOVELTY_MS_ / AM_HOUR_MS_) * AM_HOUR_MS_;
      const tf = String(q.tf || '');
      const k = Number(q.k) > 0 ? Number(q.k) : 3;
      const minSim = Number(q.minSim) > 0 ? Number(q.minSim) : 0.7;
      const cands = [];
      stories.forEach(s => {
        if (String(s.tf || '') !== tf || !s.vec) return;
        const at = Math.max(Number(s.al) || 0, s.e ? Math.max(Number(s.le) || 0, Number(s.e.at) || 0) : 0);
        if (at >= since) cands.push({ s, at });
      });
      return list.map(v => {
        if (!v || !cands.length) return [];
        return cands.map(c => ({ c, sim: vecCos_(v, c.s.vec) })).filter(x => x.sim >= minSim)
          .sort((a, b) => b.sim - a.sim).slice(0, k)
          .map(x => ({ sid: x.c.s.id, name: x.c.s.name || (x.c.s.e && x.c.s.e.nm) || '', alert_id: (x.c.s.e && x.c.s.e.id) || x.c.s.lid || '',
            at: x.c.at, sim: Math.round(x.sim * 1000) / 1000, kof: !!(x.c.s.st && x.c.s.st.k), eng: Number(x.c.s.st && x.c.s.st.g) || 0 }));
      });
    },

    counts() { return Object.assign({}, counts); },

    flush() {
      if (!S.loaded || !S.ok) return null;
      saveDay();
      const t = now();
      posts.forEach((p, k) => { if (amPostExpired_(p, t)) { posts.delete(k); if (S.inTab.has(k)) S.stale++; dirty.delete(k); } });
      stories.forEach((s, k) => { if (amStoryExpired_(s, t)) { stories.delete(k); if (S.inTab.has(k)) S.stale++; dirty.delete(k); } });
      const keep = Array.from(dirty).filter(k => (posts.has(k) && !posts.get(k).seed) || (stories.has(k) && !stories.get(k).seed));
      if (!keep.length && S.stale < AM_REWRITE_STALE_) return { written: 0 };
      let sh = S.tab || ss.getSheetByName(AM_TAB_);
      if (sh && !isAlertMemoryTab_(sh)) {
        noteProblem(`a tab named "${AM_TAB_}" that the bot didn't make is in its sheet: nothing written`);
        return null;
      }
      if (!sh) sh = makeTab();
      const cellOf = key => {
        if (stories.has(key)) {
          const s = stories.get(key);
          const data = Object.assign({}, s);
          ['id', 'vec', 'vs', 'seed'].forEach(x => delete data[x]);
          return [key, amCellJson_(data), s.vs || (s.vec && typeof vecEncode_ === 'function' ? vecEncode_(s.vec) : '')];
        }
        const p = posts.get(key);
        const data = Object.assign({}, p);
        ['k', 'seed'].forEach(x => delete data[x]);
        return [/^[=+\-@']/.test(key) ? "'" + key : key, amCellJson_(data), ''];
      };
      let written = 0;
      if (S.stale >= AM_REWRITE_STALE_ || keep.length > AM_REWRITE_DIRTY_) {
        const values = [AM_HEADER_.slice()];
        posts.forEach((p, k) => { if (!p.seed) values.push(cellOf(k)); });
        stories.forEach((s, k) => { if (!s.seed) values.push(cellOf(k)); });
        sh.clearContents();
        sh.getRange(1, 1, values.length, AM_HEADER_.length).setValues(values);
        S.inTab = new Set(values.slice(1).map(v => String(v[0]).replace(/^'/, '')));
        S.stale = 0;
        written = values.length - 1;
      } else {
        const last = sh.getLastRow();
        const at = new Map();
        if (last >= 2) {
          sh.getRange(2, 1, last - 1, 1).getValues().forEach((r, i) => {
            const k = String(r[0] === undefined || r[0] === null ? '' : r[0]).trim();
            if (k && !at.has(k)) at.set(k, i + 2);
          });
        }
        const appends = [];
        keep.forEach(k => {
          const cells = cellOf(k);
          if (at.has(k)) sh.getRange(at.get(k), 1, 1, AM_HEADER_.length).setValues([cells]);
          else appends.push(cells);
          S.inTab.add(k);
        });
        if (appends.length) sh.getRange(Math.max(1, sh.getLastRow()) + 1, 1, appends.length, AM_HEADER_.length).setValues(appends);
        written = keep.length;
      }
      dirty.clear();
      try { if (claims.size || readClaims().length) props().deleteProperty(AM_CLAIMS_PROP_); } catch (e) {}
      return { written };
    },
  };

  function makeTab() {
    const sh = ss.insertSheet(AM_TAB_);
    sh.getRange(1, 1, 1, AM_HEADER_.length).setValues([AM_HEADER_]);
    try {
      sh.protect().setDescription('Written by the Burson QA bot: the alerts it handled and the Social Alerts it sent, so no post ' +
        'or story is emailed twice').setWarningOnly(true);
    } catch (e) {}
    try { sh.hideSheet(); } catch (e) {}
    S.tab = sh;
    return sh;
  }

  function saveDay() {
    if (!counts.held && !counts.updates) return;
    try {
      const day = typeof dayKey_ === 'function' ? dayKey_() : '';
      let d = null;
      try { d = JSON.parse(props().getProperty(AM_DAY_PROP_) || 'null'); } catch (e) { d = null; }
      if (!d || d.day !== day) d = { day, held: 0, folded: 0, updates: 0 };
      d.held += counts.held;
      d.folded += counts.folded;
      d.updates += counts.updates;
      props().setProperty(AM_DAY_PROP_, JSON.stringify(d));
      counts.held = 0;
      counts.folded = 0;
      counts.updates = 0;
    } catch (e) {}
  }

  return api;
}

// ---------------------------------------------------------------------------------------------------------------
// What the flows call
// ---------------------------------------------------------------------------------------------------------------

/**
 * The live S-F Burson message a message `m` is in this flow ('' for none): the Mirror's pair (Bot.gs livePairFields_),
 * or the message itself where the flow reads S-F Burson directly (the Auto-correct space; a Burson space that is S-F
 * Burson). Never throws.
 */
function amLiveOf_(ctx, m) {
  try {
    if (!ctx || !m || !m.name) return '';
    if (ctx.outboundBlocked) return String((typeof livePairFields_ === 'function' ? livePairFields_(ctx, m) : {}).live_message || '');
    const burson = ctx.spaces && ctx.spaces.burson && ctx.spaces.burson.id;
    if (burson && (ctx.sourceReadOnly || (typeof isSfBurson_ === 'function' && isSfBurson_(ctx.sfBurson, burson))) &&
        String(m.name).indexOf(burson + '/messages/') === 0) return String(m.name);
    return '';
  } catch (e) {
    return '';
  }
}

/** The story a reviewed alert's fields tell among those alerted in the last 14 days (rule novelty), or null. Never throws. */
function amNoveltyFor_(ctx, fields) {
  const mem = amOf_(ctx);
  if (!mem.active) return null;
  try {
    const m = mem.storyMatch(fields || {}, { tf: amSyntheticFeedOf_(ctx && ctx.partition), deadline: ctx && ctx.deadline });
    if (m && ctx && typeof ctx.log === 'function') {
      ctx.log(`alert memory: the same story as ${m.alert_id || 'an alert'} ("${truncate_(m.issue_name, 80)}", ${m.how} ${m.sim})`);
    }
    return m;
  } catch (e) {
    if (ctx && typeof ctx.log === 'function') ctx.log(`alert memory: the story check failed: ${(e && e.message) || e}`);
    return null;
  }
}

/** What the memory knows for a decision on `fields` in this flow (review.memory), or null. info {live}. Never throws. */
function amFactsFor_(ctx, fields, info) {
  const mem = amOf_(ctx);
  if (!mem.active) return null;
  try {
    return mem.facts(fields || {}, Object.assign({ flow: amFlowOf_(ctx && ctx.partition), lv: amCtxLive_(ctx),
      tf: amSyntheticFeedOf_(ctx && ctx.partition), deadline: ctx && ctx.deadline }, info || {}));
  } catch (e) {
    if (ctx && typeof ctx.log === 'function') ctx.log(`alert memory: unavailable for this decision: ${(e && e.message) || e}`);
    return null;
  }
}

/** "No Social Alert: …": the note in a held-back alert's thread. Pure. */
function amHeldNoteText_(v) {
  const why = String((v && (v.why || v.skip)) || '');
  return `No Social Alert: ${why}.${v && v.fold && v.ref ? ` This post is listed in ${v.ref}'s thread.` : ''}`;
}

/** The reply in a story's alert thread naming a post folded into it (author, network, engagement, link). Pure. */
function amFoldReplyText_(row, fields) {
  const f = fields || {};
  const url = String(f.post_url || '').trim();
  const author = String(f.author || '').trim();
  const net = String(f.social_network || '').trim();
  const eng = Number.isFinite(Number(f.total_engagement)) && f.total_engagement !== null && f.total_engagement !== ''
    ? Number(f.total_engagement) : null;
  const label = author || (net ? `the post on ${net}` : 'the post');
  const facts = [net, eng !== null ? `${eng.toLocaleString('en-US')} engagements` : ''].filter(Boolean).join(' \u00b7 ');
  return `\ud83d\udd17 *Same story, no new email:* ${url ? chatLink_(url, label) : label}${facts ? ` \u00b7 ${facts}` : ''}` +
    `${row && row.alert_id ? ` (${row.alert_id})` : ''}`;
}

/**
 * Posts a reply in another alert's thread (`spaceId`, `thread`), once (`key`), as the bot's own: never in S-F Burson
 * (B25), the Burson test copy (B26) or a space people outside Google can join (Chat.gs refuses those too). The message,
 * or throws.
 */
function amPostThreadReply_(spaceId, thread, text, key) {
  const id = String(spaceId || '');
  const copy = typeof testCopyId_ === 'function' ? testCopyId_() : '';
  if (!id || !thread || id === sfBursonId_() || outsideSpace_(id) || (copy && id === copy)) {
    throw new Error(`refusing to post in ${id || 'no space'}`);
  }
  return chatPostMessage_(id, text, { thread, key });
}

/**
 * The trace a Social Alert the memory held back leaves (v: {why or skip, kind, ref, fold, story}): counted, and a fold
 * is listed in its story's alert thread (a reply citing the post) and on the story. The Alert-log decision and the note
 * in the alert's own thread are the caller's. Never throws.
 */
function amHeldTrace_(ctx, row, v) {
  try {
    const mem = amOf_(ctx);
    if (!mem.active || !v) return;
    mem.noteHeld(row, v);
    if (!v.fold || !v.story) return;
    const s = mem.storyRec(v.story);
    const e = s && s.e;
    if (!e || !e.ct || !e.cs || e.id === (row && row.alert_id)) return;
    amPostThreadReply_(e.cs, e.ct, amFoldReplyText_(row, amRowFields_(row)), `amfold:${s.id}|${row.alert_id}`);
  } catch (e) {
    if (ctx && typeof ctx.log === 'function') ctx.log(`alert memory: couldn't list ${row && row.alert_id} in its story's thread: ${(e && e.message) || e}`);
  }
}

/**
 * The send gate (Drafts.gs tryDraft_, the one place every Social Alert passes before any email or draft): asks the
 * memory again. Held back: the row is ❌ (email_status deleted, its decision, the ❌ mark, a note in its thread, a fold
 * listed in its story's thread) and false is returned. Its one update: the row replies on that email's thread. True to
 * go on. Never throws (a failed check lets it go, as before).
 */
function amSendGate_(ctx, row, report) {
  if (row && typeof SHEET_TEST_INGESTED_ === 'string' && row.ingested === SHEET_TEST_INGESTED_) return true;
  const mem = amOf_(ctx);
  if (!mem.active || !row) return true;
  let v = null;
  try {
    v = mem.sendCheck(row, ctx);
  } catch (e) {
    ctx.log(`alert memory: the send check for ${row.alert_id} failed, so it goes as before: ${(e && e.message) || e}`);
    return true;
  }
  if (!v || v.ok) {
    if (v && v.update) amThreadUpdate_(ctx, row, v.update);
    return true;
  }
  const why = String(v.why || 'already emailed');
  try {
    const draftIds = typeof rowDraftIds_ === 'function' ? rowDraftIds_(row) : [row.email_draft].filter(Boolean);
    if (draftIds.length && ctx.gmail && typeof ctx.gmail.deleteDraft === 'function') {
      draftIds.forEach(did => {
        try { ctx.gmail.deleteDraft(did); } catch (e) { ctx.log(`couldn't delete the draft for ${row.alert_id}: ${(e && e.message) || e}`); }
      });
    }
    ctx.store.updateAlert(row, { email_status: 'deleted', email_draft: '', email_error: '', decision: truncate_(`\u274c ${why}`, 300) });
  } catch (e) {
    ctx.log(`couldn't record why ${row.alert_id} has no Social Alert: ${(e && e.message) || e}`);
  }
  ctx.log(`${row.alert_id}: \u274c no Social Alert at send time (${why})`);
  try { markNoAction_(ctx, row); } catch (e) {}
  try { postDraftNote_(ctx, row, amHeldNoteText_(v), 'amheld:' + row.alert_id); } catch (e) {}
  amHeldTrace_(ctx, row, v);
  try { if (typeof bqWriteBack_ === 'function') bqWriteBack_(ctx, row, 'decided', report); } catch (e) {}
  if (report) report.memory_held = (report.memory_held || 0) + 1;
  return false;
}

/** A row the memory lets go as its one update: it replies on that earlier email's thread (unless a draft was made). */
function amThreadUpdate_(ctx, row, update) {
  try {
    const rel = update && update.rel;
    ctx.log(`${row.alert_id}: its Social Alert goes out as an update on ${update.ref}'s (${amTierWords_(update.tiers)})`);
    if (!rel || rel.o !== 'e' || !rel.th || row.email_draft || row.email_thread === rel.th) return;
    const patch = { email_thread: rel.th, email_reply_to: rel.mid || '',
      email_subject: socialAlertSubject_(row.email_input || {}, { subject: rel.sub || row.email_subject || '' }) };
    if ((Array.isArray(rel.tm) && rel.tm.length) || rel.pr) {
      const nextInput = Object.assign({}, row.email_input || {});
      if (Array.isArray(rel.tm) && rel.tm.length) {
        nextInput.related_team_emails = rel.tm.map(x => ({ key: x.k, thread: x.th, message_id: x.mid || '', subject: x.sub || '', status: 'sent' }));
      }
      if (rel.pr) nextInput.related_product = String(rel.pr);
      patch.email_input = nextInput;
    }
    ctx.store.updateAlert(row, patch);
  } catch (e) {
    ctx.log(`alert memory: couldn't put ${row.alert_id} on ${update && update.ref}'s thread: ${(e && e.message) || e}`);
  }
}

/** Noted before Gmail is asked for row's Social Alert (or its draft). Never throws. */
function amClaimSend_(ctx, row) {
  if (row && typeof SHEET_TEST_INGESTED_ === 'string' && row.ingested === SHEET_TEST_INGESTED_) return;
  try { amOf_(ctx).claimSend(row, ctx); } catch (e) { ctx.log(`alert memory: couldn't note ${row && row.alert_id}'s send: ${(e && e.message) || e}`); }
}

/** Gmail refused it, or its draft was deleted: the claim is let go. Never throws. */
function amReleaseSend_(ctx, row) {
  if (row && typeof SHEET_TEST_INGESTED_ === 'string' && row.ingested === SHEET_TEST_INGESTED_) return;
  try { amOf_(ctx).releaseSend(row); } catch (e) { ctx.log(`alert memory: couldn't let go of ${row && row.alert_id}'s send: ${(e && e.message) || e}`); }
}

/** Drafts.gs onEmailSent_'s step: the memory notes the Social Alert went out. */
function amEmailSent_(ctx, row) {
  amOf_(ctx).recordSend(row, ctx);
}

/**
 * Control tab: why the memory couldn't be read lately ('' when it could), for the status line; each alert is decided as
 * before meanwhile. Never throws.
 */
function amControlNote_() {
  try {
    const p = JSON.parse(PropertiesService.getScriptProperties().getProperty(AM_PROBLEM_PROP_) || 'null');
    if (!p || Date.now() - Number(p.at || 0) > AM_PROBLEM_SHOWN_MS_) return '';
    return `The duplicate check couldn't read its memory (${truncate_(String(p.text || ''), 140)}): each alert is decided as before.`;
  } catch (e) {
    return '';
  }
}

/** " · 3 duplicate Social Alerts held back today (2 folded into their story)" for the Control tab, or ''. Never throws. */
function amTodayText_() {
  try {
    const d = JSON.parse(PropertiesService.getScriptProperties().getProperty(AM_DAY_PROP_) || 'null');
    const day = typeof dayKey_ === 'function' ? dayKey_() : '';
    if (!d || d.day !== day || !(Number(d.held) > 0)) return '';
    const n = Number(d.held);
    return ` \u00b7 ${n} duplicate Social Alert${n === 1 ? '' : 's'} held back${Number(d.folded) > 0 ? ` (${d.folded} folded into their story)` : ''}`;
  } catch (e) {
    return '';
  }
}
