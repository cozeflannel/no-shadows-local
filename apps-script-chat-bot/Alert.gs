/**
 * Alert.gs — parse a Burson/Zapier alert, build its record key, and rebuild the analyst copy with corrected values.
 *
 * Pure functions (no Apps Script services), so they also run under Node tests (test/run_tests.js).
 * Mirrors triage_agent/qa/parser.py and record_key.py for the Burson V3 layout:
 *   banner "THIS ALERT MEETS P0 CRITERIA", header "🟥SOCIAL ALERT🟥: Product | Issue | Network | N Engagements",
 *   "[Label]: value" lines, an unlabeled summary paragraph, "[Link]", "[Name]: Issue / Status", "[Code]: …".
 */

const RX_MD_ = /[*_`~]+/g;
const RX_CHAT_LINK_ = /<(https?:\/\/[^|>]+)\|([^>]*)>/g;
const RX_BULLET_ = /^\s*(?:[-•▪◦>]|\d+[.)])\s+/u;
const RX_URL_IN_TEXT_ = /https?:\/\/[^\s<>|"')\]]+/i;
const RX_BARE_URL_ = /^https?:\/\/\S+$/i;
const RX_BANNER_ = /THIS ALERT MEETS\s+(P[012])\s+CRITERIA/i;
const RX_HEADER_ = /^(?:[^\w\s]\s*)*SOCIAL ALERT(?:\s*[^\w\s])*\s*:\s*(.*)$/iu;
const RX_BOILERPLATE_ = /^(?:As a reminder,\s*all alerts can be found|Note:\s*Brand-Social-Sends@|Please note:\s*screenshots are not available|(?:🔷🔍|🔷📊|🔍📊)?\s*\[?BigQuery\b)/i;
const RX_COMPOUND_ENGAGEMENT_ = /^([A-Za-z ]+?)\s*\(\s*([\d,]+(?:\.\d+)?[km]?)\s*(?:engagements?)?\s*\)$/i;
const RX_COMPOUND_NAME_ = /^(.+?)\s+\/\s+(Ongoing Issue|New\s*\/\s*not previously reported over the past 14 days|NEW|Recently Reported)\s*$/i;
const RX_COMPOUND_KOF_ = /^(yes|true|1|no|false|0)\s*\(([^)]+)\)\s*$/i;
// Burson names the author's lists instead of Yes: "Viral KOFs (KOFs)", "CAM Tech/AI (INFs)", "I/O 2026 KOFs" (SLRR log:
// ~3,800 such alerts Apr-Oct 2026, escalated at a median of 5-29 engagements, i.e. as KOFs)
const RX_KOF_LIST_NAME_ = /\b(?:KOFs?|INFs?|KOLs?)\b/i;
const RX_NOT_KOF_LIST_ = /^google (?:owned channels?|reps?\b)/i;
const RX_AUTHOR_FOLLOWERS_ = new RegExp(
  '(?:(?:user|account|creator|channel|poster)\\s+(@?[\\w.-]+)\\s*\\(\\s*([\\d,.]+[km]?)\\s*followers?\\)|' +
  '\\(\\s*(@?[\\w.-]+)\\s*[;,]\\s*([\\d,.]+[km]?)\\s*followers?\\)|' +
  '(@[\\w.-]+)\\s*\\(\\s*([\\d,.]+[km]?)\\s*followers?\\))', 'i');

const TRUE_ = ['yes', 'y', 'true', '1', '✅', '✔', '✔️', 'x', '☑', '☑️'];
const FALSE_ = ['no', 'n', 'false', '0', '❌', '✖', '✖️', '-', '—', 'none'];
const NULL_ = ['', 'n/a', 'na', 'null', 'tbd', 'unknown', '—'];
const NEW_STATUS_SUFFIX_ = 'New / not previously reported over the past 14 days';
const ONGOING_STATUS_SUFFIX_ = 'Ongoing Issue';

// ---------------------------------------------------------------------------------------------------------------
// Reference lookups (GEN comes from Generated.gs)
// ---------------------------------------------------------------------------------------------------------------

function fieldSpec_(name) {
  return GEN.fields.find(f => f.name === name) || null;
}

function lookupByName_(items, name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return items.find(i => i.name.toLowerCase() === key) ||
    items.find(i => (i.aliases || []).some(a => a.toLowerCase() === key)) || null;
}

function lookupTag_(name) { return lookupByName_(GEN.exposure_tags, name); }
function lookupTopic_(name) { return lookupByName_(GEN.sensitive_topics, name); }
function lookupProduct_(name) { return lookupByName_(GEN.products, name); }

function legendByCode_(code) { return GEN.legend.find(a => a.code === code) || null; }

function legendByEmoji_(emoji) {
  const norm = s => String(s || '').replace(/\uFE0F/g, '');
  return GEN.legend.find(a => norm(a.emoji) === norm(emoji)) || null;
}

/** Engagement level label for a count (KOF authors are always the viral-KOF level, like the SQL rules). */
function levelFor_(total, isKof) {
  if (isKof) return GEN.viral_kof_label;
  if (total === null || total === undefined || typeof total !== 'number') return null;
  let name = null;
  GEN.engagement_levels.slice().sort((a, b) => a.min - b.min).forEach(lv => { if (total >= lv.min) name = lv.name; });
  return name;
}

function levelEmoji_(level) {
  if (!level) return '';
  if (String(level).toUpperCase() === GEN.viral_kof_label.toUpperCase()) return '⭐';
  const lv = GEN.engagement_levels.find(l => l.name.toUpperCase() === String(level).toUpperCase());
  return lv ? lv.emoji : '';
}

// ---------------------------------------------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------------------------------------------

function parseIntValue_(raw) {
  if (typeof raw === 'number') return Math.round(raw);
  const s = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase().replace(/[, ]/g, '');
  const m = s.match(/^~?(\d+(?:\.\d+)?)([km])?\+?$/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * ({ k: 1000, m: 1000000 }[m[2]] || 1));
}

function parseBoolValue_(raw) {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw || '').replace(RX_MD_, '').trim().toLowerCase();
  if (TRUE_.includes(s) || s.startsWith('yes')) return true;
  if (FALSE_.includes(s) || s.startsWith('no ') || s === 'no') return false;
  return null;
}

/** Split on ; | newline, or commas that aren't inside parentheses ("AI Overviews (AIM, Web Guide)" stays whole). */
function splitTopLevel_(s, alsoCommas) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(s)) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' || ch === '|' || ch === '\n' || (alsoCommas && ch === ',' && depth === 0)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseListValue_(raw) {
  if (Array.isArray(raw)) return raw.map(v => String(v).trim()).filter(Boolean);
  const s = String(raw || '').replace(RX_MD_, '');
  const low = s.trim().toLowerCase();
  if (NULL_.includes(low) || low === 'none' || low === 'no') return [];
  return splitTopLevel_(s, true).map(p => p.replace(/^[\s\-•]+|[\s\-•]+$/g, '')).filter(Boolean);
}

function snapEnum_(value, allowed) {
  const key = v => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const k = key(value);
  return (allowed || []).find(o => key(o) === k) || null;
}

function extractUrl_(text) {
  const m = String(text || '').match(RX_URL_IN_TEXT_);
  return m ? m[0].replace(/[.,;]+$/, '') : null;
}

const MONTHS_ = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "October 12, 2026, 1:47 AM" / "Oct 12, 2026 1:47 PM ET" / ISO -> epoch ms (ET when no zone), or null. */
function parseDateMs_(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s.replace(' UTC', 'Z'));
    return isNaN(t) ? null : t;
  }
  const m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s*(?:at\s+)?(\d{1,2}):(\d{2})\s*([AP]M)?\s*\(?([A-Z]{2,4})?\)?$/i);
  if (!m || MONTHS_[m[1].toLowerCase()] === undefined) return null;
  let hour = parseInt(m[4], 10);
  const ampm = (m[6] || '').toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const offsets = { UTC: 0, GMT: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, PST: -8, PDT: -7, BST: 1, CET: 1, CEST: 2, IST: 5.5, JST: 9 };
  const zone = (m[7] || 'ET').toUpperCase();
  const y = parseInt(m[3], 10), mo = MONTHS_[m[1].toLowerCase()], d = parseInt(m[2], 10), mi = parseInt(m[5], 10);
  let offset = offsets[zone];
  if (offset === undefined) offset = isUsDst_(y, mo, d) ? -4 : -5;  // ET / unknown: America/New_York
  return Date.UTC(y, mo, d, hour, mi) - offset * 3600e3;
}

/** US daylight saving: second Sunday of March .. first Sunday of November. */
function isUsDst_(y, mo, d) {
  const nthSunday = (month, n) => { const first = new Date(Date.UTC(y, month, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + 7 * (n - 1); };
  if (mo < 2 || mo > 10) return false;
  if (mo > 2 && mo < 10) return true;
  if (mo === 2) return d >= nthSunday(2, 2);
  return d < nthSunday(10, 1);
}

function normalizeValue_(spec, raw) {
  if (raw === null || raw === undefined) return null;
  let text = raw;
  if (typeof raw === 'string') {
    text = raw.trim();
    if (NULL_.includes(text.toLowerCase()) && spec.type !== 'boolean') return null;
  }
  switch (spec.type) {
    case 'integer': { const v = parseIntValue_(text); return v === null ? text : v; }
    case 'number': { const v = parseFloat(String(text).replace(/,/g, '')); return isNaN(v) ? text : v; }
    case 'boolean': { const v = parseBoolValue_(text); return v === null ? (NULL_.includes(String(text).trim().toLowerCase()) ? null : text) : v; }
    case 'list': return parseListValue_(text);
    case 'url': return extractUrl_(text) || String(text).trim();
    case 'enum': return (spec.allowed && snapEnum_(text, spec.allowed)) || String(text).trim();
    case 'string': return String(text).replace(/[ \t]+/g, ' ').trim();
    default: return String(text).trim();  // text, datetime (kept as written; parsed separately)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------------------

function normLabel_(text) {
  let t = String(text || '').replace(RX_MD_, '');
  t = t.trim().replace(/^[^\w(]+/u, '');
  t = t.trim().replace(/[\]\s:：]+$/u, '');
  return t.replace(/\s+/g, ' ').toLowerCase();
}

let LABEL_INDEX_ = null;

function labelIndex_() {
  if (LABEL_INDEX_) return LABEL_INDEX_;
  const index = {};
  GEN.fields.forEach(f => [f.name].concat(f.labels || []).forEach(l => {
    const k = normLabel_(l);
    if (!(k in index)) index[k] = f;
  }));
  LABEL_INDEX_ = index;
  return index;
}

/** "[Exposure Tag]: Brand - X" -> {spec, value, prefix: "[Exposure Tag]: "}; null when the line has no known label. */
function splitLabel_(line, index) {
  const re = /[:：]/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const candidate = normLabel_(line.slice(0, m.index));
    if (candidate in index) {
      const rest = line.slice(m.index + 1);
      const lead = rest.match(/^\s*/)[0];
      return { spec: index[candidate], value: rest.trim(), prefix: line.slice(0, m.index + 1) + lead };
    }
    if (candidate.length > 40) break;
  }
  return null;
}

function cleanLine_(line) {
  return String(line).replace(RX_CHAT_LINK_, '$1').replace(RX_BULLET_, '').replace(/\s+$/, '');
}

// ---------------------------------------------------------------------------------------------------------------
// Parse + detect
// ---------------------------------------------------------------------------------------------------------------

/**
 * Parse an alert. Returns {fields, extra, missing, flags, matched}. `fields` hold normalized values keyed by
 * canonical field name; `extra` keeps layout facts the rebuild needs (banner/header lines, Burson [Name] format,
 * summary text).
 */
function parseAlert_(text) {
  const index = labelIndex_();
  const raw = {};
  const labeled = {};
  const unmatched = [];
  const extra = {};
  let current = null;
  String(text || '').split(/\r?\n/).forEach((orig, i) => {
    const line = cleanLine_(orig);
    if (!line.trim()) {
      if (current && raw[current]) current = null;
      return;
    }
    const bare = line.trim();
    const bareNoMd = bare.replace(RX_MD_, '').trim();
    const mPrio = bareNoMd.match(RX_BANNER_);
    if (mPrio) {
      extra.banner_priority = mPrio[1].toUpperCase();
      extra.banner_line = i;
      if (!('priority' in raw)) raw.priority = extra.banner_priority;
      current = null;
      return;
    }
    const mHdr = bareNoMd.match(RX_HEADER_);
    if (mHdr) {
      extra.header_line = i;
      const parts = mHdr[1].split('|').map(p => p.trim());
      if (parts.length >= 4) extra.header_parts = { product: parts[0], issue_name: parts[1], social_network: parts[2], engagements: parts[3] };
      current = null;
      return;
    }
    if (RX_BOILERPLATE_.test(bareNoMd)) { current = null; return; }
    const hit = splitLabel_(line, index);
    if (hit) {
      current = hit.spec.name;
      raw[current] = !labeled[current] ? hit.value : (raw[current] + '\n' + hit.value).trim();
      labeled[current] = true;
      return;
    }
    if (RX_BARE_URL_.test(bare)) {
      if (SCREENSHOT_LINK_RX_.test(bare)) {  // Burson's screenshot of the post (for the Social Alert email), never the post
        if (!extra.screenshot_url) extra.screenshot_url = bare.match(SCREENSHOT_LINK_RX_)[0];
        current = null;
        return;
      }
      if (!('post_url' in raw)) raw.post_url = bare; else unmatched.push(bare);
      current = null;
      return;
    }
    const spec = current ? fieldSpec_(current) : null;
    if (spec && ['text', 'string', 'list'].includes(spec.type)) {
      raw[current] = (raw[current] + '\n' + bare).trim();
    } else {
      unmatched.push(bare);
      current = null;
    }
  });

  if ('engagement_level' in raw) {  // [Engagement]: HIGH (29425 engagements)
    const m = raw.engagement_level.replace(RX_MD_, '').trim().match(RX_COMPOUND_ENGAGEMENT_);
    if (m) {
      raw.engagement_level = m[1].trim();
      if (!('total_engagement' in raw)) raw.total_engagement = m[2].trim();
      extra.compound_engagement = true;
    }
  }
  if ('alert_name' in raw) {  // [Name]: <Issue Name> / <Issue Status>
    const m = raw.alert_name.replace(RX_MD_, '').trim().match(RX_COMPOUND_NAME_);
    if (m) {
      extra.burson_name_format = true;
      if (!('issue_name' in raw)) raw.issue_name = m[1].trim();
      extra.burson_status_suffix = m[2].trim();
      if (!('issue_status' in raw)) {
        const st = m[2].trim().toLowerCase();
        raw.issue_status = (st.includes('not previously reported') || st === 'new') ? 'NEW' : 'Ongoing Issue';
      }
    }
  }
  if ('kof' in raw) {  // [KOF]: Viral KOFs (KOFs), CAM Tech/AI (INFs)  ·  [KOF]: Yes (Tech Journalists)  ·  [KOF]: No
    const v = raw.kof.replace(RX_MD_, '').trim();
    const m = v.match(RX_COMPOUND_KOF_);
    if (m) {
      raw.kof = m[1];
      if (!('kof_lists' in raw)) raw.kof_lists = m[2].trim();
    } else if (parseBoolValue_(v) === null && RX_KOF_LIST_NAME_.test(v)) {  // the KOF / influencer lists the author is on
      raw.kof = 'Yes';
      if (!('kof_lists' in raw)) raw.kof_lists = v;
    } else if (parseBoolValue_(v) === null && RX_NOT_KOF_LIST_.test(v)) {  // a Google-owned channel or rep: not a KOF
      raw.kof = 'No';
    }
  }
  if (unmatched.length && !('summary' in raw) && !('post_content' in raw)) {  // unlabeled paragraph = summary
    const summary = unmatched.filter(u => !RX_BARE_URL_.test(u));
    if (summary.length) {
      raw.summary = summary.join('\n').trim();
      extra.summary_from_paragraph = true;
    }
  }

  const fields = {};
  Object.keys(raw).forEach(name => {
    const spec = fieldSpec_(name);
    if (!spec) return;
    const target = spec.numeric_fallback ? fieldSpec_(spec.numeric_fallback) : null;
    if (target && parseIntValue_(raw[name]) !== null && !snapEnum_(raw[name], spec.allowed || [])) {
      if (!(target.name in raw)) fields[target.name] = normalizeValue_(target, raw[name]);
      return;
    }
    fields[name] = normalizeValue_(spec, raw[name]);
  });
  if (fields.issue_status === NEW_STATUS_SUFFIX_) fields.issue_status = 'NEW';
  extra.raw = raw;

  const narrative = ((fields.summary || '') + '\n' + (fields.post_content || '')).trim();
  if (narrative && (!fields.author || fields.followers === undefined || fields.followers === null)) {
    const m = narrative.match(RX_AUTHOR_FOLLOWERS_);
    if (m) {
      const handle = m[1] || m[3] || m[5];
      const foll = m[2] || m[4] || m[6];
      if (handle && !fields.author) fields.author = handle;
      if (foll && (fields.followers === undefined || fields.followers === null)) fields.followers = parseIntValue_(foll);
    }
  }
  if (!fields.author && fields.code) {  // [Code]: tag,engagement,author,risk,product,status
    const parts = splitTopLevel_(fields.code, true).map(p => p.trim());
    const handle = parts.find(p => /^(@|r\/|u\/)/i.test(p));
    if (handle) fields.author = handle;
    else if (parts.length >= 6 && parts[parts.length - 4] && !/^\d+$/.test(parts[parts.length - 4])) fields.author = parts[parts.length - 4];
  }
  if (!fields.post_url) {
    const url = extractUrl_(String(text || '').replace(RX_CHAT_LINK_, '$1').replace(new RegExp(SCREENSHOT_LINK_RX_.source, 'gi'), ' '));
    if (url) fields.post_url = url;
  }
  if (!fields.author && fields.post_url) {
    const inferred = authorFromUrl_(fields.post_url);
    if (inferred) fields.author = inferred;
  }
  if (!('social_network' in raw) && !fields.social_network) {
    const hdrNet = extra.header_parts && extra.header_parts.social_network;
    if (hdrNet) fields.social_network = normalizeValue_(fieldSpec_('social_network'), hdrNet);
    else if (fields.post_url) {
      const net = networkForDomain_(domainOf_(fields.post_url));
      if (net) fields.social_network = net;
    }
  }
  const flags = {};
  Object.keys(GEN.flag_patterns || {}).forEach(k => {
    const p = GEN.flag_patterns[k];
    flags[k] = !!(p && new RegExp(p.source, p.flags).test(text || ''));
  });
  const missing = GEN.fields.filter(f => f.required && isBlank_(fields[f.name])).map(f => f.name);
  return { fields, extra, missing, flags, matched: Object.keys(fields).length };
}

function isBlank_(v) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Is this message a Zapier/Burson alert? (enough labels + a sender or text signal), like parser.detect. */
function detectAlert_(text, parsed, senderDisplay) {
  const det = GEN.detection;
  const matched = Object.keys(parsed.fields).length;
  if (matched < det.min_labels) return false;
  const name = String(senderDisplay || '').toLowerCase();
  const bySender = det.sender_names.some(n => n && name.includes(n.toLowerCase()));
  const byText = !!(det.text_regex && new RegExp(det.text_regex.source, det.text_regex.flags).test(text || ''));
  return bySender || byText || matched >= det.min_labels + 2;
}

function authorFromUrl_(url) {
  let m = String(url).match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,30})\/status\//i);
  if (m && !['i', 'intent', 'home', 'search'].includes(m[1].toLowerCase())) return '@' + m[1];
  m = String(url).match(/tiktok\.com\/(@[A-Za-z0-9_.-]+)/i);
  if (m) return m[1];
  m = String(url).match(/reddit\.com\/(r\/[A-Za-z0-9_]+)/i);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Record keys + domains (record_key.py)
// ---------------------------------------------------------------------------------------------------------------

const RX_TRACKING_ = /^(utm_|fbclid|gclid|igshid|si$|s$|t$|ref|ref_src|feature|share|mibextid)/i;

/** One key per social post regardless of how the link was written: "x.com/status/123", "reddit.com/comments/abc". */
function normalizeUrl_(url) {
  if (!url) return null;
  let u = String(url).trim().replace(/^<|>$/g, '');
  if (u.includes('|')) u = u.split('|')[0];
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const m = u.match(/^https?:\/\/([^/?#:]+)(?::\d+)?([^?#]*)(?:\?([^#]*))?/i);
  if (!m) return null;
  let host = m[1].toLowerCase();
  ['www.', 'm.', 'mobile.', 'old.', 'new.'].forEach(pre => { if (host.startsWith(pre)) host = host.slice(pre.length); });
  if (!host || !host.includes('.')) return null;
  const path = (m[2] || '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const query = {};
  (m[3] || '').split('&').filter(Boolean).forEach(kv => {
    const [k, v] = kv.split('=');
    if (k && v !== undefined && v !== '' && !(k in query)) query[k] = v;
  });
  if (host === 'twitter.com' || host === 'x.com') {
    const s = path.match(/\/status(?:es)?\/(\d+)/);
    return s ? 'x.com/status/' + s[1] : 'x.com' + path.toLowerCase();
  }
  if (host === 'youtu.be') {
    const vid = path.replace(/^\/+/, '').split('/')[0];
    return vid ? 'youtube.com/watch?v=' + vid : 'youtube.com';
  }
  if (host.endsWith('youtube.com')) {
    const s = path.match(/^\/(?:shorts|live|embed)\/([\w-]+)/);
    if (s) return 'youtube.com/watch?v=' + s[1];
    if (query.v) return 'youtube.com/watch?v=' + query.v;
    return 'youtube.com' + path;
  }
  if (host === 'redd.it') return 'reddit.com/comments/' + path.replace(/^\/+|\/+$/g, '');
  if (host.endsWith('reddit.com')) {
    const s = path.match(/\/comments\/(\w+)/);
    if (s) return 'reddit.com/comments/' + s[1];
  }
  if (host === 'threads.net' || host === 'threads.com') host = 'threads.net';
  const kept = Object.keys(query).filter(k => !RX_TRACKING_.test(k)).sort().map(k => k + '=' + query[k]);
  return host + path + (kept.length ? '?' + kept.join('&') : '');
}

function domainOf_(url) {
  const norm = normalizeUrl_(url);
  return norm ? norm.split('/')[0].split('?')[0] : null;
}

function networkForDomain_(domain) {
  if (!domain) return null;
  const map = GEN.platform_domains || {};
  return Object.keys(map).find(net => map[net].some(d => domain === d || domain.endsWith('.' + d))) || null;
}

function recordKey_(fields) {
  return fields.post_url ? normalizeUrl_(fields.post_url) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Issue similarity (14-day novelty), like requirements.issue_tokens / jaccard
// ---------------------------------------------------------------------------------------------------------------

function issueTokens_(name) {
  const stop = new Set((GEN.issue_stopwords || []).map(s => s.toLowerCase()));
  const out = new Set();
  (String(name || '').toLowerCase().match(/[a-z0-9]+/g) || []).forEach(w0 => {
    let w = w0;
    if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 3 && w.endsWith('s') && w !== 'news' && !/(ss|us|is|as|os)$/.test(w)) w = w.slice(0, -1);
    if (!stop.has(w) && w.length > 1) out.add(w);
  });
  return Array.from(out).sort();
}

function jaccard_(a, b) {
  const sa = new Set(a), sb = new Set(b);
  const inter = Array.from(sa).filter(x => sb.has(x)).length;
  const union = new Set(Array.from(sa).concat(Array.from(sb))).size;
  return union ? inter / union : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// English-language collection filter (SLRR Collection Requirements: English-language only)
// ---------------------------------------------------------------------------------------------------------------

const NON_LATIN_CHAR_RX_ =
  /\p{Script=Hangul}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Arabic}|\p{Script=Cyrillic}|\p{Script=Devanagari}|\p{Script=Thai}|\p{Script=Hebrew}|\p{Script=Bengali}|\p{Script=Tamil}|\p{Script=Telugu}|\p{Script=Malayalam}|\p{Script=Kannada}|\p{Script=Gujarati}|\p{Script=Gurmukhi}|\p{Script=Myanmar}|\p{Script=Khmer}|\p{Script=Sinhala}|\p{Script=Georgian}|\p{Script=Armenian}/gu;

const NON_ENGLISH_SCRIPT_SQL_CLASS_ =
  '[\\p{Hangul}\\p{Han}\\p{Hiragana}\\p{Katakana}\\p{Arabic}\\p{Cyrillic}\\p{Devanagari}\\p{Thai}\\p{Hebrew}\\p{Bengali}\\p{Tamil}\\p{Telugu}]';

/** True when `lang` is an explicit non-English language code or name (empty, en/en-*, und/unknown -> false). Pure. */
function isNonEnglishLangTag_(lang) {
  const s = String(lang === undefined || lang === null ? '' : lang).trim().toLowerCase();
  if (!s || /^(?:en|eng|english|und|zxx|unknown|n\/a|none|-)$/.test(s) || /^en[-_]/.test(s)) return false;
  return true;
}

/**
 * True when a social post is non-English: either `lang` explicitly names a non-English language, or non-Latin script
 * characters in `text` (after stripping URLs, @handles and ASCII hashtags) number >= 3 and make up >= 20% of letters. Pure.
 */
function isNonEnglishPost_(text, lang) {
  if (isNonEnglishLangTag_(lang)) return true;
  const cleaned = String(text === undefined || text === null ? '' : text)
    .replace(/<https?:\/\/[^>\s]+>/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[\w.]+/g, ' ')
    .replace(/#[A-Za-z0-9_]+/g, ' ');
  const nonLatin = (cleaned.match(NON_LATIN_CHAR_RX_) || []).length;
  if (nonLatin < 3) return false;
  const latin = (cleaned.match(/\p{Script=Latin}/gu) || []).length;
  return nonLatin * 5 >= nonLatin + latin;
}

/** BigQuery RE2 SQL predicate matching text dominated by non-Latin scripts (>= 3 chars and >= 20% of letters). Pure. */
function nonEnglishScriptSql_(expr) {
  const cls = NON_ENGLISH_SCRIPT_SQL_CLASS_;
  return `(REGEXP_CONTAINS(${expr}, r'${cls}{3,}') AND ARRAY_LENGTH(REGEXP_EXTRACT_ALL(${expr}, r'${cls}')) * 5 >= ` +
    `ARRAY_LENGTH(REGEXP_EXTRACT_ALL(REGEXP_REPLACE(${expr}, r'https?://\\S+', ' '), r'\\p{L}')))`;
}

/** BigQuery SQL predicate matching English (or unset/undetermined) language tags on `expr`. Pure. */
function englishLangSql_(expr) {
  const v = `LOWER(TRIM(IFNULL(${expr}, '')))`;
  return `(${v} IN ('', 'en', 'eng', 'english', 'und', 'zxx') OR STARTS_WITH(${v}, 'en-') OR STARTS_WITH(${v}, 'en_'))`;
}

// ---------------------------------------------------------------------------------------------------------------
// Rebuild: Burson's exact text with corrected values (the analyst-space copy)
// ---------------------------------------------------------------------------------------------------------------

function displayValue_(field, value, original) {
  if (Array.isArray(value)) {
    if (value.length) return value.join(', ');
    const o = String(original || '').trim();
    return ['-', 'none', 'None', 'N/A', 'n/a'].includes(o) ? o : 'None';
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value === null || value === undefined) return String(original || '');
  return String(value);
}

function statusSuffix_(status, originalSuffix) {
  if (String(status || '').toLowerCase().startsWith('ongoing')) return ONGOING_STATUS_SUFFIX_;
  const o = String(originalSuffix || '');
  return /not previously reported|^new$/i.test(o) ? o : NEW_STATUS_SUFFIX_;
}

function bannerLine_(priority, original) {
  const plain = String(original).replace(/🚨/g, '').trim();
  const m = plain.match(/^(.*?THIS ALERT MEETS\s+)P[012](\s+CRITERIA)(.*)$/i);
  if (!m) {
    const replaced = plain.replace(/(THIS ALERT MEETS\s+)P[012](\s+CRITERIA)/i, '$1' + priority + '$2');
    return priority === 'P0' ? '🚨' + replaced.trim() + '🚨' : replaced.trim();
  }
  const core = (m[1] + priority + m[2]).trim();
  const tail = m[3] || '';
  return (priority === 'P0' ? '🚨' + core + '🚨' : core) + tail;
}

/**
 * Rewrite only the lines whose value changed; order, spacing and boilerplate stay exactly as Burson sent them.
 * `fin` = final field values, `changed` = array of field names whose value was corrected.
 */
function rebuildAlert_(text, parsed, fin, changed) {
  const ch = new Set(changed || []);
  if (!ch.size) return String(text);
  const ex = parsed.extra || {};
  const index = labelIndex_();
  const lines = String(text).split(/\r?\n/);
  const codeFields = ['exposure_tag', 'total_engagement', 'risk_tags', 'product', 'issue_status'];

  if (ch.has('priority') && ex.banner_line !== undefined) lines[ex.banner_line] = bannerLine_(fin.priority, lines[ex.banner_line]);

  if (ex.header_line !== undefined) {
    const line = lines[ex.header_line];
    const levelChanged = ch.has('engagement_level');
    const partsChanged = ['product', 'issue_name', 'social_network', 'total_engagement'].some(f => ch.has(f));
    if (ex.header_parts && (partsChanged || levelChanged)) {
      const lead = (line.match(/^([^A-Za-z]*)SOCIAL ALERT/i) || [])[1] || '';
      const sq = lead.trim() ? levelEmoji_(fin.engagement_level) || lead.trim() : '';
      const hp = ex.header_parts;
      const count = ch.has('total_engagement') ? fin.total_engagement + ' Engagements' : hp.engagements;
      lines[ex.header_line] = `${sq}SOCIAL ALERT${sq}: ${ch.has('product') ? fin.product : hp.product} | ` +
        `${ch.has('issue_name') ? fin.issue_name : hp.issue_name} | ${ch.has('social_network') ? fin.social_network : hp.social_network} | ${count}`;
    } else if (levelChanged) {
      const lead = (line.match(/^([^A-Za-z]*)SOCIAL ALERT/i) || [])[1] || '';
      const old = lead.trim();
      if (old) lines[ex.header_line] = line.split(old).join(levelEmoji_(fin.engagement_level) || old);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (i === ex.banner_line || i === ex.header_line) continue;
    const hit = splitLabel_(lines[i], index);
    if (!hit) continue;
    const f = hit.spec.name;
    const prefix = hit.prefix;
    let value = null;
    if (f === 'engagement_level' && (ch.has('engagement_level') || ch.has('total_engagement'))) {
      value = ex.compound_engagement && RX_COMPOUND_ENGAGEMENT_.test(hit.value.replace(RX_MD_, '').trim())
        ? `${fin.engagement_level} (${fin.total_engagement} engagements)` : String(fin.engagement_level);
    } else if (f === 'alert_name' && ex.burson_name_format && (ch.has('alert_name') || ch.has('issue_name') || ch.has('issue_status'))) {
      value = `${fin.issue_name} / ${statusSuffix_(fin.issue_status, ex.burson_status_suffix)}`;
    } else if (f === 'alert_name' && ch.has('alert_name')) {
      value = String(fin.alert_name);
    } else if (f === 'kof' && ch.has('kof')) {
      value = fin.kof ? 'Yes' + (fin.kof_lists && fin.kof_lists.length ? ` (${fin.kof_lists.join(', ')})` : '') : 'No';
    } else if (f === 'code' && codeFields.some(c => ch.has(c))) {
      const parts = splitTopLevel_(hit.value, true).map(p => p.trim());
      if (parts.length >= 6) {
        const status = ch.has('issue_status') ? statusSuffix_(fin.issue_status, parts.slice(5).join(',')) : parts.slice(5).join(',');
        const risk = (fin.risk_tags && fin.risk_tags.length) ? fin.risk_tags[0] : parts[3];
        value = [ch.has('exposure_tag') ? fin.exposure_tag : parts[0], ch.has('total_engagement') ? fin.total_engagement : parts[1],
          parts[2], ch.has('risk_tags') ? risk : parts[3], ch.has('product') ? fin.product : parts[4], status].join(',');
      }
    } else if (ch.has(f) && !['alert_name', 'engagement_level', 'code', 'kof'].includes(f)) {
      value = displayValue_(f, fin[f], hit.value);
    }
    if (value !== null) lines[i] = prefix + value;
  }

  let out = lines.join('\n');
  if (ch.has('summary') && ex.summary_from_paragraph && ex.raw && ex.raw.summary && fin.summary) {
    const original = ex.raw.summary;
    if (out.includes(original)) out = out.replace(original, () => fin.summary);
  }
  return out;
}
