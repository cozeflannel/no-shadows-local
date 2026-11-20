/**
 * bwquery.js — turns a Brandwatch Boolean query into a search of our own BigQuery tables, by fixed rules.
 *
 * Nothing here guesses and nothing here calls a model: the same query always converts the same way, and the result
 * says, clause by clause, what was converted exactly, what was approximated, and what was left out and why.
 *
 *   convert(text)      -> {ok, plan, report, error}          the query as a small tree ("plan")
 *   toSql(plan, cols)  -> {sql, params}                      the plan as a BigQuery WHERE clause with named parameters
 *   evaluate(plan, p)  -> true / false                       the same plan run on one post in memory
 *   prune(plan, has)   -> {plan, removed}                    the plan without the parts a table has no column for
 *   fromFilters(f)     -> a Boolean query                    the filter form, as a query (so there is one path)
 *
 * The operators handled are the ones the team's [G EVENT] queries use (surveyed over a year of them): AND, OR, NOT,
 * brackets, "phrases", wildcards (* and ?), NEAR/n and NEAR/nf, "two words"~n, {Case Sensitive}, <<<comments>>>, and
 * title:, guid:, url:, links:, site:, subreddit:, author:, language:, hashtags:, at_mentions:, authorFollowers:.
 *
 * What our tables cannot answer is left out of the query, and the report says so: engagingWith…:, parentPostId:,
 * rootPostId: and engagementType: pick out reposts of and replies to particular posts, which our tables do not hold.
 * A clause left out of an OR makes the result narrower; one left out of an AND makes it wider.
 *
 * The regular expressions use only syntax that BigQuery (RE2) and JavaScript share, so SQL and memory agree.
 */
'use strict';

const W = '[\\p{L}\\p{N}_]';       // a word character
const NW = '[^\\p{L}\\p{N}_]';     // anything else
const B0 = `(?:^|${NW})`;          // where a word starts
const B1 = `(?:$|${NW})`;          // where a word ends
const MAX_NEAR = 30;
const MAX_RX_CHARS = 30000;        // a longer NEAR pattern is approximated as AND instead

const SITE_PLATFORM = { 'twitter.com': 'x', 'x.com': 'x', 'reddit.com': 'reddit', 'instagram.com': 'instagram',
  'facebook.com': 'facebook', 'bsky.app': 'bluesky', 'youtube.com': 'youtube', 'tiktok.com': 'tiktok',
  'threads.net': 'threads', 'threads.com': 'threads', 'linkedin.com': 'linkedin', 'tumblr.com': 'tumblr' };
const PLATFORM_SITE = { x: 'twitter.com', reddit: 'reddit.com', instagram: 'instagram.com', facebook: 'facebook.com',
  bluesky: 'bsky.app', youtube: 'youtube.com', tiktok: 'tiktok.com', threads: 'threads.net', linkedin: 'linkedin.com' };

// Operators by what becomes of them (names lowercased; Brandwatch reads them in any case)
const TEXT_FIELDS = { title: 1, raw: 1 };
const MAPPED_FIELDS = { guid: 1, url: 1, links: 1, link: 1, site: 1, subreddit: 1, author: 1, language: 1, hashtags: 1,
  at_mentions: 1, authorfollowers: 1 };
const NOT_IN_OUR_DATA = { engagingwith: 1, engagingwithguid: 1, engagingwithguids: 1, engagingwithurl: 1, parentpostid: 1,
  rootpostid: 1, engagementtype: 1, threadentrytype: 1 };
const NO_COLUMN = { country: 1, continent: 1, region: 1, city: 1, state: 1, section: 1, brandids: 1, authorverified: 1,
  authorgender: 1, accounttype: 1, bio: 1, authorbio: 1, authorname: 1, channelid: 1, minuteofday: 1, latitude: 1,
  longitude: 1, publishersubtype: 1, pagetype: 1, blogname: 1, forumname: 1, entityid: 1, imagetype: 1, interest: 1,
  profession: 1, timezone: 1, authorlocation: 1 };
const KNOWN = Object.assign({}, TEXT_FIELDS, MAPPED_FIELDS, NOT_IN_OUR_DATA, NO_COLUMN);

const isWordChar = ch => /[\p{L}\p{N}_]/u.test(ch);

// ---------------------------------------------------------------------------------------------------------------
// Reading the query: tokens, then a tree
// ---------------------------------------------------------------------------------------------------------------

function tokenize(input, warnings) {
  const s = String(input || '').replace(/[“”„‟]/g, '"').replace(/\u00a0/g, ' ');
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (s.startsWith('<<<', i)) {  // a comment
      const end = s.indexOf('>>>', i + 3);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    if (c === '(' || c === ')') { toks.push({ t: c }); i++; continue; }
    if (c === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) warnings.push('A quote is never closed: it was read to the end of the query.');
      const stop = end < 0 ? s.length : end;
      const text = s.slice(i + 1, stop);
      i = Math.min(s.length, stop + 1);
      const m = /^~(\d{1,3})/.exec(s.slice(i, i + 5));
      if (m) i += m[0].length;
      toks.push({ t: 'phrase', text, slop: m ? Number(m[1]) : 0 });
      continue;
    }
    if (c === '{') {
      const end = s.indexOf('}', i + 1);
      const stop = end < 0 ? s.length : end;
      toks.push({ t: 'phrase', text: s.slice(i + 1, stop), slop: 0, cs: true });
      i = Math.min(s.length, stop + 1);
      continue;
    }
    if (c === '[' && toks.length && toks[toks.length - 1].t === 'field') {  // a range: [1000 TO 50000]
      const end = s.indexOf(']', i + 1);
      const stop = end < 0 ? s.length : end;
      toks.push({ t: 'range', text: s.slice(i + 1, stop) });
      i = Math.min(s.length, stop + 1);
      continue;
    }
    let j = i;
    while (j < s.length && !/[\s()"]/.test(s[j])) j++;
    const word = s.slice(i, j);
    const fm = /^([A-Za-z_]{2,40}):(?!\/\/)/.exec(word);
    if (fm && !/^https?$/i.test(fm[1])) {
      const name = fm[1].toLowerCase();
      const attached = word.length > fm[0].length || s[i + fm[0].length] === '(' || s[i + fm[0].length] === '"';
      if (KNOWN[name] || attached) {  // an operator: the value follows (after a space too, for one this app knows)
        toks.push({ t: 'field', name, as: fm[1] });
        i += fm[0].length;
        continue;
      }
    }
    i = j;
    if (word === 'AND' || word === 'OR' || word === 'NOT') { toks.push({ t: word }); continue; }
    const near = /^NEAR\/(\d{1,3})(f?)$/.exec(word);
    if (near) { toks.push({ t: 'NEAR', n: Math.min(MAX_NEAR, Number(near[1])), ordered: near[2] === 'f' }); continue; }
    if (/^(?:and|or|not)$/.test(word)) warnings.push(`"${word}" in lowercase is read as a word, as Brandwatch reads it. Operators are AND, OR, NOT in capitals.`);
    const clean = word.replace(/[,;:!.]+$/, '');
    if (clean) toks.push({ t: 'word', text: clean });
  }
  return toks;
}

/**
 * The query as a tree. Nodes: {t: 'and' | 'or', kids}, {t: 'not', kid}, {t: 'near', a, b, n, ordered},
 * {t: 'term', text, cs}, {t: 'phrase', words, slop, cs}, {t: 'field', name, as, value}, {t: 'range', text}.
 */
function parse(input, warnings) {
  const toks = tokenize(input, warnings);
  let pos = 0;
  let implicit = false;
  let mixed = false;
  let hoisted = false;
  let excl = [];  // what the bracket level being read says NOT to (see group)
  const peek = () => toks[pos];
  const startsPrimary = t => !!t && (t.t === '(' || t.t === 'word' || t.t === 'phrase' || t.t === 'field' || t.t === 'NOT');

  function primary() {
    const t = toks[pos];
    if (!t) return null;
    if (t.t === '(') {
      pos++;
      const inner = group();
      if (peek() && peek().t === ')') pos++;
      else warnings.push('A bracket is never closed: it was closed at the end of the query.');
      if (inner) inner.bracketed = true;
      return inner;
    }
    if (t.t === 'word') { pos++; return { t: 'term', text: t.text, cs: false }; }
    if (t.t === 'phrase') {
      pos++;
      const ws = t.text.split(/\s+/).map(w => w.replace(/[,;:!.]+$/, '')).filter(Boolean);
      if (!ws.length) return null;
      if (ws.length === 1) return { t: 'term', text: ws[0], cs: !!t.cs };
      return { t: 'phrase', words: ws, slop: t.slop || 0, cs: !!t.cs };
    }
    if (t.t === 'field') {
      pos++;
      const v = toks[pos];
      let value = null;
      if (v && v.t === 'range') { pos++; value = { t: 'range', text: v.text }; }
      else if (v && (v.t === '(' || v.t === 'word' || v.t === 'phrase')) value = primary();
      return { t: 'field', name: t.name, as: t.as, value };
    }
    pos++;  // something out of place (a stray operator or bracket): skipped
    warnings.push(`"${t.t}" is out of place and was skipped.`);
    return primary();
  }

  function nearExpr() {
    let left = primary();
    while (peek() && peek().t === 'NEAR') {
      const op = toks[pos++];
      const right = primary();
      if (!left || !right) break;
      left = { t: 'near', a: left, b: right, n: op.n, ordered: op.ordered };
    }
    return left;
  }

  function notExpr() {
    if (peek() && peek().t === 'NOT') {
      pos++;
      const kid = notExpr();
      return kid ? { t: 'not', kid } : null;
    }
    return nearExpr();
  }

  function andExpr() {
    const kids = [];
    let first = notExpr();
    if (first) kids.push(first);
    for (;;) {
      const t = peek();
      if (t && t.t === 'AND') { pos++; first = notExpr(); if (first) kids.push(first); continue; }
      if (t && t.t === 'NOT') {  // "… NOT b": b is excluded from this whole bracket level (group)
        pos++;
        first = notExpr();
        if (first) excl.push(first);
        continue;
      }
      if (startsPrimary(t)) { implicit = true; first = notExpr(); if (first) kids.push(first); continue; }
      break;
    }
    return kids.length > 1 ? { t: 'and', kids } : kids[0] || null;
  }

  function orExpr() {
    const kids = [];
    let k = andExpr();
    if (k) kids.push(k);
    while (peek() && peek().t === 'OR') {
      pos++;
      k = andExpr();
      if (k) kids.push(k);
    }
    if (kids.length > 1 && kids.some(x => x.t === 'and' && !x.bracketed)) mixed = true;
    return kids.length > 1 ? { t: 'or', kids } : kids[0] || null;
  }

  /**
   * One bracket level (or the whole query). A NOT that follows a term without AND excludes from everything at its
   * level, as Brandwatch reads it: "a OR b OR c NOT d" is "(a OR b OR c) NOT d", which is how the team writes
   * exclusions at the end of a query.
   */
  function group() {
    const outer = excl;
    excl = [];
    let node = orExpr();
    const mine = excl;
    excl = outer;
    if (!mine.length) return node;
    if (node && node.t === 'or') hoisted = true;
    const nots = mine.map(kid => ({ t: 'not', kid }));
    if (!node) return nots.length > 1 ? { t: 'and', kids: nots } : nots[0];
    return { t: 'and', kids: [node].concat(nots), bracketed: true };
  }

  let tree = group();
  while (pos < toks.length) {  // what is left after a stray ")"
    const before = pos;
    if (toks[pos].t === ')') {
      warnings.push('A closing bracket has no opening one: it was skipped.');
      pos++;
      continue;
    }
    const op = toks[pos].t === 'OR' ? 'or' : 'and';  // the operator written after the stray bracket, AND when none
    if (toks[pos].t === 'OR' || toks[pos].t === 'AND') pos++;
    const more = group();
    if (more) {
      warnings.push(`Part of the query sits after a stray bracket: it was joined with ${op.toUpperCase()}.`);
      tree = tree ? { t: op, kids: [tree, more] } : more;
    }
    if (pos === before) pos++;
  }
  return { tree, implicit, mixed, hoisted };
}

/** A node written back as a query, shortened to `max` characters: for the report. */
function show(node, max) {
  const one = n => {
    if (!n) return '';
    if (n.t === 'term') return n.cs ? `{${n.text}}` : n.text;
    if (n.t === 'phrase') return (n.cs ? `{${n.words.join(' ')}}` : `"${n.words.join(' ')}"`) + (n.slop ? `~${n.slop}` : '');
    if (n.t === 'not') return `NOT ${one(n.kid)}`;
    if (n.t === 'near') return `${one(n.a)} NEAR/${n.n}${n.ordered ? 'f' : ''} ${one(n.b)}`;
    if (n.t === 'field') return `${n.as || n.name}:${one(n.value)}`;
    if (n.t === 'range') return `[${n.text}]`;
    return `(${n.kids.map(one).join(n.t === 'and' ? ' AND ' : ' OR ')})`;
  };
  const s = one(node);
  const m = Number(max) || 110;
  return s.length <= m ? s : s.slice(0, m - 1) + '…';
}

// ---------------------------------------------------------------------------------------------------------------
// Words as patterns
// ---------------------------------------------------------------------------------------------------------------

function escLit(ch) { return /[\\^$.*+?()[\]{}|]/.test(ch) ? '\\' + ch : ch; }

/**
 * One word as a pattern: * is any run of word characters, ? is one; an apostrophe matches any kind of apostrophe or
 * none (can't, can’t, cant); a hyphen matches a hyphen, a space or nothing (e-mail, e mail, email). Lowercased unless
 * `cs` (case sensitive).
 */
function wordBody(word, cs) {
  const w = cs ? String(word) : String(word).toLowerCase();
  let out = '';
  for (const ch of w) {
    if (ch === '*') out += `${W}*`;
    else if (ch === '?') out += W;
    else if (ch === '\'' || ch === '’' || ch === '‘' || ch === '`') out += '[\'’‘`]?';
    else if (ch === '-' || ch === '‐' || ch === '‑' || ch === '–') out += '[-‐‑– ]?';
    else out += escLit(ch);
  }
  return out;
}

/** `body` held to whole words: a word edge is asked for only where the term itself starts or ends in a word character. */
function bounded(body, text) {
  const chars = Array.from(String(text));
  const edge = ch => ch === '*' || ch === '?' || isWordChar(ch);
  return (edge(chars[0]) ? B0 : '') + body + (edge(chars[chars.length - 1]) ? B1 : '');
}

/** A term or phrase (or an OR / NEAR of them) as a pattern with no edges, for use inside NEAR; null when it can't be one. */
function nearBody(n) {
  if (!n) return null;
  if (n.t === 'term') return wordBody(n.text, false);
  if (n.t === 'phrase' && !n.slop) return n.words.map(w => wordBody(w, false)).join(`${NW}+`);
  if (n.t === 'or') {
    const parts = n.kids.map(nearBody);
    return parts.every(p => p !== null) ? `(?:${parts.join('|')})` : null;
  }
  if (n.t === 'near') {
    const a = nearBody(n.a);
    const b = nearBody(n.b);
    if (a === null || b === null) return null;
    const gap = `(?:${NW}+${W}+){0,${n.n}}${NW}+`;
    return n.ordered ? `(?:${a}${gap}${b})` : `(?:${a}${gap}${b}|${b}${gap}${a})`;
  }
  return null;
}

function hasCase(n) {
  if (!n) return false;
  if (n.t === 'term' || n.t === 'phrase') return !!n.cs;
  if (n.t === 'or' || n.t === 'and') return n.kids.some(hasCase);
  if (n.t === 'near') return hasCase(n.a) || hasCase(n.b);
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// The tree as a plan our tables can answer
// ---------------------------------------------------------------------------------------------------------------

/**
 * A query tree as a plan. Plan nodes: {k: 'and' | 'or', kids}, {k: 'not', kid}, {k: 'rx', f: 'text' | 'author' | 'url',
 * rx, cs}, {k: 'xid', v: [X post ids]}, {k: 'in', f: 'platform', v}, {k: 'num', f: 'followers', min, max},
 * {k: 'eq', f: 'language', v}. A part that can't be converted returns null (it is left out) and is noted in `r`.
 * `ctx`: {parent: 'and' | 'or' | '', neg: under an odd number of NOTs}, for saying which way leaving it out leans.
 */
function plan(node, r, ctx) {
  if (!node) return null;
  const c = ctx || { parent: '', neg: false };
  const leftOut = (why) => {
    const wider = (c.parent === 'and') !== c.neg;  // out of an AND: wider; out of an OR: narrower; a NOT turns it round
    r.notes.push({ status: 'left out', clause: show(node), note: why,
      effect: c.parent ? (wider ? 'wider' : 'narrower') : 'nothing left' });
    return null;
  };
  switch (node.t) {
    case 'and':
    case 'or': {
      const kids = node.kids.map(k => plan(k, r, { parent: node.t, neg: c.neg })).filter(Boolean);
      return kids.length > 1 ? { k: node.t, kids } : kids[0] || null;
    }
    case 'not': {
      const kid = plan(node.kid, r, { parent: c.parent, neg: !c.neg });
      return kid ? { k: 'not', kid } : null;
    }
    case 'term':
      r.summary.terms++;
      if (node.cs) r.summary.caseSensitive++;
      if (/[*?]/.test(node.text)) r.summary.wildcards++;
      return { k: 'rx', f: 'text', rx: bounded(wordBody(node.text, node.cs), node.text), cs: !!node.cs };
    case 'phrase': {
      const first = node.words[0];
      const last = node.words[node.words.length - 1];
      if (node.cs) r.summary.caseSensitive++;
      if (!node.slop) {
        r.summary.phrases++;
        const ends = Array.from(first)[0] + Array.from(last).pop();
        return { k: 'rx', f: 'text', rx: bounded(node.words.map(w => wordBody(w, node.cs)).join(`${NW}+`), ends), cs: !!node.cs };
      }
      if (node.words.length === 2) {  // "two words"~n: within n words of each other, either order
        return plan({ t: 'near', a: { t: 'term', text: first, cs: node.cs }, b: { t: 'term', text: last, cs: node.cs },
          n: Math.min(MAX_NEAR, node.slop), ordered: false }, r, c);
      }
      r.notes.push({ status: 'approximated', clause: show(node), effect: 'wider',
        note: 'Three or more words within a distance: read as all of the words anywhere in the post.' });
      return plan({ t: 'and', kids: node.words.map(w => ({ t: 'term', text: w, cs: node.cs })) }, r, c);
    }
    case 'near': {
      const body = nearBody(node);
      if (body === null || body.length > MAX_RX_CHARS) {
        r.notes.push({ status: 'approximated', clause: show(node), effect: 'wider',
          note: body === null ? 'NEAR between parts that are more than words and phrases: read as AND (both anywhere in the post).'
            : 'This NEAR is too long to check word distances: read as AND (both anywhere in the post).' });
        return plan({ t: 'and', kids: [node.a, node.b] }, r, c);
      }
      r.summary.near++;
      countWords(node, r.summary);
      const out = { k: 'rx', f: 'text', rx: `${B0}${body}${B1}`, cs: false };
      if (!hasCase(node)) return out;
      // Case-sensitive terms inside NEAR: the distance is checked in any case, and each side must also match as written
      const sides = [plan(node.a, { summary: blank(), notes: [] }, c), plan(node.b, { summary: blank(), notes: [] }, c)].filter(Boolean);
      return { k: 'and', kids: [out].concat(sides) };
    }
    case 'field':
      return fieldPlan(node, r, c, leftOut);
    default:
      return leftOut('This part could not be read.');
  }
}

function blank() { return { terms: 0, phrases: 0, near: 0, caseSensitive: 0, wildcards: 0 }; }

/** Counts the words and phrases inside a NEAR (they become one pattern, so plan() never visits them one by one). */
function countWords(n, sum) {
  if (!n) return;
  if (n.t === 'term') {
    sum.terms++;
    if (n.cs) sum.caseSensitive++;
    if (/[*?]/.test(n.text)) sum.wildcards++;
  } else if (n.t === 'phrase') {
    sum.phrases++;
    if (n.cs) sum.caseSensitive++;
  } else if (n.t === 'or' || n.t === 'and') {
    n.kids.forEach(k => countWords(k, sum));
  } else if (n.t === 'near') {
    countWords(n.a, sum);
    countWords(n.b, sum);
  }
}

/** A field's value (a word, a phrase, or a bracketed AND / OR / NOT of them) with `leaf` applied to each word or phrase. */
function mapValue(v, leaf) {
  if (!v) return null;
  if (v.t === 'term') return leaf(v.text, v);
  if (v.t === 'phrase') return leaf(v.words.join(' '), v);
  if (v.t === 'and' || v.t === 'or') {
    const kids = v.kids.map(k => mapValue(k, leaf)).filter(Boolean);
    return kids.length > 1 ? { k: v.t, kids } : kids[0] || null;
  }
  if (v.t === 'not') {
    const kid = mapValue(v.kid, leaf);
    return kid ? { k: 'not', kid } : null;
  }
  return null;
}

function literal(s) { return Array.from(String(s).toLowerCase()).map(ch => (ch === '*' ? '[^\\s]*' : escLit(ch))).join(''); }

function fieldPlan(node, r, c, leftOut) {
  const name = node.name;
  const note = (status, text, effect) => r.notes.push({ status, clause: show(node), note: text, effect: effect || '' });
  if (!node.value) return leftOut(`${node.as}: has nothing after it.`);
  if (NOT_IN_OUR_DATA[name]) {
    return leftOut('It picks out reposts of, or replies to, particular posts or accounts. Our tables hold posts, not who they repost or reply to.');
  }
  if (NO_COLUMN[name]) return leftOut('Our tables have no column for it.');
  if (!KNOWN[name]) return leftOut(`"${node.as}:" is not an operator this app knows (a typing slip?). To search for it as words, put it in quotes.`);
  if (name === 'title') {
    note('approximated', 'Our tables keep a post\'s words in one piece, with no separate headline: searched in the post\'s words.', 'wider');
    return plan(node.value, r, c);
  }
  if (name === 'raw') {
    const out = mapValue(node.value, text => ({ k: 'rx', f: 'text', rx: Array.from(text).map(escLit).join(''), cs: true }));
    if (out) note('converted', 'Matched exactly as written, capitals and punctuation included.');
    return out || leftOut('Nothing to match.');
  }
  if (name === 'guid') {
    let ids = 0;
    let other = 0;
    const out = mapValue(node.value, text => {
      const t = String(text).trim();
      if (/^\d{15,20}$/.test(t)) { ids++; return { k: 'xid', v: [t] }; }
      other++;
      return { k: 'rx', f: 'url', rx: `(?:^|[^a-z0-9])${literal(t)}(?:$|[^a-z0-9])` };
    });
    if (out) note('converted', `${ids + other} post id${ids + other === 1 ? '' : 's'}: matched by the id in the post's link` +
      `${other ? ' (an id that is not an X post id is looked for anywhere in the link)' : ''}.`);
    return out || leftOut('No post ids to match.');
  }
  if (name === 'url') {
    const out = mapValue(node.value, text => ({ k: 'rx', f: 'url', rx: literal(String(text).replace(/^https?:\/\/(www\.)?/i, '').replace(/^www\./i, '').replace(/\/+$/, '')) }));
    if (out) note('converted', 'Matched against the post\'s link.');
    return out || leftOut('Nothing to match.');
  }
  if (name === 'links' || name === 'link') {
    const out = mapValue(node.value, text => ({ k: 'rx', f: 'text', rx: literal(String(text).replace(/^https?:\/\/(www\.)?/i, '').replace(/^www\./i, '').replace(/\/+$/, '')) }));
    if (out) note('approximated', 'Found only when the link is written out in the post\'s words. X shortens links, so most X posts that link to it are missed.', 'narrower');
    return out || leftOut('Nothing to match.');
  }
  if (name === 'site') {
    const out = mapValue(node.value, text => {
      const full = String(text).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
      const d = full.replace(/\/.*$/, '');
      const path = full.slice(d.length).replace(/\/+$/, '');
      if (path) return { k: 'rx', f: 'url', rx: literal(d + path) };  // a site with a path: the link holds both
      if (SITE_PLATFORM[d]) return { k: 'in', f: 'platform', v: [SITE_PLATFORM[d]] };
      return { k: 'rx', f: 'url', rx: `^https?://(?:[a-z0-9-]+\\.)*${literal(d)}(?:[/:?#]|$)` };
    });
    if (out) note('converted', 'A social network is matched by its name; any other site by the post\'s link.');
    return out || leftOut('Nothing to match.');
  }
  if (name === 'subreddit') {
    const out = mapValue(node.value, text => ({ k: 'rx', f: 'url', rx: `reddit\\.com/r/${literal(String(text).replace(/^\/?r\//i, ''))}(?:/|$)` }));
    if (out) note('converted', 'Matched by the subreddit in the post\'s link.');
    return out || leftOut('Nothing to match.');
  }
  if (name === 'author') {
    const out = mapValue(node.value, text => ({ k: 'rx', f: 'author', rx: `^@?${wordBody(String(text).replace(/^@/, ''), false)}$` }));
    if (out) note('converted', 'Matched against the author\'s handle.');
    return out || leftOut('Nothing to match.');
  }
  if (name === 'hashtags' || name === 'at_mentions') {
    const mark = name === 'hashtags' ? '#' : '@';
    const out = mapValue(node.value, text => {
      const t = mark + String(text).replace(/^[#@]/, '');
      return { k: 'rx', f: 'text', rx: bounded(wordBody(t, false), t), cs: false };
    });
    if (out) note('converted', `Looked for as ${mark}word in the post's words.`);
    return out || leftOut('Nothing to match.');
  }
  if (name === 'language') {
    const out = mapValue(node.value, text => ({ k: 'eq', f: 'language', v: String(text).toLowerCase() }));
    if (out) note('converted', 'Applied where a table has the post\'s language (Sonar, Brandwatch\'s stored mentions). The other tables have no language column, so there it is left out.');
    return out || leftOut('Nothing to match.');
  }
  if (name === 'authorfollowers') {
    const m = node.value.t === 'range' ? /^\s*(\d+|\*)\s+TO\s+(\d+|\*)\s*$/i.exec(node.value.text) : null;
    if (!m) return leftOut('The range could not be read. Write it as authorFollowers:[1000 TO 50000].');
    note('converted', 'Posts whose author\'s follower count is not known are left out.');
    return { k: 'num', f: 'followers', min: m[1] === '*' ? null : Number(m[1]), max: m[2] === '*' ? null : Number(m[2]) };
  }
  return leftOut('Our tables have no column for it.');
}

/** `p` tidied: nested ANDs / ORs flattened, the same condition kept once, X post ids of one OR gathered together. */
function simplify(p) {
  if (!p) return null;
  if (p.k === 'not') {
    const kid = simplify(p.kid);
    return kid ? { k: 'not', kid } : null;
  }
  if (p.k !== 'and' && p.k !== 'or') return p;
  let kids = [];
  p.kids.map(simplify).filter(Boolean).forEach(k => { if (k.k === p.k) kids = kids.concat(k.kids); else kids.push(k); });
  if (p.k === 'or') {
    const ids = [];
    const plats = [];
    kids = kids.filter(k => {
      if (k.k === 'xid') { k.v.forEach(v => { if (ids.indexOf(v) < 0) ids.push(v); }); return false; }
      if (k.k === 'in') { k.v.forEach(v => { if (plats.indexOf(v) < 0) plats.push(v); }); return false; }
      return true;
    });
    if (ids.length) kids.push({ k: 'xid', v: ids });
    if (plats.length) kids.push({ k: 'in', f: 'platform', v: plats });
  }
  const seen = new Set();
  kids = kids.filter(k => {
    const key = JSON.stringify(k);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return kids.length > 1 ? { k: p.k, kids } : kids[0] || null;
}

/**
 * A Brandwatch Boolean query as a plan: {ok, plan, report: {summary, notes, warnings}, error}. `error` (and ok false)
 * when nothing can be searched: an empty query, one with nothing convertible left, or one that would match every post.
 */
function convert(text) {
  const warnings = [];
  const report = { summary: blank(), notes: [], warnings };
  const src = String(text || '').trim();
  if (!src) return { ok: false, error: 'There is no query to convert.', plan: null, report };
  if (src.length > 60000) return { ok: false, error: 'The query is longer than 60,000 characters.', plan: null, report };
  const parsed = parse(src, warnings);
  if (parsed.implicit) warnings.push('Two terms sit side by side with no operator between them: read as AND, as Brandwatch reads them.');
  if (parsed.hoisted) warnings.push('A NOT after a list of ORs was read as leaving those posts out of the whole list: a OR b NOT c is (a OR b) NOT c.');
  if (parsed.mixed) warnings.push('AND and OR are mixed without brackets: AND was read first (a AND b OR c is (a AND b) OR c).');
  const out = simplify(plan(parsed.tree, report, { parent: '', neg: false }));
  if (!out) return { ok: false, error: 'Nothing in this query can be searched in our tables (see what was left out).', plan: null, report };
  if (evaluate(out, { text: '', author: '', url: '', platform: '', followers: null, language: '' })) {
    return { ok: false, error: 'This query would match every post (it only says what to leave out). Add at least one word, phrase, author or site to look for.', plan: null, report };
  }
  return { ok: true, plan: out, report };
}

/** The fields a plan asks about (text, author, url, platform, followers, language), as a Set. */
function fieldsOf(p, into) {
  const out = into || new Set();
  if (!p) return out;
  if (p.k === 'and' || p.k === 'or') p.kids.forEach(k => fieldsOf(k, out));
  else if (p.k === 'not') fieldsOf(p.kid, out);
  else out.add(p.k === 'xid' ? 'url' : p.f);
  return out;
}

/** `p` without the conditions on fields a table doesn't have (`has`: a Set of field names): {plan, removed: [fields]}. */
function prune(p, has) {
  const removed = new Set();
  const go = n => {
    if (!n) return null;
    if (n.k === 'and' || n.k === 'or') {
      const kids = n.kids.map(go).filter(Boolean);
      return kids.length > 1 ? { k: n.k, kids } : kids[0] || null;
    }
    if (n.k === 'not') {
      const kid = go(n.kid);
      return kid ? { k: 'not', kid } : null;
    }
    const f = n.k === 'xid' ? 'url' : n.f;
    if (has.has(f)) return n;
    removed.add(f);
    return null;
  };
  return { plan: go(p), removed: Array.from(removed) };
}

// ---------------------------------------------------------------------------------------------------------------
// The plan as SQL, and the same plan in memory
// ---------------------------------------------------------------------------------------------------------------

/**
 * `p` as a BigQuery condition: {sql, params}. `cols` names the columns: {text, textL (lowercased), authorL, urlL,
 * platform, followers, language}. Every value is a named parameter; a missing value never matches.
 */
function toSql(p, cols, params) {
  const ps = params || {};
  const byValue = new Map();
  const param = v => {
    const key = JSON.stringify(v);
    if (!byValue.has(key)) {
      const name = 'q' + Object.keys(ps).length;
      ps[name] = v;
      byValue.set(key, name);
    }
    return '@' + byValue.get(key);
  };
  const go = n => {
    switch (n.k) {
      case 'and': return '(' + n.kids.map(go).join(' AND ') + ')';
      case 'or': return '(' + n.kids.map(go).join(' OR ') + ')';
      case 'not': return `(NOT ${go(n.kid)})`;
      case 'rx': {
        const col = n.f === 'text' ? (n.cs ? cols.text : cols.textL) : n.f === 'author' ? cols.authorL : cols.urlL;
        return `IFNULL(REGEXP_CONTAINS(${col}, ${param(n.rx)}), FALSE)`;
      }
      case 'xid': return `IFNULL(REGEXP_EXTRACT(${cols.urlL}, r'/status/(\\d+)') IN UNNEST(${param(n.v)}), FALSE)`;
      case 'in': return `IFNULL(${cols.platform} IN UNNEST(${param(n.v)}), FALSE)`;
      case 'eq': return `IFNULL(${cols.language} = ${param(n.v)}, FALSE)`;
      case 'num': {
        const parts = [];
        if (n.min !== null && n.min !== undefined) parts.push(`${cols.followers} >= ${param(Math.round(n.min))}`);
        if (n.max !== null && n.max !== undefined) parts.push(`${cols.followers} <= ${param(Math.round(n.max))}`);
        return parts.length ? `IFNULL(${parts.join(' AND ')}, FALSE)` : `(${cols.followers} IS NOT NULL)`;
      }
      default: throw new Error('unknown plan node');
    }
  };
  return { sql: go(p), params: ps };
}

const rxCache = new Map();
function rxOf(src) {
  let r = rxCache.get(src);
  if (!r) {
    r = new RegExp(src, 'u');
    if (rxCache.size > 5000) rxCache.clear();
    rxCache.set(src, r);
  }
  return r;
}

/** Does post `post` ({text, author, url, platform, followers, language}) match plan `p`? The same answer SQL gives. */
function evaluate(p, post) {
  if (!post._l) {
    Object.defineProperty(post, '_l', { enumerable: false, value: {
      text: String(post.text || '').toLowerCase(), author: String(post.author || '').toLowerCase(),
      url: String(post.url || '').toLowerCase() } });
  }
  const go = n => {
    switch (n.k) {
      case 'and': return n.kids.every(go);
      case 'or': return n.kids.some(go);
      case 'not': return !go(n.kid);
      case 'rx': return rxOf(n.rx).test(n.f === 'text' ? (n.cs ? String(post.text || '') : post._l.text) : post._l[n.f]);
      case 'xid': { const m = /\/status\/(\d+)/.exec(post._l.url); return !!m && n.v.indexOf(m[1]) >= 0; }
      case 'in': return n.v.indexOf(String(post.platform || '').toLowerCase()) >= 0;
      case 'eq': return !!post.language && String(post.language).toLowerCase() === n.v;
      case 'num': {
        if (post.followers === null || post.followers === undefined) return false;
        return (n.min === null || n.min === undefined || post.followers >= n.min) && (n.max === null || n.max === undefined || post.followers <= n.max);
      }
      default: return false;
    }
  };
  return go(p);
}

// ---------------------------------------------------------------------------------------------------------------
// The filter form, as a query
// ---------------------------------------------------------------------------------------------------------------

function list(v) { return (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map(s => String(s).trim()).filter(Boolean); }

function quoted(term) {
  const t = String(term).replace(/"/g, '').trim();
  return /\s/.test(t) ? `"${t}"` : t;
}

/**
 * The filter form as a Brandwatch query: {all, any, none (words or phrases, comma separated), platforms, authors,
 * minFollowers}. "" when nothing was filled in.
 */
function fromFilters(f) {
  const o = f || {};
  const parts = [];
  const group = (terms, op) => (terms.length > 1 ? `(${terms.map(quoted).join(` ${op} `)})` : quoted(terms[0]));
  const all = list(o.all);
  const any = list(o.any);
  const none = list(o.none);
  const sites = list(o.platforms).map(p => PLATFORM_SITE[String(p).toLowerCase()] || '').filter(Boolean);
  const authors = list(o.authors).map(a => a.replace(/^@/, ''));
  if (all.length) parts.push(group(all, 'AND'));
  if (any.length) parts.push(group(any, 'OR'));
  if (sites.length) parts.push(`site:${sites.length > 1 ? `(${sites.join(' OR ')})` : sites[0]}`);
  if (authors.length) parts.push(`author:${authors.length > 1 ? `(${authors.join(' OR ')})` : authors[0]}`);
  if (Number(o.minFollowers) > 0) parts.push(`authorFollowers:[${Math.round(Number(o.minFollowers))} TO *]`);
  let out = parts.join(' AND ');
  if (none.length && out) out += ` NOT ${group(none, 'OR')}`;
  return out;
}

module.exports = { convert, toSql, evaluate, prune, fieldsOf, fromFilters, parse, show, simplify, SITE_PLATFORM, PLATFORM_SITE };
