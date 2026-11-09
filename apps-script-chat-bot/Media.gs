/**
 * Media.gs — lets Gemini watch, listen to, or look at the post itself, not just Burson's write-up of it. Gemini watches
 * and listens to every second of a video or audio clip (1 frame a second plus the whole soundtrack; Gemini 3.x on Vertex
 * AI takes up to ~45 minutes of video with audio).
 *
 *   gs:// Cloud Storage URI        -> passed directly as fileData (e.g. from DSD.video_candidates or inline gs://)
 *   YouTube link                   -> passed to Gemini as-is (public videos; Gemini fetches them itself)
 *   the post's own media (Post.gs) -> X and Bluesky: the post's video (the largest file Vertex AI can read from its
 *                                     link), else its photos; TikTok: the video's cover image (TikTok keeps the video
 *                                     itself from anyone not signed in); Instagram: its first image or a reel's cover,
 *                                     when Instagram's embed page shows it
 *   direct video / audio file      -> downloaded as inlineData (base64, <= 18 MB) when asked to, else passed as a
 *                                     public fileData URL so Vertex AI never fails on auth/CDN redirects
 *   any other post page            -> the page's own og:video / og:audio / og:image, when it shows one (best effort:
 *                                     Instagram and Facebook usually hide their media from anyone not signed in; the
 *                                     site's logo on their sign-in page is skipped)
 *   Burson's screenshot of the post -> when nothing else shows the post (e.g. a text-only post), Gemini looks at it;
 *                                     never one of a platform that shows a sign-in prompt (Post.gs bursonScreenshotUrl_)
 *
 * Images (photos, covers, video frames, og:image, a linked image file) always go as their bytes (inlineData), never as a
 * link: Vertex AI fetches a link itself and honours robots.txt, which blocks Google on Instagram's, Facebook's, Reddit's
 * and TikTok's image servers. The bot downloads each one (fetchImage_: PNG, JPEG, WebP, HEIC or HEIF, up to 7 MB each and
 * 15 MB for one review); one it can't download is left out, and with no picture left Gemini gets Burson's screenshot,
 * else the alert text alone.
 *
 * Size: Vertex AI reads a media link only up to 15 MB. A video or audio file bigger than that is copied to Cloud Storage
 * (settings.media_bucket, under burson-qa-bot/staging/; Apps Script can fetch up to 50 MB, about 45-60 minutes of an X
 * video at its smallest) and Gemini reads it from there; the copy is deleted right after the review (Gemini.gs).
 * Without a bucket, or past 50 MB, Gemini gets the post's photo or video frame instead.
 *
 * If Gemini can't open the video or audio (too long, private, blocked), it gets a still picture of the post (stillMedia_:
 * Burson's screenshot, a frame of the video); if nothing is found or that fails too, the review uses the alert text
 * alone, as before (Gemini.gs).
 *
 * The run's time (Gemini.gs assess): only a video or audio clip needs GEMINI_MEDIA_MIN_LEFT_MS_ of the run (reviewClipOf_
 * names it before anything is downloaded). Pictures go whatever time is left: a review with them takes no longer than
 * one without. A run too short for the clip holds the alert for the next run when it can (Bot.gs), else Gemini gets a
 * still of the post (stillMedia_) and analysts are told.
 */

const MEDIA_TYPES_ = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mov', mpeg: 'video/mpeg', mpg: 'video/mpg', avi: 'video/avi',
  wmv: 'video/wmv', flv: 'video/flv', webm: 'video/webm', mp3: 'audio/mp3', wav: 'audio/wav', m4a: 'audio/mp4',
  ogg: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp',
};
const MEDIA_PAGE_MAX_CHARS_ = 400000;
// The site's own logo, not the post's media (what Instagram's and Facebook's sign-in pages show servers as og:image)
const SITE_LOGO_RX_ = /^https:\/\/(?:static\.cdninstagram\.com\/rsrc\.php\/|static\.xx\.fbcdn\.net\/rsrc\.php\/|(?:www\.)?facebook\.com\/images\/)/i;
const MEDIA_INLINE_MAX_BYTES_ = 18 * 1024 * 1024;  // 18 MB inline base64 cap (DSD multimodal standard)
const MEDIA_LINK_MAX_BYTES_ = 14 * 1024 * 1024;    // Vertex AI reads media links up to 15 MB
const MEDIA_STAGE_MAX_BYTES_ = 48 * 1024 * 1024;   // Apps Script fetches up to 50 MB
const MEDIA_STAGING_PREFIX_ = 'burson-qa-bot/staging/';
const MEDIA_MAX_IMAGES_ = 4;
const MEDIA_IMAGE_MAX_BYTES_ = 7 * 1000 * 1000;    // Vertex AI takes an image as inlineData up to 7 MB
const MEDIA_CALL_MAX_BYTES_ = 15 * 1000 * 1000;    // all the images sent with one review, together
const MEDIA_IMAGE_TYPE_RX_ = /^image\/(?:png|jpeg|webp|heic|heif)$/;  // the image types Gemini reads
const MEDIA_IMAGE_ACCEPT_ = 'image/jpeg,image/png,image/webp,image/heic,image/heif;q=0.9,image/*;q=0.5';

/** youtube.com/watch, /shorts, /live, /embed and youtu.be links -> https://www.youtube.com/watch?v=ID (else null). */
function youtubeUrl_(url) {
  const m = String(url || '').match(
    /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/i);
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
}

/** The media type of a file link from its extension (null when it isn't a video, audio or image file). */
function mediaTypeOf_(url) {
  const ext = (String(url || '').split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  return ext ? MEDIA_TYPES_[ext.toLowerCase()] || null : null;
}

function mediaPart_(uri, mime, label, inlineBase64) {
  const part = inlineBase64
    ? { inlineData: { mimeType: mime, data: inlineBase64 } }
    : { fileData: { mimeType: mime, fileUri: uri } };
  return { kind: mime.split('/')[0], label, uri, parts: [part] };
}

/**
 * A file's part for Gemini. An image: its bytes (fetchImage_), or null when it can't be downloaded; never its link. A
 * video or audio file: inline base64 (`<= 18 MB`) when `opts.inlineFetch` is enabled or a custom `opts.fetchBinary` is
 * passed, otherwise the file's link (fileData.fileUri), as long as Vertex AI can read it from there (<= 15 MB); a bigger
 * one is copied to Cloud Storage first (stageMedia_).
 */
function maybeInlineMediaPart_(uri, mime, label, opts) {
  const o = opts || {};
  if (/^image\//.test(mime)) {
    const img = fetchImage_(uri, o, o.budget, label);
    return img ? mediaPart_(uri, img.mime, label, img.base64) : null;
  }
  if (typeof o.fetchBinary === 'function') {
    try {
      const bin = o.fetchBinary(uri);
      if (bin && bin.base64 && (!bin.bytes || bin.bytes <= MEDIA_INLINE_MAX_BYTES_)) {
        return mediaPart_(uri, bin.mimeType || mime, label, bin.base64);
      }
    } catch (e) {}
  } else if (o.inlineFetch && typeof UrlFetchApp !== 'undefined' && /^https?:\/\//i.test(uri)) {
    try {
      const r = UrlFetchApp.fetch(uri, { muteHttpExceptions: true, followRedirects: true });
      if (r.getResponseCode() === 200 && typeof r.getContent === 'function') {
        const bytes = r.getContent();
        if (bytes && bytes.length > 0 && bytes.length <= MEDIA_INLINE_MAX_BYTES_) {
          return mediaPart_(uri, mime, label, Utilities.base64Encode(bytes));
        }
      }
    } catch (e) {}
  }
  const size = mediaSize_(uri, o);
  if (size !== null && size > MEDIA_LINK_MAX_BYTES_) {
    const staged = size <= MEDIA_STAGE_MAX_BYTES_ ? stageMedia_(uri, mime, o) : '';
    if (!staged) return null;  // Vertex AI couldn't read it from its link: the review goes on without it
    return Object.assign(mediaPart_(staged, mime, label), { staged: [staged] });
  }
  return mediaPart_(uri, mime, label);
}

/**
 * An image downloaded for Gemini: {mime, base64, bytes} or null, with why in the log. Images never go to Vertex AI as a
 * link: it fetches links itself and honours robots.txt, which blocks Google on Instagram's, Facebook's, Reddit's and
 * TikTok's image servers. Checked as Post.gs fetchScreenshot_ checks Burson's screenshot (https only, a 200, an image
 * Content-Type, not empty, a size cap, POST_UA_), and for Gemini: a type it reads (PNG, JPEG, WebP, HEIC, HEIF: the
 * bytes' own type when they show one; a generic binary Content-Type passes when the bytes are such an image), at most
 * MEDIA_IMAGE_MAX_BYTES_, and within what's left of the review's MEDIA_CALL_MAX_BYTES_ (budget.left, which it takes
 * from). o.fetchBinary(url) -> {base64, bytes, mimeType} replaces the download. `what` names the image in the log.
 * Never throws.
 */
function fetchImage_(url, o, budget, what) {
  const u = String(url || '').trim();
  if (!/^https:\/\//i.test(u)) return null;
  const skip = why => {
    console.warn(`couldn't attach ${what || 'an image'} for Gemini: ${why}`);
    return null;
  };
  const mb = n => `${(n / 1e6).toFixed(1)} MB`;
  const room = budget && Number.isFinite(budget.left) ? budget.left : MEDIA_CALL_MAX_BYTES_;
  let img = null;
  try {
    if (o && typeof o.fetchBinary === 'function') {
      const bin = o.fetchBinary(u) || {};
      const b64 = String(bin.base64 || '');
      if (!b64) return skip('nothing was downloaded');
      img = { mime: imageMime_(bin.mimeType, null), base64: b64, bytes: Number(bin.bytes) || Math.floor(b64.length * 3 / 4) };
    } else if (typeof UrlFetchApp !== 'undefined') {
      const r = UrlFetchApp.fetch(u, {
        muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': POST_UA_, Accept: MEDIA_IMAGE_ACCEPT_ } });
      const code = r.getResponseCode();
      if (code !== 200 || typeof r.getContent !== 'function') return skip(`HTTP ${code}`);
      const h = (typeof r.getHeaders === 'function' && r.getHeaders()) || {};
      const type = String(h['Content-Type'] || h['content-type'] || '').split(';')[0].trim().toLowerCase();
      // Too big by its own Content-Length: never read into the script (getContent() turns a file into an array of
      // numbers many times its size, and a big one runs Apps Script out of memory, which no catch sees)
      const declared = Number(h['Content-Length'] || h['content-length']) || 0;
      if (declared > MEDIA_IMAGE_MAX_BYTES_) return skip(`too big (${mb(declared)}; Gemini takes up to ${mb(MEDIA_IMAGE_MAX_BYTES_)})`);
      const bytes = r.getContent() || [];
      if (!bytes.length) return skip('the file is empty');
      const mime = imageMime_(type, bytes);
      if (!mime) return skip(`not an image (${type || 'no Content-Type'})`);
      img = { mime, bytes: bytes.length, raw: bytes };
    } else {
      return null;
    }
  } catch (e) {
    return skip(String((e && e.message) || e));
  }
  if (!MEDIA_IMAGE_TYPE_RX_.test(img.mime)) return skip(`Gemini doesn't read ${img.mime || 'this type of image'}`);
  if (img.bytes > MEDIA_IMAGE_MAX_BYTES_) return skip(`too big (${mb(img.bytes)}; Gemini takes up to ${mb(MEDIA_IMAGE_MAX_BYTES_)})`);
  if (img.bytes > room) return skip(`over the ${mb(MEDIA_CALL_MAX_BYTES_)} of pictures one review can take`);
  if (budget) budget.left = room - img.bytes;
  if (img.raw) {
    img.base64 = Utilities.base64Encode(img.raw);
    delete img.raw;
  }
  return img;
}

/**
 * The type to send Gemini for a downloaded image: the bytes' own type when they show one (imageTypeOf_), else the
 * Content-Type's (image/jpg read as image/jpeg); '' when it isn't an image (a sign-in or error page, JSON) or a generic
 * binary type whose bytes aren't one. Pure.
 */
function imageMime_(contentType, bytes) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase()
    .replace(/^image\/(?:jpg|pjpeg)$/, 'image/jpeg').replace(/^image\/x-png$/, 'image/png');
  const sniffed = imageTypeOf_(bytes);
  if (/^image\//.test(type)) return sniffed || type;
  return !type || /^(?:application|binary)\/octet-stream$/.test(type) ? sniffed : '';
}

/** An image's type from its first bytes (PNG, JPEG, GIF, WebP, HEIC / HEIF / AVIF), or '' when they don't show one. Pure. */
function imageTypeOf_(bytes) {
  if (!bytes || bytes.length < 12) return '';
  const b = i => bytes[i] & 255;
  const ascii = (from, to) => Array.prototype.slice.call(bytes, from, to).map(x => String.fromCharCode(x & 255)).join('');
  if (b(0) === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (/^(?:heic|heix|hevc|hevx|heim|heis|hevm|hevs)$/.test(brand)) return 'image/heic';
    if (/^(?:mif1|msf1)$/.test(brand)) return 'image/heif';
    if (/^(?:avif|avis)$/.test(brand)) return 'image/avif';
  }
  return '';
}

/**
 * What Gemini can review for an alert's post: {kind: 'video'|'audio'|'image', label, uri, parts} or null, plus
 * duration_s (a post's video) and staged (Cloud Storage copies to delete after the review) when there are any.
 * Checks in priority order:
 *   1. `bq.gcs_video_uri` or `fields.gcs_media_uri` (`gs://...` from DSD.video_candidates or Cloud Storage)
 *   2. YouTube URL (`https://www.youtube.com/watch?v=...`)
 *   3. The post's own video / photos / cover image (`opts.post`, Post.gs lookupPost_)
 *   4. Direct video / audio / image URL (`.mp4`, `.mov`, `.mp3`, `.wav`, `.m4a`, `.png`, `.jpg`, etc.)
 *   5. OpenGraph / Twitter meta tags (`og:video`, `og:audio`, `og:image`, `twitter:player:stream`) on the post page
 *      (not for X or Bluesky posts that were looked up: their pages show no more than the lookup)
 *   6. Burson's screenshot of the post (`opts.screenshotUrl`), as an image
 * Images go as their bytes (fetchImage_); one that can't be downloaded is skipped for the next step.
 * `fetchPage` (optional) replaces UrlFetchApp for reading the post page; `opts` (optional) can pass
 * `{bq, post, screenshotUrl, fetchBinary, inlineFetch, sizeOf, stage, picturesOnly}`. picturesOnly: every video or
 * audio source is skipped (nothing is downloaded or copied for it) for the next picture (a run too short for a clip:
 * Gemini.gs assess).
 */
function mediaFor_(fields, fetchPage, opts) {
  const o = opts || {};
  const clip = mime => /^(?:video|audio)\//.test(String(mime || ''));
  const skip = mime => !!o.picturesOnly && clip(mime);
  const bq = o.bq || (fields && fields.bq) || null;
  const gcsUri = String((fields && fields.gcs_media_uri) || (bq && bq.gcs_video_uri) || '').trim();
  if (/^gs:\/\/[^\s]+/i.test(gcsUri)) {
    const gcsMime = (bq && bq.gcs_video_mime) || mediaTypeOf_(gcsUri) || 'video/mp4';
    if (!skip(gcsMime)) return mediaPart_(gcsUri, gcsMime, `the Cloud Storage ${gcsMime.split('/')[0]}`);
  }
  const url = String((fields && fields.post_url) || '').trim();
  if (/^gs:\/\/[^\s]+/i.test(url)) {
    const gcsMime = mediaTypeOf_(url) || 'video/mp4';
    return skip(gcsMime) ? screenshotMedia_(o) : mediaPart_(url, gcsMime, `the Cloud Storage ${gcsMime.split('/')[0]}`);
  }
  if (!/^https?:\/\//i.test(url)) return null;
  const yt = youtubeUrl_(url);
  if (yt) return o.picturesOnly ? screenshotMedia_(o) : mediaPart_(yt, 'video/mp4', 'the YouTube video');
  const post = o.post && o.post.platform !== 'YouTube' ? o.post : null;
  const fromPost = post ? postMedia_(post, o) : null;
  if (fromPost) return fromPost;
  const direct = mediaTypeOf_(url);
  if (direct && !skip(direct)) {
    const part = maybeInlineMediaPart_(url, direct, `the linked ${direct.split('/')[0]} file`, o);
    return part || (/^image\//.test(direct) ? screenshotMedia_(o) : null);  // an image it couldn't download: the screenshot
  }
  const found = post && /^(X|Bluesky)$/.test(post.platform) ? null : pageMedia_(url, fetchPage, o.picturesOnly ? ['image'] : null);
  if (found) {
    const part = maybeInlineMediaPart_(found.url, found.mime, `the post's ${found.mime.split('/')[0]}`, o);
    if (part) return part;
  }
  return screenshotMedia_(o);
}

/**
 * The post's own media (Post.gs): its video (with the soundtrack), else up to 4 photos, else its video frame or cover
 * image. Null when the post has none. Photos, frames and covers go as their bytes (fetchImage_, MEDIA_CALL_MAX_BYTES_ at
 * most together): one that can't be downloaded is left out, and the label says how many Gemini got. o.picturesOnly
 * (mediaFor_): the video is left out, nothing fetched for it.
 */
function postMedia_(post, o) {
  const parts = [];
  const staged = [];
  let video = null;
  if (post.video && post.video.url && !(o && o.picturesOnly)) video = videoPart_(post.video, o);
  if (video) {
    parts.push(video.part);
    if (video.staged) staged.push(video.staged);
  }
  const photos = (post.photos || []).filter(u => /^https:\/\//i.test(String(u))).slice(0, MEDIA_MAX_IMAGES_);
  const stills = !video && !photos.length
    ? [post.video && post.video.poster, post.thumbnail].filter(u => /^https:\/\//i.test(String(u || ''))) : [];
  const what = photos.length ? 'the post\'s photo' : post.video ? 'the post\'s video frame' : 'the video\'s cover image';
  const budget = { left: MEDIA_CALL_MAX_BYTES_ };
  const images = [];
  photos.concat(stills).forEach(u => {
    const img = fetchImage_(u, o, budget, what);
    if (img) images.push({ url: u, img });
  });
  images.forEach(x => parts.push({ inlineData: { mimeType: x.img.mime, data: x.img.base64 } }));
  if (!parts.length) return null;
  const duration = video ? post.video.duration_s : null;
  const n = images.length;
  const some = photos.length > 0 && n < photos.length;  // photos it couldn't download
  const photosText = some ? `${n} of its ${photos.length} photos` : n === 1 ? 'a photo' : `${n} photos`;
  const label = video
    ? `the post's ${post.video.gif ? 'GIF' : 'video'}${duration ? ` (${clock_(duration)} long)` : ''}${n ? ` and ${photosText}` : ''}`
    : photos.length ? (some ? `${n} of the post's ${photos.length} photos` : `the post's ${n === 1 ? 'photo' : photosText}`)
      : (post.video ? 'a frame from the post\'s video (the video itself couldn\'t be attached)' : 'the video\'s cover image');
  const out = { kind: video ? 'video' : 'image', label, uri: video ? video.uri : images[0].url, parts };
  if (duration) out.duration_s = duration;
  if (staged.length) out.staged = staged;
  return out;
}

/**
 * The best file of a post's video for Gemini: {part, uri, staged?} or null. The largest one Vertex AI can read from its
 * link (<= 15 MB, judged from its bitrate and length, else from its real size), else the smallest one copied to Cloud
 * Storage (<= 50 MB, when a bucket is set). video: {url, variants: [{url, bitrate}], duration_s, size, mime}.
 * Bitrates are ceilings (X's files run ~3x smaller), so a file whose estimate is over a limit but could be under it has
 * its real size checked (once for the link, once for the copy): a 38-minute X video is ~30 MB at its smallest. A file
 * whose real size is known already (a Bluesky video: its post record gives it) is never checked: the check asks for the
 * file's first byte, and a server that ignores that (Bluesky's getBlob) sends the whole file instead.
 */
function videoPart_(video, o) {
  const mime = String(video.mime || 'video/mp4');
  const dur = Number(video.duration_s) || 0;
  const files = (video.variants && video.variants.length ? video.variants : [{ url: video.url, bitrate: 0, size: video.size }])
    .map(v => Object.assign({}, v)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const estimate = v => v.size || (v.bitrate && dur ? Math.round(v.bitrate * dur / 8) : null);
  const link = v => ({ part: { fileData: { mimeType: mime, fileUri: v.url } }, uri: v.url });
  let probes = 1;
  for (const v of files) {
    const est = estimate(v);
    if (est !== null && est <= MEDIA_LINK_MAX_BYTES_) return link(v);
    if (probes > 0 && !v.size && (est === null || est / 3 <= MEDIA_LINK_MAX_BYTES_)) {
      probes--;
      const real = mediaSize_(v.url, o);
      if (real !== null) v.size = real;
      if (real !== null && real <= MEDIA_LINK_MAX_BYTES_) return link(v);
      if (real === null && est === null) return link(v);  // size unknown: let Vertex AI try the link
    }
  }
  let stageProbes = 1;
  const fitsCopy = v => {
    let est = estimate(v);
    if (est !== null && est > MEDIA_STAGE_MAX_BYTES_ && !v.size && est / 3 <= MEDIA_STAGE_MAX_BYTES_ && stageProbes > 0) {
      stageProbes--;
      const real = mediaSize_(v.url, o);
      if (real !== null) est = v.size = real;
    }
    return est === null || est <= MEDIA_STAGE_MAX_BYTES_;
  };
  const small = files.slice().reverse().find(fitsCopy);
  const staged = small ? stageMedia_(small.url, mime, o) : '';
  return staged ? { part: { fileData: { mimeType: mime, fileUri: staged } }, uri: staged, staged } : null;
}

/**
 * A file's size in bytes from a 1-byte range request (UrlFetchApp has no HEAD), or null. opts.sizeOf replaces it. A
 * server that ignores the range answers 200 with the whole file (Bluesky's getBlob does), so it's only asked about a file
 * whose size isn't known any other way (videoPart_).
 */
function mediaSize_(url, o) {
  if (o && typeof o.sizeOf === 'function') {
    try { const n = o.sizeOf(url); return Number.isFinite(n) ? n : null; } catch (e) { return null; }
  }
  if (typeof UrlFetchApp === 'undefined' || !/^https:\/\//i.test(String(url || ''))) return null;
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { Range: 'bytes=0-0', 'User-Agent': POST_UA_ } });
    const h = (typeof r.getHeaders === 'function' && r.getHeaders()) || {};
    const range = String(h['Content-Range'] || h['content-range'] || '');
    const total = (range.match(/\/(\d+)\s*$/) || [])[1];
    if (r.getResponseCode() === 206 && total) return Number(total);
    const len = Number(h['Content-Length'] || h['content-length']);
    return r.getResponseCode() === 200 && len > 1 ? len : null;
  } catch (e) {
    return null;
  }
}

/**
 * Copies a video or audio file too big for a media link to Cloud Storage (settings.media_bucket) for Gemini to read:
 * its gs:// URI, or '' (no bucket, too big, or a failure). opts.stage replaces it. Deleted after the review.
 * The file goes from the download to the upload as a Blob, never as its bytes in the script: getContent() turns a file
 * into a JavaScript array of numbers many times its size, and a 17-50 MB video ran Apps Script out of memory ("Out of
 * memory error.", which no catch or finally sees: the run just ends). Its size is the one Cloud Storage reports for the
 * copy; an empty copy, one past MEDIA_STAGE_MAX_BYTES_ (what Apps Script fetches whole) or one of unknown size is
 * deleted and not used.
 */
function stageMedia_(url, mime, o) {
  if (o && typeof o.stage === 'function') {
    try { return String(o.stage(url, mime) || ''); } catch (e) { return ''; }
  }
  const S = (typeof GEN !== 'undefined' && GEN.settings) || {};
  const bucket = String(S.media_bucket || '').trim();
  if (!bucket || typeof UrlFetchApp === 'undefined') return '';
  const kind = String(mime).split('/')[0];
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': POST_UA_ } });
    if (r.getResponseCode() !== 200 || typeof r.getBlob !== 'function') return '';
    const blob = r.getBlob();
    if (typeof blob.setContentType === 'function') blob.setContentType(mime);  // Bluesky's file server sends no Content-Type
    const ext = (String(mime).split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
    const name = `${MEDIA_STAGING_PREFIX_}${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const uri = `gs://${bucket}/${name}`;
    const up = UrlFetchApp.fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media` +
      `&name=${encodeURIComponent(name)}`, {
      method: 'post', contentType: mime, payload: blob, muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    });
    if (up.getResponseCode() >= 300) {
      console.warn(`couldn't copy the post's ${kind} to Cloud Storage: ${up.getResponseCode()} ` +
        `${String(up.getContentText() || '').slice(0, 200)}`);
      return '';
    }
    let size = NaN;
    try { size = Number(JSON.parse(up.getContentText() || '{}').size); } catch (e) { size = NaN; }
    if (!(size > 0) || size > MEDIA_STAGE_MAX_BYTES_) {
      console.warn(`couldn't copy the post's ${kind} to Cloud Storage: the copy is ` +
        `${Number.isFinite(size) ? `${(size / 1048576).toFixed(1)} MB` : 'of unknown size'}, so it isn't used`);
      unstageMedia_([uri]);
      return '';
    }
    console.log(`copied the post's ${kind} (${Math.round(size / 1048576)} MB) to ${uri} for Gemini`);
    return uri;
  } catch (e) {
    console.warn(`couldn't copy the post's media to Cloud Storage: ${(e && e.message) || e}`);
    return '';
  }
}

/** Deletes the Cloud Storage copies stageMedia_ made (only the bot's own, under burson-qa-bot/staging/). Never throws. */
function unstageMedia_(uris) {
  (uris || []).forEach(uri => {
    const m = String(uri || '').match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!m || m[2].indexOf(MEDIA_STAGING_PREFIX_) !== 0 || typeof UrlFetchApp === 'undefined') return;
    try {
      UrlFetchApp.fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(m[1])}/o/${encodeURIComponent(m[2])}`,
        { method: 'delete', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
    } catch (e) {
      console.warn(`couldn't delete the Cloud Storage copy ${uri}: ${(e && e.message) || e}`);
    }
  });
}

/** Burson's screenshot of the post, as an image for Gemini (when nothing else shows the post), or null. */
function screenshotMedia_(o) {
  const url = String((o && o.screenshotUrl) || '').trim();
  if (!url || typeof fetchScreenshot_ !== 'function') return null;
  const shot = fetchScreenshot_({ url, label: 'Screenshot of the post' });
  return shot ? mediaPart_(url, shot.mime, 'a screenshot of the post (Burson\'s)', shot.base64) : null;
}

/**
 * A still picture of the post for when Gemini can't open its video or audio (too long, private, blocked), or the run is
 * too short for it (Gemini.gs assess): Burson's screenshot, else a frame of the video or its cover image (Post.gs), as
 * its bytes (fetchImage_: one that can't be downloaded is left out). Null when there's none.
 */
function stillMedia_(parsed) {
  const shot = screenshotMedia_({ screenshotUrl: bursonScreenshotUrl_(parsed) });
  if (shot) return shot;
  const post = (parsed && parsed.post) || {};
  const poster = post.video && /^https:\/\//i.test(String(post.video.poster || '')) ? post.video.poster : '';
  const thumb = /^https:\/\//i.test(String(post.thumbnail || '')) ? post.thumbnail : '';
  const stills = [[poster, 'a frame from the post\'s video'], [thumb, 'the video\'s cover image']].filter(s => s[0]);
  for (const [still, label] of stills) {
    const img = fetchImage_(still, {}, null, label);
    if (img) return mediaPart_(still, img.mime, `${label} (the video itself couldn't be reviewed)`, img.base64);
  }
  return null;
}

/**
 * The video or audio clip mediaFor_ would give a review first, named for the log and the analysts' note ("the post's
 * video (1:23 long)", "the YouTube video"), judged from what's known before anything is downloaded: a Cloud Storage
 * file, a YouTube link, the post's own video (Post.gs; not one whose known size is past what Apps Script can copy,
 * MEDIA_STAGE_MAX_BYTES_: its frame goes instead), or a linked video or audio file when the post shows no media of its
 * own. '' when there's none of those: only pictures, or nothing (a clip that a page shows only in its meta tags isn't
 * known until the page is read). Only a clip needs GEMINI_MEDIA_MIN_LEFT_MS_ of the run (Gemini.gs assess). Pure.
 */
function reviewClipOf_(parsed) {
  const p = parsed || {};
  const f = p.fields || {};
  const bq = p.bq || f.bq || null;
  const clip = mime => (String(mime || '').match(/^(video|audio)\//) || [])[1] || '';
  const gcsUri = String(f.gcs_media_uri || (bq && bq.gcs_video_uri) || '').trim();
  if (/^gs:\/\/[^\s]+/i.test(gcsUri)) {
    const kind = clip((bq && bq.gcs_video_mime) || mediaTypeOf_(gcsUri) || 'video/mp4');
    return kind ? `the Cloud Storage ${kind}` : '';
  }
  const url = String(f.post_url || '').trim();
  if (/^gs:\/\/[^\s]+/i.test(url)) {
    const kind = clip(mediaTypeOf_(url) || 'video/mp4');
    return kind ? `the Cloud Storage ${kind}` : '';
  }
  if (!/^https?:\/\//i.test(url)) return '';
  if (youtubeUrl_(url)) return 'the YouTube video';
  const post = p.post && p.post.platform !== 'YouTube' ? p.post : null;
  if (post) {
    const v = post.video;
    if (v && v.url && !(Number(v.size) > MEDIA_STAGE_MAX_BYTES_)) {
      const dur = Number(v.duration_s) || 0;
      return `the post's ${v.gif ? 'GIF' : 'video'}${dur ? ` (${clock_(dur)} long)` : ''}`;
    }
    const https = u => /^https:\/\//i.test(String(u || ''));
    if ((post.photos || []).some(https) || https(v && v.poster) || https(post.thumbnail)) return '';  // its pictures go first
  }
  const kind = clip(mediaTypeOf_(url));
  return kind ? `the linked ${kind} file` : '';
}

/**
 * The post page's own video, else audio, else image (from its og: / twitter: meta tags), or null. One small fetch.
 * `only` (optional): the kinds to look for, e.g. ['image'].
 */
function pageMedia_(url, fetchPage, only) {
  let html = '';
  try {
    html = fetchPage ? String(fetchPage(url) || '') : fetchPageHtml_(url);
  } catch (e) {
    return null;
  }
  if (!html) return null;
  html = html.slice(0, MEDIA_PAGE_MAX_CHARS_);
  const meta = name => {
    const tag = (html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i')) || [])[0] || '';
    const m = tag.match(/content=["']([^"']+)["']/i);
    return m ? m[1].replace(/&amp;/g, '&').trim() : '';
  };
  const kinds = [
    { kind: 'video', names: ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream'], type: 'og:video:type' },
    { kind: 'audio', names: ['og:audio:secure_url', 'og:audio:url', 'og:audio'], type: 'og:audio:type' },
    { kind: 'image', names: ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image'], type: 'og:image:type' },
  ].filter(k => !only || only.includes(k.kind));
  for (const k of kinds) {
    for (const name of k.names) {
      const link = meta(name);
      if (!/^https:\/\//i.test(link) || SITE_LOGO_RX_.test(link)) continue;
      const yt = youtubeUrl_(link);
      if (yt) {
        if (!only || only.includes('video')) return { url: yt, mime: 'video/mp4' };
        continue;
      }
      const declared = meta(k.type).toLowerCase();
      const mime = (declared.startsWith(k.kind + '/') && declared) || mediaTypeOf_(link) || (k.kind === 'image' ? 'image/jpeg' : '');
      if (mime && mime.startsWith(k.kind + '/')) return { url: link, mime };
    }
  }
  return null;
}

function fetchPageHtml_(url) {
  const r = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SLRR-QA-bot/1.0)', Accept: 'text/html' },
  });
  return r.getResponseCode() === 200 ? String(r.getContentText() || '') : '';
}

// ---------------------------------------------------------------------------------------------------------------
// Automated Google Text Transcript Extraction for Video & Audio Clips
//   1. Google Cloud Speech-to-Text REST API (`speech:recognize` / `speech:longrunningrecognize`)
//   2. YouTube TimedText Caption API (`https://www.youtube.com/api/timedtext`)
//   3. WebVTT / SRT subtitle track parser
//   4. Pre-extracted / BigQuery / post metadata transcripts
// Ensures the LLM always receives and analyzes the text transcript of video and audio posts, even when a clip is
// over 50 MB, longer than 1 minute, short on run time (< 90 s), or fails direct multimodal streaming.
// ---------------------------------------------------------------------------------------------------------------

const SPEECH_API_URL_ = 'https://speech.googleapis.com/v1/speech:recognize';
const SPEECH_LONG_API_URL_ = 'https://speech.googleapis.com/v1/speech:longrunningrecognize';
const SPEECH_OP_URL_ = 'https://speech.googleapis.com/v1/operations/';
const YOUTUBE_TIMEDTEXT_URL_ = 'https://www.youtube.com/api/timedtext';
const TRANSCRIPT_MAX_CHARS_ = 16000;
const SPEECH_INLINE_MAX_BYTES_ = 10 * 1000 * 1000;  // 10 MB cap for inline base64 audio to Speech-to-Text

/** Format seconds into `MM:SS` (or `H:MM:SS` when >= 1 hour) for transcript lines. Pure. */
function fmtTranscriptStamp_(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const pad = n => (n < 10 ? '0' + n : String(n));
  return h > 0 ? `${h}:${pad(m)}:${pad(rem)}` : `${pad(m)}:${pad(rem)}`;
}

/** Parse a Google Cloud Speech-to-Text duration string (`"12.500s"` or `{seconds, nanos}`) into seconds. Pure. */
function parseSpeechTimeSec_(t) {
  if (t === null || t === undefined) return 0;
  if (typeof t === 'number') return isFinite(t) ? Math.max(0, t) : 0;
  if (typeof t === 'string') {
    const m = t.trim().match(/^(\d+(?:\.\d+)?)s?$/i);
    return m ? Number(m[1]) || 0 : 0;
  }
  if (typeof t === 'object') {
    return (Number(t.seconds) || 0) + (Number(t.nanos) || 0) / 1e9;
  }
  return 0;
}

/** Map a media MIME type or URL to a Google Cloud Speech-to-Text encoding hint when known. Pure. */
function speechEncodingForMime_(mime, uri) {
  const m = String(mime || '').toLowerCase();
  const u = String(uri || '').toLowerCase();
  if (m.includes('flac') || /\.flac(?:[?#]|$)/.test(u)) return 'FLAC';
  if (m.includes('wav') || /\.wav(?:[?#]|$)/.test(u)) return 'LINEAR16';
  if (m.includes('ogg') || m.includes('opus') || /\.(?:ogg|opus)(?:[?#]|$)/.test(u)) return 'OGG_OPUS';
  if (m.includes('mp3') || m.includes('mpeg') || /\.mp3(?:[?#]|$)/.test(u)) return 'MP3';
  if (m.includes('webm') || /\.webm(?:[?#]|$)/.test(u)) return 'WEBM_OPUS';
  return 'ENCODING_UNSPECIFIED';
}

/**
 * Format a Google Cloud Speech-to-Text REST response (`{results: [{alternatives: [{transcript, words}], resultEndTime}]}`)
 * into `{text, duration_s}` with `[MM:SS]` timestamps on each segment. Pure.
 */
function formatSpeechApiResults_(body) {
  const obj = typeof body === 'string' ? (() => { try { return JSON.parse(body); } catch (e) { return null; } })() : body;
  const payload = obj && obj.response && Array.isArray(obj.response.results) ? obj.response : obj;
  const results = payload && Array.isArray(payload.results) ? payload.results : [];
  if (!results.length) return null;
  const lines = [];
  let maxSec = 0;
  for (const r of results) {
    const alt = r && Array.isArray(r.alternatives) && r.alternatives[0];
    const words = alt && Array.isArray(alt.words) ? alt.words : [];
    const text = String((alt && alt.transcript) || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const startSec = words.length ? parseSpeechTimeSec_(words[0].startTime) : maxSec;
    const endSec = words.length
      ? parseSpeechTimeSec_(words[words.length - 1].endTime)
      : parseSpeechTimeSec_(r.resultEndTime);
    if (endSec > maxSec) maxSec = endSec;
    else if (startSec > maxSec) maxSec = startSec;
    lines.push(`[${fmtTranscriptStamp_(startSec)}] ${text}`);
  }
  if (!lines.length) return null;
  return {
    text: lines.join('\n').slice(0, TRANSCRIPT_MAX_CHARS_),
    duration_s: maxSec > 0 ? Math.round(maxSec) : null,
  };
}

/**
 * Call Google Cloud Speech-to-Text REST API (`speech:recognize`, or `speech:longrunningrecognize` when `opts.longRunning`
 * is set) for a video or audio clip (`source`: `{uri, content, mime, duration_s}` or a URL/URI string).
 * Returns `{text, duration_s, source: 'google_speech_stt'}` or `null` when unavailable.
 */
function transcribeWithSpeechApi_(source, mime, opts) {
  const src = typeof source === 'string' ? { uri: source } : (source || {});
  const uri = String(src.uri || '').trim();
  let content = String(src.content || '').trim();
  const effMime = String(mime || src.mime || mediaTypeOf_(uri) || '').toLowerCase();

  // For direct audio URLs (`https://.../*.mp3` etc.) when inline download is allowed and no content was passed,
  // try reading inline bytes if the host serves them under SPEECH_INLINE_MAX_BYTES_; otherwise pass `audio: {uri}`.
  if (!content && /^https:\/\//i.test(uri) && /^audio\//.test(effMime) && (!opts || opts.allowDownload !== false)) {
    try {
      const r = UrlFetchApp.fetch(uri, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SLRR-QA-bot/1.0)' },
      });
      if (r.getResponseCode() === 200) {
        const h = r.getHeaders() || {};
        const len = Number(h['Content-Length'] || h['content-length'] || 0);
        if (!len || len <= SPEECH_INLINE_MAX_BYTES_) {
          const bytes = r.getContent();
          if (bytes && bytes.length > 0 && bytes.length <= SPEECH_INLINE_MAX_BYTES_) {
            content = Utilities.base64Encode(bytes);
          }
        }
      }
    } catch (e) {}
  }

  if (!content && !uri) return null;
  const audio = content ? { content } : { uri };
  const encoding = speechEncodingForMime_(effMime, uri);
  const config = {
    languageCode: (opts && opts.languageCode) || 'en-US',
    alternativeLanguageCodes: ['es-US', 'pt-BR', 'fr-FR', 'de-DE', 'ja-JP', 'hi-IN'],
    enableAutomaticPunctuation: true,
    enableWordTimeOffsets: true,
    model: 'latest_long',
  };
  if (encoding !== 'ENCODING_UNSPECIFIED') config.encoding = encoding;

  const billingProject = (typeof GEN !== 'undefined' && GEN.models && GEN.models.project) || 'brand-social-central-data';
  const authHeaders = {
    Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    'x-goog-user-project': billingProject,
  };
  const callSpeech = endpoint => {
    const res = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: authHeaders,
      payload: JSON.stringify({ config, audio }),
    });
    return { code: res.getResponseCode(), text: String(res.getContentText() || '') };
  };

  try {
    const useLong = Boolean(opts && opts.longRunning) || (/^gs:\/\//i.test(uri) && Number(src.duration_s) > 60 && Boolean(opts && opts.preferLongRunning));
    let resp = callSpeech(useLong ? SPEECH_LONG_API_URL_ : SPEECH_API_URL_);
    if (useLong && resp.code === 404) {
      resp = callSpeech(SPEECH_API_URL_);
    }
    if (resp.code !== 200) return null;
    let body = JSON.parse(resp.text || '{}');
    if (body && body.name && !body.done && !Array.isArray(body.results)) {
      const opUrl = `${SPEECH_OP_URL_}${encodeURIComponent(String(body.name).replace(/^operations\//, ''))}`;
      const r2 = UrlFetchApp.fetch(opUrl, {
        method: 'get',
        muteHttpExceptions: true,
        headers: authHeaders,
      });
      if (r2.getResponseCode() === 200) body = JSON.parse(r2.getContentText() || '{}');
    }
    const parsed = formatSpeechApiResults_(body);
    if (!parsed || !parsed.text) return null;
    return {
      text: parsed.text,
      duration_s: parsed.duration_s || Number(src.duration_s) || null,
      source: 'google_speech_stt',
    };
  } catch (e) {
    return null;
  }
}

/** Decode basic HTML entities in YouTube XML/VTT captions. Pure. */
function decodeCaptionEntities_(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Parse a YouTube TimedText caption response (either `fmt=json3` `{events: [...]}` or XML `<transcript><text start="..." dur="...">`)
 * into `{text, duration_s}` with `[MM:SS]` timestamps. Pure.
 */
function parseYouTubeTimedText_(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      const events = obj && Array.isArray(obj.events) ? obj.events : [];
      const lines = [];
      let maxSec = 0;
      for (const ev of events) {
        const segs = ev && Array.isArray(ev.segs) ? ev.segs : [];
        const words = segs.map(x => String((x && x.utf8) || '')).join('').replace(/\s+/g, ' ').trim();
        if (!words) continue;
        const startSec = (Number(ev.tStartMs) || 0) / 1000;
        const endSec = startSec + (Number(ev.dDurationMs) || 0) / 1000;
        if (endSec > maxSec) maxSec = endSec;
        lines.push(`[${fmtTranscriptStamp_(startSec)}] ${words}`);
      }
      if (!lines.length) return null;
      return { text: lines.join('\n').slice(0, TRANSCRIPT_MAX_CHARS_), duration_s: maxSec > 0 ? Math.round(maxSec) : null };
    } catch (e) {
      return null;
    }
  }
  const tagRx = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  const lines = [];
  let maxSec = 0;
  let m;
  while ((m = tagRx.exec(s)) !== null) {
    const attrs = m[1] || '';
    const startM = attrs.match(/\bstart=["']([\d.]+)["']/i);
    const durM = attrs.match(/\bdur=["']([\d.]+)["']/i);
    const startSec = startM ? Number(startM[1]) || 0 : 0;
    const durSec = durM ? Number(durM[1]) || 0 : 0;
    if (startSec + durSec > maxSec) maxSec = startSec + durSec;
    const words = decodeCaptionEntities_(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (words) lines.push(`[${fmtTranscriptStamp_(startSec)}] ${words}`);
  }
  if (!lines.length) return null;
  return { text: lines.join('\n').slice(0, TRANSCRIPT_MAX_CHARS_), duration_s: maxSec > 0 ? Math.round(maxSec) : null };
}

/**
 * Fetch a YouTube video's text transcript via Google's TimedText caption endpoint (`https://www.youtube.com/api/timedtext`).
 * Returns `{text, duration_s, source: 'youtube_timedtext'}` or `null`.
 */
function fetchYouTubeTranscript_(url) {
  const yt = youtubeUrl_(url);
  const id = yt ? (yt.match(/[?&]v=([A-Za-z0-9_-]{11})/) || [])[1] : '';
  if (!id) return null;
  const timedUrl = `${YOUTUBE_TIMEDTEXT_URL_}?lang=en&v=${encodeURIComponent(id)}&fmt=json3`;
  try {
    const r = UrlFetchApp.fetch(timedUrl, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SLRR-QA-bot/1.0)' },
    });
    if (r.getResponseCode() === 200) {
      const parsed = parseYouTubeTimedText_(r.getContentText());
      if (parsed && parsed.text) {
        return { text: parsed.text, duration_s: parsed.duration_s, source: 'youtube_timedtext' };
      }
    }
  } catch (e) {}
  return null;
}

/** Parse a `HH:MM:SS.mmm` or `MM:SS.mmm` WebVTT/SRT timestamp into seconds. Pure. */
function parseSubtitleStampSec_(stamp) {
  const m = String(stamp || '').trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0) + (Number((m[4] || '').padEnd(3, '0')) || 0) / 1000;
}

/**
 * Parse a WebVTT (`WEBVTT`) or SRT subtitle file into `{text, duration_s}` with `[MM:SS]` timestamps. Pure.
 */
function parseWebVttOrSrt_(raw) {
  const s = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!s) return null;
  const blocks = s.split(/\n{2,}/);
  const lines = [];
  let maxSec = 0;
  for (const block of blocks) {
    const bLines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!bLines.length || /^WEBVTT\b/i.test(bLines[0])) continue;
    const timingIdx = bLines.findIndex(l => l.includes('-->'));
    if (timingIdx < 0) continue;
    const parts = bLines[timingIdx].split('-->');
    const startSec = parseSubtitleStampSec_(parts[0]);
    const endSec = parseSubtitleStampSec_((parts[1] || '').trim().split(/\s+/)[0]);
    if (startSec === null) continue;
    if (endSec !== null && endSec > maxSec) maxSec = endSec;
    else if (startSec > maxSec) maxSec = startSec;
    const text = decodeCaptionEntities_(bLines.slice(timingIdx + 1).join(' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text) lines.push(`[${fmtTranscriptStamp_(startSec)}] ${text}`);
  }
  if (!lines.length) return null;
  return { text: lines.join('\n').slice(0, TRANSCRIPT_MAX_CHARS_), duration_s: maxSec > 0 ? Math.round(maxSec) : null };
}

/**
 * Extract a text transcript for any video or audio clip on an alert (`parsed`), using:
 *   1. Pre-extracted transcript fields on `parsed.transcript`, `parsed.fields.transcript`, `parsed.post`, or `parsed.bq`
 *   2. Custom `opts.transcribe(parsed, opts)` hook when provided
 *   3. Subtitle / caption tracks (`vtt` / `srt` URL or inline text on `parsed.post.video` or `parsed.bq`)
 *   4. YouTube TimedText caption API (`fetchYouTubeTranscript_`) for YouTube links
 *   5. Google Cloud Speech-to-Text REST API (`transcribeWithSpeechApi_`) for video and audio clips (including clips > 50 MB,
 *      long videos > 1 min, audio files, or when run time is < 90 s and direct video download is skipped)
 *
 * Returns `{text, label, kind: 'video' | 'audio', source, duration_s}` or `null` when no clip or transcript is available.
 */
function extractMediaTranscript_(parsed, opts) {
  if (!parsed || typeof parsed !== 'object') return null;
  const f = parsed.fields || {};
  const bq = parsed.bq || {};
  const post = parsed.post || {};
  const video = post.video || null;
  const audio = post.audio || null;
  const attached = opts && opts.media && typeof opts.media === 'object' ? opts.media : null;

  const clipLabel = reviewClipOf_(parsed) ||
    (attached && /^(?:video|audio)$/.test(String(attached.kind || '')) ? attached.label : '') ||
    (video && !video.gif ? `the post's video${videoDurationText_(video.duration_s)}` : '') ||
    (audio ? "the post's audio" : '');
  const isAudio = /audio/i.test(clipLabel) || Boolean(audio) ||
    Boolean(attached && attached.kind === 'audio') ||
    /^audio\//i.test(String(bq.gcs_video_mime || bq.gcs_audio_mime || '')) ||
    /^audio\//.test(mediaTypeOf_(f.post_url || ''));
  const kind = isAudio ? 'audio' : 'video';
  const durationHint = Number(video && video.duration_s) || Number(audio && audio.duration_s) || Number(bq.video_duration_s) || null;

  // 1. Pre-populated transcript on parsed / fields / post / bq
  const pre = (parsed.transcript && typeof parsed.transcript === 'object' && parsed.transcript.text)
    ? parsed.transcript
    : null;
  if (pre) {
    return {
      text: String(pre.text).trim().slice(0, TRANSCRIPT_MAX_CHARS_),
      label: pre.label || clipLabel || `the post's ${kind}`,
      kind: pre.kind || kind,
      source: pre.source || 'pre_extracted',
      duration_s: Number(pre.duration_s) || durationHint,
    };
  }
  const rawInline = [
    typeof parsed.transcript === 'string' ? parsed.transcript : '',
    f.transcript,
    video && video.transcript,
    audio && audio.transcript,
    post.transcript,
    bq.transcript,
    bq.video_transcript,
    bq.audio_transcript,
  ].map(x => String(x || '').trim()).find(Boolean);
  if (rawInline) {
    const vtt = /^WEBVTT\b/i.test(rawInline) || /\d{2}:\d{2}[.,]\d{3}\s*-->/.test(rawInline) ? parseWebVttOrSrt_(rawInline) : null;
    return {
      text: (vtt ? vtt.text : rawInline).slice(0, TRANSCRIPT_MAX_CHARS_),
      label: clipLabel || `the post's ${kind}`,
      kind,
      source: vtt ? 'subtitles' : 'feed_transcript',
      duration_s: (vtt && vtt.duration_s) || durationHint,
    };
  }

  if (!clipLabel) return null;

  // 2. Custom transcribe hook (e.g. injected by caller or tests)
  if (opts && typeof opts.transcribe === 'function') {
    try {
      const custom = opts.transcribe(parsed, opts);
      if (custom && (typeof custom === 'string' || custom.text)) {
        const text = String(typeof custom === 'string' ? custom : custom.text).trim();
        if (text) {
          return {
            text: text.slice(0, TRANSCRIPT_MAX_CHARS_),
            label: (custom && custom.label) || clipLabel,
            kind: (custom && custom.kind) || kind,
            source: (custom && custom.source) || 'custom_transcribe',
            duration_s: Number(custom && custom.duration_s) || durationHint,
          };
        }
      }
    } catch (e) {}
  }

  // 3. Subtitle / caption track URL (.vtt / .srt) on post.video or bq
  const subUrl = String(
    (video && (video.subtitles_url || video.captions_url || video.subtitle_url || video.vtt_url)) ||
    bq.subtitles_url || bq.captions_url || ''
  ).trim();
  if (/^https:\/\//i.test(subUrl)) {
    try {
      const sr = UrlFetchApp.fetch(subUrl, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SLRR-QA-bot/1.0)' },
      });
      if (sr.getResponseCode() === 200) {
        const sub = parseWebVttOrSrt_(sr.getContentText()) || parseYouTubeTimedText_(sr.getContentText());
        if (sub && sub.text) {
          return {
            text: sub.text,
            label: clipLabel,
            kind,
            source: 'subtitles',
            duration_s: sub.duration_s || durationHint,
          };
        }
      }
    } catch (e) {}
  }

  // 4. YouTube TimedText caption API
  const ytTarget = youtubeUrl_(f.post_url) || (attached && youtubeUrl_(attached.uri));
  if (ytTarget) {
    const ytTr = fetchYouTubeTranscript_(ytTarget);
    if (ytTr && ytTr.text) {
      return {
        text: ytTr.text,
        label: clipLabel,
        kind: 'video',
        source: ytTr.source,
        duration_s: ytTr.duration_s || durationHint,
      };
    }
  }

  // 5. Google Cloud Speech-to-Text API for GCS URIs, audio files, or video URLs (never downloads post.video.url into memory)
  const gcsUri = [
    attached && /^gs:\/\//i.test(String(attached.uri || '')) ? attached.uri : '',
    f.gcs_media_uri,
    bq.gcs_video_uri,
    bq.gcs_audio_uri,
    /^gs:\/\//i.test(String(f.post_url || '')) ? f.post_url : '',
  ].map(x => String(x || '').trim()).find(u => /^gs:\/\//i.test(u));

  const bestVariant = video && Array.isArray(video.variants)
    ? video.variants.filter(v => v && /^https:\/\//i.test(String(v.url || '')))
        .sort((a, b) => (Number(a.bitrate) || 0) - (Number(b.bitrate) || 0))[0]
    : null;
  const mediaUri = gcsUri ||
    String((audio && audio.url) || (video && (video.audio_url || video.url || (bestVariant && bestVariant.url))) ||
      (attached && attached.uri) || bq.audio_url || (/^https:\/\//i.test(String(f.post_url || '')) ? f.post_url : '')).trim();
  const mediaMime = (attached && attached.mime) ||
    (audio && audio.mime) ||
    (video && video.mime) ||
    bq.gcs_audio_mime || bq.gcs_video_mime ||
    mediaTypeOf_(mediaUri) ||
    (isAudio ? 'audio/mp3' : 'video/mp4');

  if (mediaUri || (video && video.audio_base64) || (audio && audio.base64)) {
    const allowDownload = Boolean(opts && opts.allowDownload !== false) &&
      /^audio\//i.test(mediaMime) &&
      !(video && (video.url === mediaUri || (video.variants || []).some(v => v && v.url === mediaUri)));
    const stt = transcribeWithSpeechApi_({
      uri: mediaUri,
      content: (audio && audio.base64) || (video && video.audio_base64) || '',
      mime: mediaMime,
      duration_s: durationHint,
    }, mediaMime, { allowDownload, longRunning: opts && opts.longRunning });
    if (stt && stt.text) {
      return {
        text: stt.text,
        label: clipLabel,
        kind,
        source: stt.source,
        duration_s: stt.duration_s || durationHint,
      };
    }
  }
  return null;
}

