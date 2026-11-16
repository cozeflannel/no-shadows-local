/**
 * EarlyDetectionCross.gs — a story whose main post already has another alert's card (the Auto-correct flow only,
 * setting cross_alert_notes).
 *
 * Early Detection (BigQuery.gs earlyWaveCheck_) finds a story among small accounts. Its main post may already have a card
 * of another path from the last 24 hours: Burson's corrected alert, a Direct BigQuery card, a Watch alert. Until now the
 * story was then skipped without a word. In the Auto-correct flow (ctx.sourceReadOnly; never the Mirror flow, row 32 or
 * B33) with the setting cross_alert_notes on, the two point at each other instead:
 *   - that alert went out as a Social Alert (Escalate.gs earlierOutcome_ says 'alerted', the test the Direct BigQuery
 *     poll uses for a story's card: BigQuery.gs bqStoryCardRow_): the story is not reviewed. One note goes under that
 *     alert's card (ThreadNotes.gs acThreadNote_, the one way to post under a card in the Auto-correct space):
 *       🔗 *Part of a story:* 5 small accounts on X and Reddit now tell it: <the story's plain title> (up to 3 posts)
 *     It ends as "Added under another alert's card", or as "Its main post already has an alert" when the note could not
 *     be posted. With the note posted, the signal's id and its story's keys are marked with its accounts, so the story
 *     adds another note only when it has grown to twice the accounts (and 3 more: EarlyDetection.gs edUpdateNews_);
 *   - that alert did not go out as a Social Alert: the story goes on as any other signal. When its review posts a card
 *     (a new card, not an update in an earlier story card's thread), the review note in the card's thread says so
 *     (edRelatedLine_) and one note goes under the other alert's card, pointing at the story's card (edRelatedNote_).
 *     Its review may end in a Social Alert like any story's. The line is in the review note, not on the card under its
 *     classification lines: Burson's parser (Alert.gs parseAlert_), which reads the cards in the space for the posts
 *     waiting there (BigQuery.gs bqWaitingKeys_), would take the line's link to the other card for the post's own.
 * A pace jump on a topic or on risk words is no story about one post (its "main post" is only a sample): another alert on
 * that post is no reason to stop it there, and it goes on as any other signal, with no line and no note.
 * The setting off, and every other flow: the story is skipped as before, now counted ("Its main post already has an
 * alert") and with its own id marked as seen.
 */

/**
 * True when this flow lets a story and another alert's card point at each other: the Auto-correct flow (ctx.sourceReadOnly,
 * and not the Mirror flow, row 32 or B33) with the setting cross_alert_notes on. Pure.
 */
function edCrossOn_(ctx) {
  const c = ctx || {};
  return c.sourceReadOnly === true && !c.outboundBlocked && !c.direct && !c.otherSpace &&
    (c.settings || {}).cross_alert_notes !== false;
}

/** A pace jump on a topic or on risk words: its main post is only a sample of many posts. Pure. */
function edSampleOnly_(row) {
  const r = row || {};
  return String(r.signal_type || '').trim().toUpperCase() === 'VELOCITY_SPIKE' &&
    ['PRIORITY_TOPIC', 'RISK_TERM_GROUP'].indexOf(String(r.velocity_grain || '').trim().toUpperCase()) >= 0;
}

/**
 * What the 15-minute check does with a signal (`row`) whose main post another alert covers (`other`: that alert's
 * Alert-log row): 'note' (that alert went out as a Social Alert: a note under its card, no review), 'review' (it did
 * not, or the signal is a pace jump on a topic or risk words: the signal goes on as any other), or '' (the setting
 * off, or another flow: skipped as before). Never throws.
 */
function edCrossOf_(ctx, row, other, now) {
  try {
    if (!other || !edCrossOn_(ctx)) return '';
    if (edSampleOnly_(row)) return 'review';
    return earlierOutcome_(other, now) === 'alerted' ? 'note' : 'review';
  } catch (e) {
    return '';
  }
}

/** "5 small accounts on X and Reddit": how many accounts tell a signal's story, and where. Pure. */
function edCrossAccounts_(row) {
  const r = row || {};
  const n = ewCount_(r.unique_low_tier_authors);
  const plats = edPlatformList_(r.platforms_csv || (Array.isArray(r.platforms) ? r.platforms.join(', ') : ''))
    .map(p => String(p).replace(/[<>|*_~`\r\n]+/g, ' ').trim()).filter(Boolean).slice(0, 4);
  return `${n ? `${fmtInt_(n)} small account${n === 1 ? '' : 's'}` : 'Small accounts'}${plats.length ? ` on ${edAndList_(plats)}` : ''}`;
}

/**
 * The note under the card of an alert that went out as a Social Alert: "🔗 *Part of a story:* 5 small accounts on X and
 * Reddit now tell it: <the story's plain title> (<post> · <post> · <post>)". The title is the one a card without a review
 * gets (EarlyDetectionNotes.gs edNoteStory_) without its "5 accounts posting" (the note counts them already), never the
 * producer's label; up to 3 of the story's posts are linked. Pure.
 */
function edCrossNoteText_(row) {
  const r = row || {};
  // the accounts are already counted in the note's own words: the plain title's "5 accounts posting" goes
  const title = truncate_(String(edNoteStory_(r, '')).replace(/[<>|*\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:[\d,]+ accounts|Small accounts) posting (?=“)/, ''), 120);
  const links = edRepPosts_(Array.isArray(r.posts) ? r.posts : r.representative_posts_json)
    .filter(p => /^https?:\/\/[^\s<>|]+$/i.test(p.url)).slice(0, 3)
    .map(p => edChatLink_(p.url, `@${String(p.author || 'post').replace(/^@+/, '')}`));
  return noMarkdownLinks_(`🔗 *Part of a story:* ${edCrossAccounts_(r)} now tell it: ${title}` +
    `${links.length ? ` (${links.join(' · ')})` : ''}`);
}

/**
 * A signal whose main post's alert went out as a Social Alert (edCrossOf_ 'note'): no review; one note under that
 * alert's card, then the signal is noted: "Added under another alert's card" when the note is in the card's thread,
 * "Its main post already has an alert" when it could not be posted there (the helper said why in the log). True when
 * the note is there. The caller marks the signal as seen. Never throws.
 */
function edCrossNote_(ctx, row, other, now) {
  let posted = false;
  try {
    posted = acThreadNote_(ctx, other, edCrossNoteText_(row), `story:${(other && other.alert_id) || ''}:${edNoteKey_(row)}`);
  } catch (e) {
    posted = false;
  }
  const words = edAlertWords_(other, now);
  if (posted) {
    edNote_(ctx, row, ED_OUT_.under, `Its main post already had a Social Alert, ${words}, and the story was added under its card`,
      { card: edAlertCard_(other) });
  } else {
    edNote_(ctx, row, ED_OUT_.covered, `${words}, and no note could be added under its card`, { card: edAlertCard_(other) });
  }
  return posted;
}

/**
 * At a story's review (EarlyDetection.gs edReviewAndPost_): the other alert whose card already covers the story's main
 * post (the newest Alert-log row of the last 24 hours on that post that is not an Early Detection card, as the check
 * reads them), or null. Only in the Auto-correct flow with the setting on, only for a new card (`update`: false), and
 * never for a pace jump on a topic or risk words. Never throws.
 */
function edRelatedOf_(ctx, row, now, update) {
  try {
    if (update || !row || !edCrossOn_(ctx) || edSampleOnly_(row)) return null;
    const url = String(row.primary_url || '').trim();
    const key = url ? recordKey_({ post_url: url }) : '';
    if (!key) return null;
    let best = null;
    ((ctx.store && ctx.store.alerts) || []).forEach(a => {
      if (!a || String(a.record_key || '') !== String(key) || a.ingested === ED_ALERT_INGESTED_) return;
      if (now - (Number(a.created_at) || 0) >= EW_SEEN_MS_) return;
      if (!best || (Number(a.created_at) || 0) >= (Number(best.created_at) || 0)) best = a;
    });
    return best;
  } catch (e) {
    return null;
  }
}

/** Another alert in a few words: "QA-1001 · BigQuery · BSIP, 8:08 AM ET" (its path as edAlertWords_ names it). Pure but for the time zone. */
function edAlertLabel_(alert, now) {
  const a = alert || {};
  const ing = String(a.ingested || '').trim();
  const direct = Object.keys(BQ_SOURCE_LABELS_).some(k => BQ_SOURCE_LABELS_[k] === ing);
  const path = !ing ? 'Burson alert' : direct ? `BigQuery · ${ing}` : ing;
  const when = edCardTime_(a.created_at, now);
  return `${a.alert_id || 'An alert'} · ${path}${when ? `, ${when}` : ''}`.replace(/[<>|*\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The last line of the story card's review note when another alert's card covers its main post (EarlyDetection.gs
 * edAct_ adds it as d.relatedLine): "*Related alert:* its main post already has a card (<link|QA-1001 · BigQuery · BSIP,
 * 8:08 AM ET>)", linked only when that card's message is in this flow's space. Pure.
 */
function edRelatedLine_(ctx, other, now) {
  const space = String((((ctx || {}).spaces || {}).analyst || {}).id || '');
  const msg = String((other && other.forward_message) || '');
  const url = space && msg.indexOf(`${space}/messages/`) === 0 ? originalAlertLink_(msg) : '';
  const words = edAlertLabel_(other, now);
  return `*Related alert:* its main post already has a card (${url ? edChatLink_(url, words) : words})`;
}

/**
 * After the story's card is posted (`card`: Chat's message; `logged`: its Alert-log id): one note under the other alert's
 * card (`other`), "🔗 *Part of a story:* 5 small accounts on X and Reddit tell it (<link|story card>)". True when it is
 * there (ThreadNotes.gs acThreadNote_, which logs why when it is not). Never throws.
 */
function edRelatedNote_(ctx, other, row, card, logged) {
  try {
    const url = card && card.name ? originalAlertLink_(card.name) : '';
    const where = url ? edChatLink_(url, 'story card') : `story card ${logged || ''}`.trim();
    const text = `🔗 *Part of a story:* ${edCrossAccounts_(row)} tell it (${where})`;
    return acThreadNote_(ctx, other, text, `story:${(other && other.alert_id) || ''}:${edNoteKey_(row)}`);
  } catch (e) {
    return false;
  }
}
