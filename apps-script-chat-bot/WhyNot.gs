/**
 * WhyNot.gs — "Why not this post?" (step S18 of the open-engine plan). Under Control row 51 (OpenEngine.gs openOn_), a
 * person who writes `why not <link>` in the Auto-correct space (B10) gets an answer in that message's thread from what
 * the bot already holds about the post, read-only:
 *   - the alert memory (AlertMemory.gs seenPost): a Social Alert or a card already went out for it;
 *   - the Watch detections tab (the bot's own only: isPwDetectionsTab_): a Watch flag and what came of it;
 *   - Early Detection's producer (EarlyWaveSource.gs): the story the post joined (its accounts so far), or the pool where
 *     it waits for other posts on the same story.
 * When it holds nothing it says so, and why that can be. Nothing is asked of Gemini, BigQuery or a source, and nothing is
 * written but the answer, which passes the leak guard (Outbox.gs outboxGuardHits_) and is never posted to S-F Burson
 * (B25) or the Burson test copy (B26). Its first words, "Why not:", are among the bot's own (Voice.gs isBotFormattedText_).
 *
 *   whyNotLink_(text)              the post's link when `text` is "why not <link>", else ''
 *   whyNotText_(url, facts)        the answer from what is held (whyNotFacts_), at most WHY_NOT_MAX_ characters. Pure
 *   whyNotFacts_(ctx, url)         what the bot holds about the post. Never throws
 *   whyNotAnswer_(ctx, m, url, report)  answers in m's thread (Bot.gs pollAnalystMessages_)
 */

const WHY_NOT_MAX_ = 200;
const WHY_NOT_DET_ROWS_ = 2000;    // the newest Watch detections read for it
const WHY_NOT_SOURCES_ = { sonar: 'Sonar', spk: 'Sprinklr comments', bw: 'Brandwatch (nightly)', tub: 'Tubular', ami: 'the AMIE table',
  bwl: 'Brandwatch live' };

/** The post's link when `text` is "why not <link>" (a Chat link's markup allowed), else ''. Pure. */
function whyNotLink_(text) {
  const m = String(text || '').trim().match(/^why\s+not\b\s*[:?,-]?\s*<?(https?:\/\/[^\s<>|]+)(?:\|[^>]*)?>?\s*\??$/i);
  return m ? m[1] : '';
}

/** "10:42 AM" (Eastern), or '' without a time. Never throws. */
function whyNotAt_(ms) {
  try {
    return Number(ms) > 0 ? Utilities.formatDate(new Date(Number(ms)), 'America/New_York', 'h:mm a') : '';
  } catch (e) {
    return '';
  }
}

/** The source of a producer's post, from its id ('SONAR|…' -> 'Sonar'), or ''. Pure. */
function whyNotSource_(id) {
  const k = String(id || '').split('|')[0].toLowerCase().replace(/s$/, '');
  return WHY_NOT_SOURCES_[k] || '';
}

/**
 * What the bot holds about the post at `url`: {memory: seenPost's answer | null, watch: the post's Watch detections key
 * | null, story: {lab, accounts, at, source} | null, pool: {at, source} | null}. Read-only. Never throws (a store that
 * can't be read says nothing).
 */
function whyNotFacts_(ctx, url) {
  const out = { memory: null, watch: null, story: null, pool: null };
  const key = typeof amPostKey_ === 'function' ? amPostKey_(url) : String(url || '').toLowerCase();
  const same = u => !!u && (typeof amPostKey_ === 'function' ? amPostKey_(u) : String(u).toLowerCase()) === key;
  try { out.memory = alertMemory_().seenPost(url) || null; } catch (e) { /* not read */ }
  try {
    const ss = ctx && ctx.ss;
    const sh = ss ? ss.getSheetByName(PW_DET_TAB_) : null;
    if (sh && isPwDetectionsTab_(sh)) {
      const rk = recordKey_({ post_url: url });
      const rows = pwDetRows_(sh, WHY_NOT_DET_ROWS_).values;
      for (let i = rows.length - 1; i >= 0 && !out.watch; i--) {
        const k = pwKeyOf_(rows[i][PW_COL_.key - 1]);
        if (k && (k.k === rk || same(rows[i][PW_COL_.post - 1]))) out.watch = k;
      }
    }
  } catch (e) { /* not read */ }
  try {
    const cache = CacheService.getScriptCache();
    const st = ewsState_(PropertiesService.getScriptProperties());
    const now = Date.now();
    for (const c of ewsLoadClusters_(cache, Number(st.cl) || 0)) {
      const m = (c.m || []).find(x => same(x.u));
      if (m) {
        out.story = { lab: String(c.lab || ''), accounts: new Set((c.m || []).map(x => x.a).filter(Boolean)).size, at: Number(m.j) || Number(m.t) || 0,
          source: whyNotSource_(m.i) };
        break;
      }
    }
    if (!out.story) {
      const p = ewsLoadPool_(cache, st.pool, now).find(x => same(x.u));
      if (p) out.pool = { at: Number(p.g) || 0, source: whyNotSource_(p.i) };
    }
  } catch (e) { /* not read */ }
  return out;
}

/** The answer, "Why not: …", from what is held, at most WHY_NOT_MAX_ characters (`noLabel`: the story's words left out). Pure. */
function whyNotText_(facts, noLabel) {
  const f = facts || {};
  const parts = [];
  const mem = f.memory;
  // (no alert id or path name: those are the bot's own and the leak guard keeps them in)
  const on = mem && Number(mem.at) > 0 ? ` at ${whyNotAt_(mem.at)}` : '';
  if (mem && mem.outcome === 'emailed') parts.push(`a Social Alert already went out for it${on}`);
  else if (mem && mem.outcome === 'claimed') parts.push(`a card already went out for it${on}`);
  else if (mem) parts.push(`it was already handled here${on}`);
  const w = f.watch;
  if (w) {
    const words = { p: 'the Watch posted an alert for it', g: 'the Watch listed it under an alert on the same story',
      b: `the Watch flagged it; it waits for ${PW_BREW_MIN_ACCOUNTS_} accounts on its story before one alert goes out`,
      o: 'the Watch flagged it, but the AI read says it is not about Google', d: 'the Watch flagged it, but it was already alerted',
      u: 'the Watch flagged it; it is listed under another alert', x: 'the Watch flagged it, but it waited too long and was dropped' };
    parts.push(words[w.a] || 'the Watch flagged it');
  }
  const read = x => [x.at ? `read ${whyNotAt_(x.at)}` : 'read', x.source ? `from ${x.source}` : ''].filter(Boolean).join(' ');
  if (f.story) {
    const n = Number(f.story.accounts) || 1;
    parts.push(`${read(f.story)}; it joined ${noLabel || !f.story.lab ? 'a story' : `the story "${truncate_(f.story.lab, 60)}"`} (${n} account${n === 1 ? '' : 's'} so far)`);
  } else if (f.pool) {
    parts.push(`${read(f.pool)}; it waits for other posts on the same story (none yet)`);
  }
  if (!parts.length) {
    return 'Why not: nothing is held here on this post: no source read brought it in, or it was left out before grouping (not English, too short, a repost) or read long ago.';
  }
  return truncate_(`Why not: ${parts.join('; ')}.`.replace(/\.\.$/, '.'), WHY_NOT_MAX_);
}

/**
 * Answers "why not <link>" (`url`) in m's thread in the Auto-correct space, from what the bot holds; through the leak
 * guard (a story's words that trip it are left out; an answer that still trips it is not posted). Never throws.
 */
function whyNotAnswer_(ctx, m, url, report) {
  try {
    const facts = whyNotFacts_(ctx, url);
    const guard = typeof guardFor_ === 'function' ? guardFor_(ctx) : null;
    let text = whyNotText_(facts);
    if (outboxGuardHits_(text, guard).length) text = whyNotText_(facts, true);
    if (outboxGuardHits_(text, guard).length) {
      ctx.log('a "why not" answer was not posted: it named something kept internal');
    } else {
      postTo_(ctx, ctx.spaces.analyst.id, text, m.thread || null, 'whynot:' + m.name);
      if (report) report.answers++;
    }
    ctx.store.markDone(m.name, 'question', '');
  } catch (e) {
    ctx.log('"why not" answer failed: ' + ((e && e.message) || e));
  }
}
