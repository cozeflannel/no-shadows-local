/**
 * Email.gs — the Social Alert email: subject, body (the team's HTML template, ported from the prototype's
 * template.html, plus a plain-text copy) and the MIME message Gmail stores as a draft. Pure (no Apps Script services
 * except Utilities for base64), so tests can read every draft.
 *
 *   socialAlertEmail_(input, plan, opts)   -> {subject, html, text, to, cc, inline}: input = emailInput_() of an alert;
 *                                             opts.standIn (testing) addresses it to that address only, opts.footer
 *                                             adds a last line; opts.test (test space, no stand-in) addresses the draft to
 *                                             opts.mailbox only; opts.reply = {subject} for an update on a sent thread;
 *                                             opts.screenshot shows the picture of the post under the summary
 *   buildMime_(msg)                        -> RFC 2822 text (multipart/alternative, UTF-8, base64 parts; inside a
 *                                             multipart/related with the screenshot when there is one)
 *   addRecipientsToMime_(raw, to, cc)      -> the same message with addresses added (the body, including any edits
 *                                             someone made in Gmail, is untouched)
 *   emailInput_(fields, esc, noWait)       -> what the email is built from, stored on the row. escalation.kb_basis (only
 *                                             when KB & Guidance started the alert) is for analysts' "Why", never the email.
 *                                             no_wait (only when "Never wait on Burson", Control row 23, was ON for the
 *                                             review): the email (and the T&S form, TnsForm.gs) gets the video's
 *                                             "Timestamp in the video" line (videoStamp_); every other email is byte for
 *                                             byte as before
 *   commsEmailInput_ / commsEmailRows_     -> Check outage & comms docs (Control tab row 20): email_input.comms_context
 *                                             (only while it was ON) adds a "Comms / Status Context" section under the
 *                                             Alert Details (Google's status when it was checked, and the approved holding
 *                                             statement); every other email is byte for byte as before
 */

const SOCIAL_ALERT_LINKS_ = {
  learnMore: 'https://sites.google.com/corp/google.com/247-social-listening-site/slrr-alerts',
  allAlerts: 'https://lookerstudio.google.com/c/u/0/reporting/f3b19d3c-e8d9-401c-b384-f730c4d66af4/page/p_ath6l398kd/',
  digest: 'http://go/slrr-digest',
  feedback: 'https://slrr-tooling-1028310913761.us-central1.run.app/feedback',
  logo: 'https://services.google.com/fh/files/newsletters/brandsafetylogo2.png',
  icon: 'https://services.google.com/fh/files/newsletters/brandsafetylogo.png',
};
const HEADER_COLORS_ = { 'VERY LOW': '#d2d4d8', LOW: '#e1aa26', MODERATE: '#de7525', HIGH: '#e6392d' };
const EMAIL_INPUT_FIELDS_ = ['issue_name', 'issue_status', 'engagement_level', 'total_engagement', 'product', 'social_network',
  'exposure_tag', 'risk_tags', 'kof', 'kof_lists', 'summary', 'post_url', 'post_date', 'code', 'author', 'location',
  'post_content', 'other_products', 'product_targets', 'alert_name', 'priority', 'video_timestamp'];

/**
 * What an alert's email (and its recipients) is built from: the corrected values + the escalation. Stored on the row.
 * kb_basis (KB & Guidance can start alerts) is copied only when there is one, and no_wait only when "Never wait on
 * Burson" is ON (noWait), so every other row is as before.
 */
function emailInput_(fields, esc, noWait) {
  const values = {};
  EMAIL_INPUT_FIELDS_.forEach(k => { if (!isBlank_(fields[k])) values[k] = k === 'post_content' ? truncate_(fields[k], 1500) : fields[k]; });
  const input = {
    fields: values,
    escalation: {
      track: esc.track, status: esc.status, reasons: esc.reasons, priority: esc.priority, exposure_tag: esc.exposure_tag,
      product: esc.product, issue_name: esc.issue_name, sensitive_topics: esc.sensitive_topics, risk_topics: esc.risk_topics || [],
      is_kof: esc.is_kof,
      engagement_total: esc.engagement_total, platform: esc.platform, non_us_markets: esc.non_us_markets,
      sundar_mention: esc.sundar_mention, owned_post: esc.owned_post, ts_reasons: esc.ts_reasons, youtube: esc.youtube,
      text: truncate_(esc.text, 4000),
    },
  };
  if (Array.isArray(esc.other_products) && esc.other_products.length) input.escalation.other_products = esc.other_products.slice();
  if (Array.isArray(esc.product_targets) && esc.product_targets.length >= 2) input.escalation.product_targets = esc.product_targets.slice();
  if (esc.kb_basis) input.escalation.kb_basis = truncate_(String(esc.kb_basis), 200);
  // the stream triage's reason (OtherAlerts.gs: an alert in another format it escalated), for analysts' "Why" only
  if (esc.triage_basis) input.escalation.triage_basis = truncate_(String(esc.triage_basis), 200);
  if (noWait) input.no_wait = true;  // Never wait on Burson (Control row 23): the timestamp line (videoStamp_)
  return input;
}

/**
 * Check outage & comms docs (Control tab row 20): what the email shows of a review's comms / status context
 * (Review.gs commsContextOf_), stored on the row as email_input.comms_context. Pure.
 */
function commsEmailInput_(c) {
  const out = {
    kind: String(c.kind || ''),
    outage_confirmed: c.outage_confirmed === true ? true : c.outage_confirmed === false ? false : null,
    status_source: truncate_(String(c.status_source || ''), 120),
    status_summary: truncate_(String(c.status_summary || ''), 240),
    holding_statement: truncate_(String(c.holding_statement || ''), COMMS_STATEMENT_MAX_CHARS_),
    document: truncate_(String(c.document || ''), 160),
  };
  if (out.outage_confirmed === null && c.unclear === true) out.unclear = true;  // searched, couldn't tell (analysts only)
  if (out.outage_confirmed === null && c.searched === true && !out.unclear) out.searched = true;  // searched, no sources (analysts only)
  return out;
}

/**
 * The "Comms / Status Context" rows at the bottom of the email ([[label, value]]): the issue, Google's status (only
 * when it was checked) and the holding statement (only when there is one). [] when there's neither, or no context. Pure.
 */
function commsEmailRows_(cc) {
  try {
    if (!cc || typeof cc !== 'object' || Array.isArray(cc)) return [];
    const checked = cc.outage_confirmed === true || cc.outage_confirmed === false;
    const stmt = String(cc.holding_statement || '').trim();
    if (!checked && !stmt) return [];
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    const rows = [];
    const kind = commsKindName_(cc.kind);
    if (kind) rows.push(['Issue', cap(kind)]);
    if (checked) rows.push(['Google status', cap(commsStatusText_(cc))]);
    if (stmt) rows.push(['Holding statement', `"${stmt}"${cc.document ? ` (from ${String(cc.document)})` : ''}`]);
    return rows;
  } catch (e) {
    return [];
  }
}

function htmlEsc_(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function levelSquare_(level, isKof) {
  if (isKof || String(level || '').toUpperCase() === String(GEN.viral_kof_label).toUpperCase()) return '\u2b50';
  const lv = GEN.engagement_levels.find(l => l.name === String(level || '').toUpperCase());
  return lv ? lv.emoji : '\ud83d\udfe7';
}

function emailValues_(input) {
  const f = input.fields || {};
  const esc = input.escalation || {};
  const status = esc.status === 'ONGOING' ? ONGOING_STATUS_SUFFIX_ : 'New';
  const count = Number.isInteger(f.total_engagement) ? f.total_engagement : (esc.engagement_total || 0);
  const kofLists = asList_(f.kof_lists);
  const primaryProduct = f.product || esc.product || 'Google';
  return {
    product: allProductsText_(f, esc, 'Google'), primaryProduct,
    issue: f.issue_name || esc.issue_name || 'Alert', network: f.social_network || '-',
    count, level: f.engagement_level || 'N/A', square: levelSquare_(f.engagement_level, esc.is_kof),
    name: `${f.issue_name || esc.issue_name || '-'} / ${status}`,
    tag: f.exposure_tag || '-', risk: asList_(f.risk_tags).join(', ') || '-',
    kof: esc.is_kof ? 'Yes' + (kofLists.length ? ` (${kofLists.join(', ')})` : '') : 'No',
    ts: input.tns_submitted ? 'Yes' : 'No',  // "whether the incident was submitted to T&S" (✍️), never why it was flagged
    summary: f.summary || '-', link: f.post_url || '', date: f.post_date || '-', code: f.code || '-',
    owned: f.exposure_tag === 'Content - Negative reaction to owned social post',
    noWait: !!input.no_wait, stamp: input.no_wait ? videoStamp_(f) : '',  // Never wait on Burson only (emailInput_)
  };
}

/**
 * Where Google comes up in a long video ("[02:15]": Burson's Timestamp, or the one the bot added from Gemini's watch),
 * for its own line in the email when the summary doesn't already give one ([MM:SS], as hasTimestamp_ reads it; a time
 * of day like "12:15 PM" isn't one); '' otherwise. Only for an alert reviewed with "Never wait on Burson" ON
 * (email_input.no_wait): every other email has no such line, as before. Pure.
 */
function videoStamp_(f) {
  const stamp = String((f && f.video_timestamp) || '').trim();
  return stamp && !/\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(String((f && f.summary) || '')) ? stamp : '';
}

function socialAlertSubject_(input, reply) {
  if (reply && reply.subject) {
    const prefix = GEN.email.reply_subject_prefix || 'Re: ';
    return reply.subject.toLowerCase().startsWith(prefix.toLowerCase()) ? reply.subject : prefix + reply.subject;
  }
  const v = emailValues_(input);
  return `${v.square}SOCIAL ALERT${v.square}: ${v.product} | ${v.issue} | ${v.network} | ${v.count} Engagements`;
}

/**
 * "[Auto-correct test] SOCIAL ALERT: …": the auto-correct test space's emails say so up front (ctx.flowTag), so the
 * tester can tell them from the Mirror space's. A reply keeps its thread's subject (already tagged), so Gmail threads it.
 */
function taggedSubject_(subject, tag, reply) {
  return tag && !(reply && reply.subject) ? `[${tag}] ${subject}` : subject;
}

function socialAlertHtml_(v, opts) {
  const color = HEADER_COLORS_[String(v.level).toUpperCase()] || '#FFA500';
  const L = SOCIAL_ALERT_LINKS_;
  const campaignProd = String(v.primaryProduct || v.product || '').trim();
  const learnMore = `${L.learnMore}?utm_source=social_alert&utm_medium=email&utm_campaign=` +
    `${encodeURIComponent(campaignProd.replace(/\s+/g, '_').toLowerCase()) || 'social_alert'}` +
    `&utm_content=header_learn_more&utm_term=${encodeURIComponent(String(v.code).trim()) || 'none'}`;
  const sendId = encodeURIComponent(opts.sendId || '');
  const sq = c => `<span style="display: inline-block; width: 12px; height: 12px; vertical-align: middle; border: 1px solid #ccc; background-color: ${c};"></span>`;
  const button = (href, label) => `<td align="center"><table border="0" cellpadding="0" cellspacing="0" role="presentation"><tr>` +
    `<td align="center" bgcolor="#007BFF" style="border-radius: 5px;"><a href="${htmlEsc_(href)}" target="_blank" style="font-size: 14px; ` +
    `font-family: Arial, sans-serif; color: #ffffff; text-decoration: none; padding: 10px 15px; border-radius: 5px; display: inline-block;">` +
    `${label}</a></td></tr></table></td>`;
  const vote = (dir, emoji, label) => `<td align="center" bgcolor="#ffffff" style="border: 1px solid #dadce0; border-radius: 6px;">` +
    `<a href="${L.feedback}?send_id=${sendId}&amp;vote=${dir}" target="_blank" style="font-size: 15px; font-family: Arial, sans-serif; ` +
    `color: #3c4043; text-decoration: none; padding: 8px 16px; display: inline-block;"><span style="font-size: 18px;">${emoji}</span> ${label}</a></td>`;
  const row = (label, value) => `<tr><td style="padding: 8px; border: 1px solid #ddd; font-size: 14px; font-weight: bold; ` +
    `color: #555555; width: 30%;">${label}</td><td style="padding: 8px; border: 1px solid #ddd; font-size: 14px;">${htmlEsc_(value)}</td></tr>`;
  const key = (mark, text) => `<tr style="vertical-align: top;"><td style="padding: 2px 0; width: 25px;">${mark}:</td>` +
    `<td style="padding: 2px 0;">${text}</td></tr>`;
  const link = v.link || '#';
  // Check outage & comms docs: its own section under Alert Details (opts.comms: commsEmailRows_), else nothing at all
  const comms = (opts.comms || []).length ? ['', '<div style="margin-top: 20px; margin-bottom: 20px;">',
    `<div style="font-size: 18px; font-weight: bold; color: #333333; margin-bottom: 10px; border-bottom: 2px solid ${color}; ` +
      'padding-bottom: 5px;">Comms / Status Context</div>',
    '<table style="width: 100%; border-collapse: collapse;">'].concat(opts.comms.map(([label, value]) => row(label, value)),
    ['</table></div>']).join('\n') : '';
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Social Alert</title></head>',
    '<body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">',
    '<div style="width: 100%; max-width: 680px; margin: 0 auto; background-color: #ffffff; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">',
    `<div style="background-color: ${color}; color: #ffffff; padding: 15px 20px; font-size: 24px; font-weight: bold; text-align: center; line-height: 30px;">`,
    `<a href="${htmlEsc_(learnMore)}" target="_blank" style="float: right; background-color: #ffffff; color: #202124; font-size: 11px; font-weight: bold; ` +
      'text-decoration: none; padding: 4px 8px; border-radius: 4px; white-space: nowrap; margin-top: 3px; line-height: normal;">Learn more</a>',
    `<img src="${L.logo}" alt="Logo" style="width: 30px; height: auto; vertical-align: middle; margin-right: 15px;">SOCIAL ALERT` +
      `<img src="${L.logo}" alt="Logo" style="width: 30px; height: auto; vertical-align: middle; margin-left: 15px;"></div>`,
    '<div style="padding: 20px;">',
    '<div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px; font-size: 14px; line-height: 1.6; margin-top: 20px;">',
    `<p style="margin-top: 0; margin-bottom: 15px; white-space: pre-wrap;">${htmlEsc_(v.summary)}</p>`,
    // Never wait on Burson only (v.noWait): the timestamp line; every other email is as before, without even its empty slot
    ...(v.noWait ? [v.stamp ? `<p style="margin-top: 0; margin-bottom: 15px;">Timestamp in the video: ${htmlEsc_(v.stamp)}</p>` : ''] : []),
    opts.screenshot ? screenshotHtml_(opts.screenshot, link) : '',
    v.owned ? '<p style="margin-top: 0; margin-bottom: 15px; font-style: italic;">*We\'re now sharing owned social alerts once sentiment reaches 40% negativity.</p>' : '',
    '<table border="0" cellpadding="0" cellspacing="0" role="presentation" align="center" style="margin: 0 auto;"><tr>',
    button(link, 'View Post'), '<td style="width: 10px;"> </td>', button(L.allAlerts, 'View All Alerts'),
    '<td style="width: 10px;"> </td>', button(L.digest, 'Create Custom Alerts Digest'), '</tr></table>',
    '<table border="0" cellpadding="0" cellspacing="0" role="presentation" align="center" style="margin: 20px auto 0 auto; border-top: 1px solid #e0e0e0; padding-top: 14px; width: 100%;">',
    '<tr><td align="center" style="font-size: 13px; font-weight: 500; color: #555555; padding-bottom: 8px;">Was this alert useful?</td></tr>',
    '<tr><td align="center"><table border="0" cellpadding="0" cellspacing="0" role="presentation" align="center" style="margin: 0 auto;"><tr>',
    vote('up', '&#x1F44D;', 'Yes'), '<td style="width: 12px;"></td>', vote('down', '&#x1F44E;', 'No'), '</tr></table></td></tr></table>',
    '</div>',
    '<div style="margin-top: 20px; margin-bottom: 20px;">',
    `<div style="font-size: 18px; font-weight: bold; color: #333333; margin-bottom: 10px; border-bottom: 2px solid ${color}; padding-bottom: 5px;">` +
      `<img src="${L.icon}" alt="Alert Icon" style="height: 20px; width: auto; vertical-align: middle; margin-right: 8px;">Alert Details</div>`,
    '<table style="width: 100%; border-collapse: collapse;">',
    row('Name', v.name), row('Engagement', `${v.level} (${v.count} engagements)`), row('Product', v.product),
    row('Social Network', v.network), row('Exposure Tag', v.tag), row('Risk Tag', v.risk), row('KOF', v.kof), row('T&S', v.ts),
    '</table></div>' + comms,
    '<div style="background-color: #f4f4f4; padding: 15px; font-size: 12px; color: #666666;">',
    '<div style="margin-bottom: 20px; padding: 10px; background-color: #e9e9e9; border-radius: 5px;">',
    '<p style="margin-top: 0; margin-bottom: 8px; font-weight: bold; color: #333333;">Emoji Key</p>',
    '<table style="width: 100%; border-collapse: collapse; font-size: 12px; color: #666666;">',
    key('⬛', 'Post being flagged has &lt;200 engagements'), key(sq('#FFD700'), 'Post being flagged has 200-499 engagements'),
    key(sq('#FFA500'), 'Post being flagged has 500-1,999 engagements'), key(sq('#DC143C'), 'Post being flagged 2,000+ engagements'),
    key('⭐', 'Post being flagged is from a Viral KOF (separate emoji because we often see these posts to eventually have high ' +
      'engagement, even if they have low engagement when we alert originally)'),
    '</table></div>',
    '<p style="margin: 5px 0;">As a reminder, all alerts can be found in our Alert Dashboard at go/SLRR-Database.</p>',
    '<p style="margin: 5px 0;">Note: Brand-Social-Sends@ and SLRR-updates@ includes xWF vendors that support Brand Social\'s 24/7 ' +
      'Social Listening &amp; Rapid Response. Please consider removing these aliases in NTK replies.</p>',
    `<p style="margin: 5px 0;">Code: ${htmlEsc_(v.code)}</p>`,
    `<p style="margin: 5px 0;">Link: <a href="${htmlEsc_(link)}" style="color: #007bff; text-decoration: underline;">${htmlEsc_(v.link || 'Link not available')}</a></p>`,
    '</div></div></div></body></html>',
  ].join('\n');
}

function socialAlertText_(v) {
  return `SOCIAL ALERT\n\n${v.summary}\n\nLink: ${v.link || '#'}${v.stamp ? `\nTimestamp in the video: ${v.stamp}` : ''}` +
    `\n\n--- Alert Details ---\nName: ${v.name}\n` +
    `Engagement: ${v.level} (${v.count} engagements)\nProduct: ${v.product}\nSocial Network: ${v.network}\n` +
    `Exposure Tag: ${v.tag}\nRisk Tag: ${v.risk}\nKOF: ${v.kof}\nT&S: ${v.ts}\nCode: ${v.code}`;
}

/** The screenshot of the post (an inline image, linked to the post) with its caption, under the summary. */
function screenshotHtml_(shot, link) {
  const label = htmlEsc_(shot.label || 'Screenshot of the post');
  return '<div style="margin: 0 0 15px 0; text-align: center;">' +
    `<a href="${htmlEsc_(link)}" target="_blank"><img src="cid:${htmlEsc_(shot.cid)}" alt="${label}" ` +
    'style="max-width: 100%; height: auto; border: 1px solid #dddddd; border-radius: 4px;"></a>' +
    `<div style="font-size: 12px; color: #777777; margin-top: 4px;">${label}</div></div>`;
}

/**
 * The Social Alert email for an alert. opts.standIn (testing): addressed to that one address only, exactly as it would
 * go out live otherwise. opts.test (a test space with no stand-in): addressed to the mailbox only, subject marked [TEST].
 * opts.footer: a last line under everything (testing: the distros it would have gone to). opts.screenshot: the picture
 * of the post (Post.gs fetchScreenshot_: {cid, mime, name, base64, label}), shown under the summary; it comes back in
 * `inline` for buildMime_ to attach.
 */
function socialAlertEmail_(input, plan, opts) {
  opts = opts || {};
  const v = emailValues_(input);
  const real = GEN.email.recipients_in === 'bcc'
    ? { to: [GEN.email.from_email], cc: [], bcc: plan.to.concat(plan.cc) } : { to: plan.to.slice(), cc: plan.cc.slice(), bcc: [] };
  const testers = onlyToList_(opts.standIn);
  const only = testers.length ? testers : (opts.test && opts.mailbox ? [opts.mailbox] : []);
  const footerHtml = opts.footer ? '<div style="max-width: 680px; margin: 12px auto 20px auto; font-family: Arial, sans-serif; ' +
    `font-size: 12px; color: #555555;">${htmlEsc_(opts.footer)}</div>` : '';
  const shot = opts.screenshot && opts.screenshot.base64 && opts.screenshot.cid ? opts.screenshot : null;
  const comms = commsEmailRows_(input.comms_context);  // Check outage & comms docs (only when it was ON for this alert)
  const commsText = comms.length ? '\n\n--- Comms / Status Context ---\n' + comms.map(([l, v2]) => `${l}: ${v2}`).join('\n') : '';
  return {
    subject: (opts.test && !testers.length ? '[TEST] ' : '') + taggedSubject_(socialAlertSubject_(input, opts.reply), opts.tag, opts.reply),
    html: socialAlertHtml_(v, Object.assign({}, opts, { screenshot: shot, comms }))
      .replace(/<\/body><\/html>$/, () => `${footerHtml}</body></html>`),
    text: socialAlertText_(v) + commsText + (opts.footer ? `\n\n${opts.footer}` : ''),
    to: only.length ? only : real.to,
    cc: only.length ? [] : real.cc,
    bcc: only.length ? [] : real.bcc,
    inline: shot ? [shot] : [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------------------------------------------

function b64_(s) { return Utilities.base64Encode(String(s), Utilities.Charset.UTF_8); }

function utf8Length_(s) { return unescape(encodeURIComponent(s)).length; }

/** A header value, as RFC 2047 encoded words when it isn't plain ASCII (each word at most 75 characters). */
function encodeHeaderValue_(value) {
  const s = String(value);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = '';
  Array.from(s).forEach(ch => {
    if (utf8Length_(chunk + ch) > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  });
  if (chunk) words.push(chunk);
  return words.map(w => `=?UTF-8?B?${b64_(w)}?=`).join('\r\n ');
}

/** "Name: a, b, c" folded at commas so no line is longer than 78 characters. */
function foldAddressHeader_(name, addresses) {
  const lines = [];
  let line = `${name}:`;
  addresses.forEach((a, i) => {
    const piece = ` ${a}${i < addresses.length - 1 ? ',' : ''}`;
    if (line.length + piece.length > 78 && line !== `${name}:`) { lines.push(line); line = ' '; }
    line += line === ' ' ? piece.trimStart() : piece;
  });
  lines.push(line);
  return lines.join('\r\n');
}

function b64Lines_(s) { return (b64_(s).match(/.{1,76}/g) || ['']).join('\r\n'); }

/**
 * RFC 2822 message: {from, to[], cc[], bcc[], subject, text, html, inReplyTo, references, inline}. multipart/alternative
 * (plain text + HTML); with inline images (inline: [{cid, mime, name, base64}], e.g. the screenshot of the post the HTML
 * shows as cid:…) that goes inside a multipart/related with the images.
 */
function buildMime_(m) {
  const hash = hashText_(m.subject + '\n' + m.html).slice(0, 28);
  const boundary = 'bqa-' + hash;
  const inline = (m.inline || []).filter(x => x && x.cid && x.base64 && /^image\//.test(String(x.mime || '')));
  const head = [];
  if (m.from) head.push(`From: ${m.from}`);
  if ((m.to || []).length) head.push(foldAddressHeader_('To', m.to));
  if ((m.cc || []).length) head.push(foldAddressHeader_('Cc', m.cc));
  if ((m.bcc || []).length) head.push(foldAddressHeader_('Bcc', m.bcc));
  head.push(`Subject: ${encodeHeaderValue_(m.subject)}`);
  if (m.inReplyTo) head.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references) head.push(`References: ${m.references}`);
  const alternative = [
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64Lines_(m.text),
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64Lines_(m.html),
    `--${boundary}--`];
  if (!inline.length) {
    head.push('MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`);
    return head.concat([''], alternative, ['']).join('\r\n');
  }
  const related = 'bqr-' + hash;
  head.push('MIME-Version: 1.0', `Content-Type: multipart/related; boundary="${related}"; type="multipart/alternative"`);
  const body = [`--${related}`, `Content-Type: multipart/alternative; boundary="${boundary}"`, ''].concat(alternative);
  inline.forEach(x => {
    const name = String(x.name || 'image').replace(/[^\w.-]/g, '_');
    body.push(`--${related}`, `Content-Type: ${x.mime}; name="${name}"`, 'Content-Transfer-Encoding: base64',
      `Content-ID: <${x.cid}>`, `Content-Disposition: inline; filename="${name}"`, '',
      (String(x.base64).replace(/\s+/g, '').match(/.{1,76}/g) || ['']).join('\r\n'));
  });
  body.push(`--${related}--`);
  return head.concat([''], body, ['']).join('\r\n');
}

const ADDRESS_RX_ = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * The raw message with `to` / `cc` addresses added (those already on To, Cc or Bcc are skipped). Only the To and Cc
 * headers change; the body, including any edits made in Gmail, is untouched. Returns {raw, added: [addresses]}.
 */
function addRecipientsToMime_(raw, to, cc) {
  const text = String(raw);
  const split = text.search(/\r?\n\r?\n/);
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? '' : text.slice(split);
  const fields = head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  const nameOf = f => f.slice(0, f.indexOf(':')).trim().toLowerCase();
  const present = [];
  fields.filter(f => ['to', 'cc', 'bcc'].includes(nameOf(f))).forEach(f => (f.match(ADDRESS_RX_) || []).forEach(a => present.push(a.toLowerCase())));
  const added = [];
  const fresh = list => (list || []).filter(a => {
    const k = String(a).toLowerCase();
    if (!a || present.includes(k)) return false;
    present.push(k);
    added.push(a);
    return true;
  });
  const update = (name, extra) => {
    if (!extra.length) return;
    const i = fields.findIndex(f => nameOf(f) === name.toLowerCase());
    const current = i >= 0 ? fields[i].slice(fields[i].indexOf(':') + 1).split(',').map(s => s.trim()).filter(Boolean) : [];
    const line = foldAddressHeader_(name, current.concat(extra));
    if (i >= 0) fields[i] = line; else fields.splice(Math.max(0, fields.findIndex(f => nameOf(f) === 'subject')), 0, line);
  };
  update('To', fresh(to));
  update('Cc', fresh(cc));
  return { raw: added.length ? fields.join('\r\n') + body : text, added };
}

/**
 * The raw draft with its T&S row set to `value` ("Yes" once ✍️ says the T&S form was submitted). Only that row
 * changes, in the bot's own base64 text parts (at any depth: a draft with the screenshot is multipart/related around
 * multipart/alternative), so the rest of the draft (including edits made in Gmail) stays as it is.
 * Returns null when the row can't be found as the bot wrote it (e.g. Gmail re-encoded the draft after an edit).
 */
function setTnsInMime_(raw, value) {
  const text = String(raw);
  const boundaries = Array.from(new Set((text.match(/boundary="?[^";\r\n]+"?/gi) || [])
    .map(b => b.replace(/^boundary="?/i, '').replace(/"$/, ''))));
  if (!boundaries.length) return null;
  let out = text;
  let changed = false;
  boundaries.forEach(boundary => {
    const marker = '--' + boundary;
    out = out.split(marker).map((piece, i) => {
      const split = piece.search(/\r?\n\r?\n/);
      if (i === 0 || split < 0) return piece;
      const head = piece.slice(0, split);
      if (!/content-transfer-encoding:\s*base64/i.test(head) || !/content-type:\s*text\/(?:html|plain)/i.test(head)) return piece;
      const sep = piece.slice(split).match(/^\r?\n\r?\n/)[0];
      const body = piece.slice(split + sep.length);
      const trailing = body.match(/\s*$/)[0];
      let decoded;
      try {
        decoded = Utilities.newBlob(Utilities.base64Decode(body.replace(/\s+/g, ''))).getDataAsString('UTF-8');
      } catch (e) {
        return piece;
      }
      const next = /content-type:\s*text\/html/i.test(head)
        ? decoded.replace(/(>T&(?:amp;)?S<\/td>\s*<td[^>]*>)[^<]*(<\/td>)/, `$1${htmlEsc_(value)}$2`)
        : decoded.replace(/^(T&S:[ \t]*)[^\r\n]*/m, `$1${value}`);
      if (next === decoded) return piece;
      changed = true;
      return head + sep + b64Lines_(next) + trailing;
    }).join(marker);
  });
  return changed ? out : null;
}
