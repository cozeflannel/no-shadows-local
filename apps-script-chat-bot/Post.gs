/**
 * Post.gs — the original post behind an alert, so the bot works from the post itself and not only Burson's write-up.
 *
 *   lookupPost_(url)        the post as the bot uses it, or null. Public data only (nothing signed in):
 *     X / Twitter   the data X serves for embedded posts (cdn.syndication.twimg.com, the endpoint embedded tweets use):
 *                   the post's text and author, the posts above it in its thread (two levels), the post it quotes, its
 *                   video (MP4 files in several sizes, with their bitrates and the video's length) and its photos.
 *     Bluesky       Bluesky's public API (public.api.bsky.app): the same, and the original video file from the author's
 *                   server (com.atproto.sync.getBlob).
 *     TikTok        TikTok's embed info (oEmbed): the caption and the video's cover image; when oEmbed doesn't give them
 *                   (it returns only its player now), the video page's own data (tiktokPostFromPage_). TikTok serves
 *                   the video itself only to people signed in.
 *     YouTube       the video id and its thumbnail (Gemini watches YouTube links itself).
 *     Instagram     the post's public embed page (instagram.com/p/<code>/embed/captioned/, the page embedded posts use):
 *                   its first image (a reel's cover), its author and caption. Instagram serves it only when it wants to
 *                   (it can show servers a sign-in page instead): then null.
 *     Reddit, Facebook, Threads…: they show posts only to people signed in (Reddit blocks servers): null.
 *     A post with no photo or video file of its own carries `preview` ({url, label, video}) when it still shows a
 *     picture: an X video's frame (no MP4 file small enough, or only a stream), the photo or video frame of the post it
 *     quotes, or its link card's image (X and Bluesky); a TikTok photo post's first image. Only the picture of the post
 *     reads it (screenshotFor_): Gemini's media and the post in its prompt are as they were without it.
 *   lookupXPosts_(ids)      several X posts at once (one round trip), for the Proactive watch's Brandwatch query (its X
 *                           posts come without their text); same cache as lookupPost_
 *   postIdOf_(url)          the post's id in its link (X status id, Bluesky post key), for matching posts in a thread
 *   postGone_(url)          whether the post was deleted or taken down (X, Bluesky, YouTube): true / false, or null when
 *                           the platform doesn't say (lookupPost_'s null can't tell); for Watch sent alerts (Watch.gs)
 *   screenshotFor_(parsed)  the picture of the post for the Social Alert email (never Burson's screenshot of a platform
 *                           that shows people who aren't signed in a sign-in prompt: screenshotSignInWalled_)
 *   fetchScreenshot_(shot)  downloads it for the email (an inline image)
 *   pagePicture_(url)       the picture a post's page shows link previews (og:image / twitter:image), for the posts the
 *                           lookup gives no picture for (Facebook, Reddit, Threads, LinkedIn, news and other sites;
 *                           Instagram and TikTok when their embed data shows none); never a site's logo, a banner or a
 *                           profile picture (PAGE_PIC_SKIP_RX_), never X's or Bluesky's pages (they show the author)
 *   alertPicture_(url, post) the picture under an alert the bot posts itself (a watch alert, a Direct BigQuery card):
 *                           screenshotFor_'s, else pagePicture_'s, downloaded by fetchScreenshot_
 *
 * Used for: the full video and audio Gemini watches and listens to (Media.gs), the thread that shows a post is a reply
 * under an alerted post or quotes one (Escalate.gs earlierAlerts_, BigQuery.gs related alerts), the post's own words in
 * Gemini's prompt (Review.gs), the screenshot in the Social Alert email, and the picture under the bot's own alerts.
 * Never throws: anything unavailable is null. Lookups are cached for 30 minutes.
 */

const POST_CACHE_SEC_ = 30 * 60;
const POST_UA_ = 'Mozilla/5.0 (compatible; SLRR-QA-bot/1.0)';
// Instagram's embed page, as link previews read it (Instagram shows other agents a sign-in page or an empty shell)
const IG_EMBED_UA_ = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const IG_CDN_RX_ = /^https:\/\/[a-z0-9.-]+\.(?:cdninstagram\.com|fbcdn\.net)\//i;  // where Instagram's images are
const IG_EMBED_PAGE_RX_ = /^https:\/\/www\.instagram\.com\/(?:p|reels?|tv)\/[A-Za-z0-9_-]+\/embed\/(?:captioned\/?)?(?:\?[^#\s]*)?$/i;
const X_EMBED_API_ = 'https://cdn.syndication.twimg.com/tweet-result';
const X_VIDEO_MAX_BITRATE_ = 2200000;  // 720p at most: Gemini samples 1 frame a second at low resolution anyway
const BSKY_API_ = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread';
const TIKTOK_OEMBED_ = 'https://www.tiktok.com/oembed';
const YOUTUBE_OEMBED_ = 'https://www.youtube.com/oembed';
// The images of a link card in X's embed data (card.binding_values: each {image_value: {url}}), a medium size first
const X_CARD_IMAGE_KEYS_ = ['_large', '_x_large', '', '_original'].reduce((all, size) => all.concat(
  ['photo_image_full_size', 'summary_photo_image', 'thumbnail_image', 'player_image'].map(k => k + size)), []);
// The picture a post's page shows link previews (pagePicture_): only this much of the page is read (its head has it)...
const PAGE_PIC_MAX_CHARS_ = 400000;
// ...read as a link preview reads it on these sites (they show other agents a sign-in page, a check page or an empty
// shell), other sites as the bot first...
const PAGE_PIC_AS_PREVIEW_RX_ = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.com|fb\.watch|instagram\.com|threads\.net|threads\.com|reddit\.com|redd\.it|tiktok\.com|linkedin\.com)(?:[/:?#]|$)/i;
// ...never these sites' pages (they show the author's profile picture; lookupPost_ reads their posts)...
const PAGE_PIC_NEVER_RX_ = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:x\.com|twitter\.com|bsky\.app)(?:[/:?#]|$)/i;
// ...and never one of these pictures: a site's logo, banner or placeholder, or a profile picture (Reddit's preview of a
// text post is its banner; Bluesky's, Truth Social's and Gab's the author's avatar; Instagram's -19 and Facebook's -1
// files are profile pictures; LinkedIn's static files its logo)
const PAGE_PIC_SKIP_RX_ = /^https:\/\/(?:static\.cdninstagram\.com\/rsrc\.php\/|static\.xx\.fbcdn\.net\/rsrc\.php\/|(?:www\.)?facebook\.com\/images\/|share\.redd\.it\/preview\/|(?:[a-z0-9-]+\.)?redditstatic\.com\/|styles\.redditmedia\.com\/|cdn\.bsky\.app\/img\/avatar|abs\.twimg\.com\/|pbs\.twimg\.com\/profile_images\/|static(?:-exp\d)?\.licdn\.com\/|s0\.wp\.com\/i\/blank)|\/avatars?\/|\/t(?:51\.2885-19|39\.30808-1|1\.30497-1|1\.6435-1)\/|favicon|apple-touch-icon|\/spacer\.gif|\/blank\.(?:gif|png|jpe?g)(?:[?#]|$)|\blogo[^/?#]*\.(?:png|jpe?g|gif|webp|svg)(?:[?#]|$)/i;
// A link to a video's own page (beside YouTube's: Media.gs youtubeUrl_): an alert's link then says "Watch the video"
const VIDEO_LINK_RX_ = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:facebook\.com\/(?:[^?#]*\/)?(?:videos?|reels?|watch)(?:[/?#]|$)|fb\.watch\/|instagram\.com\/(?:[^/?#]+\/)?(?:reels?|tv)\/|tiktok\.com\/@[^/?#]+\/video\/|rumble\.com\/v|bitchute\.com\/video\/|vimeo\.com\/\d|dailymotion\.com\/video\/)/i;

/** x.com / twitter.com status link -> its numeric id ('' when it isn't one). Pure. */
function xStatusId_(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/?#]+\/status(?:es)?\/(\d{5,25})/i);
  return m ? m[1] : '';
}

/** bsky.app post link -> {who (handle or DID), rkey}, or null. Pure. */
function bskyRef_(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.)?bsky\.app\/profile\/([^/?#]+)\/post\/([a-z0-9]{6,20})/i);
  return m ? { who: decodeURIComponent(m[1]), rkey: m[2] } : null;
}

/** The post's id in its link: the X status id or the Bluesky post key ('' for other links). Pure. */
function postIdOf_(url) {
  const ref = bskyRef_(url);
  return xStatusId_(url) || (ref ? ref.rkey : '');
}

/** The token X's embed endpoint expects for a post id (as X's own embed code computes it). Pure. */
function xEmbedToken_(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** The original post for an alert's link: {platform, id, url, author, text, …} or null. Never throws. */
function lookupPost_(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  const yt = typeof youtubeUrl_ === 'function' ? youtubeUrl_(u) : null;
  if (yt) {
    const id = yt.split('v=')[1];
    return { platform: 'YouTube', id, url: yt, author: '', text: '', photos: [], video: null, thumbnail:
      `https://img.youtube.com/vi/${id}/hqdefault.jpg`, reply_to: null, parent: null, quoted: null, thread_ids: [] };
  }
  const xId = xStatusId_(u);
  const bsky = xId ? null : bskyRef_(u);
  const tiktok = !xId && !bsky && /^https?:\/\/(?:www\.|m\.|vm\.)?tiktok\.com\//i.test(u);
  const ig = !xId && !bsky && !tiktok ? igCode_(u) : '';
  if (!xId && !bsky && !tiktok && !ig) return null;
  const key = 'post:' + (xId ? 'x:' + xId : bsky ? `bsky:${bsky.who}:${bsky.rkey}` : ig ? 'ig:' + ig : 'tt:' + hashText_(u).slice(0, 40));
  const cache = typeof CacheService !== 'undefined' && CacheService.getScriptCache ? CacheService.getScriptCache() : null;
  if (cache) {
    try { const hit = cache.get(key); if (hit) return JSON.parse(hit); } catch (e) {}
  }
  let post = null;
  try {
    if (xId) post = xPostFromEmbed_(fetchJson_(`${X_EMBED_API_}?id=${xId}&lang=en&token=${xEmbedToken_(xId)}`));
    else if (bsky) post = lookupBsky_(bsky);
    else if (ig) {
      const page = instagramEmbedPage_(ig);
      post = instagramPostFromEmbed_(page.html, u, ig, page.url);
    }
    else {
      post = tiktokPostFromOembed_(fetchJson_(`${TIKTOK_OEMBED_}?url=${encodeURIComponent(u)}`), u);
      // TikTok's oEmbed stopped giving the caption and the cover: they're in the video page's own data
      if (!post) post = tiktokPostFromPage_(fetchTikTokPage_(u), u);
    }
  } catch (e) {
    console.warn(`couldn't look up the post ${u}: ${(e && e.message) || e}`);
  }
  if (post && cache) {
    try { cache.put(key, JSON.stringify(post), POST_CACHE_SEC_); } catch (e) {}
  }
  return post;
}

/**
 * X posts by id, looked up together (UrlFetchApp.fetchAll: one round trip for all of them), for the Proactive watch's
 * Brandwatch query, whose X posts come without their text: {id: the post as lookupPost_ gives it} for those X serves.
 * Cached for 30 minutes under lookupPost_'s keys, so a later lookupPost_ of one of them costs nothing. Never throws:
 * a post that fails is left out.
 */
function lookupXPosts_(ids) {
  const out = {};
  const want = Array.from(new Set((ids || []).map(String).filter(id => /^\d{5,25}$/.test(id))));
  if (!want.length) return out;
  const cache = typeof CacheService !== 'undefined' && CacheService.getScriptCache ? CacheService.getScriptCache() : null;
  let hits = {};
  if (cache) {
    try { hits = cache.getAll(want.map(id => 'post:x:' + id)) || {}; } catch (e) { hits = {}; }
  }
  const missing = want.filter(id => {
    try {
      const post = hits['post:x:' + id] ? JSON.parse(hits['post:x:' + id]) : null;
      if (post) out[id] = post;
      return !post;
    } catch (e) {
      return true;
    }
  });
  if (!missing.length) return out;
  let resps = [];
  try {
    resps = UrlFetchApp.fetchAll(missing.map(id => ({ url: `${X_EMBED_API_}?id=${id}&lang=en&token=${xEmbedToken_(id)}`,
      muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': POST_UA_ } })));
  } catch (e) {
    console.warn(`couldn't look up ${missing.length} X posts: ${(e && e.message) || e}`);
    return out;
  }
  const keep = {};
  missing.forEach((id, i) => {
    try {
      const r = resps[i];
      const post = r && r.getResponseCode() === 200 ? xPostFromEmbed_(JSON.parse(r.getContentText() || 'null')) : null;
      if (!post) return;
      out[id] = post;
      keep['post:x:' + id] = JSON.stringify(post);
    } catch (e) { /* that post is left out */ }
  });
  if (cache && Object.keys(keep).length) {
    try { cache.putAll(keep, POST_CACHE_SEC_); } catch (e) {}
  }
  return out;
}

/** An Instagram post's shortcode from its link (/p/, /reel/, /reels/, /tv/), or ''. Pure. */
function igCode_(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:p|reels?|tv)\/(?!audio\/)([A-Za-z0-9_-]{5,})/i);
  return m ? m[1] : '';
}

/**
 * Instagram's public embed page for post `code`: {html, url} (url: the page that served it), html '' when Instagram
 * doesn't serve it. A redirect to the post's own embed page (e.g. a reel's) is followed once; any other redirect is the
 * sign-in page. Never throws.
 */
function instagramEmbedPage_(code) {
  const get = url => UrlFetchApp.fetch(url, {
    muteHttpExceptions: true, followRedirects: false, headers: { 'User-Agent': IG_EMBED_UA_, Accept: 'text/html' } });
  let url = `https://www.instagram.com/p/${encodeURIComponent(code)}/embed/captioned/`;
  try {
    let r = get(url);
    if (r.getResponseCode() >= 300 && r.getResponseCode() < 400) {
      const headers = (typeof r.getHeaders === 'function' && r.getHeaders()) || {};
      const to = String(headers.Location || headers.location || '').trim();
      url = to.charAt(0) === '/' && to.charAt(1) !== '/' ? 'https://www.instagram.com' + to : to;
      if (!IG_EMBED_PAGE_RX_.test(url)) return { html: '', url };
      r = get(url);
    }
    return { html: r.getResponseCode() === 200 ? String(r.getContentText() || '') : '', url };
  } catch (e) {
    return { html: '', url };
  }
}

/**
 * Instagram's embed page -> the post as the bot uses it: its first image (photos; a reel's or video's cover goes in
 * thumbnail), its author and caption. No likes or replies (the page doesn't say). Null for the sign-in page or the
 * empty shell Instagram serves when it won't show the post (removed, private, or it doesn't trust the visitor). A reel or
 * video: from the post's link, the embed page's own link (`pageUrl`, a reel's when Instagram redirected there), or the
 * page's video markers. Pure.
 */
function instagramPostFromEmbed_(html, url, code, pageUrl) {
  const h = String(html || '');
  if (!/class="[^"]*\bEmbedded?Media/.test(h) && !/class="[^"]*\bEmbed\b/.test(h)) return null;
  const tag = (h.match(/<img[^>]*class="[^"]*\bEmbeddedMediaImage\b[^"]*"[^>]*>/i) || [])[0] || '';
  const attr = name => decodeEntities_(((tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i')) || [])[1]) || '');
  const largest = attr('srcset').split(',').map(x => x.trim().split(/\s+/)).filter(x => x[0])
    .sort((a, b) => (parseInt(b[1], 10) || 0) - (parseInt(a[1], 10) || 0))[0];
  const img = [largest ? largest[0] : '', attr('src')].find(x => IG_CDN_RX_.test(x) && !/\/rsrc\.php\//i.test(x)) || '';
  const video = /\/(?:reels?|tv)\//i.test(`${url || ''} ${pageUrl || ''}`) || /\bEmbeddedMediaVideo\b|\bWatchOnInstagram\b/.test(h);
  const author = decodeEntities_(((h.match(/class="[^"]*\bUsernameText\b[^"]*"[^>]*>([^<]+)</) || [])[1]) || '').trim();
  const captionHtml = ((h.match(/<div class="Caption"[^>]*>([\s\S]*?)(?:<div class="CaptionComments"|<\/div>)/) || [])[1]) || '';
  const caption = htmlToText_(captionHtml.replace(/<a[^>]*class="CaptionUsername"[^>]*>[\s\S]*?<\/a>/, ''))
    .replace(/\s+/g, ' ').trim();
  if (!img && !caption) return null;
  return {
    platform: 'Instagram', id: code, url, author, text: postText_(caption).slice(0, 1200),
    photos: img && !video ? [img] : [], thumbnail: img && video ? img : '', video: null,
    reply_to: null, parent: null, quoted: null, thread_ids: [],
  };
}

/** GET a JSON document (public, no sign-in): the parsed body, or null on any error. */
function fetchJson_(url) {
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': POST_UA_ } });
    return r.getResponseCode() === 200 ? JSON.parse(r.getContentText() || 'null') : null;
  } catch (e) {
    return null;
  }
}

/**
 * Whether the post behind a link is gone (deleted or taken down), for Watch sent alerts (Watch.gs). true when the platform
 * says so: X has no post at that id (or shows a "deleted" / "no longer exists" / "suspended" notice in its place),
 * Bluesky says the post isn't found, YouTube's embed info says the video isn't found. false when it's there. null when
 * it can't tell (another platform, an error, or an answer that isn't clear). One request, nothing cached. Never throws.
 */
function postGone_(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  try {
    const yt = typeof youtubeUrl_ === 'function' ? youtubeUrl_(u) : null;
    if (yt) {
      const r = fetchStatus_(`${YOUTUBE_OEMBED_}?format=json&url=${encodeURIComponent(yt)}`);
      return !r ? null : r.code === 404 ? true : (r.code === 200 && r.json ? false : null);
    }
    const xId = xStatusId_(u);
    if (xId) {
      const r = fetchStatus_(`${X_EMBED_API_}?id=${xId}&lang=en&token=${xEmbedToken_(xId)}`);
      if (!r) return null;
      if (r.code === 404) return true;
      const d = r.code === 200 ? r.json : null;
      if (d && d.__typename === 'TweetTombstone') {  // X's notice in the post's place (also for age-restricted posts)
        const notice = String((((d.tombstone || {}).text || {}).text) || '');
        return /deleted|no longer exists|suspended/i.test(notice) ? true : null;
      }
      return d && d.id_str ? false : null;
    }
    const bsky = bskyRef_(u);
    if (bsky) {
      const uri = `at://${bsky.who}/app.bsky.feed.post/${bsky.rkey}`;
      const r = fetchStatus_(`${BSKY_API_}?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=2`);
      if (!r) return null;
      const d = r.json || {};
      if (r.code === 400 && d.error === 'NotFound') return true;
      const t = r.code === 200 ? d.thread : null;
      if (t && (t.notFound === true || /#notFoundPost$/.test(String(t.$type || '')))) return true;
      return t && t.post ? false : null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/** GET (public, no sign-in): {code, json (the parsed body, or null)}, or null when the request itself failed. */
function fetchStatus_(url) {
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': POST_UA_ } });
    let json = null;
    try { json = JSON.parse(r.getContentText() || 'null'); } catch (e) { json = null; }
    return { code: r.getResponseCode(), json };
  } catch (e) {
    return null;
  }
}

function postText_(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

/** X's embed data -> the post as the bot uses it. Pure. */
function xPostFromEmbed_(d) {
  if (!d || !d.id_str) return null;
  const handle = t => String(((t && t.user) || {}).screen_name || '');
  const link = (who, id) => (id ? `https://x.com/${who || 'i'}/status/${id}` : '');
  const parent = d.parent && d.parent.id_str ? {
    id: d.parent.id_str, author: handle(d.parent), text: postText_(d.parent.text).slice(0, 600),
    reply_to: d.parent.in_reply_to_status_id_str
      ? { id: String(d.parent.in_reply_to_status_id_str), author: String(d.parent.in_reply_to_screen_name || '') } : null,
  } : null;
  const replyTo = d.in_reply_to_status_id_str
    ? { id: String(d.in_reply_to_status_id_str), author: String(d.in_reply_to_screen_name || '') } : null;
  const quoted = d.quoted_tweet && d.quoted_tweet.id_str ? {
    id: d.quoted_tweet.id_str, author: handle(d.quoted_tweet), text: postText_(d.quoted_tweet.text).slice(0, 600),
    url: link(handle(d.quoted_tweet), d.quoted_tweet.id_str),
  } : null;
  let video = null;
  const photos = [];
  (d.mediaDetails || []).forEach(m => {
    if ((m.type === 'video' || m.type === 'animated_gif') && !video) {
      const variants = (((m.video_info || {}).variants) || []).filter(v => v.content_type === 'video/mp4' && v.url)
        .map(v => ({ url: v.url, bitrate: Number(v.bitrate) || 0 }))
        .filter(v => !v.bitrate || v.bitrate <= X_VIDEO_MAX_BITRATE_).sort((a, b) => b.bitrate - a.bitrate);
      if (variants.length) {
        const ms = Number((m.video_info || {}).duration_millis) || 0;
        video = { url: variants[0].url, variants, poster: m.media_url_https || '', duration_s: ms ? Math.round(ms / 1000) : null,
          gif: m.type === 'animated_gif' };
      }
    } else if (m.type === 'photo' && m.media_url_https) {
      photos.push(m.media_url_https);
    }
  });
  if (!photos.length) (d.photos || []).forEach(p => { if (p && p.url) photos.push(p.url); });
  const post = {
    platform: 'X', id: d.id_str, url: link(handle(d), d.id_str), author: handle(d), text: postText_(d.text).slice(0, 1200),
    created_at: d.created_at || '', likes: Number(d.favorite_count) || 0, replies: Number(d.conversation_count) || 0,
    reply_to: replyTo, parent, quoted, video, photos: photos.slice(0, 4),
    // the posts this one sits under in its thread (its parent, and the post the parent replied to)
    thread_ids: [replyTo && replyTo.id, parent && parent.reply_to && parent.reply_to.id].filter(Boolean),
  };
  // no photo or video file of its own: the picture it still shows, for the picture of the post only (screenshotFor_)
  const preview = photos.length || video ? null : xPreview_(d);
  if (preview) post.preview = preview;
  return post;
}

/**
 * What an X post with no photo or video file of its own still shows, from X's embed data: its video's frame (a video X
 * gives no MP4 file small enough for, or only as a stream), else the photo or video frame of the post it quotes, else
 * the image of its link card (or of the quoted post's). {url, label, video: true only for its own video}, or null. Pure.
 */
function xPreview_(d) {
  const https = u => (/^https:\/\//i.test(String(u || '')) ? String(u) : '');
  const frameOf = t => {
    const m = ((t && t.mediaDetails) || []).find(x => x && (x.type === 'video' || x.type === 'animated_gif') && https(x.media_url_https));
    return m ? m.media_url_https : https(t && t.video && t.video.poster);
  };
  const photoOf = t => {
    const m = ((t && t.mediaDetails) || []).find(x => x && x.type === 'photo' && https(x.media_url_https));
    if (m) return m.media_url_https;
    const p = ((t && t.photos) || []).find(x => x && https(x.url));
    return p ? p.url : '';
  };
  const own = frameOf(d);
  if (own) return { url: own, label: 'Frame from the post\'s video', video: true };
  const q = d && d.quoted_tweet;
  const qPhoto = photoOf(q);
  if (qPhoto) return { url: qPhoto, label: 'Image from the post it quotes', video: false };
  const qFrame = frameOf(q);
  if (qFrame) return { url: qFrame, label: 'Frame from the video in the post it quotes', video: false };
  const card = xCardImage_(d && d.card) || xCardImage_(q && q.card);
  return card ? { url: card, label: 'Image from the link in the post', video: false } : null;
}

/** The image of a link card in X's embed data (card.binding_values; X_CARD_IMAGE_KEYS_ order), or ''. Pure. */
function xCardImage_(card) {
  const values = (card && card.binding_values) || {};
  for (const k of X_CARD_IMAGE_KEYS_) {
    const url = String((values[k] && values[k].image_value && values[k].image_value.url) || '');
    if (/^https:\/\//i.test(url)) return url;
  }
  return '';
}

/** A Bluesky post (and the original file of its video, from the author's server), or null. */
function lookupBsky_(ref) {
  const uri = `at://${ref.who}/app.bsky.feed.post/${ref.rkey}`;
  const d = fetchJson_(`${BSKY_API_}?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=2`);
  const post = bskyPostFromThread_(d && d.thread);
  if (post && post.video && post.video.cid && post.video.did) {
    const pds = bskyPds_(post.video.did);
    if (pds) {
      post.video.url = `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(post.video.did)}&cid=${encodeURIComponent(post.video.cid)}`;
    }
  }
  return post;  // a video with no file to fetch (url '') still has its cover frame (poster) for Gemini and the email
}

/** The server that holds a Bluesky account's files (its PDS), from its DID document, or ''. */
function bskyPds_(did) {
  const d = /^did:plc:/i.test(did) ? fetchJson_(`https://plc.directory/${did}`)
    : /^did:web:/i.test(did) ? fetchJson_(`https://${did.slice(8)}/.well-known/did.json`) : null;
  const svc = ((d && d.service) || []).find(s => s && /#atproto_pds$/.test(String(s.id || '')));
  const host = svc ? String(svc.serviceEndpoint || '').replace(/\/+$/, '') : '';
  return /^https:\/\//i.test(host) ? host : '';
}

/** Bluesky's thread view -> the post as the bot uses it (video.url is filled in by lookupBsky_). Pure. */
function bskyPostFromThread_(t) {
  const p = t && t.post;
  if (!p || !p.uri) return null;
  const rkeyOf = uri => (String(uri || '').match(/\/app\.bsky\.feed\.post\/([^/]+)$/) || [])[1] || '';
  const didOf = uri => (String(uri || '').match(/^at:\/\/([^/]+)\//) || [])[1] || '';
  const handle = a => String((a && a.handle) || '');
  const link = (who, rk) => (rk ? `https://bsky.app/profile/${who}/post/${rk}` : '');
  const rec = p.record || {};
  const up = t.parent && t.parent.post ? t.parent : null;
  const up2 = up && up.parent && up.parent.post ? up.parent : null;
  const upReply = up && up.post.record && up.post.record.reply && up.post.record.reply.parent;
  const parent = up ? {
    id: rkeyOf(up.post.uri), author: handle(up.post.author), text: postText_((up.post.record || {}).text).slice(0, 600),
    reply_to: up2 ? { id: rkeyOf(up2.post.uri), author: handle(up2.post.author) }
      : (upReply ? { id: rkeyOf(upReply.uri), author: '' } : null),
  } : null;
  const replyUri = rec.reply && rec.reply.parent ? rec.reply.parent.uri : '';
  const replyTo = replyUri ? { id: rkeyOf(replyUri), author: parent ? parent.author : '' } : null;
  const emb = p.embed || {};
  const type = String(emb.$type || '');
  const withMedia = /recordWithMedia/.test(type);
  const media = withMedia ? (emb.media || {}) : emb;
  const mediaType = String(media.$type || '');
  const quotedView = withMedia ? ((emb.record || {}).record || null) : (/embed\.record#view/.test(type) ? emb.record : null);
  const quoted = quotedView && quotedView.uri && /app\.bsky\.feed\.post/.test(quotedView.uri) ? {
    id: rkeyOf(quotedView.uri), author: handle(quotedView.author), text: postText_((quotedView.value || {}).text).slice(0, 600),
    url: link(handle(quotedView.author) || didOf(quotedView.uri), rkeyOf(quotedView.uri)),
  } : null;
  const photos = /embed\.images/.test(mediaType) ? (media.images || []).map(i => i.fullsize || i.thumb).filter(Boolean) : [];
  let video = null;
  if (/embed\.video/.test(mediaType)) {
    const recVideo = ((withMedia ? ((rec.embed || {}).media || {}) : (rec.embed || {})).video) || {};
    video = { url: '', cid: String(media.cid || ((recVideo.ref || {}).$link) || ''), did: didOf(p.uri), poster: media.thumbnail || '',
      duration_s: null, size: Number(recVideo.size) || null, mime: String(recVideo.mimeType || 'video/mp4') };
  }
  const post = {
    platform: 'Bluesky', id: rkeyOf(p.uri), url: link(handle(p.author) || didOf(p.uri), rkeyOf(p.uri)), author: handle(p.author),
    text: postText_(rec.text).slice(0, 1200), created_at: rec.createdAt || '', likes: Number(p.likeCount) || 0,
    replies: Number(p.replyCount) || 0, reply_to: replyTo, parent, quoted, video, photos: photos.slice(0, 4),
    thread_ids: [replyTo && replyTo.id, parent && parent.reply_to && parent.reply_to.id].filter(Boolean),
  };
  // no images or video of its own: the picture it still shows, for the picture of the post only (screenshotFor_)
  const preview = photos.length || video ? null : bskyPreview_(media, quotedView);
  if (preview) post.preview = preview;
  return post;
}

/**
 * What a Bluesky post with no images or video of its own still shows (`media`: its embed's view, `quotedView`: the post
 * it quotes): its link card's image, else the quoted post's image, video frame or link card image. {url, label, video:
 * false}, or null. Pure.
 */
function bskyPreview_(media, quotedView) {
  const https = u => (/^https:\/\//i.test(String(u || '')) ? String(u) : '');
  const pic = view => {
    const v = view || {};
    const type = String(v.$type || '');
    if (/embed\.images/.test(type)) {
      const i = (v.images || []).find(x => x && https(x.fullsize || x.thumb));
      return i ? { url: https(i.fullsize || i.thumb), what: 'image' } : null;
    }
    if (/embed\.video/.test(type)) return https(v.thumbnail) ? { url: v.thumbnail, what: 'video' } : null;
    if (/embed\.external/.test(type)) return https(v.external && v.external.thumb) ? { url: v.external.thumb, what: 'link' } : null;
    if (/recordWithMedia/.test(type)) return pic(v.media);
    return null;
  };
  const card = /embed\.external/.test(String((media && media.$type) || '')) ? pic(media) : null;
  if (card) return { url: card.url, label: 'Image from the link in the post', video: false };
  const q = ((quotedView && quotedView.embeds) || []).map(pic).find(Boolean);
  if (!q) return null;
  const label = q.what === 'video' ? 'Frame from the video in the post it quotes'
    : q.what === 'link' ? 'Image from the link in the post it quotes' : 'Image from the post it quotes';
  return { url: q.url, label, video: false };
}

/** TikTok's oEmbed -> the post as the bot uses it: the caption and the video's cover image. Pure. */
function tiktokPostFromOembed_(d, url) {
  if (!d || !(d.title || d.thumbnail_url)) return null;
  return {
    platform: 'TikTok', id: String(d.embed_product_id || ''), url, author: String(d.author_unique_id || ''),
    text: postText_(d.title).slice(0, 1200), thumbnail: String(d.thumbnail_url || ''), photos: [], video: null,
    reply_to: null, parent: null, quoted: null, thread_ids: [],
  };
}

/**
 * TikTok's video page -> the same post as tiktokPostFromOembed_ gives: the caption, the author and the video's cover
 * image, from the data the page carries for its own scripts (<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">,
 * __DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct); a photo post with no cover gets its first image as
 * its preview (imagePost.images: the picture of the post only). Null when the page doesn't carry the post (removed,
 * private, a sign-in or check page) or the data can't be read. Pure.
 */
function tiktokPostFromPage_(html, url) {
  const m = String(html || '').match(/<script[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  let data = null;
  try { data = JSON.parse(m[1]); } catch (e) { return null; }
  const detail = ((data && data.__DEFAULT_SCOPE__) || {})['webapp.video-detail'] || {};
  const item = (detail.itemInfo && detail.itemInfo.itemStruct) || {};
  const video = item.video || {};
  const cover = [video.cover, video.originCover, video.dynamicCover].map(c => String(c || '')).find(c => /^https:\/\//i.test(c)) || '';
  const text = postText_(typeof item.desc === 'string' ? item.desc : '');
  if (!item.id || !(text || cover)) return null;
  const post = {
    platform: 'TikTok', id: String(item.id), url, author: String((item.author && item.author.uniqueId) || ''),
    text: text.slice(0, 1200), thumbnail: cover, photos: [], video: null,
    reply_to: null, parent: null, quoted: null, thread_ids: [],
  };
  // a photo post: its images' links (a JPEG first, the format every mail and chat client shows)
  const image = ((item.imagePost && item.imagePost.images) || []).map(i => {
    const list = (((i && i.imageURL) || {}).urlList || []).map(String).filter(u => /^https:\/\//i.test(u));
    return list.find(u => /jpe?g/i.test(u)) || list[0] || '';
  }).find(Boolean);
  if (!cover && image) post.preview = { url: image, label: 'Image from the post', video: false };
  return post;
}

/** A TikTok video page's HTML (public, no sign-in), or '' on any error. */
function fetchTikTokPage_(url) {
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': POST_UA_, Accept: 'text/html' } });
    return r.getResponseCode() === 200 ? String(r.getContentText() || '') : '';
  } catch (e) {
    return '';
  }
}

/** "m:ss" for a number of seconds. Pure. */
function clock_(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Burson's screenshot link for the post, when the alert carries one. */
const SCREENSHOT_LINK_RX_ = /https?:\/\/api\.screenshotmachine\.com\/?\?[^\s<>"')\]|]+/i;

/**
 * The platforms whose pages show people who aren't signed in (and screenshot services) a sign-in prompt or a block page
 * over the post, or instead of it: Burson's alerts say screenshots aren't available for Reddit, TikTok, Facebook,
 * YouTube and Instagram, and Threads and LinkedIn do the same. Burson's screenshot of them is never used.
 */
const SIGNIN_WALLED_NETWORKS_ = ['Instagram', 'Facebook', 'Threads', 'LinkedIn', 'TikTok', 'Reddit', 'YouTube'];

/** The page a ScreenshotMachine link shows (its url= parameter), or ''. Pure. */
function screenshotTarget_(shot) {
  const m = String(shot || '').match(/[?&]url=([^&#]+)/i);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
  } catch (e) {
    return '';
  }
}

/**
 * True when Burson's screenshot `shot` shows a platform that puts a sign-in prompt over its posts
 * (SIGNIN_WALLED_NETWORKS_): the network of the page in the screenshot's link, else of the alert's link, else the
 * alert's network (`fields`). Pure.
 */
function screenshotSignInWalled_(shot, fields) {
  const f = fields || {};
  const fromLink = url => (typeof networkForDomain_ === 'function' ? networkForDomain_(domainOf_(url)) : null);
  const raw = String(f.social_network || '').trim();
  const named = ((GEN.network_aliases || {})[raw.toLowerCase()]) || raw;
  const network = String(fromLink(screenshotTarget_(shot)) || fromLink(f.post_url) || named).toLowerCase();
  return SIGNIN_WALLED_NETWORKS_.some(n => n.toLowerCase() === network);
}

/** Burson's screenshot of the post (the alert's ScreenshotMachine link), or '' when there's none or it would show a
 * sign-in prompt (screenshotSignInWalled_). Everything that shows or fetches Burson's screenshot reads it through here
 * (Bot.gs reads the raw field only to log that it was skipped). Pure. */
function bursonScreenshotUrl_(parsed) {
  const shot = String((parsed && parsed.extra && parsed.extra.screenshot_url) || '').trim();
  return shot && !screenshotSignInWalled_(shot, parsed && parsed.fields) ? shot : '';
}

/**
 * The picture saved with a queued email (input.screenshot: {url, label}), or null when it's Burson's screenshot of a
 * platform that shows a sign-in prompt (queued before the bot stopped using those). Pure.
 */
function savedScreenshot_(input) {
  const shot = input && input.screenshot;
  const url = String((shot && typeof shot === 'object' ? shot.url : shot) || '').trim();
  if (!url) return null;
  const fields = Object.assign({ social_network: ((input && input.escalation) || {}).platform }, (input && input.fields) || {});
  return SCREENSHOT_LINK_RX_.test(url) && screenshotSignInWalled_(url, fields) ? null : shot;
}

/**
 * The picture of the post for the Social Alert email: {url, label} or null. Burson's screenshot of the post first (what
 * IMs paste in), else the post's own photo or video frame, else the video's thumbnail or cover, else what the post
 * still shows with no media of its own (its preview: an X video's frame, the photo or frame of the post it quotes, a
 * link card's image, a TikTok photo post's image; then {url, label, video}). Pure.
 */
function screenshotFor_(parsed) {
  const shot = bursonScreenshotUrl_(parsed);
  if (shot) return { url: shot, label: 'Screenshot of the post' };
  const p = parsed && parsed.post;
  if (!p) return null;
  if (p.photos && p.photos.length) return { url: p.photos[0], label: 'Image from the post' };
  if (p.video && p.video.poster) return { url: p.video.poster, label: 'Frame from the post\'s video' };
  if (p.thumbnail) return { url: p.thumbnail, label: 'The video\'s thumbnail' };
  const pre = p.preview;
  if (pre && /^https:\/\//i.test(String(pre.url || ''))) {
    return { url: String(pre.url), label: String(pre.label || 'Image from the post'), video: !!pre.video };
  }
  return null;
}

const SCREENSHOT_MAX_BYTES_ = 3 * 1024 * 1024;
// The image types Gmail and Chat show inline, asked for in that order (a server that can send several sends one of them)
const SCREENSHOT_ACCEPT_ = 'image/jpeg,image/png,image/webp,image/gif;q=0.9,*/*;q=0.5';

/**
 * Downloads the screenshot for an email (or the picture under one of the bot's own alerts: alertPicture_): {cid, mime,
 * name, base64, label} or null (not a PNG, JPEG, WebP or GIF, too big, or unreachable: the email goes without it). Its
 * type is the bytes' own when they show one (Media.gs imageMime_: an image server may send a generic binary type, or
 * image/jpg). Burson's screenshot service can take several seconds to render the page.
 */
function fetchScreenshot_(shot) {
  if (!shot || !/^https:\/\//i.test(String(shot.url || ''))) return null;
  try {
    const r = UrlFetchApp.fetch(shot.url, { muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': POST_UA_, Accept: SCREENSHOT_ACCEPT_ } });
    if (r.getResponseCode() !== 200 || typeof r.getContent !== 'function') return null;
    const headers = (typeof r.getHeaders === 'function' && r.getHeaders()) || {};
    const type = String(headers['Content-Type'] || headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    // too big by its own Content-Length: never read into the script (getContent() makes it an array many times its size)
    if (Number(headers['Content-Length'] || headers['content-length']) > SCREENSHOT_MAX_BYTES_) return null;
    const bytes = r.getContent();
    if (!bytes || !bytes.length || bytes.length > SCREENSHOT_MAX_BYTES_) return null;
    const mime = typeof imageMime_ === 'function' ? imageMime_(type, bytes) : type.replace(/^image\/jpg$/, 'image/jpeg');
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) return null;
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');
    return { cid: 'post-screenshot', mime, name: `post.${ext}`, base64: Utilities.base64Encode(bytes), label: shot.label || '' };
  } catch (e) {
    console.warn(`couldn't fetch the post's screenshot: ${(e && e.message) || e}`);
    return null;
  }
}

/**
 * The picture a post's page shows link previews (og:image, twitter:image), for an alert's picture when the post's own
 * lookup gives none (alertPicture_): Facebook, Reddit, Threads, LinkedIn, news and other sites, and Instagram or TikTok
 * when their embed data shows none. {url, label, video: true when the page is a video's}, or null. Social sites' pages
 * are read as a link preview reads them (IG_EMBED_UA_: PAGE_PIC_AS_PREVIEW_RX_), other sites as the bot, then as a
 * link preview when that shows none. Never X's or Bluesky's pages (PAGE_PIC_NEVER_RX_: they show the author's picture,
 * and lookupPost_ reads their posts) or YouTube's (lookupPost_ gives its thumbnail). Cached for 30 minutes (a page
 * with none isn't). Never throws.
 */
function pagePicture_(url) {
  const u = String(url || '').trim();
  try {
    if (!/^https?:\/\//i.test(u) || PAGE_PIC_NEVER_RX_.test(u) || (typeof youtubeUrl_ === 'function' && youtubeUrl_(u))) return null;
    const key = 'post:pic:' + hashText_(u).slice(0, 40);
    const cache = typeof CacheService !== 'undefined' && CacheService.getScriptCache ? CacheService.getScriptCache() : null;
    if (cache) {
      try { const hit = cache.get(key); if (hit) return JSON.parse(hit); } catch (e) {}
    }
    let pic = null;
    for (const agent of PAGE_PIC_AS_PREVIEW_RX_.test(u) ? [IG_EMBED_UA_] : [POST_UA_, IG_EMBED_UA_]) {
      pic = pagePictureFrom_(fetchPageAs_(u, agent), u);
      if (pic) break;
    }
    if (pic && cache) {
      try { cache.put(key, JSON.stringify(pic), POST_CACHE_SEC_); } catch (e) {}
    }
    return pic;
  } catch (e) {
    console.warn(`couldn't read the picture of ${u}: ${(e && e.message) || e}`);
    return null;
  }
}

/**
 * A page's picture for link previews, as pagePicture_ gives it: the first of og:image:secure_url, og:image:url,
 * og:image, twitter:image:src and twitter:image that isn't a site's logo, a banner or a profile picture
 * (PAGE_PIC_SKIP_RX_, Media.gs SITE_LOGO_RX_), made https (a relative link: on the page's own site). {url, label,
 * video: true when the page is a video's (its og:type or og:video, a player card, or a video link: videoLink_)}, or
 * null. Pure.
 */
function pagePictureFrom_(html, url) {
  const h = String(html || '').slice(0, PAGE_PIC_MAX_CHARS_);
  if (!h) return null;
  const tags = h.match(/<meta\b[^>]*>/gi) || [];
  const meta = name => {
    for (const tag of tags) {
      const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!key || key.trim().toLowerCase() !== name) continue;
      const c = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const v = c ? decodeEntities_(c[1] !== undefined ? c[1] : c[2]).trim() : '';
      if (v) return v;
    }
    return '';
  };
  const site = (String(url || '').match(/^https?:\/\/[^/?#]+/i) || [''])[0].replace(/^http:/i, 'https:');
  const https = link => {
    const l = String(link || '').trim();
    if (/^\/\//.test(l)) return 'https:' + l;
    if (/^\/(?!\/)/.test(l)) return site ? site + l : '';
    return l.replace(/^http:\/\//i, 'https://');
  };
  const notPost = l => PAGE_PIC_SKIP_RX_.test(l) || (typeof SITE_LOGO_RX_ !== 'undefined' && SITE_LOGO_RX_.test(l));
  const pic = ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image:src', 'twitter:image']
    .map(name => https(meta(name))).find(l => /^https:\/\/[^\s"'<>]+$/i.test(l) && !notPost(l)) || '';
  if (!pic) return null;
  const video = /video/i.test(meta('og:type')) || !!(meta('og:video:secure_url') || meta('og:video:url') || meta('og:video')) ||
    /^player$/i.test(meta('twitter:card')) || videoLink_(url);
  return { url: pic, label: video ? 'The video\'s thumbnail' : 'Image from the post\'s page', video };
}

/** A page's HTML as the user agent `agent` gets it (public, no sign-in; PAGE_PIC_MAX_CHARS_ at most), or '' on any error. */
function fetchPageAs_(url, agent) {
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': agent, Accept: 'text/html,application/xhtml+xml' } });
    return r.getResponseCode() === 200 ? String(r.getContentText() || '').slice(0, PAGE_PIC_MAX_CHARS_) : '';
  } catch (e) {
    return '';
  }
}

/**
 * True for a link to a video's own page: YouTube's (Media.gs youtubeUrl_), a TikTok video, an Instagram reel, a
 * Facebook video or reel, Rumble, BitChute… (VIDEO_LINK_RX_). Pure.
 */
function videoLink_(url) {
  const u = String(url || '');
  return !!(typeof youtubeUrl_ === 'function' && youtubeUrl_(u)) || VIDEO_LINK_RX_.test(u);
}

/**
 * The picture under an alert the bot posts itself about the post at `url` (WatchAlerts.gs watch alerts, BigQuery.gs
 * Direct BigQuery cards): the post's own, as the Social Alert email picks it (screenshotFor_ on `post`, or on
 * lookupPost_(url) when `post` isn't given: its photo, its video's frame, a video's thumbnail or cover, else its
 * preview), else, unless `pageOk` is false, the picture its page shows link previews (pagePicture_); downloaded by
 * fetchScreenshot_ (a PNG, JPEG, WebP or GIF of 3 MB at most). {img: {cid, mime, name, base64, label}, video: true
 * when it's a video's, or the link is a video's (videoLink_)}, or null (none, or it couldn't be downloaded: the alert
 * goes as text). Never throws.
 */
function alertPicture_(url, post, pageOk) {
  try {
    const p = post !== undefined ? post : lookupPost_(url);
    let shot = p ? screenshotFor_({ post: p }) : null;
    let img = shot ? fetchScreenshot_(shot) : null;
    if (!img && pageOk !== false) {
      const page = pagePicture_(url);
      if (page && !(shot && shot.url === page.url)) {
        shot = page;
        img = fetchScreenshot_(page);
      }
    }
    if (!img) return null;
    const video = typeof shot.video === 'boolean' ? shot.video : /video/i.test(String(shot.label || ''));
    return { img, video: video || videoLink_(url) };
  } catch (e) {
    console.warn(`no picture for ${url}: ${(e && e.message) || e}`);
    return null;
  }
}
