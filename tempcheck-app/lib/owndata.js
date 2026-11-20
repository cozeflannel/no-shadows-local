/**
 * owndata.js — finds an issue's posts in our own BigQuery tables, instead of exporting them from Brandwatch.
 *
 * Every table of posts the chat bot reads is searched, each with the same converted query (bwquery.js):
 *   alerts      Sundar all mentions: the Brandwatch alert-feed rows (X, Instagram, Facebook, Bluesky, Reddit), minutes
 *               behind. X posts come with their words.
 *   sonar       the Sonar feed (X, YouTube, Bluesky, Instagram, TikTok, Reddit and more), minutes behind.
 *   brandwatch  Brandwatch's stored mentions (news, Reddit, forums, blogs, reviews, Bluesky, Instagram, YouTube,
 *               Facebook). A day's mentions arrive the day after, so it fills in the older part of a window, and its
 *               X rows have no words or author, so they can never match a word.
 *   sprinklr    comments, replies and mentions on Google's own posts and accounts (Instagram, X, Facebook, YouTube,
 *               TikTok, Threads, LinkedIn), minutes behind. Google's own posts and replies are left out.
 *   tubular     videos (YouTube, Instagram, Facebook, TikTok) by their titles, a day or two behind.
 * Not searched: Sprinklr's outbound table (Google's own posts, not what people say) and the tables of posts the team
 * already alerted (they are alerts, not a feed).
 *
 * None of these holds reposts, and replies only where a table is made of them (Sprinklr's), so a count here is a count
 * of posts and comments. It is not Brandwatch's mention total and is never shown as one.
 *
 * Every search is estimated first (free). A table whose search would scan more than the cap is skipped, with the reason.
 */
'use strict';

const bq = require('./bigquery');
const q = require('./bwquery');
const tc = require('./tempcheck');

const ROW_LIMIT = Math.max(100, Math.min(5000, Number(process.env.TEMPCHECK_OWN_ROWS) || 3000));
const TEXT_CHARS = 2000;
const COLS = { text: 'text', textL: 'text_l', authorL: 'author_l', urlL: 'url_l', platform: 'platform', followers: 'followers', language: 'language' };
const EMPTY = { text: '', author: '', url: '', platform: '', followers: null, language: '' };

const TABLES = {
  alerts: process.env.TEMPCHECK_ALERTS_TABLE || 'brand-social-central-data.social_alerts_dataset.all_sundar_mentions',
  sonar: process.env.TEMPCHECK_SONAR_TABLE || 'bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw',
  brandwatch: process.env.TEMPCHECK_BRANDWATCH_TABLE || 'brand-social-central-data.raw_data.brandwatch_raw_mentions_base',
  sprinklr: process.env.TEMPCHECK_SPRINKLR_TABLE || 'brand-social-central-data.reporting_data.sprinklr_inbound_comments',
  tubular: process.env.TEMPCHECK_TUBULAR_TABLE || 'brand-social-central-data.google_tubular_mentions.tubular_videos',
};
Object.keys(TABLES).forEach(k => {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(TABLES[k])) throw new Error(`the ${k} table's name is not project.dataset.table`);
});

const SOURCES = {
  alerts: {
    label: 'Sundar all mentions',
    what: 'Sundar all mentions, the Brandwatch alert-feed rows: X, Instagram, Facebook, Bluesky and Reddit, minutes behind. X posts come with their words.',
    location: 'US',
    has: new Set(['text', 'author', 'url', 'platform', 'followers']),
    base: `SELECT IF(LOWER(SocialNetwork) = 'twitter', 'x', LOWER(SocialNetwork)) AS platform, authorHandle AS author,
      snippet AS text, url, postTime AS posted, followers, engagementScore AS eng, LOWER(Sentiment) AS sentiment,
      CAST(NULL AS STRING) AS language, CAST(NULL AS INT64) AS shares, CAST(NULL AS INT64) AS replies,
      ingestionTimestamp AS seen, url AS one
    FROM \`${TABLES.alerts}\`
    WHERE ingestionTimestamp >= @t_from AND ingestionTimestamp < TIMESTAMP_ADD(@t_to, INTERVAL 24 HOUR)`,
  },
  sonar: {
    label: 'Sonar',
    what: 'The Sonar feed: X, YouTube, Bluesky, Instagram, TikTok, Reddit and more, minutes after posting.',
    location: 'us-central1',
    has: new Set(['text', 'author', 'url', 'platform', 'followers', 'language']),
    base: `SELECT IF(LOWER(platform) = 'twitter', 'x', LOWER(platform)) AS platform,
      JSON_VALUE(payload, '$.detail.channel.username') AS author, JSON_VALUE(payload, '$.detail.post.snippet.text') AS text,
      post_url AS url, SAFE_CAST(post_timestamp AS TIMESTAMP) AS posted, follower_count AS followers,
      IFNULL(engagement_likes, 0) + IFNULL(engagement_comments, 0) + IFNULL(engagement_shares, 0) AS eng,
      CAST(NULL AS STRING) AS sentiment, LOWER(language) AS language, engagement_shares AS shares,
      engagement_comments AS replies, received_at AS seen, post_id AS one
    FROM \`${TABLES.sonar}\`
    WHERE received_at >= @t_from AND received_at < TIMESTAMP_ADD(@t_to, INTERVAL 24 HOUR)`,
  },
  brandwatch: {
    label: 'Brandwatch stored mentions',
    what: 'Brandwatch\'s stored mentions: news, Reddit, forums, blogs, reviews, Bluesky, Instagram, YouTube and Facebook. ' +
      'A day\'s mentions arrive the day after, and its X rows have no words, so they never match.',
    location: 'US',
    has: new Set(['text', 'author', 'url', 'platform', 'language']),
    // A mention sits in the table once for each standing query it matched: `one` keeps a single copy. The day a mention
    // is filed under is not always the day it was posted, so a day either side of the window is read too.
    base: `SELECT CASE LOWER(platform) WHEN 'twitter' THEN 'x' WHEN 'facebook_public' THEN 'facebook'
        WHEN 'instagram_public' THEN 'instagram' WHEN 'linkedin_brand_mentions' THEN 'linkedin' ELSE LOWER(platform) END AS platform,
      author,
      CASE WHEN TRIM(IFNULL(mention_text, '')) = '' THEN NULLIF(TRIM(IFNULL(title, '')), '')
        WHEN TRIM(IFNULL(title, '')) = '' OR STARTS_WITH(mention_text, SUBSTR(TRIM(title), 1, 30)) THEN mention_text
        ELSE CONCAT(TRIM(title), ': ', mention_text) END AS text,
      post_url AS url, published_timestamp AS posted, CAST(NULL AS INT64) AS followers,
      SAFE_CAST(ROUND(engagement_score) AS INT64) AS eng, LOWER(sentiment) AS sentiment, LOWER(language) AS language,
      CAST(NULL AS INT64) AS shares, CAST(NULL AS INT64) AS replies, load_timestamp AS seen, mention_id AS one
    FROM \`${TABLES.brandwatch}\`
    WHERE report_date BETWEEN DATE_SUB(DATE(@t_from), INTERVAL 1 DAY) AND DATE_ADD(DATE(@t_to), INTERVAL 1 DAY)
      AND mention_id IS NOT NULL`,
  },
  sprinklr: {
    label: 'Sprinklr comments',
    what: 'Comments, replies and mentions on Google\'s own posts and accounts: Instagram, X, Facebook, YouTube, TikTok, Threads and ' +
      'LinkedIn, minutes behind. Google\'s own posts are left out. A comment\'s link opens the post it is under.',
    location: 'US',
    has: new Set(['text', 'author', 'url', 'platform', 'followers']),
    keyBy: 'id',  // many comments share one link (the post they are under): each is itself by its comment id
    base: `SELECT IF(LOWER(platform) = 'twitter', 'x', LOWER(platform)) AS platform, author_username AS author,
      comment_text AS text, post_url AS url, comment_timestamp AS posted, SAFE_CAST(author_followers AS INT64) AS followers,
      SAFE_CAST(ROUND(IFNULL(comment_like_count, 0) + IFNULL(comment_reply_count, 0)) AS INT64) AS eng,
      LOWER(sentiment) AS sentiment, CAST(NULL AS STRING) AS language, CAST(NULL AS INT64) AS shares,
      CAST(NULL AS INT64) AS replies, comment_timestamp AS seen, comment_id AS one
    FROM \`${TABLES.sprinklr}\`
    WHERE comment_timestamp >= @t_from AND comment_timestamp < TIMESTAMP_ADD(@t_to, INTERVAL 24 HOUR)
      AND comment_id IS NOT NULL AND IFNULL(is_brand_post, '') != 'Brand'
      AND LOWER(IFNULL(is_deleted, 'false')) != 'true' AND LOWER(IFNULL(is_spam, 'false')) != 'true'
      AND LOWER(IFNULL(is_hidden, 'false')) != 'true'`,
  },
  tubular: {
    label: 'Tubular videos',
    what: 'Tubular\'s videos that mention Google: YouTube, Instagram, Facebook and TikTok, searched by their titles (it has no ' +
      'descriptions or transcripts). A day or two behind.',
    location: 'us-central1',
    has: new Set(['text', 'author', 'url', 'platform', 'followers']),
    // A video is listed again on each day's snapshot (the newest copy, with the latest counts, is kept), and first
    // appears a day or two after it was published: the snapshots up to three days after the window are read.
    base: `SELECT LOWER(platform) AS platform, creator AS author, video_title AS text, video_url AS url,
      published_at_utc AS posted, SAFE_CAST(creator_followers_or_subscribers AS INT64) AS followers,
      SAFE_CAST(total_engagements AS INT64) AS eng, CAST(NULL AS STRING) AS sentiment, CAST(NULL AS STRING) AS language,
      SAFE_CAST(shares AS INT64) AS shares, SAFE_CAST(comments AS INT64) AS replies, report_run_at_utc AS seen, video_url AS one
    FROM \`${TABLES.tubular}\`
    WHERE snapshot_date BETWEEN DATE(@t_from) AND DATE_ADD(DATE(@t_to), INTERVAL 3 DAY) AND video_url IS NOT NULL`,
  },
};
// When one post is in several tables, the copy kept is the one with the most engagement known; on a tie, this order
const ORDER = ['alerts', 'sonar', 'brandwatch', 'tubular', 'sprinklr'];

/** The SQL that finds plan `p`'s posts in table `key` between `from` and `to` (ms): {posts, counts, params, removed} or {skip}. */
function sqlFor(key, p, from, to) {
  const src = SOURCES[key];
  const pruned = q.prune(p, src.has);
  if (!pruned.plan) return { skip: 'Nothing in the query can be asked of this table.' };
  if (q.evaluate(pruned.plan, Object.assign({}, EMPTY))) {
    return { skip: 'Without the parts this table has no column for, the query would match every post in it.' };
  }
  const params = { t_from: new Date(from), t_to: new Date(to), lim: ROW_LIMIT };
  const where = q.toSql(pruned.plan, COLS, params);
  const head = `WITH base AS (\n    ${src.base}\n),\ntyped AS (\n  SELECT *, LOWER(IFNULL(text, '')) AS text_l, LOWER(IFNULL(author, '')) AS author_l, LOWER(IFNULL(url, '')) AS url_l\n` +
    `  FROM base WHERE posted >= @t_from AND posted < @t_to\n),\nhits AS (\n  SELECT * FROM typed\n  WHERE ${where.sql}\n` +
    '  QUALIFY ROW_NUMBER() OVER (PARTITION BY one ORDER BY seen DESC) = 1\n)\n';
  return {
    posts: head + `SELECT platform, author, SUBSTR(text, 1, ${TEXT_CHARS}) AS text, url, posted, followers, eng, sentiment, language,\n` +
      '  shares, replies, one, COUNT(*) OVER () AS matched, MAX(posted) OVER () AS newest\nFROM hits\n' +
      'ORDER BY IFNULL(eng, -1) DESC, posted DESC\nLIMIT @lim',
    counts: head + 'SELECT platform, UNIX_MILLIS(TIMESTAMP_TRUNC(posted, HOUR)) AS hr, IFNULL(sentiment, \'\') AS sentiment,\n' +
      '  COUNT(*) AS n, SUM(IFNULL(eng, 0)) AS eng, SUM(IFNULL(shares, 0)) AS shares, SUM(IFNULL(replies, 0)) AS replies,\n' +
      '  COUNTIF(shares IS NOT NULL) AS counted\nFROM hits\nGROUP BY 1, 2, 3',
    params, removed: pruned.removed, location: src.location,
  };
}

/**
 * A post's identity across both tables and across alerts: an X post by its id; a YouTube video by its video id (it sits
 * in the link's query, and youtu.be links name the same video); a Facebook permalink by the ids in its query; anything
 * else by its link without the protocol, www, query and trailing slash. Only the site's name is lowercased: the ids
 * of YouTube videos and Instagram posts tell capitals apart.
 */
function postKey(url) {
  const raw = String(url || '').trim();
  const x = /(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/i.exec(raw);
  if (x) return 'x:' + x[1];
  const m = /^(?:https?:\/\/)?(?:www\.|m\.|mobile\.)?([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(raw);
  if (!m) return raw;
  const host = m[1].toLowerCase();
  const pathPart = m[2].replace(/\/+$/, '');
  const query = new URLSearchParams((m[3] || '').slice(1));
  if (host === 'youtu.be' && pathPart.length > 1) return 'youtube.com/watch?v=' + pathPart.slice(1);
  if (/(?:^|\.)youtube\.com$/.test(host) && pathPart === '/watch' && query.get('v')) return 'youtube.com/watch?v=' + query.get('v');
  if (/(?:^|\.)facebook\.com$/.test(host) && /^\/(?:permalink|story|photo)\.php$/.test(pathPart)) {
    const ids = ['story_fbid', 'fbid', 'id'].filter(k => query.get(k)).map(k => `${k}=${query.get(k)}`);
    if (ids.length) return `facebook.com${pathPart}?${ids.join('&')}`;
  }
  return host + pathPart;
}

function shape(row, key) {
  const platform = String(row.platform || '').toLowerCase();
  return { src: key, platform, source: tc.SOURCES[platform] || (platform ? platform[0].toUpperCase() + platform.slice(1) : 'Web'),
    author: String(row.author || ''), text: String(row.text || ''), url: String(row.url || ''), at: Number(row.posted) || 0,
    followers: row.followers === null || row.followers === undefined ? null : Number(row.followers),
    eng: row.eng === null || row.eng === undefined ? null : Number(row.eng),
    shares: row.shares === null || row.shares === undefined ? null : Number(row.shares),
    replies: row.replies === null || row.replies === undefined ? null : Number(row.replies),
    sentiment: String(row.sentiment || ''), language: String(row.language || ''), one: String(row.one || '') };
}

/**
 * What makes a row one post: its link (postKey), or for a table whose rows share links (Sprinklr's comments, each
 * under the post it answers) the row's own id. A row with neither is itself by its table, time and first words.
 */
function rowKey(r) {
  const src = SOURCES[r.src] || {};
  if (src.keyBy === 'id' && r.one) return `${r.src}:${r.one}`;
  return postKey(r.url) || `${r.src}:${r.at}:${r.text.slice(0, 40)}`;
}

/**
 * What a search would scan, without running it: {[table]: {bytes, removed} | {skip}}. Free.
 */
async function preview(p, from, to, sources) {
  const out = {};
  await Promise.all((sources || Object.keys(SOURCES)).filter(k => SOURCES[k]).map(async key => {
    const s = sqlFor(key, p, from, to);
    if (s.skip) { out[key] = { skip: s.skip }; return; }
    try {
      out[key] = { bytes: await bq.estimate({ sql: s.posts, params: s.params, location: s.location }), removed: s.removed, sql: s.posts };
    } catch (e) {
      out[key] = { skip: `BigQuery would not take the search: ${e.message}` };
    }
  }));
  return out;
}

/**
 * Plan `p`'s posts between `from` and `to` (ms) in `sources` (the tables' keys; all of them when not given):
 *   {tables: {[table]: {matched, read, bytes, removed, newest (ms: its newest match)} | {skip}}, posts (one per post,
 *    the most engagement first),
 *    complete (every match was read, so the numbers below count each post once), total, hours [{at, n}],
 *    byPlatform [{label, n}], engByPlatform, sentiment}.
 * When a table has more matches than ROW_LIMIT, its numbers come from a second, counting query, and a post that is in
 * both tables is then counted in each (complete: false).
 */
async function search(p, from, to, sources) {
  const tables = {};
  const rows = [];
  const tallies = [];
  await Promise.all((sources || Object.keys(SOURCES)).filter(k => SOURCES[k]).map(async key => {
    const s = sqlFor(key, p, from, to);
    if (s.skip) { tables[key] = { skip: s.skip }; return; }
    try {
      const est = await bq.estimate({ sql: s.posts, params: s.params, location: s.location });
      if (est > bq.MAX_GB * bq.GB) {
        tables[key] = { skip: `It would scan ${(est / bq.GB).toFixed(1)} GB, over the ${bq.MAX_GB} GB cap. Use a shorter window.`, bytes: est };
        return;
      }
      const got = await bq.query({ sql: s.posts, params: s.params, location: s.location, maxRows: ROW_LIMIT });
      const matched = got.rows.length ? Number(got.rows[0].matched) || got.rows.length : 0;
      tables[key] = { matched, read: got.rows.length, bytes: got.bytes, removed: s.removed,
        newest: got.rows.length ? Number(got.rows[0].newest) || 0 : 0 };
      got.rows.forEach(r => rows.push(shape(r, key)));
      if (matched > got.rows.length) {
        const counts = await bq.query({ sql: s.counts, params: s.params, location: s.location, maxRows: 5000 });
        tables[key].bytes += counts.bytes;
        tallies.push({ key, rows: counts.rows });
      }
    } catch (e) {
      tables[key] = { skip: `The search failed: ${e.message}` };
    }
  }));
  // One per post: the copy with the most engagement known; on a tie, the tables in ORDER (the alert feed first: it
  // carries sentiment)
  const byKey = new Map();
  rows.sort((a, b) => (b.eng === null ? -1 : b.eng) - (a.eng === null ? -1 : a.eng) || ORDER.indexOf(a.src) - ORDER.indexOf(b.src));
  rows.forEach(r => {
    const k = rowKey(r);
    const had = byKey.get(k);
    if (!had) { byKey.set(k, Object.assign({ key: k, also: [] }, r)); return; }
    if (had.src !== r.src && had.also.indexOf(r.src) < 0) had.also.push(r.src);
    if (!had.sentiment && r.sentiment) had.sentiment = r.sentiment;
    if (had.followers === null && r.followers !== null) had.followers = r.followers;
    if (had.shares === null && r.shares !== null) { had.shares = r.shares; had.replies = r.replies; }
  });
  const posts = Array.from(byKey.values());
  const complete = !tallies.length;
  return Object.assign({ tables, posts, complete }, complete ? numbersOf(posts, from, to) : numbersOfTallies(tables, tallies, posts, from, to));
}

function ranked(by) { return Object.keys(by).map(label => ({ label, n: by[label] })).filter(x => x.n > 0).sort((a, b) => b.n - a.n); }

function hourList(by, from, to) {
  const out = [];
  for (let at = tc.floorHour(from); at < to; at += tc.HOUR) out.push({ at, n: by.get(at) || 0 });
  return out;
}

/**
 * The numbers of `posts` (each one post): {total, hours, byPlatform, engByPlatform, sentiment, spread}. `spread` is
 * what the posts' own counters say about the conversation around them: {counted (posts that came with a repost
 * count: Sonar's and Tubular's), reposts, replies}. Pure.
 */
function numbersOf(posts, from, to) {
  const hours = new Map();
  const plat = {};
  const eng = {};
  const sentiment = { positive: 0, neutral: 0, negative: 0 };
  const spread = { counted: 0, reposts: 0, replies: 0 };
  posts.forEach(p => {
    const h = tc.floorHour(p.at);
    hours.set(h, (hours.get(h) || 0) + 1);
    plat[p.source] = (plat[p.source] || 0) + 1;
    eng[p.source] = (eng[p.source] || 0) + (Number(p.eng) || 0);
    if (sentiment[p.sentiment] !== undefined) sentiment[p.sentiment]++;
    if (p.shares !== null && p.shares !== undefined) {
      spread.counted++;
      spread.reposts += Number(p.shares) || 0;
      spread.replies += Number(p.replies) || 0;
    }
  });
  return { total: posts.length, hours: hourList(hours, from, to), byPlatform: ranked(plat), engByPlatform: ranked(eng), sentiment, spread };
}

/** The same numbers when a table had more matches than were read: from its counting query, the other tables from their rows. */
function numbersOfTallies(tables, tallies, posts, from, to) {
  const hours = new Map();
  const plat = {};
  const eng = {};
  const sentiment = { positive: 0, neutral: 0, negative: 0 };
  const spread = { counted: 0, reposts: 0, replies: 0 };
  let total = 0;
  const counted = new Set(tallies.map(t => t.key));
  tallies.forEach(t => t.rows.forEach(r => {
    const label = tc.SOURCES[String(r.platform)] || String(r.platform || 'Web');
    const n = Number(r.n) || 0;
    total += n;
    spread.counted += Number(r.counted) || 0;
    spread.reposts += Number(r.shares) || 0;
    spread.replies += Number(r.replies) || 0;
    hours.set(Number(r.hr), (hours.get(Number(r.hr)) || 0) + n);
    plat[label] = (plat[label] || 0) + n;
    eng[label] = (eng[label] || 0) + (Number(r.eng) || 0);
    if (sentiment[r.sentiment] !== undefined) sentiment[r.sentiment] += n;
  }));
  const rest = numbersOf(posts.filter(p => !counted.has(p.src)), from, to);
  total += rest.total;
  rest.hours.forEach(h => hours.set(h.at, (hours.get(h.at) || 0) + h.n));
  rest.byPlatform.forEach(x => { plat[x.label] = (plat[x.label] || 0) + x.n; });
  rest.engByPlatform.forEach(x => { eng[x.label] = (eng[x.label] || 0) + x.n; });
  Object.keys(sentiment).forEach(k => { sentiment[k] += rest.sentiment[k]; });
  Object.keys(spread).forEach(k => { spread[k] += rest.spread[k]; });
  return { total, hours: hourList(hours, from, to), byPlatform: ranked(plat), engByPlatform: ranked(eng), sentiment, spread };
}

/**
 * X posts by id in the alert rows, ingested between `from` and a day after `to`: {id: {author, text, url, eng, from:
 * 'alert rows'}}. One small query (it reads the link and the words of X rows only). Never throws: {} when it fails.
 */
async function findXPosts(ids, from, to) {
  const want = Array.from(new Set((ids || []).map(String).filter(id => /^\d{5,25}$/.test(id))));
  if (!want.length) return {};
  try {
    const got = await bq.query({
      location: 'US', maxGb: 2, maxRows: 500,
      params: { t_from: new Date(from), t_to: new Date(to), ids: want },
      sql: 'SELECT REGEXP_EXTRACT(url, r\'/status/(\\d+)\') AS id, ANY_VALUE(authorHandle) AS author, ANY_VALUE(snippet) AS text,\n' +
        `  ANY_VALUE(url) AS url, MAX(engagementScore) AS eng\nFROM \`${TABLES.alerts}\`\n` +
        'WHERE ingestionTimestamp >= @t_from AND ingestionTimestamp < TIMESTAMP_ADD(@t_to, INTERVAL 24 HOUR)\n' +
        '  AND SocialNetwork = \'X\' AND REGEXP_EXTRACT(url, r\'/status/(\\d+)\') IN UNNEST(@ids)\nGROUP BY 1',
    });
    const out = {};
    got.rows.forEach(r => { if (r.id && r.text) out[r.id] = { author: r.author || '', text: r.text, url: r.url || '', eng: r.eng, from: 'alert rows' }; });
    return out;
  } catch (e) {
    return {};
  }
}

/** A post from our tables in the shape the write-up uses ({key, x, id, source, author, text, url, eng, negative}). Pure. */
function asWriteupPost(p) {
  const x = p.platform === 'x';
  const id = x ? ((/\/status\/(\d+)/.exec(p.url) || [])[1] || '') : '';
  return { key: p.key || postKey(p.url), x, id, source: p.source, author: tc.cleanHandle(p.author), text: p.text, url: p.url,
    eng: p.eng, negative: p.sentiment === 'negative', textFrom: SOURCES[p.src] ? SOURCES[p.src].label : '' };
}

function describe() {
  return Object.keys(SOURCES).map(k => ({ key: k, label: SOURCES[k].label, what: SOURCES[k].what, table: TABLES[k] }));
}

module.exports = { ROW_LIMIT, SOURCES, ORDER, sqlFor, postKey, rowKey, preview, search, numbersOf, findXPosts, asWriteupPost, describe };
