/**
 * WatchAlerts.gs — Watch alerts (Control tab row 35, OFF until a person chooses where they go): the Proactive watch's
 * flags (ProactiveWatch.gs: a watch's yes and a score at its bar) posted as alerts of the bot's own, so the bot works
 * them like any alert there: the same story already alerted gets ❌ and no second email; anything else gets its Social
 * Alert to the right teams (only the testers while Testing) and its marks, and T&S when the post's rules say so.
 *
 *   B35 "Watch alerts"   OFF                        the watch only lists what it would flag (the Watch detections tab)
 *                        Other alerts space (B33)   posted in the Other alerts space (OtherSpace.gs: a midterms space,
 *                                                   say), a place of their own, always Testing there; paste another
 *                                                   space in B33 and the next ones go there
 *                        Mirror space (B9)          posted in the Mirror space, beside Burson's alerts: the Mirror and
 *                                                   the Relay carry on exactly as before (nothing the bot posts is ever
 *                                                   relayed to S-F Burson: Relay.gs relayBotsOwn_)
 *
 * Each alert is posted once, in the bot's own format (pwAlertText_: "🔭 Watch alert · <watch>", which neither Burson nor
 * a monitoring tool writes, so it never looks like a Zapier alert), with an id of its own (PW_ALERT_ID_PREFIX_): the
 * post's link as a hyperlink, its author, when it was posted and the watch's summary, with the post's picture attached
 * when one can be found (pwAlertPicture_: its photo, or its video's frame or cover; what an X or Bluesky post shows from
 * the post it quotes or its link card; else the picture its page shows link previews: Facebook, Reddit, news sites…).
 * The score, the watch's bar and topic, and
 * the source that found it stay off the message: the bot keeps them for the flow (pwRememberPosted_). The
 * space's flow knows it for the bot's (pwAlertOf_) and works it with the watch's call (Bot.gs handleMessage_ ->
 * OtherAlerts.gs handleOtherAlert_ / otherDecide_: Gemini's look for an earlier alert on the same story, then a Social
 * Alert unless it's a repeat); its Alert-log row says `ingested`: PW_ALERT_INGESTED_ (never Burson's: the Results tab
 * and Write back to SLRR BigQuery leave it out).
 * The queue is the Watch detections tab itself: a flag recorded while B35 isn't OFF waits there (its hidden key, a: 'q')
 * until it's posted (a: 'p', with the message and when), PW_ALERTS_MAX_OTHER_ / PW_ALERTS_MAX_MIRROR_ a run, the
 * highest scores first; one that couldn't go out within PW_ALERT_MAX_AGE_MS_ of being seen is dropped (a: 'x'). None
 * goes to the Mirror space while its flow ran out of time on the last run (Burson's alerts come first). Never into S-F
 * Burson (B25), the Burson test copy (B26) or a space people outside Google can join (Chat.gs refuses them too).
 */

const PW_ALERTS_ROW_ = 35;
const PW_ALERTS_LABEL_ = 'Watch alerts';
const PW_ALERTS_OFF_ = 'OFF';
const PW_ALERTS_OTHER_ = 'Other alerts space (B33)';
const PW_ALERTS_MIRROR_ = 'Mirror space (B9)';
const PW_ALERTS_CHOICES_ = [PW_ALERTS_OFF_, PW_ALERTS_OTHER_, PW_ALERTS_MIRROR_];
const PW_ALERT_ID_PREFIX_ = 'client-zwat-';       // the watch alerts' message ids (Relay.gs RELAY_ID_RX_: the bot's own)
const PW_ALERT_INGESTED_ = 'Watch alert';         // the Alert log's `ingested` for them
const PW_ALERT_SOURCE_ = 'Proactive watch';       // the "tool" they come from, for the triage (OtherAlerts.gs)
const PW_ALERTS_MAX_OTHER_ = 5;                   // posted a run at most in the Other alerts space...
const PW_ALERTS_MAX_MIRROR_ = 2;                  // ...and in the Mirror space, whose flow works Burson's alerts too
const PW_ALERT_MAX_AGE_MS_ = 3 * 60 * 60 * 1000;  // a flag not posted within 3 hours of being seen is dropped
const PW_ALERT_POSTED_PROP_ = 'PW_ALERT_POSTED';  // the watch alerts posted lately: hashes of their message names
const PW_ALERT_POSTED_MAX_ = 300;
const PW_ALERT_INFO_PROP_ = 'PW_ALERT_INFO';      // what a watch alert's message leaves off (score, bar, topic, source)...
const PW_ALERT_INFO_MAX_ = 40;                    // ...for the newest (the flow works each a run or two after it's posted)
const PW_ALERT_PIC_LEFT_MS_ = 30 * 1000;          // the post's picture is attached only with this much of the run left
const PW_ALERT_PAGE_PIC_LEFT_MS_ = 45 * 1000;     // ...and its page read for one (Post.gs pagePicture_) only with this much
// The networks a link label names ("View the post on X"); anything else is just "View the post"
const PW_ALERT_NETS_ = ['X', 'Instagram', 'TikTok', 'YouTube', 'Reddit', 'Bluesky', 'Facebook', 'Threads', 'LinkedIn'];
const PW_ALERT_DAY_PROP_ = 'PW_ALERT_TODAY';      // {day, n}: today's watch alerts
const PW_ALERT_PENDING_PROP_ = 'PW_ALERT_PENDING';  // set while flags may wait on the Watch detections tab (else it isn't read)
const PW_ALERT_TEXT_CHARS_ = 600;                 // of the post's words in an alert
const PW_ALERT_HEAD_ = '🔭';

// --------------------------------------------------------------------------------------------------------------
// Control tab row 35
// --------------------------------------------------------------------------------------------------------------

/** Strict dropdown for B35: OFF, Other alerts space (B33), Mirror space (B9). */
function pwAlertsRule_() {
  return SpreadsheetApp.newDataValidation().requireValueInList(PW_ALERTS_CHOICES_, true).setAllowInvalid(false).build();
}

/** C35 while B35 is OFF. Pure. */
function pwAlertsOffText_() {
  return 'OFF (the Proactive watch only lists what it would flag, on the Watch detections tab)';
}

/**
 * Row 35 ("Watch alerts"), below the Proactive watch switch: a tab from before it gets it on its next run, without
 * setup(), OFF (only a person chooses where they go), with its dropdown; "How it works" moves down to row 38.
 */
function ensureWatchAlertsRow_(sh) {
  if (!sh) return;
  if (String(sh.getRange(PW_ALERTS_ROW_, 1).getValue() || '').trim() === PW_ALERTS_LABEL_) return;
  sh.getRange(PW_ALERTS_ROW_, 1, 1, 3).setValues([[PW_ALERTS_LABEL_, PW_ALERTS_OFF_, pwAlertsOffText_()]]);
  sh.getRange(PW_ALERTS_ROW_, 1).setFontWeight('bold');
  sh.getRange(PW_ALERTS_ROW_, 2).setBackground('#fff8e1').setDataValidation(pwAlertsRule_());
  writeControlHelp_(sh);
}

/** B35 as where the alerts go: 'other' (B33), 'mirror' (B9), or '' (OFF, blank or anything else). Pure. */
function pwAlertsChoice_(raw) {
  const v = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (!v || v === 'off') return '';
  if (/\bb33\b|other alerts/.test(v)) return 'other';
  if (/\bb9\b|mirror/.test(v)) return 'mirror';
  return '';
}

/** C35: written only when it changes. */
function writeWatchAlertsNote_(sh, note) {
  if (!sh) return;
  const cell = sh.getRange(PW_ALERTS_ROW_, 3);
  if (String(cell.getValue() || '') !== String(note || '')) cell.setValue(note || '');
}

/**
 * This run's Other alerts space for the watch's alerts: the one its run worked this minute (`os`: OtherSpace.gs
 * runOtherSpace_'s {report, ctx}), else B33 found and checked as its run checks it (otherSpaceProblem_), else null.
 * `cfg`: the main run's setup; `sfb`: this run's B25 (Main.gs sfBursonFor_; null when the run stopped before it). Never
 * throws.
 */
function pwOtherSpaceFor_(os, wanted, cfg, sfb) {
  try {
    if (os && os.ctx && os.ctx.spaces && os.ctx.spaces.burson && os.ctx.spaces.burson.id) return os.ctx.spaces.burson;
    const ref = String((wanted && wanted.otherSpace) || '').trim();
    if (!ref || !sfb) return null;
    const space = resolveOtherSpace_(ref);
    return otherSpaceProblem_(space, wanted, cfg, sfb.space) ? null : space;
  } catch (e) {
    return null;
  }
}

/**
 * Where the watch's alerts go this run: {choice ('' | 'other' | 'mirror'), space ({id, name}, or null), problem ('' when
 * they can go)}. `otherSpace`: pwOtherSpaceFor_; `cfg`: the main run's setup, whose Mirror space counts only while
 * outbounds are blocked (never while the bot works directly in B25). Never S-F Burson, the Burson test copy or a space
 * people outside Google can join. Never throws (a failed check: they wait, and the problem says why).
 */
function pwAlertsDest_(raw, otherSpace, cfg) {
  const choice = pwAlertsChoice_(raw);
  const out = { choice, space: null, problem: '' };
  if (!choice) return out;
  try {
    let space = null;
    if (choice === 'other') {
      space = otherSpace && otherSpace.id ? otherSpace : null;
      if (!space) out.problem = 'the Other alerts space (B33) is blank or can\'t be used this run (see C33)';
    } else {
      space = cfg && cfg.outboundBlocked && !cfg.direct && cfg.mirror && cfg.mirror.id ? cfg.mirror : null;
      if (!space) out.problem = 'the Mirror space (B9) isn\'t working this run (see C9)';
    }
    const copy = typeof testCopyId_ === 'function' ? testCopyId_() : '';
    if (space && (space.externalUserAllowed || space.id === sfBursonId_() || outsideSpace_(space.id) || (copy && space.id === copy))) {
      out.problem = `"${space.name || space.id}" can't take them (it's S-F Burson, the Burson test copy, or people outside Google can join it)`;
      space = null;
    }
    out.space = space ? { id: space.id, name: space.name || space.id } : null;
  } catch (e) {
    out.space = null;
    out.problem = `couldn't check where they go: ${truncate_(String((e && e.message) || e), 120)}`;
  }
  return out;
}

/** "Other alerts space (B33)" / "Mirror space (B9)" for `choice`. Pure. */
function pwAlertsWhere_(choice) { return choice === 'mirror' ? 'Mirror space (B9)' : 'Other alerts space (B33)'; }

/**
 * C35 for this run: `dest` (pwAlertsDest_), `res` (pwPostAlerts_, or null when nothing was tried), `watchOn` (row 34),
 * `today` (watch alerts posted today). Under 250 characters. Pure.
 */
function pwAlertsNoteText_(dest, res, watchOn, today) {
  const choice = dest && dest.choice;
  if (!choice) return pwAlertsOffText_();
  const where = pwAlertsWhere_(choice);
  if (!watchOn) return `⚠️ ${where} chosen, but the Proactive watch (row 34) is OFF: nothing to post`;
  const counts = ` · today: ${fmtInt_(today || 0)} posted${res && res.waiting ? `, ${fmtInt_(res.waiting)} waiting` : ''}`;
  const problem = (dest && dest.problem) || (res && res.problem) || (!dest.space ? 'no space to post in this run' : '');
  if (problem) return truncate_(`⚠️ waiting: ${problem} (a flag waits up to 3 hours)${counts}`, 250);
  return truncate_(`✓ ${dest.space.name} (${choice === 'mirror' ? 'B9' : 'B33'}): each flag at a watch's bar is posted there as a ` +
    `${PW_ALERT_HEAD_} Watch alert for full triage: ❌ if off-topic or already alerted, 👍, or a Social Alert` +
    `${choice === 'other' ? ' (always Testing there)' : ' (only the testers while Testing)'}${counts}`, 250);
}

// --------------------------------------------------------------------------------------------------------------
// The alert: the bot's own format, written and read back
// --------------------------------------------------------------------------------------------------------------

/** A score or bar as the alert writes it ("7", "6.5"; "?" for none). Pure. */
function pwAlertNum_(n) {
  const v = Number(n);
  return n !== '' && n !== null && n !== undefined && isFinite(v) ? String(Math.round(v * 10) / 10) : '?';
}

/**
 * A watch alert's message (`a`: {watch, url, author, network, followers, eng, posted, summary, video: true when its
 * picture is a video's frame or cover}), plain text in Chat's markup, in the bot's own format (pwAlertParse_ reads it
 * back), the post's picture attached under it when it has one (pwPostAlerts_):
 *   🔭 *Watch alert · Midterms 2026 × Civics*
 *   *Link:* <https://x.com/…|View the post on X>          (a hyperlink; "Watch the video on X" for a video)
 *   *Author:* @someone · X · 4,470 followers · 52 engagements
 *   *Posted:* 2026-11-01 23:26 ET
 *   *Summary:* … (the watch's own summary of the post)
 * The score, the watch's bar and topic, and the source that found it aren't on it (the flow gets them from the bot's
 * record of what it posted: pwRememberPosted_). Pure.
 */
function pwAlertText_(a) {
  const one = (v, n) => truncate_(String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim(), n);
  const num = v => (Number(v) > 0 ? fmtInt_(Math.round(Number(v))) : '');
  const who = [one(a.author, 120) || 'unknown author', one(a.network, 40),
    num(a.followers) ? `${num(a.followers)} followers` : '', num(a.eng) ? `${num(a.eng)} engagements` : ''].filter(Boolean);
  const summary = one(a.summary, PW_ALERT_TEXT_CHARS_);
  const net = one(a.network, 40);
  const label = `${a.video ? 'Watch the video' : 'View the post'}${PW_ALERT_NETS_.indexOf(net) >= 0 ? ` on ${net}` : ''}`;
  return [
    `${PW_ALERT_HEAD_} *Watch alert · ${one(a.watch, 80) || 'Proactive watch'}*`,
    `*Link:* ${chatLink_(one(a.url, 500), label)}`,
    `*Author:* ${who.join(' · ')}`,
    one(a.posted, 40) ? `*Posted:* ${one(a.posted, 40)} ET` : '',
    summary ? `*Summary:* ${summary}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * A watch alert read back (pwAlertText_'s lines, with or without Chat's bold marks, a link as Chat may show it):
 * {watch, score, bar, topic, url, author, network, followers, eng, posted, source, seen, summary}; null when the text
 * isn't one. Score, bar, topic, source and seen are read only from an alert posted before they left the message (its
 * "Score:" and "Found by:" lines); else null / ''. Each label is read on its own line, the first one only, so a post's
 * words can't stand in for the alert's. Pure.
 */
function pwAlertParse_(text) {
  const t = String(text || '');
  if (!t.trim() || t.length > OTHER_TEXT_MAX_CHARS_) return null;
  const bare = s => String(s || '').replace(/<(https?:\/\/[^|>\s]+)\|[^>]*>/g, '$1').replace(/\*/g, '').trim();
  const lines = t.split(/\r?\n/).map(bare).filter(Boolean);
  const head = (lines[0] || '').match(/^🔭\s*Watch alert · (.+)$/);
  if (!head) return null;
  const get = label => {
    const hit = lines.slice(1).find(l => l.indexOf(`${label}:`) === 0);
    return hit ? hit.slice(label.length + 1).trim() : '';
  };
  const score = get('Score').match(/^([\d.]+|\?) of 10 \(flags at ([\d.]+|\?)\)(?: · Topic: (.+))?$/) || [];
  const who = get('Author').split(' · ').map(s => s.trim()).filter(Boolean);
  const isCount = s => /^[\d,]+ (?:followers|engagements)$/.test(s);
  const count = word => {
    const hit = who.find(s => new RegExp(`^[\\d,]+ ${word}$`).test(s));
    return hit ? Number(hit.replace(/[^\d]/g, '')) : null;
  };
  const found = get('Found by').split(' · ');
  const seen = found.length > 1 && /^\d{4}-\d\d-\d\d \d\d:\d\d ET$/.test(found[found.length - 1]) ? found.pop().replace(/ ET$/, '') : '';
  const num = s => (s && s !== '?' && isFinite(Number(s)) ? Number(s) : null);
  return {
    watch: head[1].trim(), score: num(score[1]), bar: num(score[2]), topic: String(score[3] || '').trim(),
    url: (get('Link').match(/https?:\/\/\S+/) || [''])[0], author: who[0] && who[0] !== 'unknown author' ? who[0] : '',
    network: who.find((s, i) => i > 0 && !isCount(s)) || '', followers: count('followers'), eng: count('engagements'),
    posted: get('Posted').replace(/ ET$/, ''), source: found.join(' · ').trim(), seen, summary: get('Summary'),
  };
}

/**
 * The bot's own watch alert in a flow's space, for Bot.gs handleMessage_: a top-level post it made itself (its id, or
 * its record of the posts, PW_ALERT_POSTED, when Chat took no custom id) in the watch alert's format, as an alert in
 * another format for OtherAlerts.gs handleOtherAlert_, with `watch` (the watch's call, for otherDecide_: the score, bar,
 * topic and source from the bot's record of what it posted, PW_ALERT_INFO, as the message no longer shows them; an
 * older alert's own lines first); null for anything else (a person's copy of one included). Never throws.
 */
function pwAlertOf_(ctx, m) {
  try {
    if (!m || m.threadReply) return null;
    const id = String(m.clientId || '');
    const mine = id ? id.indexOf(PW_ALERT_ID_PREFIX_) === 0
      : !!(ctx && ctx.botUser) && m.senderName === ctx.botUser && pwAlertPosted_(m.name);
    if (!mine) return null;
    const a = pwAlertParse_(m.text);
    // Chat keeps a hyperlink's address out of the plain text (only "View the post on X" stays there): the message's
    // links have it (Chat.gs messageLinks_: formattedText's <url|words>), the Link line's first
    if (a && !a.url && Array.isArray(m.links) && m.links.length) a.url = String(m.links[0] || '');
    if (!a || !a.url) return null;
    const info = pwAlertInfo_(m.name) || {};
    const known = v => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
    const score = a.score !== null ? a.score : known(info.sc);
    const bar = a.bar !== null ? a.bar : known(info.br);
    const topic = a.topic || String(info.tp || '');
    const source = a.source || String(info.src || '');
    const scoreLine = `${pwAlertNum_(score)} of 10 (the watch flags at ${pwAlertNum_(bar)})`;
    return {
      header: `Watch alert · ${a.watch}`, source: PW_ALERT_SOURCE_, topic: a.watch, sentiment: '',
      labels: {}, keys: ['link', 'author', 'summary'], loose: [],
      unknown: [{ label: 'watch_score', value: scoreLine }, topic ? { label: 'watch_topic', value: topic } : null,
        source ? { label: 'found_by', value: source } : null].filter(Boolean),
      url: a.url, author: a.author, followers: Number.isInteger(a.followers) ? a.followers : null,
      network: networkForDomain_(domainOf_(a.url)) || otherNetwork_(a.network) || '',
      engagement: otherEngagementOf_(Number.isInteger(a.eng) ? String(a.eng) : ''), kof: null, kofLists: '',
      text: '', summary: a.summary, date: a.posted, location: '', language: '', product: '', sender: String(m.senderDisplay || ''),
      watch: { name: a.watch, score, bar, topic, source },
    };
  } catch (e) {
    return null;
  }
}

/**
 * Why a watch alert goes out, in words: "the Midterms 2026 × Civics watch scored it 7 of 10 (it flags at 4): …"; "the
 * … watch flagged it" when its score isn't known. Pure.
 */
function pwAlertWhy_(w) {
  const x = w || {};
  const scored = x.score === null || x.score === undefined || x.score === '' ? 'flagged it'
    : `scored it ${pwAlertNum_(x.score)} of 10 (it flags at ${pwAlertNum_(x.bar)})`;
  return `the ${x.name || 'Proactive'} watch ${scored}${x.topic ? `: ${x.topic}` : ''}`;
}

// --------------------------------------------------------------------------------------------------------------
// Posting: the flags waiting on the Watch detections tab
// --------------------------------------------------------------------------------------------------------------

/**
 * The watch alert to post for a waiting flag: its row on the Watch detections tab (`v`; a text cell's leading
 * apostrophe, which keeps "@handle" or a time as text, dropped) and its key (`k`). Pure.
 */
function pwAlertOfRow_(v, k) {
  const c = col => {
    const x = v[PW_COL_[col] - 1];
    return typeof x === 'string' ? x.replace(/^'/, '') : x;
  };
  return {
    watch: k.w || c('watch'), score: k.sc !== undefined ? k.sc : c('score'), bar: k.br, topic: c('topic'), url: c('post'),
    author: c('author'), network: c('network'), followers: c('followers'), eng: c('eng'), posted: c('posted'),
    seen: c('seen'), source: c('source'), summary: c('summary'),
  };
}

/**
 * Posts one watch alert in `space` ({id, name}) with its own id, once (`key`: the same key never posts twice in a
 * space), with `img` attached under it when given ({name, mime, base64}: pwAlertPicture_; Chat refusing the upload, or
 * the alert with it, leaves the alert as text): never in S-F Burson (B25), the Burson test copy (B26) or a space people
 * outside Google can join (Chat.gs refuses them too). The message, or throws.
 */
function pwPostAlert_(space, text, key, img) {
  const copy = typeof testCopyId_ === 'function' ? testCopyId_() : '';
  if (!space || !space.id || space.id === sfBursonId_() || outsideSpace_(space.id) || (copy && space.id === copy)) {
    throw new Error(`refusing to post a watch alert in ${(space && space.id) || 'no space'}`);
  }
  const attachments = [];
  if (img) {
    try {
      attachments.push({ attachmentDataRef: chatUploadImage_(space.id, img) });
    } catch (e) {
      console.warn(`Watch alerts: posted without the post's picture: ${truncate_(String((e && e.message) || e), 200)}`);
    }
  }
  const post = withPicture => chatPostMessage_(space.id, text, { key, idPrefix: PW_ALERT_ID_PREFIX_,
    attachments: withPicture ? attachments : [] });
  if (!attachments.length) return post(false);
  try {
    return post(true);
  } catch (e) {  // the same key: an alert Chat did take is read back, never posted twice
    console.warn(`Watch alerts: Chat refused the alert with the post's picture, so it goes as text: ` +
      `${truncate_(String((e && e.message) || e), 200)}`);
    return post(false);
  }
}

/**
 * The post's picture for its watch alert (Post.gs alertPicture_): as the Social Alert email picks it (lookupPost_ and
 * screenshotFor_: its photo, else its video's frame, else a video's thumbnail or cover, else what an X or Bluesky post
 * shows from the post it quotes or its link card), else, with `pageOk` (time for one more page), the picture its page
 * shows link previews (pagePicture_: Facebook, Reddit, news sites…); fetchScreenshot_: an image of 3 MB at most.
 * {img: {name, mime, base64}, video: true when it's a video's}; null when there's none (no picture, or it couldn't be
 * fetched: the alert goes as text). Accepts optional `prefetchedPost` so pwPostAlerts_ can reuse a single lookupPost_
 * call for both thread deduplication and media. Never throws.
 */
function pwAlertPicture_(url, prefetchedPost, pageOk) {
  try {
    return alertPicture_(url, prefetchedPost, pageOk);
  } catch (e) {
    console.warn(`Watch alerts: no picture for ${url}: ${truncate_(String((e && e.message) || e), 200)}`);
    return null;
  }
}

/** The Mirror space's flow ran out of time on the last run (LAST_RUN): its alerts come first. Never throws. */
function pwMirrorBusy_() {
  try {
    const last = JSON.parse(PropertiesService.getScriptProperties().getProperty('LAST_RUN') || 'null');
    return !!(last && (last.errors || []).some(e => /^time budget/.test(String(e))));
  } catch (e) {
    return false;
  }
}

/**
 * Remembers a watch alert the bot posted (its message name, hashed), the newest PW_ALERT_POSTED_MAX_; with `info`
 * ({sc: score, br: bar, tp: topic, src: source}: what the message doesn't show), that too, for the newest
 * PW_ALERT_INFO_MAX_ (pwAlertInfo_). Never throws.
 */
function pwRememberPosted_(name, info) {
  if (!name) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const h = hashText_(String(name)).slice(0, 16);
    let list = [];
    try { list = JSON.parse(props.getProperty(PW_ALERT_POSTED_PROP_) || '[]') || []; } catch (e) { list = []; }
    if (list.indexOf(h) < 0) props.setProperty(PW_ALERT_POSTED_PROP_, JSON.stringify(list.concat([h]).slice(-PW_ALERT_POSTED_MAX_)));
    if (!info) return;
    let all = [];
    try { all = JSON.parse(props.getProperty(PW_ALERT_INFO_PROP_) || '[]') || []; } catch (e) { all = []; }
    const keep = { h, sc: info.sc === undefined ? null : info.sc, br: info.br === undefined ? null : info.br,
      tp: truncate_(String(info.tp || ''), 60), src: truncate_(String(info.src || ''), 60) };
    props.setProperty(PW_ALERT_INFO_PROP_, JSON.stringify((Array.isArray(all) ? all : []).filter(x => x && x.h !== h)
      .concat([keep]).slice(-PW_ALERT_INFO_MAX_)));
  } catch (e) {
    console.warn('Watch alerts: couldn\'t remember a posted alert: ' + ((e && e.message) || e));
  }
}

/** What the bot kept of watch alert `name` when it posted it ({sc, br, tp, src}: pwRememberPosted_), or null. Never throws. */
function pwAlertInfo_(name) {
  try {
    if (!name) return null;
    const h = hashText_(String(name)).slice(0, 16);
    const all = JSON.parse(PropertiesService.getScriptProperties().getProperty(PW_ALERT_INFO_PROP_) || '[]') || [];
    return (Array.isArray(all) ? all : []).find(x => x && x.h === h) || null;
  } catch (e) {
    return null;
  }
}

/** True when the bot posted message `name` as a watch alert (pwRememberPosted_). Never throws. */
function pwAlertPosted_(name) {
  try {
    if (!name) return false;
    const list = JSON.parse(PropertiesService.getScriptProperties().getProperty(PW_ALERT_POSTED_PROP_) || '[]') || [];
    return list.indexOf(hashText_(String(name)).slice(0, 16)) >= 0;
  } catch (e) {
    return false;
  }
}

/** Today's watch alerts so far, with `add` more. Never throws. */
function pwAlertDay_(add) {
  try {
    const props = PropertiesService.getScriptProperties();
    let s = null;
    try { s = JSON.parse(props.getProperty(PW_ALERT_DAY_PROP_) || 'null'); } catch (e) { s = null; }
    const day = dayKey_();
    if (!s || s.day !== day) s = { day, n: 0 };
    if (add) {
      s.n = (Number(s.n) || 0) + add;
      props.setProperty(PW_ALERT_DAY_PROP_, JSON.stringify(s));
    }
    return Number(s.n) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Posts and conversation thread IDs already alerted across Watch detections (`block`) and the non-autocorrect Alert log
 * (`ss`): {done (Set of record keys), doneThreadIds (Set of platform post/thread IDs)}. Never throws.
 */
function pwAlertedState_(ss, block, choice) {
  const done = new Set();
  const doneThreadIds = new Set();
  const markUrl = raw => {
    const u = String(raw || '').replace(/^'/, '').trim();
    if (!u) return;
    done.add(recordKey_({ post_url: u }) || u);
    const pid = postIdOf_(u);
    if (pid) doneThreadIds.add(pid);
  };
  ((block && block.values) || []).forEach(v => {
    const k = pwKeyOf_(v[PW_COL_.key - 1]);
    const bursonAt = String(v[PW_COL_.bursonAt - 1] || '').trim();
    if ((k && k.a === 'p') || bursonAt) {
      if (k && k.k) done.add(String(k.k));
      markUrl(v[PW_COL_.post - 1]);
      if (k && Array.isArray(k.th)) k.th.forEach(id => { if (id) doneThreadIds.add(String(id)); });
    }
  });
  if (ss) {
    try {
      const osSuffix = typeof OS_PARTITION_SUFFIX_ === 'string' ? OS_PARTITION_SUFFIX_ : ' (other alerts)';
      const alerts = sheetBackend_(ss).loadAlerts() || [];
      alerts.forEach(r => {
        const sp = String((r && r.space) || '');
        if (!r || sp.endsWith(AC_PARTITION_SUFFIX_) || (choice !== 'other' && sp.endsWith(osSuffix))) return;
        if (earlierOutcome_(r) !== 'alerted') return;
        if (r.record_key) done.add(String(r.record_key));
        markUrl((r.forwarded_fields || {}).post_url);
      });
    } catch (e) {
      console.warn('Watch alerts: could not read Alert log for pre-post dedup: ' + ((e && e.message) || e));
    }
  }
  return { done, doneThreadIds };
}

/**
 * Posts the flags waiting on the Watch detections tab (`sh`; their key a: 'q') as watch alerts in this run's
 * destination (`dest`: pwAlertsDest_), the highest scores first, PW_ALERTS_MAX_OTHER_ / PW_ALERTS_MAX_MIRROR_ a run, each
 * once (its key then says a: 'p', the message, where and when); a flag waiting longer than PW_ALERT_MAX_AGE_MS_ since it
 * was seen is dropped (a: 'x'), and one for a post or conversation thread already alerted (by another watch, Burson, or
 * any flow in the Alert log) isn't posted again (a: 'd'). Nothing goes out while B35 is OFF or the destination can't
 * take them (they wait), nor while the destination space's flow ran out of time. `left`: ms of the run left;
 * `opts`: {ss, otherBusy}. {posted, waiting, dropped, problem, error (it failed: whatever waits is kept)}. Never throws.
 */
function pwPostAlerts_(sh, dest, now, left, opts) {
  const out = { posted: 0, waiting: 0, dropped: 0, problem: '', error: false };
  try {
    const block = pwDetRows_(sh, PW_DET_READ_ROWS_);
    const queued = [];
    block.values.forEach((v, i) => {
      const k = pwKeyOf_(v[PW_COL_.key - 1]);
      if (k && k.a === 'q') queued.push({ i, k, v });
    });
    if (!queued.length) return out;
    const { done, doneThreadIds } = pwAlertedState_(opts && opts.ss, block, dest && dest.choice);
    const writes = [];  // [index in the block, the key to write]
    // another watch, Burson, or an earlier post in the same thread already alerted: this flag isn't posted again
    const same = q => writes.push([q.i, Object.assign({}, q.k, { a: 'd' })]);
    const fresh = queued.filter(q => {
      const qUrl = String(q.v[PW_COL_.post - 1] || '').replace(/^'/, '').trim();
      const qPid = postIdOf_(qUrl);
      const qSum = String(q.v[PW_COL_.summary - 1] || '').replace(/^'/, '').trim();
      if (done.has(q.k.k) || String(q.v[PW_COL_.bursonAt - 1] || '').trim() || (qPid && doneThreadIds.has(qPid)) ||
          isNonEnglishPost_(qSum, '')) {
        same(q);
        return false;
      }
      if (now - (Number(q.k.s) || 0) <= PW_ALERT_MAX_AGE_MS_) return true;
      writes.push([q.i, Object.assign({}, q.k, { a: 'x' })]);
      out.dropped++;
      return false;
    });
    let dup = 0;  // fresh flags skipped because their post or conversation thread was already alerted (or non-English)
    let problem = !dest || !dest.choice ? 'Watch alerts (row 35) is OFF' : dest.problem || '';
    if (!problem && dest.choice === 'mirror' && pwMirrorBusy_()) {
      problem = 'the Mirror space\'s flow ran out of time on its last run (Burson\'s alerts come first)';
    } else if (!problem && dest.choice === 'other' && opts && opts.otherBusy) {
      problem = 'the Other alerts space\'s flow ran out of time on this run (its current alerts come first)';
    }
    if (!problem) {
      const max = dest.choice === 'mirror' ? PW_ALERTS_MAX_MIRROR_ : PW_ALERTS_MAX_OTHER_;
      fresh.sort((a, b) => (Number(b.k.sc) || 0) - (Number(a.k.sc) || 0) || (Number(a.k.s) || 0) - (Number(b.k.s) || 0));
      for (const q of fresh) {
        if (out.posted >= max || (typeof left === 'function' && left() < PW_MIN_LEFT_MS_)) break;
        const a = pwAlertOfRow_(q.v, q.k);
        const pid = postIdOf_(a.url);
        if (done.has(q.k.k) || (pid && doneThreadIds.has(pid))) { same(q); dup++; continue; }
        try {
          const canFetch = typeof left !== 'function' || left() >= PW_MIN_LEFT_MS_ + PW_ALERT_PIC_LEFT_MS_;
          let post = null;
          if (canFetch) {
            try { post = lookupPost_(a.url); } catch (e) { post = null; }
          }
          if (post && isNonEnglishPost_(post.text || '', post.lang || '')) { same(q); dup++; continue; }
          const parentIds = Array.from(new Set(
            [post && post.parent && post.parent.id, post && post.reply_to && post.reply_to.id]
              .concat((post && post.thread_ids) || [])
              .map(v => String(v || '')).filter(Boolean)
          ));
          if (parentIds.some(id => doneThreadIds.has(id))) { same(q); dup++; continue; }
          const allThreadIds = [pid].concat(parentIds).filter(Boolean);
          // reuse the looked-up post for its picture so lookupPost_ runs once per candidate; its page is read for one
          // (a post the lookup gives none for) only with time for it
          const pageOk = typeof left !== 'function' || left() >= PW_MIN_LEFT_MS_ + PW_ALERT_PAGE_PIC_LEFT_MS_;
          const pic = canFetch ? pwAlertPicture_(a.url, post, pageOk) : null;
          const msg = pwPostAlert_(dest.space, pwAlertText_(Object.assign({}, a, { video: !!(pic && pic.video) })),
            `pwa:${q.k.w}|${q.k.k}`, pic && pic.img);
          const postedKey = Object.assign({}, q.k, { a: 'p', at: now, d: dest.choice, m: (msg && msg.name) || '' },
            allThreadIds.length ? { th: allThreadIds.slice(0, 6) } : {});
          writes.push([q.i, postedKey]);
          pwRememberPosted_(msg && msg.name, { sc: a.score, br: a.bar, tp: a.topic, src: a.source });
          done.add(q.k.k);
          allThreadIds.forEach(id => doneThreadIds.add(id));
          out.posted++;
        } catch (e) {
          problem = `couldn't post in ${dest.space.name}: ${truncate_(String((e && e.message) || e), 120)}`;
          console.warn(`Watch alerts: ${problem}`);
          break;
        }
      }
    }
    out.waiting = fresh.length - out.posted - dup;
    out.problem = problem;
    writes.forEach(([i, k]) => sh.getRange(block.first + i, PW_COL_.key).setValue(JSON.stringify(k)));
    if (out.posted) {
      pwAlertDay_(out.posted);
      console.log(`Watch alerts: ${out.posted} posted in ${dest.space.name}${out.waiting ? `, ${out.waiting} waiting` : ''}`);
    }
  } catch (e) {
    out.problem = truncate_(String((e && e.message) || e), 160);
    out.error = true;
    console.error('Watch alerts: ' + ((e && e.stack) || e));
  }
  return out;
}

/**
 * C35 when the Proactive watch didn't run this minute (its switch OFF, or the bot paused before it): what B35 says and
 * why nothing is posted. Never throws.
 */
function pwAlertsIdle_(control, raw, watchOn) {
  try {
    writeWatchAlertsNote_(control, pwAlertsNoteText_({ choice: pwAlertsChoice_(raw), space: null, problem: '' }, null, watchOn,
      pwAlertDay_(0)));
  } catch (e) {
    console.error('could not write C35 (Watch alerts): ' + ((e && e.message) || e));
  }
}
