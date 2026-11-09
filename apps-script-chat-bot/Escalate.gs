/**
 * Escalate.gs — which alerts are escalated (they get a Social Alert email draft), and who the email goes to.
 *
 *   escalation_(fields, opts)                port of triage_agent/qa/requirements.py: the Collection Requirements'
 *                                            tracks (URGENT / HIGH_ENGAGEMENT), exclusions, "an ongoing issue needs a
 *                                            KOF" and the YouTube protocol. Escalated = an email alert.
 *   planRecipients_(a, text, extraGroups)    port of triage_agent/routing.py plan_recipients: the product's alert POCs
 *                                            (+ conditional lists, execs, gUP), the groups whose triggers match (or
 *                                            that an analyst added with an emoji), and the default CC.
 *   relatedAlert_(review, history, now)      the earlier alert on the same issue (14 days), for a threaded reply
 *   earlierAlerts_ / followUpOf_ / followUpSkip_   the same post alerted again, or the author following up on their own
 *                                            alerted post: no second Social Alert unless it adds something (then an
 *                                            update on the earlier email's thread)
 *   kbPromotion_(review, esc, now)           KB & Guidance can start alerts (Control tab row 13, Drafts.gs escalationFor_):
 *                                            an alert the rules leave below the bar, escalated on a Guidance tab row or
 *                                            a Resources document Gemini cited and quoted (Review.gs kbCitation_)
 *
 * Pure (GEN data only). tests/test_apps_script_bot.py checks both against the Python engine on the same alerts.
 * Burson alerts carry no Sonar relevance score and no detection time, so those gates of the Python engine never apply.
 */

const RX_CACHE_ = {};

function rx_(source) { return RX_CACHE_[source] || (RX_CACHE_[source] = new RegExp(source, 'i')); }

function patternHit_(name, text) {
  const p = GEN.escalation_rules.patterns[name];
  return !!p && rx_(p).test(String(text || ''));
}

function escapeRx_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function wordRx_(term) { return rx_(`\\b${escapeRx_(term)}\\b`); }

function asList_(v) {
  if (v === null || v === undefined || v === '') return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

function casefoldIn_(value, options) {
  const v = String(value || '').trim().toLowerCase();
  return !!v && (options || []).some(o => String(o).trim().toLowerCase() === v);
}

function fmtInt_(n) { return Number(n || 0).toLocaleString('en-US'); }

/** The issue name, else the part of the alert name after the product dash (requirements.issue_name_of). */
function issueNameOf_(fields) {
  if (fields.issue_name) return String(fields.issue_name).trim();
  const name = String(fields.alert_name || '').replace(/^\s*(?:\[[^\]]*\]\s*)+/, '').trim();
  for (const dash of [' – ', ' — ', ' - ']) {
    if (name.includes(dash)) return name.split(dash).slice(1).join(dash).trim();
  }
  return name || null;
}

function isRedundantTopic_(tagName, risk) {
  const t = String(tagName || '').toLowerCase();
  return GEN.escalation_rules.redundant_pairs.some(([tag, r]) => tag.toLowerCase() === t && r.toLowerCase() === String(risk).toLowerCase());
}

function briefedHits_(products, textAll, now) {
  return (GEN.escalation_rules.briefed_topics || []).filter(b => {
    if (!b.active) return false;
    const start = b.starts_at ? Date.parse(b.starts_at) : NaN;
    const end = b.ends_at ? Date.parse(b.ends_at) : NaN;
    if ((start && now < start) || (end && now > end)) return false;
    const okProduct = !b.product_regex || rx_(b.product_regex).test(products.join(' | '));
    const okText = !b.text_regex || rx_(b.text_regex).test(textAll);
    return okProduct && okText && !!(b.product_regex || b.text_regex);
  }).map(b => b.label);
}

/**
 * Is this alert escalated (a Social Alert email), and why? `fields` are the alert's corrected values (V1 review).
 * opts.status: 'NEW' | 'ONGOING' (default: from the issue status), opts.now (ms), opts.language (default from the YAML).
 */
function escalation_(fields, opts) {
  opts = opts || {};
  const R = GEN.escalation_rules;
  const product = fields.product ? String(fields.product) : null;
  const products = [product].concat(asList_(fields.other_products)).filter(Boolean);
  const post = String(fields.post_content || '');
  const summary = String(fields.summary || '');
  const issueName = issueNameOf_(fields);
  const textAll = [post, summary, issueName || '', String(fields.alert_name || '')].join('\n').toLowerCase();
  const snippet = post.toLowerCase() || textAll;
  const issueText = `${issueName || ''}\n${summary}`.toLowerCase();
  const location = String(fields.location || '').trim();
  const language = String(opts.language || R.language || 'en').toLowerCase();
  const usLocations = R.politics_us_locations.map(s => s.toLowerCase());

  // Exposure tag and priority (an account suspension that claims censorship or bias counts as Perceived bias)
  let tag = lookupTag_(fields.exposure_tag);
  if (R.remap_suspension_bias && tag && tag.name === 'Product - Account deletion/suspension' && patternHit_('censorship', textAll)) {
    tag = lookupTag_('Product - Perceived bias') || tag;
  }
  const priority = tag ? tag.priority : (['P0', 'P1', 'P2'].includes(fields.priority) ? fields.priority : null);
  const tagName = tag ? tag.name : (fields.exposure_tag ? String(fields.exposure_tag) : null);

  // Sensitive Topics (not ones that restate the exposure tag; Politics only for the US or an English election mention)
  const riskTags = asList_(fields.risk_tags);
  const sensitive = [];
  riskTags.forEach(rt => {
    const topic = lookupTopic_(rt);
    if (!topic || isRedundantTopic_(tagName, topic.name) || isRedundantTopic_(tagName, rt)) return;
    if (topic.name === 'Politics') {
      const us = !location || usLocations.includes(location.toLowerCase());
      const election = language.startsWith('en') && patternHit_('election', textAll);
      if (!(us || election)) return;
    }
    if (!sensitive.includes(topic.name)) sensitive.push(topic.name);
  });
  const briefed = briefedHits_(products, textAll, opts.now || Date.now());

  // KOF and engagement
  const isKof = fields.kof === true || asList_(fields.kof_lists).length > 0;
  let total = Number.isInteger(fields.total_engagement) ? fields.total_engagement : null;
  if (total === null) {
    const parts = ['likes', 'comments', 'shares'].map(k => fields[k]).filter(Number.isInteger);
    total = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }
  const engagement = total || 0;

  // Exclusions (skipped when a risk signal is present)
  const riskSignal = riskTags.length > 0;
  const brandish = ['brand', 'search', 'google search', 'google', 'google (brand)'];
  const excl = [];
  R.exclusions.forEach(rule => {
    let hit;
    switch (rule.id) {
      case 'google_as_verb':
        hit = !riskSignal && priority !== 'P0' && patternHit_('google_verb', snippet) &&
          (products.length ? products : ['brand']).every(p => brandish.includes(p.toLowerCase()));
        break;
      case 'drive_link': hit = !riskSignal && patternHit_('drive_link', snippet); break;
      case 'spam':
        hit = !riskSignal && (patternHit_('spam', snippet) || (snippet.match(/https?:\/\//gi) || []).length >= 4 ||
          (snippet.match(/#[\p{L}\p{N}_]+/gu) || []).length >= 12);
        break;
      case 'ai_comparison':
        hit = R.generic_criticism_tags.includes(tagName) && !sensitive.length && patternHit_('comparison', textAll) &&
          patternHit_('ai_context', textAll);
        break;
      case 'benchmark':
        hit = priority !== 'P0' && patternHit_('benchmark', issueText) && !sensitive.some(s => s !== 'AI Personification');
        break;
      default: hit = !!rule.pattern && rx_(rule.pattern).test(snippet) && !(rule.unless_risk_keywords && riskSignal);
    }
    if (hit) excl.push('EXCLUDED_' + rule.id.toUpperCase());
  });

  // Tracks
  const urgentReasons = [];
  if (priority === 'P0') urgentReasons.push('P0_TOPIC');
  if (sensitive.length) urgentReasons.push('SENSITIVE_TOPIC');
  if (briefed.length) urgentReasons.push('BRIEFED_TOPIC');
  if (isKof) urgentReasons.push('KOF');
  const urgentOk = urgentReasons.length > 0 && !excl.length;
  const heOk = engagement >= R.high_engagement_threshold && !excl.length;
  const reasons = urgentReasons.concat(engagement >= R.high_engagement_threshold ? ['HIGH_ENGAGEMENT'] : [], excl);
  const status = opts.status || (isNewStatus_(fields.issue_status) ? 'NEW' : 'ONGOING');
  let track = urgentOk ? 'URGENT' : (heOk ? 'HIGH_ENGAGEMENT' : null);
  let suppression = null;
  if (!track) {
    suppression = excl[0] || 'below_threshold';
  } else if (track === 'URGENT' && status === 'ONGOING' && !isKof && R.ongoing_urgent_requires_kof &&
      !R.always_alert_tags.includes(tagName)) {
    if (heOk) track = 'HIGH_ENGAGEMENT';  // 2K+ still alerts, as an update on the earlier email
    else suppression = 'ongoing_no_kof';
  }

  // YouTube protocol: when YouTube is the subject, email only for a bias allegation (otherwise the YouTube space)
  const yt = R.youtube;
  const ytRx = s => patternHit_('youtube', s);
  const ytInProducts = products.some(p => ytRx(p.toLowerCase()));
  const ytSubject = (ytRx(issueName || '') || ytInProducts) && !patternHit_('google_products', issueName || '') &&
    products.every(p => ['brand', 'google (brand)'].includes(p.toLowerCase()) || ytRx(p.toLowerCase())) &&
    tagName !== 'Employees - Executive criticism';
  const ytMentioned = ytSubject || ytRx(summary.toLowerCase().replace(/^\s*you ?tube (user|channel|creator)/, '')) ||
    (String(fields.social_network || '').toLowerCase() !== 'youtube' && ytRx(snippet)) || ytInProducts;
  const ytSensitive = sensitive.some(s => yt.sensitive_topics.includes(s)) || yt.sensitive_exposure_tags.includes(tagName);
  const bias = R.bias_tags.includes(tagName) || patternHit_('censorship', issueText);
  let action = null;
  let youtube = 'none';
  if (!suppression) {
    if (yt.enabled && ytSubject && (track === 'HIGH_ENGAGEMENT' || isKof)) {
      action = bias ? 'EMAIL_ALERT' : 'YOUTUBE_CHAT_ONLY';
      youtube = bias ? 'email_and_ping' : 'chat_only';
    } else if (yt.enabled && ytSubject) {
      if (ytSensitive) { action = 'YOUTUBE_CHAT_ONLY'; youtube = 'sensitive_ping'; } else suppression = 'youtube_no_action';
    } else {
      action = 'EMAIL_ALERT';
      youtube = yt.enabled && ytMentioned ? 'email_and_ping' : 'none';
    }
  }

  // What the routing looks at: markets, Sundar, owned posts, T&S
  const markets = [];
  if (location && !usLocations.includes(location.toLowerCase())) markets.push(location);
  if (!location) {
    GEN.distribution.regional_leads.forEach(rl => {
      const terms = [rl.region].concat((rl.aliases || []).filter(a => a.length > 2));
      if (terms.some(term => wordRx_(term).test(`${issueName || ''}\n${summary}`)) &&
          !markets.some(x => x.toLowerCase() === rl.region.toLowerCase())) markets.push(rl.region);
    });
    if (!language.startsWith('en')) markets.push(`language:${language}`);
  }
  const ts = [];
  // "Viral KOF post showing a product issue": a KOF author alone isn't a T&S case (✍️ on ~3% of KOF/INF alerts in the log)
  if (isKof && R.hallucination_tags.includes(tagName)) ts.push('viral KOF');
  if (sensitive.includes('Child Safety')) ts.push('child safety');
  if (R.hallucination_tags.includes(tagName) &&
      (products.some(p => p.toLowerCase().includes('gemini')) || /\bgemini\b/.test((issueName || '').toLowerCase()))) {
    ts.push('Gemini hallucination');
  } else if (R.hallucination_tags.includes(tagName) && products.some(p => {
    const d = lookupByName_(GEN.distribution.products, p);
    return casefoldIn_((d && d.name) || p, R.hallucination_products || []);
  })) {
    ts.push('AI hallucination');
  }

  const alertable = !suppression;
  // Every Sensitive Topic on the alert, for routing: IMs still loop in Civics when the topic restates the exposure tag
  // (Privacy on a privacy alert) or is non-US politics, even though those don't make the alert urgent.
  const riskTopics = [];
  riskTags.forEach(rt => { const topic = lookupTopic_(rt); if (topic && !riskTopics.includes(topic.name)) riskTopics.push(topic.name); });
  // 🧑‍💻 [Internal] SLRR P0 + Sensitive Topics + Product Failure Escalation Protocol (port of requirements.py): a NEW
  // alert with a P0 tag or a Sensitive Topic that is a product failure / Google mistake also goes to the team leads.
  const L = GEN.leadership || {};
  const mistake = (L.product_failure_tags || []).includes(tagName) || (R.product_mistake_tags || []).includes(tagName) ||
    (L.include_content_tags !== false && /^Content - /.test(tagName || ''));
  const severe = (L.priorities || ['P0']).includes(priority) || (L.include_sensitive_topics !== false && (sensitive.length + briefed.length) > 0);
  const leadership = !!L.enabled && alertable && action === 'EMAIL_ALERT' && (status === 'NEW' || L.require_new_issue === false) &&
    severe && mistake;
  return {
    escalated: alertable && action === 'EMAIL_ALERT',
    track: alertable ? track : null, action, status, reasons, suppression, youtube,
    priority, exposure_tag: tagName, product, issue_name: issueName, sensitive_topics: sensitive.concat(briefed.map(b => `Launches: ${b}`)),
    risk_topics: riskTopics, leadership,
    is_kof: isKof, engagement_total: total, platform: fields.social_network ? String(fields.social_network) : null,
    non_us_markets: markets, sundar_mention: patternHit_('sundar', textAll),
    owned_post: tagName === 'Content - Negative reaction to owned social post', ts_reasons: ts,
    text: `${textAll}\n${issueText}`,  // what the routing keyword triggers look at
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------------------------------------------

/** The product's distro, following a single redirect of a removed one. Returns {distro, note}. */
function resolveDistro_(name) {
  const products = GEN.distribution.products;
  const distro = lookupByName_(products, name);
  if (!distro) return { distro: null, note: name ? `No distro for product '${name}'` : 'No product' };
  if (distro.deprecated) {
    const to = distro.redirect_to || [];
    const target = to.length === 1 ? lookupByName_(products, to[0]) : null;
    if (target) return { distro: target, note: `${distro.name} distro removed → ${target.name}` };
    return { distro: null, note: `${distro.name} distro removed; reclassify to one of: ${to.join(', ')}` };
  }
  return { distro, note: null };
}

/** Why a group's triggers match this alert (null = no match). */
function groupMatchReason_(group, a, text) {
  const t = group.triggers || {};
  const list = k => t[k] || [];
  if (list('exclude_products').length && casefoldIn_(a.product, t.exclude_products)) return null;
  const conds = [];
  const tag = a.exposure_tag || '';
  if (list('exposure_tags').length) conds.push([casefoldIn_(tag, t.exposure_tags), `exposure tag ${tag}`]);
  if (list('exposure_tag_prefixes').length) {
    conds.push([t.exposure_tag_prefixes.some(p => tag.toLowerCase().startsWith(p.toLowerCase())), `exposure tag ${tag}`]);
  }
  if (list('priorities').length) conds.push([casefoldIn_(a.priority, t.priorities), `priority ${a.priority}`]);
  if (list('sensitive_topics').length) {
    const topics = Array.from(new Set([].concat(a.sensitive_topics || [], a.risk_topics || [])));
    // urgent_only: the topic counts when it's why the alert is urgent (a KOF author, or under the high-engagement bar)
    const urgent = !!a.is_kof || (a.engagement_total || 0) < GEN.escalation_rules.high_engagement_threshold;
    const hits = topics.filter(s => casefoldIn_(s, t.sensitive_topics) &&
      (!t.sensitive_topics_urgent_only || urgent || casefoldIn_(s, t.sensitive_topics_any_engagement || [])));
    conds.push([hits.length > 0, `sensitive topic ${hits.join(', ')}`]);
  }
  if (list('keywords').length) conds.push([t.keywords.some(k => rx_(k).test(text || '')), 'keyword match']);
  if (t.sundar_mention) conds.push([!!a.sundar_mention, 'Sundar mention']);
  if (t.non_us_market) conds.push([(a.non_us_markets || []).length > 0, `non-US market ${(a.non_us_markets || []).join(', ')}`]);
  if (t.owned_post) conds.push([!!a.owned_post, 'owned social post']);
  if (!conds.length) return null;
  if (t.match === 'all') return conds.every(c => c[0]) ? conds.map(c => c[1]).join('; ') : null;
  const hit = conds.find(c => c[0]);
  return hit ? hit[1] : null;
}

function addUnique_(out, emails) {
  (emails || []).forEach(e => { if (e && !out.some(x => x.toLowerCase() === e.toLowerCase())) out.push(e); });
  return out;
}

/** Regional leads for the markets the alert mentions (P0: their reputational-risk list), plus parent regions. */
function regionalLeads_(a, text) {
  const leads = GEN.distribution.regional_leads || [];
  const markets = (a.non_us_markets || []).map(m => String(m).trim()).filter(m => m && !m.startsWith('language:'));
  const termsOf = (rl, long) => [rl.region].concat((rl.aliases || []).filter(al => !long || al.length > 2));
  let matched = leads.filter(rl => markets.some(m => termsOf(rl, false).some(t => t.toLowerCase() === m.toLowerCase())));
  if (!matched.length && text) matched = leads.filter(rl => termsOf(rl, true).some(t => wordRx_(t).test(text)));
  const out = [];
  const parents = [];
  matched.forEach(rl => {
    const risk = rl.reputational_risk_recipients || [];
    addUnique_(out, a.priority === 'P0' && risk.length ? risk : rl.recipients);
    if (rl.parent_region && !parents.includes(rl.parent_region.toLowerCase())) parents.push(rl.parent_region.toLowerCase());
  });
  parents.forEach(p => { const parent = leads.find(r => r.region.toLowerCase() === p); if (parent) addUnique_(out, parent.recipients); });
  return out;
}

/** Owners of the Google channel the alert is about: a channel URL or @handle in the text, else the product's own channels. */
function channelOwners_(a, product, text) {
  const channels = typeof GEN_CHANNEL_OWNERS !== 'undefined' ? GEN_CHANNEL_OWNERS : [];
  const out = [];
  const normUrl = u => String(u || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
  const hay = normUrl(text);
  const target = normUrl(a && a.owned_profile_url);
  if (target || hay) {
    channels.forEach(co => {
      const cu = normUrl(co.account_url);
      if (cu && ((target && (target === cu || target.startsWith(cu + '/'))) || (hay && hay.includes(cu)))) {
        addUnique_(out, co.owners);
      }
    });
  }
  if (!out.length && text) {
    channels.forEach(co => {
      const h = String(co.handle || '').trim();
      if (h.startsWith('@') && h.length > 2 && rx_(`(?<!\\w)${escapeRx_(h)}\\b`).test(text)) addUnique_(out, co.owners);
    });
  }
  const name = String((product ? product.name : a.product) || '').toLowerCase();
  const platform = String(a.platform || '').toLowerCase();
  if (!out.length && name) {
    channels.forEach(co => {
      if ((String(co.team_brand || '').toLowerCase() === name || String(co.account_name || '').toLowerCase() === name) &&
          (!platform || String(co.platform || '').toLowerCase() === platform) &&
          ['US', 'GLOBAL', ''].includes(String(co.region || '').toUpperCase())) addUnique_(out, co.owners);
    });
  }
  return out;
}

function groupRecipients_(group, product, a, text) {
  if (group.action_code === 'gup') return product ? (product.gup || []).slice() : [];
  if (group.action_code === 'regional_leads') { const r = regionalLeads_(a, text); if (r.length) return r; }
  if (group.action_code === 'channel_owner') { const r = channelOwners_(a, product, text); if (r.length) return r; }
  return (group.recipients || []).slice();
}

function execsApply_(product, a) {
  const high = (a.engagement_total || 0) >= GEN.escalation_rules.high_engagement_threshold;
  const rule = product.execs_rule;
  return rule === 'always' || (rule === 'p0' && a.priority === 'P0') || (rule === 'high_engagement' && high) ||
    (rule === 'p0_or_high_engagement' && (a.priority === 'P0' || high));
}

/**
 * Recipients for the Social Alert draft: {to, cc, groups, reasons, members, missing, notes}.
 *   to: the product's alert POCs (+ engagement add-ons, execs per rule, gUP when triggered)
 *   cc: groups whose triggers match (auto-included) or that an analyst added (extraGroups: legend codes), + default CC
 *   members: each group's own addresses ({group name: [emails]}, before to / cc drop the ones already on), so a reply
 *            can be credited to the team whose address sent it (FollowUp.gs)
 */
function planRecipients_(a, text, extraGroups, productName) {
  const plan = { to: [], cc: [], groups: [], reasons: {}, members: {}, missing: [], notes: [] };
  const all = () => plan.to.concat(plan.cc).map(e => e.toLowerCase());
  const add = (target, emails) => (emails || []).forEach(e => { if (e && !all().includes(e.toLowerCase())) target.push(e); });
  const res = resolveDistro_(productName || a.product);
  if (res.note) plan.notes.push(res.note);
  const product = res.distro;
  if (product) {
    add(plan.to, product.pa);
    plan.groups.push(product.name);
    plan.reasons[product.name] = 'product alert POCs';
    plan.members[product.name] = (product.pa || []).slice();
    (product.conditional || []).forEach(c => {
      if ((a.engagement_total || 0) < c.min_engagement) return;
      add(plan.to, c.recipients);
      const label = `${product.name} – ${c.label}`;
      plan.groups.push(label);
      plan.reasons[label] = `${fmtInt_(a.engagement_total)} engagements ≥ ${fmtInt_(c.min_engagement)}`;
      plan.members[label] = (c.recipients || []).slice();
    });
    if ((product.execs || []).length) {
      if (execsApply_(product, a)) {
        add(plan.to, product.execs);
        plan.groups.push(`${product.name} Execs`);
        plan.reasons[`${product.name} Execs`] = `execs rule: ${product.execs_rule}`;
        plan.members[`${product.name} Execs`] = product.execs.slice();
      } else {
        plan.notes.push(`${product.name} Execs list not added (rule: ${product.execs_rule})`);
      }
    }
  } else {
    add(plan.to, GEN.email.default_to);
  }
  const extra = (extraGroups || []).filter(Boolean).map(g => String(g).trim().toLowerCase());
  GEN.distribution.groups.forEach(group => {
    const keyMatch = extra.includes(String(group.action_code || '').toLowerCase()) || extra.includes(group.name.toLowerCase());
    const reason = keyMatch ? 'added by IM' : (group.auto_include ? groupMatchReason_(group, a, text) : null);
    if (!reason) return;
    const emails = groupRecipients_(group, product, a, text);
    if (!emails.length) { plan.missing.push(group.name); return; }
    add(group.action_code === 'gup' ? plan.to : plan.cc, emails);
    plan.groups.push(group.name);
    plan.reasons[group.name] = reason;
    plan.members[group.name] = emails.slice();
  });
  add(plan.cc, GEN.email.default_cc);
  return plan;
}

/**
 * The earlier alert on the same issue in the last 14 days (same exposure tag, near-identical issue name, another
 * post), preferring one whose Social Alert was sent, so the new email can reply on that thread. Null if none.
 */
function relatedAlert_(review, history, now) {
  const tag = String(review.fields.exposure_tag || '').toLowerCase();
  const tokens = review.issueTokens || [];
  if (!tag || !tokens.length) return null;
  const since = now - GEN.novelty_days * DAY_MS_;
  const same = (history || []).filter(h => h.created_at >= since && h.created_at <= now &&
    String(h.exposure_tag || '').toLowerCase() === tag && (!review.recordKey || h.record_key !== review.recordKey) &&
    jaccard_(tokens, h.issue_tokens || []) >= GEN.novelty_min_jaccard);
  const newest = rows => rows.reduce((best, r) => (!best || r.created_at > best.created_at ? r : best), null);
  return newest(same.filter(h => h.email_status === 'sent' && h.email_thread)) || newest(same);
}

// ---------------------------------------------------------------------------------------------------------------
// Earlier alerts: the same post alerted again, or the author following up on their own alerted post. IMs don't
// alert those twice ("X'ing this because we alerted the original post"), unless the new post adds something.
// ---------------------------------------------------------------------------------------------------------------

/** "@ICannot_Enough " -> "icannot_enough": handles compare without case or @. */
function normHandle_(s) { return String(s || '').trim().replace(/^@+/, '').trim().toLowerCase(); }

/** Normalized author handles/names known for a post: display name, URL handle, and fetched post handle. Pure. */
function authorHandles_(author, postUrl, post) {
  const out = new Set();
  const add = v => { const n = normHandle_(v); if (n) out.add(n); };
  add(author);
  if (postUrl) add(authorFromUrl_(postUrl));
  if (post && post.author) add(post.author);
  return out;
}

/** Burson's write-up says the post follows up on the author's own earlier post (a reply, a comment, a thread). */
const FOLLOW_UP_RX_ = new RegExp([
  '\\bfollow[- ]?up\\b', '\\bfollowed up\\b',
  '\\b(?:replied|responded|commented|replying|responding|commenting|replies|responds|comments) (?:to|on|under) ' +
    '(?:their|his|her|its) (?:own )?(?:earlier |previous |original |prior )?(?:post|tweet|thread|video|reel|comment)s?\\b',
  '\\brepl(?:y|ied|ies) to a post (?:they|he|she) (?:had )?(?:previously|earlier) (?:made|shared|posted)\\b',
  '\\bin (?:a|the|their|his|her) (?:same )?thread\\b', '\\bcontinu(?:ed|es|ing) (?:their|the|his|her) thread\\b',
  '\\badded to (?:their|the|his|her) (?:earlier |original )?(?:post|thread)\\b', '\\bpreviously (?:discussed|shared|posted)\\b',
  '\\b(?:their|his|her) (?:own )?(?:earlier|previous|original|prior) (?:post|tweet|video|thread)\\b', '\\bself[- ]repl',
].join('|'), 'i');

/** The bot's own outcome for an earlier alert: 'alerted' (a Social Alert went out or is going out), 'not alerted' (❌), or ''. */
function earlierOutcome_(h) {
  const st = String(h.email_status || '');
  if (['sent', 'drafted', 'pending'].includes(st)) return 'alerted';
  const codes = String(h.mirrored || '').split(' ').filter(Boolean).map(e => (legendByEmoji_(e) || {}).code).filter(Boolean);
  if (codes.some(c => ACTION_CODES_.has(c) && !['no_action', 'tns', 'escalated_jon'].includes(c))) return 'alerted';  // a team's emoji
  if (codes.includes('no_action') || ['discarded', 'deleted'].includes(st)) return 'not alerted';
  return '';
}

/** Today's date in the team's time zone ("2026-10-18"), like the SLRR alert log's date_added. */
function etDay_(ms) {
  try { return Utilities.formatDate(new Date(ms), GEN.timezone || 'America/New_York', 'yyyy-MM-dd'); } catch (e) { return ''; }
}

const EARLIER_MAX_ = 4;

/**
 * Earlier alerts this one may repeat or follow up on, newest first (at most 4; the same post and the posts this one
 * replies under or quotes are always kept):
 *   - the bot's own alerts in the last novelty_days for the same post, from the same author, or for a post this one replies
 *     under or quotes (post.thread_ids / post.quoted, from Post.gs), with their outcome and the email thread to reply on
 *   - the SLRR alert log's alerts from the same author (bq.author_alerts, 90 days) and for the posts this one replies
 *     under or quotes (bq.related_alerts, anyone's); the log only holds alerts that went out, so they're all 'alerted'
 *   - the same post in the log on an earlier day (bq.slrr_first_alerted): it was already alerted, some other way. The log
 *     never counts as the same post otherwise: the alert being reviewed may already be in it today.
 *   history: Store recentForwarded rows · bq: BigQuery.gs enrichment · now: ms · post: Post.gs lookupPost_ (optional)
 * Each: {n, source: 'bot'|'log', at, days_ago, same_post, in_thread, quoted, linked, alert_id, url, author, product,
 *        exposure_tag, risk_tags, priority, issue_name, summary, engagement, engagement_level, outcome, emojis,
 *        row (the store row: thread to reply on)}
 */
function earlierAlerts_(fields, history, bq, now, post, opts) {
  const f = fields || {};
  const authors = authorHandles_(f.author, f.post_url, post);
  const key = recordKey_(f);
  const threadIds = new Set(((post && post.thread_ids) || []).map(String));
  const quotedId = post && post.quoted && post.quoted.id ? String(post.quoted.id) : '';
  if (!authors.size && !key && !threadIds.size && !quotedId) return [];
  const linkOf = url => {
    const id = postIdOf_(url);
    const inThread = !!id && threadIds.has(id);
    const quoted = !!id && id === quotedId;
    return { in_thread: inThread, quoted, linked: inThread || quoted };
  };
  const since = now - GEN.novelty_days * DAY_MS_;
  const out = [];
  (history || []).forEach(h => {
    const at = Number(h.created_at) || 0;
    if (at < since || at > now) return;
    const v = h.fields || {};
    const samePost = !!key && h.record_key === key;
    const link = samePost ? { in_thread: false, quoted: false, linked: false } : linkOf(v.post_url);
    const hAuthors = authorHandles_(h.author || v.author, v.post_url, null);
    const sameAuthor = authors.size > 0 && Array.from(hAuthors).some(a => authors.has(a));
    if (!samePost && !link.linked && !sameAuthor) return;
    out.push(Object.assign({
      source: 'bot', at, same_post: samePost, alert_id: h.alert_id || '', url: v.post_url || '', author: h.author || v.author || '',
      product: v.product || '', exposure_tag: h.exposure_tag || v.exposure_tag || '', risk_tags: asList_(v.risk_tags),
      priority: v.priority || '', issue_name: v.issue_name || '', summary: v.summary || '',
      engagement: Number.isInteger(v.total_engagement) ? v.total_engagement : null, engagement_level: v.engagement_level || '',
      outcome: earlierOutcome_(h), emojis: String(h.mirrored || '').trim(), row: h,
    }, link));
  });
  const seen = new Set(out.map(e => recordKey_({ post_url: e.url })).filter(Boolean));
  const logEntry = (r, at, extra) => {
    const eng = Number(r.engagements);
    const engagement = r.engagements === null || r.engagements === undefined || !Number.isFinite(eng) ? null : Math.round(eng);
    return Object.assign({
      source: 'log', at, same_post: false, in_thread: false, quoted: false, linked: false, alert_id: '', url: String(r.url || ''),
      author: String(r.author_handle || ''), product: r.product || '', exposure_tag: r.exposure_tag || '',
      risk_tags: String(r.risk_tag || '').split(/\s*,\s*/).filter(s => s && s !== '-'), priority: '',
      issue_name: r.issue_name || '', summary: r.overview || '', engagement,
      engagement_level: engagement === null ? '' : (levelFor_(engagement, false) || ''), outcome: 'alerted',
      emojis: String(r.emojis || '').trim(), row: null,
    }, extra || {});
  };
  // The same post, already in the SLRR alert log: earlier day for Burson's own alerts (which may land in it today),
  // or today too for non-Burson / Watch alerts (opts.includeSameDayLog), which are never written to the SLRR log.
  const first = bq && bq.slrr_first_alerted ? String(bq.slrr_first_alerted) : '';
  const firstAt = Date.parse(first) || 0;
  const today = etDay_(now);
  const sameDayOk = !!(opts && opts.includeSameDayLog);
  if (key && firstAt && today && (sameDayOk ? first.slice(0, 10) <= today : first.slice(0, 10) < today) && !seen.has(key)) {
    seen.add(key);
    out.push(logEntry({ url: f.post_url, author_handle: f.author || '', product: bq.slrr_product, exposure_tag: bq.slrr_exposure_tag,
      issue_name: bq.slrr_issue_name, engagements: bq.slrr_engagements, overview: bq.slrr_overview, emojis: bq.slrr_emojis },
    firstAt, { same_post: true }));
  }
  [].concat((bq && bq.related_alerts) || [], (bq && bq.author_alerts) || []).forEach(r => {
    const at = Date.parse(String(r.date_added || '')) || 0;
    const k = recordKey_({ post_url: r.url });
    if (!at || at > now || !k || k === key || seen.has(k)) return;
    seen.add(k);
    out.push(logEntry(r, at, linkOf(r.url)));
  });
  const pinned = out.filter(e => e.same_post || e.linked).sort((a, b) => b.at - a.at).slice(0, EARLIER_MAX_);
  const rest = out.filter(e => !e.same_post && !e.linked).sort((a, b) => b.at - a.at);
  return pinned.concat(rest.slice(0, Math.max(0, EARLIER_MAX_ - pinned.length))).sort((a, b) => b.at - a.at)
    .map((e, i) => Object.assign(e, { n: i + 1, days_ago: Math.max(0, Math.floor((now - e.at) / DAY_MS_)) }));
}

/**
 * Which earlier alert (earlierAlerts_) this one repeats or follows up on, or null:
 *   same_post  the same post, alerted again (the bot's own alerts, or the SLRR log on an earlier day)
 *   thread     the post replies under (or quotes) an earlier alert's post, by anyone (Post.gs: certain, not a guess);
 *              whether it adds anything is Gemini's call when it picked that same alert
 *   ai         Gemini's call (llm.follow_up {of, adds_new, confidence, reason}) on an alert from the last novelty_days
 *   rule       no Gemini: Burson's write-up says it's a follow-up and the issue name matches an earlier alert's
 * Returns {original, by, adds_new (true | false | null), confidence, reason, corroborated}. corroborated: something
 * besides Gemini ties it to that alert (the thread, Burson's follow-up wording, or a near-identical issue name).
 */
function followUpOf_(earlier, ai, fields, now) {
  const recent = (earlier || []).filter(e => now - e.at <= GEN.novelty_days * DAY_MS_);
  if (!recent.length) return null;
  const f = fields || {};
  const words = FOLLOW_UP_RX_.test(`${f.summary || ''}\n${f.post_content || ''}`);
  const tokens = issueTokens_(f.issue_name || f.alert_name);
  const sameIssue = e => tokens.length > 0 && jaccard_(tokens, issueTokens_(e.issue_name)) >= GEN.novelty_min_jaccard;
  const result = (e, by, extra) => Object.assign({ original: e, by, adds_new: null, confidence: null, reason: '',
    corroborated: !!(e.same_post || e.linked || words || sameIssue(e)) }, extra || {});
  const same = recent.find(e => e.same_post);
  if (same) return result(same, 'same_post');
  const n = ai ? Number(ai.of) : NaN;
  const pick = Number.isInteger(n) ? recent.find(e => e.n === n) : null;
  const judged = pick ? {
    adds_new: typeof ai.adds_new === 'boolean' ? ai.adds_new : null,
    confidence: Math.max(0, Math.min(1, Number(ai.confidence) || 0)),
    reason: truncate_(String(ai.reason || '').trim().replace(/[.\s]+$/, ''), 200),
  } : {};
  const linked = recent.filter(e => e.linked)
    .sort((a, b) => (b.outcome === 'alerted') - (a.outcome === 'alerted') || b.at - a.at)[0];
  if (linked) return result(linked, 'thread', pick === linked ? judged : {});
  if (pick) return result(pick, 'ai', judged);
  if (ai) return null;  // Gemini looked: not a follow-up
  const rule = words ? recent.find(sameIssue) : null;
  return rule ? result(rule, 'rule') : null;
}

/**
 * Why this alert needs no Social Alert of its own because one already went out for it, or '': the same post alerted
 * again, or a follow-up (the author's, or a reply under or quote of an alerted post) with nothing new (Gemini at least
 * settings.follow_up_min_confidence sure, and the thread, Burson's write-up or issue name ties it to that alert). IMs
 * mark these ❌. Never when it raises the stakes: P0 or a Sensitive Topic the earlier alert didn't have, 2K+ engagements
 * of its own, or (same post) a higher priority or engagement level: those go out as an update on the earlier email's thread.
 */
function followUpSkip_(review, esc) {
  const fu = review && review.followUp;
  const o = fu && fu.original;
  if (!o || o.outcome !== 'alerted') return '';
  const S = GEN.settings || {};
  const minConfidence = Number(S.follow_up_min_confidence) || 0.8;
  const judgedRepeat = ['ai', 'thread'].includes(fu.by) && fu.adds_new === false && fu.confidence >= minConfidence && fu.corroborated;
  if (fu.by !== 'same_post' && !judgedRepeat) return '';
  if (stakesRose_(review, esc)) return '';
  const which = o.alert_id || o.url || 'an earlier alert';
  const why = fu.reason || 'nothing new';
  if (fu.by === 'same_post') return `the same post was already alerted (${which}${o.source === 'log' ? ', SLRR alert log' : ''})`;
  if (o.in_thread) return `a reply in the thread of ${which}, which was already alerted: ${why}`;
  if (o.quoted) return `quotes ${which}, which was already alerted: ${why}`;
  return `follow-up by the same author to ${which}, which was already alerted: ${why}`;
}

/**
 * KB & Guidance can start alerts (Control tab row 13; Drafts.gs escalationFor_ calls it only while it's ON): the
 * escalation for an alert the rules leave below the bar (under the engagement threshold, or an ongoing issue with no
 * KOF author) when Gemini is at least settings.llm_min_confidence sure it warrants a Social Alert and cites a Guidance
 * tab row or a Resources document whose words check out (review.socialAlert.per.basis, Review.gs kbCitation_). null
 * otherwise: never across an exclusion, the YouTube protocol (had the rules escalated it, it would be the YouTube chat's
 * call), a hard rule (the Sprinklr owned-post threshold), one of Gemini's no-alert checks, or a repeat of an alert that
 * went out. It keeps the rules' reasons and adds KB_OR_GUIDANCE; it never sends the leadership DM. Pure.
 */
function kbPromotion_(review, esc, now) {
  const sa = review && review.socialAlert;
  const per = sa && sa.per;
  if (!esc || esc.escalated || !per || !per.basis || sa.warranted !== true || sa.source === 'rule') return null;
  if (!(Number(sa.confidence) >= (GEN.settings.llm_min_confidence || 0.9))) return null;
  if (!['below_threshold', 'ongoing_no_kof'].includes(esc.suppression)) return null;
  const checks = review.noAlertChecks;
  if (checks && Object.keys(checks).some(k => checks[k] === true)) return null;
  if (followUpSkip_(review, esc)) return null;
  // Below the bar the rules never get to the YouTube protocol: what they'd call it at the engagement threshold
  const asIf = escalation_(Object.assign({}, review.fields, { total_engagement: GEN.escalation_rules.high_engagement_threshold }),
    { status: esc.status, now });
  if (!asIf.escalated) return null;
  return Object.assign({}, esc, {
    escalated: true, track: 'URGENT', action: 'EMAIL_ALERT', suppression: null, youtube: asIf.youtube,
    reasons: (esc.reasons || []).concat(['KB_OR_GUIDANCE']), kb_basis: per.basis, leadership: false,
  });
}

/**
 * Does this alert raise the stakes over the earlier alert it follows up on (review.followUp.original)? P0 or a Sensitive
 * Topic the earlier alert didn't have, 2K+ engagements of its own, or (the same post) a higher priority or engagement
 * level. Then it goes out, as an update on the earlier email's thread.
 */
function stakesRose_(review, esc) {
  const fu = review && review.followUp;
  const o = fu && fu.original;
  if (!o) return false;
  const e = esc || {};
  const high = GEN.escalation_rules.high_engagement_threshold;
  const had = new Set((o.risk_tags || []).map(t => String((lookupTopic_(t) || { name: t }).name).toLowerCase()));
  const newTopic = (e.sensitive_topics || []).some(t => !had.has(String(t).toLowerCase()));
  const oPriority = o.priority || (lookupTag_(o.exposure_tag) || {}).priority || '';
  const newP0 = e.priority === 'P0' && oPriority !== 'P0';
  const viral = (e.engagement_total || 0) >= high && !(fu.by === 'same_post' && (o.engagement || 0) >= high);
  const raised = fu.by === 'same_post' && raisedBy_({ priority: oPriority, engagement_level: o.engagement_level },
    { priority: e.priority, engagement_level: ((review && review.fields) || {}).engagement_level }).length > 0;
  return newTopic || newP0 || viral || raised;
}
