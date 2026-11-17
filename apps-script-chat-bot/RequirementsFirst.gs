/**
 * RequirementsFirst.gs — requirements first (the requirements-first plan, step S19a: the code check, counted only).
 * Under Control row 51 (OpenEngine.gs openOn_) with the setting open_requirements_first (true), every post Early
 * Detection reads is checked against the alert requirements the bot already holds that code can decide (the config's
 * collection rules through Escalate.gs escalation_, and the owned-post rule): it MEETS one alone (a KOF author on a list
 * the post carries or on the KOF sheet, 2,000+ engagements, the source's own official P0 tag or Sensitive Topic, Google's
 * own post with 30+ comments and 30%+ negative), it FAILS whatever its topic (an exclusion a topic would not lift), or a
 * JUDGMENT could pass it (a P0 tag or a Sensitive Topic only a reading can give); a very short post is GATED (judged on
 * less). Nothing is posted, queued or reviewed because of it: the counts go on the Engine tab (alone read, code pass,
 * gated, failed). No number is copied here: escalation_ holds them.
 *
 *   rqOn_()                        row 51 ON and the setting on
 *   rqCheckPost_(post, facts)      {rq: 'm' | 'f' | 'j' | 'g' | '', rr: reason code}; '' = not checked alone (facts.seen)
 *   rqKofIndex_(rows)              the KOF sheet's handles: {handle: [network | '*']} from its cells
 *   rqKofSheetHit_(index, handle, network)  true when the sheet lists the handle on that network (or on any: '*')
 *   rqCountPosts_(posts, facts)    checks a check's posts and counts them on the Engine tab (EngineTab.gs)
 */

const RQ_GATED_CHARS_ = 40;        // a post under this many characters is judged on less (gated)
const RQ_OWNED_MIN_COMMENTS_ = 30; // Google's own post: 30+ comments...
const RQ_OWNED_MIN_NEG_PCT_ = 30;  // ...and 30%+ of them negative (CFG:348; Review.gs's owned-post rule)
const RQ_REASON_MAX_ = 24;

/** Requirements first is on: row 51 ON and the setting open_requirements_first (true). Never throws. */
function rqOn_() {
  try {
    return typeof openOn_ === 'function' && openOn_() &&
      ((typeof GEN !== 'undefined' && GEN && GEN.settings) || {}).open_requirements_first !== false;
  } catch (e) {
    return false;
  }
}

/** An always-alert Content tag of priority P0 (step 3's stand-in for a judgment's tag). Pure (reads GEN). */
function rqP0Tag_() {
  const R = (GEN && GEN.escalation_rules) || {};
  const tags = (R.always_alert_tags || []).concat(((GEN && GEN.exposure_tags) || []).map(t => t && t.name));
  return tags.find(n => { const t = n && typeof lookupTag_ === 'function' ? lookupTag_(n) : null; return t && t.priority === 'P0'; }) || '';
}

/**
 * Checks one post against the requirements code can decide (the plan's RQ2, steps 0-3). `post`: {text, author,
 * platform, url, eng (a number or null), kofLists (the lists the source names for the author), kof (the source's own
 * KOF column), tag / topic (the source's own, used only when they are official names), product, tier ('HIGH' counts as
 * 2,000+), owned: {comments, negPct} for Google's own post}. `facts`: {seen (claimed, emailed, DSD-alerted: not checked
 * alone), kofIndex (rqKofIndex_)}. {rq, rr}: 'm' met (rr: OWNED, KOF, KOF_SHEET, HIGH_ENGAGEMENT, SOURCE_P0,
 * SOURCE_TOPIC), 'f' failed whatever its topic (rr: the exclusion), 'j' a judgment could pass it, 'g' the same for a
 * post too short to judge well, '' not checked alone. Never throws ({rq: 'j'} on an error: the permissive side).
 */
function rqCheckPost_(post, facts) {
  try {
    const p = post || {};
    const x = facts || {};
    if (x.seen) return { rq: '', rr: 'seen' };
    // 1. Google's own post: its comments and their negative share decide, nothing else
    if (p.owned && typeof p.owned === 'object') {
      const met = Number(p.owned.comments) >= RQ_OWNED_MIN_COMMENTS_ && Number(p.owned.negPct) >= RQ_OWNED_MIN_NEG_PCT_;
      return met ? { rq: 'm', rr: 'OWNED' } : { rq: 'f', rr: 'OWNED_BELOW' };
    }
    const text = String(p.text || '');
    const lists = (Array.isArray(p.kofLists) ? p.kofLists : String(p.kofLists || '').split(/[,;|]/))
      .map(s => String(s || '').trim()).filter(s => s && !RX_NOT_KOF_LIST_.test(s));
    const tag = p.tag && typeof lookupTag_ === 'function' && lookupTag_(p.tag) ? lookupTag_(p.tag).name : '';
    const topic = p.topic && typeof lookupTopic_ === 'function' && lookupTopic_(p.topic) ? lookupTopic_(p.topic).name : '';
    const eng = String(p.tier || '').toUpperCase() === 'HIGH' ? Math.max(2000, Number(p.eng) || 0)
      : (isFinite(Number(p.eng)) && p.eng !== null && p.eng !== '' ? Math.round(Number(p.eng)) : null);
    const base = { post_content: text, product: String(p.product || ''), issue_status: 'NEW' };
    if (eng !== null) base.total_engagement = eng;
    const fields = Object.assign({}, base, { kof: p.kof === true || lists.length > 0 }, lists.length ? { kof_lists: lists } : {},
      tag ? { exposure_tag: tag } : {}, topic ? { risk_tags: [topic] } : {});
    // 2. the rules alone
    const e = escalation_(fields, {});
    if (e && e.track) {
      const r = e.reasons || [];
      const rr = r.indexOf('KOF') >= 0 ? 'KOF' : r.indexOf('HIGH_ENGAGEMENT') >= 0 ? 'HIGH_ENGAGEMENT'
        : r.indexOf('P0_TOPIC') >= 0 ? 'SOURCE_P0' : r.indexOf('SENSITIVE_TOPIC') >= 0 ? 'SOURCE_TOPIC' : String(r[0] || 'MET');
      return { rq: 'm', rr: rr.slice(0, RQ_REASON_MAX_) };
    }
    // a KOF sheet hit: a code pass (Burson's review decides `kof` itself: it is not set in the review's fields)
    if (x.kofIndex && rqKofSheetHit_(x.kofIndex, p.author, p.platform)) {
      const k = escalation_(Object.assign({}, fields, { kof: true }), {});
      if (k && k.track) return { rq: 'm', rr: 'KOF_SHEET' };
    }
    // 3. could a judgment pass it? The same post with a P0 tag and a Sensitive Topic: no track even then -> fails
    const j = escalation_(Object.assign({}, fields, { exposure_tag: rqP0Tag_() || tag, risk_tags: ['Child Safety'] }), {});
    if (!(j && j.track)) {
      const why = ((e && e.reasons) || []).find(s => /^EXCLUDED_/.test(s)) || (e && e.suppression) || 'FAILED';
      return { rq: 'f', rr: String(why).slice(0, RQ_REASON_MAX_) };
    }
    return text.replace(/\s+/g, ' ').trim().length < RQ_GATED_CHARS_ ? { rq: 'g', rr: 'JUDGE_SHORT' } : { rq: 'j', rr: 'JUDGE' };
  } catch (e) {
    return { rq: 'j', rr: 'JUDGE' };
  }
}

/** A profile link's handle and network ({h, n}) or null. Pure. */
function rqProfileOf_(cell) {
  const s = String(cell || '').trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|m\.|mobile\.)?(x|twitter|tiktok|instagram|youtube|threads|reddit|linkedin|facebook|bsky)\.(?:com|net|app)\/(?:@|u\/|user\/|in\/|profile\/)?([A-Za-z0-9_.-]+)/i);
  if (!m) return null;
  const net = { x: 'x', twitter: 'x', tiktok: 'tiktok', instagram: 'instagram', youtube: 'youtube', threads: 'threads',
    reddit: 'reddit', linkedin: 'linkedin', facebook: 'facebook', bsky: 'bluesky' }[m[1].toLowerCase()];
  const h = m[2].toLowerCase();
  return /^(i|intent|home|search|web|status|watch|channel|r)$/.test(h) ? null : { h, n: net };
}

/** The network a platform name or link domain means ('x', 'reddit', ...; '' when unknown). Pure. */
function rqNetworkOf_(platform) {
  const s = String(platform || '').toLowerCase();
  if (/^(x|twitter)$/.test(s) || /\b(x|twitter)\.com/.test(s)) return 'x';
  const known = ['tiktok', 'instagram', 'youtube', 'threads', 'reddit', 'linkedin', 'facebook', 'bluesky'];
  return known.find(k => s.indexOf(k) >= 0) || '';
}

/**
 * The KOF sheet's handles (`rows`: its cells, a list a row): a profile link counts for its network, a bare handle (with
 * or without "@") for any ('*'). {handle: [networks]}, compact (an index of 3,000 rows fits two cache items). Pure.
 */
function rqKofIndex_(rows) {
  const out = {};
  const add = (h, n) => {
    if (!h) return;
    const list = out[h] = out[h] || [];
    if (list.indexOf(n) < 0) list.push(n);
  };
  (rows || []).forEach(row => (Array.isArray(row) ? row : [row]).forEach(cell => {
    const s = String(cell === undefined || cell === null ? '' : cell).trim();
    if (!s || s.length > 200) return;
    const prof = rqProfileOf_(s);
    if (prof) { add(prof.h, prof.n); return; }
    const bare = s.match(/^@?([A-Za-z0-9_.]{2,40})$/);
    if (bare && /[a-z]/i.test(bare[1]) && !/\s/.test(s)) add(bare[1].toLowerCase(), '*');
  }));
  return out;
}

/** Does the KOF sheet list `handle` on `platform`'s network, or on any ('*')? Pure. */
function rqKofSheetHit_(index, handle, platform) {
  const h = String(handle || '').trim().replace(/^@|^\/?u\//i, '').toLowerCase();
  const list = h && index ? index[h] : null;
  if (!list) return false;
  const net = rqNetworkOf_(platform);
  return list.indexOf('*') >= 0 || (!!net && list.indexOf(net) >= 0);
}

/**
 * Checks a check's posts (EarlyWaveSource.gs, after the same-author dedup) and counts what came of them on the Engine
 * tab: alone read, code pass, gated, failed. Each post keeps `rq` and `rr` (in memory, for later steps). Nothing is
 * posted, queued or reviewed. Off (row 51 OFF or the setting false): nothing. Never throws.
 */
function rqCountPosts_(posts, facts) {
  try {
    if (!rqOn_()) return null;
    const t0 = Date.now();
    const n = { alone: 0, codePass: 0, gated: 0, failed: 0, judge: 0 };
    (posts || []).forEach(p => {
      const res = rqCheckPost_({ text: p.text, author: p.author, platform: p.platform, url: p.url, eng: p.eng,
        kofLists: p.kofl, tag: p.stag, owned: p.owned }, facts);
      p.rq = res.rq;
      p.rr = res.rr;
      if (!res.rq) return;
      n.alone++;
      if (res.rq === 'm') n.codePass++;
      else if (res.rq === 'g') n.gated++;
      else if (res.rq === 'f') n.failed++;
      else n.judge++;
    });
    rqKeepJudge_(posts);  // for this run's quick looks (rqJudgeRun_, step S19d)
    if (typeof engAdd_ === 'function') {
      engAdd_('alone', n.alone);
      engAdd_('codePass', n.codePass);
      engAdd_('gated', n.gated);
      engAdd_('failed', n.failed);
      engAdd_('codeMs', Date.now() - t0);
    }
    return n;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The quick look at single posts (step S19d), counted: every post the code check left to a judgment is asked, in
// batches side by side within the run's slice; its verdict is counted at four bars, and nothing is queued (the list
// of passes waits for step S19b)
// ---------------------------------------------------------------------------------------------------------------

const RQ_BARS_ = [0.30, 0.35, 0.40, 0.50];
const RQ_SLICE_MS_ = 20 * 1000;      // the most of a run the looks may take
const RQ_LEFT_MS_ = 30 * 1000;       // a new batch starts only with this much of the flow left beyond it
let RQ_RUN_JUDGE_ = [];              // this run's posts the code check left to a judgment (the producer hands them over)

/**
 * The verdict from one post's answers (`dec`, decPostCompact_) at P0-share bar `bar` (the plan's rqDecide_): not about
 * Google under 0.20 fails; the tag is the most probable P0 tag when the P0 share is at the bar, else the chosen tag at
 * 0.80; the topic is the top one when its probability, or the share on any topic, is at the bar; a share of about
 * Google of 0.50 lifts "Google as a verb"; then escalation_: a track is a quick pass. 'pass' | 'fail'. Pure (reads GEN).
 */
function rqDecide_(dec, post, bar) {
  try {
    const d = dec || {};
    if (!(Number(d.g) >= 0.20)) return 'fail';
    const b = Number(bar) || 0.35;
    const p0Tag = Number(d.p0) >= b ? (lookupTag_(d.c) && lookupTag_(d.c).priority === 'P0' ? d.c : rqP0Tag_()) : '';
    const tag = p0Tag || (Number(d.cp) >= 0.80 && lookupTag_(d.c) ? d.c : '');
    if (tag && /owned social post/i.test(tag) && !p0Tag) return 'fail';  // the owned-post tag needs Sprinklr's numbers
    const topic = d.st && d.st !== DEC_NO_SENSITIVE_ && (Number(d.stp) >= b || Number(d.sp0) >= b) ? d.st : '';
    const text = String((post && post.text) || '');
    const fields = { post_content: Number(d.g) >= 0.50 ? text.replace(/\bgoogl(e|ed|ing)\b/gi, 'search') : text, issue_status: 'NEW',
      product: String((post && post.product) || '') };
    if (tag) fields.exposure_tag = tag;
    if (topic) fields.risk_tags = [topic];
    const e = escalation_(fields, {});
    return e && e.track ? 'pass' : 'fail';
  } catch (e) {
    return 'fail';
  }
}

/** Keeps this run's posts left to a judgment (rqCountPosts_), for rqJudgeRun_. */
function rqKeepJudge_(posts) {
  RQ_RUN_JUDGE_ = (posts || []).filter(p => p && (p.rq === 'j' || p.rq === 'g')).map(p => ({ id: p.id, text: p.text, platform: p.platform,
    t: p.t, chash: p.chash, risk: p.risk || [], eng: p.eng }));
}

/**
 * The run's quick looks at single posts (the last background step of the Auto-correct flow): this run's posts left to
 * a judgment, a P0 risk-term group first, then most engagements, asked in batches side by side (decisionsAskMany_, a
 * batch starting at 10, growing by 10 to 50 while a batch is quick) while the slice and the flow's time allow and the
 * open engine allows a quick look; each verdict counted at the four bars on the Engine tab. Off: nothing. Never throws.
 */
function rqJudgeRun_(ctx) {
  const out = { asked: 0, passes: {}, short: 0, notReached: 0 };
  try {
    if (!rqOn_() || !RQ_RUN_JUDGE_.length) return out;
    const start = Date.now();
    const deadline = Number(ctx && ctx.deadline) || 0;
    const p0 = p => (p.risk || []).some(g => typeof ftP0Group_ === 'function' && ftP0Group_({ risk_groups: g }));
    const todo = RQ_RUN_JUDGE_.slice().sort((a, b) => (p0(b) ? 1 : 0) - (p0(a) ? 1 : 0) || (Number(b.eng) || 0) - (Number(a.eng) || 0));
    const seen = new Set();
    const items = [];
    todo.forEach(p => {
      if (p.chash && seen.has(p.chash)) return;
      if (p.chash) seen.add(p.chash);
      const input = decPostInput_(p);
      if (!input) { out.short++; return; }
      items.push({ p, input });
    });
    RQ_BARS_.forEach(b => { out.passes[b] = 0; });
    const session = decSession_(() => (deadline ? deadline - Date.now() : Infinity), !!(ctx && ctx.slaBusy));
    let size = 10;
    let i = 0;
    while (i < items.length) {
      if (Date.now() - start >= RQ_SLICE_MS_ || (deadline && deadline - Date.now() < RQ_LEFT_MS_)) break;
      const may = typeof openMayStart_ === 'function' ? openMayStart_('quick', null) : { ok: true };
      if (!may.ok) break;
      const part = items.slice(i, i + size);
      const t0 = Date.now();
      const res = decisionsAskMany_(part.map(x => ({ input: x.input, questions: decPostQuestions_() })), session);
      i += part.length;
      res.forEach((r, j) => {
        if (!r || !r.ok) return;
        const dec = decPostCompact_(r.answers);
        if (!dec) return;
        out.asked++;
        RQ_BARS_.forEach(b => { if (rqDecide_(dec, part[j].p, b) === 'pass') out.passes[b]++; });
      });
      if (res.every(r => r && r.skipped)) break;
      size = Date.now() - t0 < 3000 ? Math.min(50, size + 10) : 0;
      if (!size) break;  // a slow batch: no more asks this run
    }
    out.notReached = items.length - Math.min(i, items.length);
    if (typeof engAdd_ === 'function') {
      engAdd_('asked', out.asked);
      engAdd_('qPass', out.passes[0.35]);
      engAdd_('notReached', out.notReached);
      engAdd_('quickS', Math.round((Date.now() - start) / 100) / 10);
      engSet_('note', `quick passes at 0.30 / 0.35 / 0.40 / 0.50: ${RQ_BARS_.map(b => out.passes[b]).join(' / ')}`);
    }
    RQ_RUN_JUDGE_ = [];
    return out;
  } catch (e) {
    return out;
  }
}
