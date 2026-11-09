// Fix B1 (review 2026-10-22): Gemini and media.
//   H4  images go to Gemini as their bytes (Media.gs fetchImage_), never as a link Vertex AI would fetch itself
//   H5  output cap, thinking level, MAX_TOKENS as an error, finish reason + usage logged (Gemini.gs)
//   H7  the run's time limit: no media call with less than 90 s left, no other try with less than 45 s (Gemini.gs)
//   M7  media_review counts only when the media went with that call; timestamp / story accuracy only for video or audio
//   M6  outage comms: "searched; no web sources returned" instead of "not checked" (Review.gs, Email.gs input)
//   M4  no unreachable regional tier; the BigQuery ML fallback waits on its job and cancels it when giving up
'use strict';

const POSTS = require('./posts.json');

module.exports = H => {
  const { test, eq, assert, B, NOW, F, world, review, makeGoogle, loadBot } = H;

  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0xff, 0xd9]);
  const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00', 'latin1');
  const b64 = buf => buf.toString('base64');
  const image = (bytes, type, code) => ({ code: code || 200, bytes, headers: type ? { 'Content-Type': type } : {} });
  const UA = 'Mozilla/5.0 (compatible; SLRR-QA-bot/1.0)';
  const X_URL = 'https://x.com/ICannot_Enough/status/2111814207448514693';  // F.WAYMO_KOF's link
  const SHOT = 'https://api.screenshotmachine.com?key=813bd0&url=https%3A%2F%2Fx.com%2FICannot_Enough%2Fstatus%2F2111814207448514693' +
    '&device=desktop&dimension=1024x768&format=png&delay=2000';
  const withShot = text => `${text}\n\nPlease note: screenshots are not available for Reddit, TikTok, Facebook, YouTube or Instagram.\n\n${SHOT}`;
  const PHOTO_A = 'https://pbs.twimg.com/media/GaWaymoA.jpg';
  const PHOTO_B = 'https://pbs.twimg.com/media/GaWaymoB.png';
  const photoPost = photos => ({ platform: 'X', id: '2111814207448514693', url: X_URL, author: 'ICannot_Enough',
    text: 'Waymo stuck in the middle of the road again', photos, video: null, reply_to: null, parent: null, quoted: null, thread_ids: [] });
  const reviews = w => w.vertex.calls.filter(c => c.payload.generationConfig.responseSchema.properties.checks).map(c => c.payload);
  // a call's media, readable: "inline image/jpeg <base64>" or "link video/mp4 <uri>"
  const mediaOf = payload => payload.contents[0].parts.filter(p => p.fileData || p.inlineData)
    .map(p => (p.fileData ? `link ${p.fileData.mimeType} ${p.fileData.fileUri}` : `inline ${p.inlineData.mimeType} ${p.inlineData.data}`));
  const systemOf = payload => payload.systemInstruction.parts[0].text;
  /** A fetch that answers `special` URLs itself (a response object), and everything else as the fake does. */
  const intercept = (w, special) => {
    const fetch = w.g.services.UrlFetchApp.fetch;
    w.g.services.UrlFetchApp.fetch = (url, params) => {
      const r = special[url];
      if (!r) return fetch(url, params);
      w.g.fetches.push({ url, method: 'get', headers: (params && params.headers) || {} });
      return { getResponseCode: () => r.code || 200, getHeaders: () => r.headers || {}, getContentText: () => '', getContent: () => r.content };
    };
  };
  /** Array-like bytes of length n starting with `head` (an image too big to send, without allocating it). */
  const bigBytes = (n, head) => { const a = { length: n }; Array.from(head).forEach((x, i) => { a[i] = x; }); return a; };

  // ===========================================================================================================
  // H4: images as bytes
  // ===========================================================================================================

  test('B1 H4: the post\'s photos go to Gemini as their bytes (downloaded with the bot\'s user agent), never as a link Vertex AI would fetch itself', () => {
    const w = world({ post: () => photoPost([PHOTO_A, PHOTO_B]) });
    w.g.pages.set(PHOTO_A, image(JPG, 'image/jpeg'));
    w.g.pages.set(PHOTO_B, image(PNG, 'image/png; charset=binary'));
    w.vertex.assess = () => ({ checks: [], media_review: { watched: true, what_happens: 'Two photos of a stalled Waymo' } });
    w.paste(F.WAYMO_KOF);
    w.run();
    const [call] = reviews(w);
    eq(mediaOf(call), [`inline image/jpeg ${b64(JPG)}`, `inline image/png ${b64(PNG)}`]);
    assert.match(systemOf(call), /attached above is the post's 2 photos\./);
    eq(call.generationConfig.mediaResolution, undefined);  // images keep their default resolution, as before
    const got = w.g.fetches.filter(f => f.url === PHOTO_A || f.url === PHOTO_B);
    eq(got.map(f => [f.url, f.headers['User-Agent'], /^image\/jpeg,image\/png,image\/webp/.test(f.headers.Accept)]), [[PHOTO_A, UA, true], [PHOTO_B, UA, true]]);
    assert.match(w.analystPosts()[0].text, /QA: Gemini looked at the post's 2 photos: Two photos of a stalled Waymo/);
    assert.ok(!JSON.stringify(w.vertex.calls.map(c => c.payload.contents)).includes('"fileData"'), 'no image link anywhere');
  });

  test('B1 H4: a photo that\'s blocked (403), isn\'t an image (a sign-in page), is a type Gemini can\'t read (GIF) or is too big (over 7 MB) is left out, and the label says so; the bytes\' own type wins over the Content-Type', () => {
    const PHOTO_C = 'https://pbs.twimg.com/media/GaWaymoC.gif';
    const PHOTO_D = 'https://pbs.twimg.com/media/GaWaymoD.jpg';
    const w = world({ post: () => photoPost([PHOTO_A, PHOTO_B, PHOTO_C, PHOTO_D]) });
    w.g.pages.set(PHOTO_A, image(Buffer.from('Forbidden'), 'text/plain', 403));
    w.g.pages.set(PHOTO_B, image(PNG, 'image/jpeg'));  // says JPEG, is a PNG: sent as what it is
    w.g.pages.set(PHOTO_C, image(GIF, 'image/gif'));
    intercept(w, { [PHOTO_D]: { headers: { 'Content-Type': 'image/jpeg' }, content: bigBytes(9.5e6, JPG) } });
    w.paste(F.WAYMO_KOF);
    w.run();
    const [call] = reviews(w);
    eq(mediaOf(call), [`inline image/png ${b64(PNG)}`]);
    assert.match(systemOf(call), /attached above is 1 of the post's 4 photos\./);
    const logs = w.g.logs.filter(l => /couldn't attach/.test(l));
    eq(logs, ['couldn\'t attach the post\'s photo for Gemini: HTTP 403',
      'couldn\'t attach the post\'s photo for Gemini: Gemini doesn\'t read image/gif',
      'couldn\'t attach the post\'s photo for Gemini: too big (9.5 MB; Gemini takes up to 7.0 MB)']);
    // A sign-in page instead of the photo; a generic binary type whose bytes are a PNG passes
    const v = world({ post: () => photoPost([PHOTO_A, PHOTO_B]) });
    v.g.pages.set(PHOTO_A, image(Buffer.from('<html><title>Log in</title></html>'), 'text/html; charset=utf-8'));
    v.g.pages.set(PHOTO_B, image(PNG, 'application/octet-stream'));
    v.paste(F.WAYMO_KOF);
    v.run();
    eq(mediaOf(reviews(v)[0]), [`inline image/png ${b64(PNG)}`]);
    assert.ok(v.g.logs.includes('couldn\'t attach the post\'s photo for Gemini: not an image (text/html)'), v.g.logs.join('\n'));
  });

  test('B1 H4: no photo can be downloaded: Burson\'s screenshot instead (as its bytes), else the alert text alone; never a link', () => {
    const w = world({ post: () => photoPost([PHOTO_A]) });
    w.g.pages.set(PHOTO_A, image(Buffer.from('nope'), 'text/plain', 403));
    w.g.pages.set(SHOT, image(PNG, 'image/png'));
    w.vertex.assess = () => ({ checks: [], media_review: { watched: true, what_happens: 'A tweet about a stalled Waymo' } });
    w.paste(withShot(F.WAYMO_KOF));
    w.run();
    const [call] = reviews(w);
    eq(mediaOf(call), [`inline image/png ${b64(PNG)}`]);
    assert.match(systemOf(call), /attached above is a screenshot of the post \(Burson's\)\./);
    // No screenshot either: one text-only review (no failed media call first)
    const v = world({ post: () => photoPost([PHOTO_A]) });
    v.g.pages.set(PHOTO_A, image(Buffer.from('nope'), 'text/plain', 403));
    v.paste(F.WAYMO_KOF);
    v.run();
    eq([reviews(v).length, mediaOf(reviews(v)[0]), /\nMEDIA \(/.test(systemOf(reviews(v)[0]))], [1, [], false]);
    eq(v.alertRows().length, 1);
  });

  test('B1 H4: the post page\'s og:image, a linked image file, Instagram\'s embed image and a video\'s still go as their bytes; one that can\'t be downloaded is skipped', () => {
    const REDDIT = 'https://www.reddit.com/r/GoogleMaps/comments/1abcde/street_view_dog/';  // F.MAPS's link
    const OG = 'https://share.redd.it/preview/post/1abcde.jpg';
    // og:image (Reddit's share image: robots.txt blocks Google there, so only the bytes can work)
    const w = world();
    w.g.pages.set(REDDIT, `<html><head><meta property="og:image" content="${OG}"></head></html>`);
    w.g.pages.set(OG, image(JPG, 'image/jpeg'));
    w.paste(F.MAPS);
    w.run();
    const [call] = reviews(w);
    eq(mediaOf(call), [`inline image/jpeg ${b64(JPG)}`]);
    assert.match(systemOf(call), /attached above is the post's image\./);
    // blocked: Reddit has no usable screenshot, so the text alone, and never the link
    const v = world();
    v.g.pages.set(REDDIT, `<html><head><meta property="og:image" content="${OG}"></head></html>`);
    v.g.pages.set(OG, image(Buffer.from('blocked'), 'text/plain', 403));
    v.paste(F.MAPS);
    v.run();
    eq([reviews(v).length, mediaOf(reviews(v)[0])], [1, []]);
    assert.ok(v.g.logs.includes('couldn\'t attach the post\'s image for Gemini: HTTP 403'), v.g.logs.join('\n'));
    // a linked image file (the alert's link is the picture itself); when it can't be downloaded: Burson's screenshot
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const FILE = 'https://cdn.example.com/memes/gemini.png';
    g.pages.set(FILE, image(PNG, 'image/png'));
    eq(bot.mediaFor_({ post_url: FILE }), { kind: 'image', label: 'the linked image file', uri: FILE,
      parts: [{ inlineData: { mimeType: 'image/png', data: b64(PNG) } }] });
    g.pages.set(FILE, image(Buffer.from('gone'), 'text/plain', 404));
    eq(bot.mediaFor_({ post_url: FILE }), null);
    g.pages.set(SHOT, image(PNG, 'image/png'));
    eq(bot.mediaFor_({ post_url: FILE }, null, { screenshotUrl: SHOT }).label, 'a screenshot of the post (Burson\'s)');
    // Instagram's embed image (scontent CDN: robots.txt blocks Google there too)
    const IG_IMG = 'https://scontent-iad3-1.cdninstagram.com/v/t51.2885-15/post_n.jpg?stp=dst-jpg_e35_p1080x1080&oh=00_AB&oe=6720';
    const ig = { platform: 'Instagram', id: 'DenPQ0sDPMi', url: 'https://www.instagram.com/p/DenPQ0sDPMi', author: 'andrewjpdiaz', text: 'x',
      photos: [IG_IMG], thumbnail: '', video: null, reply_to: null, parent: null, quoted: null, thread_ids: [] };
    g.pages.set(IG_IMG, image(JPG, 'image/jpeg'));
    eq(bot.mediaFor_({ post_url: ig.url }, null, { post: ig }).parts, [{ inlineData: { mimeType: 'image/jpeg', data: b64(JPG) } }]);
    g.pages.set(IG_IMG, image(Buffer.from('robots'), 'text/plain', 403));
    eq(bot.mediaFor_({ post_url: ig.url }, null, { post: ig }), null);
    // A video's still (stillMedia_): the frame, else the cover when the frame can't be downloaded
    const POSTER = 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/frame.jpg';
    const COVER = 'https://p16-sign-va.tiktokcdn.com/obj/cover.jpeg';
    g.pages.set(POSTER, image(Buffer.from('no'), 'text/plain', 403));
    g.pages.set(COVER, image(JPG, 'image/jpeg'));
    const still = bot.stillMedia_({ fields: { post_url: X_URL }, extra: {}, post: { video: { poster: POSTER }, thumbnail: COVER } });
    eq([still.kind, still.label, still.uri, still.parts], ['image', 'the video\'s cover image (the video itself couldn\'t be reviewed)', COVER,
      [{ inlineData: { mimeType: 'image/jpeg', data: b64(JPG) } }]]);
    g.pages.set(COVER, image(Buffer.from('no'), 'text/plain', 403));
    eq(bot.stillMedia_({ fields: { post_url: X_URL }, extra: {}, post: { video: { poster: POSTER }, thumbnail: COVER } }), null);
  });

  test('B1 H4: up to 7 MB an image and 15 MB for one review: an image past what\'s left is skipped, a smaller one after it still fits', () => {
    const MB = 1e6;
    const sizes = { a: 6 * MB, b: 6 * MB, c: 6 * MB, d: 1 * MB };
    const fetchBinary = url => ({ base64: 'QUJD', bytes: sizes[url.slice(-5, -4)], mimeType: 'image/jpeg' });
    const photos = ['a', 'b', 'c', 'd'].map(k => `https://pbs.twimg.com/media/${k}.jpg`);
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const m = bot.mediaFor_({ post_url: X_URL }, null, { post: photoPost(photos), fetchBinary });
    eq([m.kind, m.label, m.parts.length], ['image', '3 of the post\'s 4 photos', 3]);
    assert.ok(g.logs.includes('couldn\'t attach the post\'s photo for Gemini: over the 15.0 MB of pictures one review can take'), g.logs.join('\n'));
    eq([bot.ev('MEDIA_IMAGE_MAX_BYTES_'), bot.ev('MEDIA_CALL_MAX_BYTES_')], [7e6, 15e6]);
    // exactly 7 MB passes, one byte more doesn't
    const one = n => bot.fetchImage_('https://cdn.example.com/x.jpg', { fetchBinary: () => ({ base64: 'QUJD', bytes: n, mimeType: 'image/jpeg' }) }, null, 'x');
    eq([!!one(7e6), one(7e6 + 1)], [true, null]);
    // a video (with photos): the video still goes as its link, the photos as their bytes
    const post = B.xPostFromEmbed_(POSTS.x_original);
    const both = bot.mediaFor_({ post_url: post.url }, null, { post: Object.assign({}, post, { photos: [photos[3]] }), fetchBinary,
      sizeOf: url => (url.includes('640x360') ? 6664800 : 18399254) });
    eq([both.kind, both.label, both.parts.map(p => Object.keys(p)[0])], ['video', 'the post\'s video (3:13 long) and a photo', ['fileData', 'inlineData']]);
  });

  test('B1 H4: video paths are unchanged: a post\'s video, YouTube, gs://, og:video and a linked video file still go as links (or a Cloud Storage copy), and no picture is downloaded for them', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const post = B.xPostFromEmbed_(POSTS.x_original);
    const sizeOf = url => ({ '1280x720': 18399254, '640x360': 6664800, '480x270': 2600117 })[['1280x720', '640x360', '480x270'].find(k => url.includes(k))];
    const vid = bot.mediaFor_({ post_url: post.url }, null, { post, sizeOf });
    eq([vid.kind, vid.parts.length, Object.keys(vid.parts[0]), vid.parts[0].fileData.mimeType, vid.uri.includes('640x360')],
      ['video', 1, ['fileData'], 'video/mp4', true]);
    eq(bot.mediaFor_({ post_url: 'https://youtu.be/dQw4w9WgXcQ' }).parts, [{ fileData: { mimeType: 'video/mp4', fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }]);
    eq(bot.mediaFor_({ post_url: X_URL }, null, { bq: { gcs_video_uri: 'gs://b/v.mp4', gcs_video_mime: 'video/mp4' } }).parts,
      [{ fileData: { mimeType: 'video/mp4', fileUri: 'gs://b/v.mp4' } }]);
    const PAGE = 'https://www.example.com/news/clip';
    g.pages.set(PAGE, '<meta property="og:video:secure_url" content="https://cdn.example.com/clip.mp4">');
    eq(bot.mediaFor_({ post_url: PAGE }).parts, [{ fileData: { mimeType: 'video/mp4', fileUri: 'https://cdn.example.com/clip.mp4' } }]);
    eq(bot.mediaFor_({ post_url: 'https://cdn.example.com/talk.mp3' }).parts, [{ fileData: { mimeType: 'audio/mp3', fileUri: 'https://cdn.example.com/talk.mp3' } }]);
    const staged = bot.mediaFor_({ post_url: post.url }, null, { post: Object.assign({}, post, { video: Object.assign({}, post.video, { duration_s: 1500 }) }),
      sizeOf: () => null, stage: () => 'gs://bucket/burson-qa-bot/staging/9.mp4' });
    eq([staged.uri, staged.staged], ['gs://bucket/burson-qa-bot/staging/9.mp4', ['gs://bucket/burson-qa-bot/staging/9.mp4']]);
    // the video's frame is never downloaded while the video itself goes
    assert.ok(!g.fetches.some(f => /pbs\.twimg\.com/.test(f.url)), g.fetches.map(f => f.url).join('\n'));
  });

  // ===========================================================================================================
  // H5: output cap, thinking level, MAX_TOKENS
  // ===========================================================================================================

  test('B1 H5: every call has an output cap (24,576 tokens for reviews, 8,192 for answers and the Results summary) and, on Gemini 3+, thinking level MEDIUM; the temperature is unchanged', () => {
    const w = world();
    w.paste(F.P0_OK);
    w.run();
    const [rev] = reviews(w);
    eq([rev.generationConfig.maxOutputTokens, rev.generationConfig.thinkingConfig, rev.generationConfig.temperature],
      [24576, { thinkingLevel: 'MEDIUM' }, B.ev('GEN').models.temperature]);
    const client = w.bot.geminiClient_();
    client.answer('Is the product right?', null, [], null);
    client.answerAnalyst('Why was this escalated?', null, w.ctx(), null);
    client.synopsis({ alerts: 3 });
    const caps = w.vertex.calls.slice(1).map(c => [Object.keys(c.payload.generationConfig.responseSchema.properties)[0],
      c.payload.generationConfig.maxOutputTokens, c.payload.generationConfig.thinkingConfig.thinkingLevel]);
    eq(caps, [['answer', 8192, 'MEDIUM'], ['answer', 8192, 'MEDIUM'], ['synopsis', 8192, 'MEDIUM']]);
    w.vertex.grounding = () => null;
    client.pressCoverage({ url: X_URL });
    eq(w.vertex.calls.slice(-1)[0].payload.generationConfig.maxOutputTokens, 8192);
    // Only Gemini 3 and later text models get a thinking level (Gemini 2.5 refuses it)
    eq(['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-4-argon', 'gemini-2.5-flash', 'gemini-2.0-flash-001', 'gemini-3-pro-image-preview', '']
      .map(m => B.thinkingLevelFor_(m)), ['MEDIUM', 'MEDIUM', 'MEDIUM', '', '', '', '']);
    const old = world();
    old.bot.ev('GEN').models.triage = 'gemini-2.5-flash';
    old.paste(F.P0_OK);
    old.run();
    eq([reviews(old)[0].generationConfig.thinkingConfig, reviews(old)[0].generationConfig.maxOutputTokens], [undefined, 24576]);
    eq(B.geminiPayload_('s', 'p', { type: 'OBJECT' }, {}).generationConfig.maxOutputTokens, undefined);  // the payload builder adds only what it's given
  });

  test('B1 H5: an answer cut off at the cap (MAX_TOKENS) is a clear error in geminiGenerate_; assess() retries once at LOW thinking + temperature 0.3 keeping any photo attached without falsely blaming the photo', () => {
    const cut = { code: 200, body: { candidates: [{ content: { parts: [{ text: '{"checks": [{"id": "product_fit", "fin' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 31204, thoughtsTokenCount: 2950, candidatesTokenCount: 13434, totalTokenCount: 47588 } } };
    const w = world();
    w.vertex.fail = () => cut;
    assert.throws(() => w.bot.geminiGenerate_('s', 'p', { type: 'OBJECT' }, {}), /^Error: Gemini's answer was cut off \(MAX_TOKENS\)$/);
    eq(w.vertex.calls.length, 1);
    assert.ok(w.g.logs.includes('Gemini finish reason MAX_TOKENS \u00b7 tokens: 31,204 in, 2,950 thinking, 13,434 out, 47,588 total'), w.g.logs.join('\n'));
    // When the first review with a photo hits MAX_TOKENS and the LOW-thinking retry succeeds, the photo stays attached and no missed-photo note is posted
    const p = world({ post: () => photoPost([PHOTO_A]) });
    p.g.pages.set(PHOTO_A, image(JPG, 'image/jpeg'));
    let photoCalls = 0;
    p.vertex.fail = () => (++photoCalls === 1 ? cut : null);
    p.paste(F.WAYMO_KOF);
    p.run();
    const pRevs = reviews(p);
    eq(pRevs.length, 2);
    eq([pRevs[0].generationConfig.thinkingConfig.thinkingLevel, pRevs[1].generationConfig.thinkingConfig.thinkingLevel,
      pRevs[1].generationConfig.temperature], ['MEDIUM', 'LOW', 0.3]);
    eq([mediaOf(pRevs[0]), mediaOf(pRevs[1])], [[`inline image/jpeg ${b64(JPG)}`], [`inline image/jpeg ${b64(JPG)}`]]);
    assert.ok(!/Gemini couldn't review/.test(p.analystPosts()[0].text), p.analystPosts()[0].text);
    // A review cut off on every try: the bot says why and goes on with its rules (the alert is still handled)
    const v = world();
    v.vertex.fail = () => cut;
    v.paste(F.P0_OK);
    v.run();
    assert.ok(v.g.logs.includes('Gemini review failed: Gemini\'s answer was cut off (MAX_TOKENS)'), v.g.logs.join('\n'));
    eq([v.alertRows().length, v.analystPosts().length], [1, 1]);
    // The notes, pure: STOP says nothing; the API's long names are read too
    eq([B.geminiFinishNote_({ candidates: [{ finishReason: 'STOP' }] }), B.geminiFinishNote_({ candidates: [{ finishReason: 'FINISH_REASON_STOP' }] }),
      B.geminiFinishNote_({ candidates: [{ finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } }),
      B.geminiFinishNote_({ candidates: [{}] }), B.geminiFinishNote_({ promptFeedback: { blockReason: 'OTHER' } })],
    ['', '', 'finish reason SAFETY \u00b7 tokens: 10 in, 10 total', 'finish reason none', 'finish reason none (no answer)']);
    assert.throws(() => B.parseGeminiJson_({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'FINISH_REASON_MAX_TOKENS' }] }), /cut off \(MAX_TOKENS\)/);
    eq(B.parseGeminiJson_({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'STOP' }] }), { a: 1 });
    // A normal answer logs no finish reason
    const ok = world();
    ok.bot.geminiGenerate_('s', 'p', { type: 'OBJECT' }, {});
    assert.ok(!ok.g.logs.some(l => /finish reason/.test(l)), ok.g.logs.join('\n'));
  });

  test('English-only collection filter: excludes non-English posts by language tag or non-Latin script while keeping English posts', () => {
    eq([
      B.isNonEnglishLangTag_(''), B.isNonEnglishLangTag_('en'), B.isNonEnglishLangTag_('en-US'), B.isNonEnglishLangTag_('und'),
      B.isNonEnglishLangTag_('ko'), B.isNonEnglishLangTag_('ja'), B.isNonEnglishLangTag_('id'), B.isNonEnglishLangTag_('es'),
    ], [false, false, false, false, true, true, true, true]);
    eq([
      B.isNonEnglishPost_('Google Search AI Overviews returned wrong dates', 'en'),
      B.isNonEnglishPost_('Google Tokyo office (\u6771\u4eac\u90fd) announced a Pixel fix today', ''),
      B.isNonEnglishPost_('\uad6c\uae00 \uc81c\ubbf8\ub098\uc774 \ud504\ub85c \uacb0\uc81c \uc624\ub958 Google AI Pro', ''),
      B.isNonEnglishPost_('\u65e5\u672c\u8a9e\u306e\u30dd\u30b9\u30c8 Google Pixel 9', ''),
      B.isNonEnglishPost_('Post text in Bahasa Indonesia without non-Latin letters', 'id'),
    ], [false, false, true, true, true]);
    const parsedKo = B.parseAlert_(F.P0_OK);
    parsedKo.post = { platform: 'X', id: '1', url: X_URL, author: 'u', text: '\uad6c\uae00 \uc81c\ubbf8\ub098\uc774 \uc624\ub958 \ubc1c\uc0dd', lang: 'ko', photos: [] };
    const revKo = B.reviewAlert_(parsedKo, { llm: { checks: [], social_alert: { warranted: true, confidence: 0.95, reason: 'test' } } });
    eq([revKo.socialAlert.warranted, revKo.socialAlert.source], [false, 'rule']);
  });

  // ===========================================================================================================
  // H7: the run's time limit
  // ===========================================================================================================

  /** A world whose runs have `leftMs` of their time limit left when the review starts; each Vertex call takes `takes(payload)` ms. */
  const timed = (opts, leftMs, takes, fail) => {
    const w = world(opts);
    const base = w.ctx;
    w.ctx = () => Object.assign(base(), { deadline: w.g.clock.now + leftMs });
    w.vertex.fail = payload => {
      w.g.clock.now += takes ? takes(payload) : 0;
      return fail ? fail(payload) : null;
    };
    return w;
  };
  const hasMedia = payload => payload.contents[0].parts.some(p => p.fileData || p.inlineData);

  test('B1 H7: with less than 90 s of the run left, the post\'s photos still go (a review with them takes no longer than one without); only a video waits: nothing is fetched for it, a still goes instead, and analysts are told', () => {
    const w = timed({ post: () => photoPost([PHOTO_A]) }, 85 * 1000);
    w.g.pages.set(PHOTO_A, image(JPG, 'image/jpeg'));
    w.paste(F.WAYMO_KOF);
    w.run();
    eq([reviews(w).length, mediaOf(reviews(w)[0])], [1, [`inline image/jpeg ${b64(JPG)}`]]);
    assert.ok(!w.g.logs.some(l => /s left in this run/.test(l)), w.g.logs.join('\n'));
    assert.ok(!/QA: (The bot was short of time|Gemini couldn't review)/.test(w.analystPosts()[0].text), w.analystPosts()[0].text);
    // a video post with 85 s left (the first message of the run: never held): the video isn't linked, sized or copied;
    // its frame goes, and the forwarded alert says what Gemini didn't get
    const post = B.xPostFromEmbed_(POSTS.x_original);
    const v = timed({ post: () => post }, 85 * 1000);
    v.g.pages.set(post.video.poster, image(JPG, 'image/jpeg'));
    v.paste(F.WAYMO_KOF);
    v.run();
    eq(reviews(v).map(mediaOf), [[`inline image/jpeg ${b64(JPG)}`]]);
    assert.ok(!v.g.fetches.some(f => (post.video.variants || []).some(x => x.url === f.url) || f.url === post.video.url), 'nothing fetched for the video');
    assert.ok(v.g.logs.some(l => /^less than 90 s left in this run \(8\d s\): Gemini doesn't get the post's video( \([^)]*\))?, only a still of the post$/.test(l)), v.g.logs.join('\n'));
    assert.match(v.analystPosts()[0].text, /\nQA: The bot was short of time, so Gemini didn't review the post's video( \([^)]*\))? and had only a still of the post(\n|$)/);
    // with more time, the same alerts get their photo and their video
    const u = timed({ post: () => photoPost([PHOTO_A]) }, 180 * 1000);
    u.g.pages.set(PHOTO_A, image(JPG, 'image/jpeg'));
    u.paste(F.WAYMO_KOF);
    u.run();
    eq(mediaOf(reviews(u)[0]), [`inline image/jpeg ${b64(JPG)}`]);
    const x = timed({ post: () => post }, 180 * 1000);
    x.paste(F.WAYMO_KOF);
    x.run();
    eq(mediaOf(reviews(x)[0]).map(s => s.split(' ').slice(0, 2).join(' ')), ['link video/mp4']);
  });

  test('B1 H7: a slow media call that fails leaves no time for the still picture (under 90 s) but the text-only review is made with 45 s or more; under 45 s it isn\'t started and the alert goes on with the rules', () => {
    const post = B.xPostFromEmbed_(POSTS.x_original);
    const run = (startLeft, mediaTakes) => {
      const w = timed({ post: () => post }, startLeft * 1000, p => (hasMedia(p) ? mediaTakes * 1000 : 5000),
        p => (hasMedia(p) ? { code: 400, body: { error: { message: 'The video is too long' } } } : null));
      w.g.pages.set(post.video.poster, image(JPG, 'image/jpeg'));
      w.paste(F.WAYMO_KOF);
      w.run();
      return w;
    };
    // 150 s left, the video call takes 70 s: 80 s left, so no still (it needs 90), but the text review (needs 45) is made
    const a = run(150, 70);
    eq(reviews(a).map(p => (hasMedia(p) ? mediaOf(p)[0].split(' ').slice(0, 2).join(' ') : 'text')), ['link video/mp4', 'text']);
    assert.ok(!a.g.fetches.some(f => f.url === post.video.poster), 'the frame isn\'t even downloaded');
    // 150 s left, the video call takes 120 s: 30 s left, no further try: the review goes on with the rules alone
    const b = run(150, 120);
    eq(reviews(b).length, 1);
    assert.ok(b.g.logs.some(l => /^Gemini review failed: no time left in this run for the text-only review \(\d+ s left\)$/.test(l)), b.g.logs.join('\n'));
    eq([b.alertRows().length, b.analystPosts().length], [1, 1]);
    // plenty of time: video, then the frame, then (both refused) the text, as before
    const c = run(600, 70);
    eq(reviews(c).map(p => (hasMedia(p) ? mediaOf(p)[0].split(' ').slice(0, 2).join(' ') : 'text')), ['link video/mp4', 'inline image/jpeg', 'text']);
  });

  test('B1 H7: a retry (429 / 5xx) isn\'t started with less than 45 s left, nor the BigQuery ML fallback; a media call is never started with less than 90 s; no time limit is as before', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    let bq = 0;
    const fetch = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (url.includes('bigquery.googleapis.com/')) { bq++; throw new Error('BigQuery down'); }
      return fetch(url, params);
    };
    g.vertex.fail = () => { g.clock.now += 20 * 1000; return { code: 503, body: { error: { message: 'overloaded' } } }; };
    const schema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } };
    // 60 s left: the first try (20 s) leaves 40 s: no second try, no fallback
    assert.throws(() => bot.geminiGenerate_('s', 'p', schema, { deadline: g.clock.now + 60 * 1000 }),
      /^Error: Gemini unavailable after 1 of 3 tries, no time left in this run for another try \(40 s left\): 503 /);
    eq([g.vertex.calls.length, bq], [1, 0]);
    // 75 s left: two tries (55 s left before the second, 35 s after it), no fallback
    g.vertex.calls.length = 0;
    assert.throws(() => bot.geminiGenerate_('s', 'p', schema, { deadline: g.clock.now + 75 * 1000 }), /after 2 of 3 tries, no time left .*\(35 s left\)/);
    eq([g.vertex.calls.length, bq], [2, 0]);
    // 100 s left: three tries (100, 80, 60 s left before each), then 40 s: no BigQuery ML fallback
    g.vertex.calls.length = 0;
    assert.throws(() => bot.geminiGenerate_('s', 'p', schema, { deadline: g.clock.now + 100 * 1000 }), /after 3 of 3 tries, no time left .*\(40 s left\)/);
    eq([g.vertex.calls.length, bq], [3, 0]);
    // no time limit: 3 tries, then the BigQuery ML fallback (which fails here), as before
    g.vertex.calls.length = 0;
    assert.throws(() => bot.geminiGenerate_('s', 'p', schema, {}), /^Error: Gemini unavailable after 3 tries: 503 /);
    eq([g.vertex.calls.length, bq], [3, 1]);
    assert.ok(g.logs.includes('BigQuery ML fallback failed: BigQuery down'), g.logs.join('\n'));
    // a call with a video with 60 s left is never started; one with only a picture is, as a text-only call is
    g.vertex.calls.length = 0;
    assert.throws(() => bot.geminiGenerate_('s', 'p', schema, { parts: [{ fileData: { mimeType: 'video/mp4', fileUri: 'https://video.twimg.com/v.mp4' } }], tries: 1,
      deadline: g.clock.now + 60 * 1000 }), /^Error: Gemini not called: not enough time left in this run \(60 s\)$/);
    eq(g.vertex.calls.length, 0);
    assert.throws(() => bot.geminiGenerate_('s', 'p', schema, { parts: [{ inlineData: { mimeType: 'image/png', data: b64(PNG) } }], tries: 1,
      deadline: g.clock.now + 60 * 1000 }), /^Error: Gemini unavailable after 1 tries: 503 /);
    eq(g.vertex.calls.length, 1);
    // Burson's question near the end of the run: one try only (then the bot's fixed answer)
    g.vertex.calls.length = 0;
    assert.throws(() => bot.geminiClient_().answer('Is the product right?', null, [], null, { deadline: g.clock.now + 50 * 1000 }), /after 1 of 3 tries/);
    eq(g.vertex.calls.length, 1);
    g.vertex.calls.length = 0;
    assert.throws(() => bot.geminiClient_().answerAnalyst('Why?', null, { deadline: g.clock.now + 50 * 1000 }, null), /after 1 of 3 tries/);
    eq(g.vertex.calls.length, 1);
  });

  test('B1 H7: Bot.gs gives the review and Burson\'s answers the run\'s time limit', () => {
    const w = world();
    const seen = [];
    const client = w.bot.geminiClient_();
    w.ctx = (base => () => Object.assign(base(), { gemini: {
      assess: (parsed, o) => { seen.push(['assess', o && o.deadline]); return client.assess(parsed, o); },
      answer: (q, row, res, kb, o) => { seen.push(['answer', o && o.deadline]); return client.answer(q, row, res, kb, o); },
      answerAnalyst: client.answerAnalyst,
    } }))(w.ctx);
    const msg = w.paste(F.MISTAKES);
    w.run();
    w.reply(msg, 'Why is the product wrong?');
    w.run();
    eq(seen.map(s => [s[0], typeof s[1], s[1] > NOW]), [['assess', 'number', true], ['answer', 'number', true]]);
  });

  // ===========================================================================================================
  // M7: media_review only for media that went with the call
  // ===========================================================================================================

  test('B1 M7: Gemini\'s media_review is used only when the media went with that call; the timestamp and the story accuracy check only for the video or audio itself', () => {
    const P0 = F.P0_OK;  // no timestamp in the summary
    const llm = extra => Object.assign({ checks: [], media_review: { watched: true, duration_seconds: 245, google_timestamp: '02:15',
      what_happens: 'Search comes up at 02:15', story_accuracy: 'needs_review', corrected_summary: 'A rewritten summary from the video.',
      accuracy_note: 'The summary misses the parody' } }, extra || {});
    const stamped = r => r.fixes.concat(r.missing).some(x => x.field === 'video_timestamp');
    const summary = r => r.fixes.some(x => x.field === 'summary');
    // nothing attached (a text-only review, e.g. after the video failed): nothing from media_review
    const none = review(P0, { llm: llm() });
    eq([stamped(none), summary(none), none.media, none.notes.some(n => /^Gemini /.test(n))], [false, false, null, false]);
    // a still picture (Burson's screenshot, a frame): the note, but no timestamp and no summary rewrite
    const still = review(P0, { llm: llm({ _media: { label: 'a frame from the post\'s video (the video itself couldn\'t be reviewed)', kind: 'image' } }) });
    eq([stamped(still), summary(still)], [false, false]);
    assert.ok(still.notes.includes('Gemini looked at a frame from the post\'s video (the video itself couldn\'t be reviewed): Search comes up at 02:15'), still.notes.join('\n'));
    // the video or the audio itself: as before
    for (const kind of ['video', 'audio']) {
      const r = review(P0, { llm: llm({ _media: { label: `the post's ${kind}`, kind } }) });
      eq([kind, stamped(r), summary(r), r.fields.summary], [kind, true, true, 'A rewritten summary from the video.']);
    }
    // end to end: the video is refused, the text-only review returns a media_review anyway: none of it is applied
    const post = B.xPostFromEmbed_(POSTS.x_original);
    const w = world({ post: () => post });
    w.vertex.fail = p => (hasMedia(p) ? { code: 400, body: { error: { message: 'The video is too long' } } } : null);
    w.vertex.assess = () => llm();
    w.paste(F.P0_OK);
    w.run();
    const row = w.alertRows()[0];
    eq([(row.requested || []).some(x => x.field === 'video_timestamp' || x.field === 'summary'), /02:15|Gemini (?:watched|looked)/.test(w.analystPosts()[0].text)],
      [false, false]);
  });

  // ===========================================================================================================
  // M6: "searched; no web sources returned"
  // ===========================================================================================================

  test('B1 M6: outage comms, the web search ran but returned no sources: "searched; no web sources returned" for analysts (and on the stored email input), never "not checked"; Google\'s status stays unconfirmed and the email shows no status', () => {
    const COMMS = { applies: true, kind: 'outage', outage_confirmed: true, status_source: 'Google Workspace Status Dashboard',
      status_summary: 'Gemini app disruption', holding_statement: null, document: null };
    const searched = { queries: ['gemini app outage status'], sources: [] };
    const c = B.commsContextOf_(COMMS, null, searched);
    eq(c, { kind: 'outage', outage_confirmed: null, status_source: '', status_summary: '', holding_statement: '', document: '', dropped: '', searched: true });
    eq(B.commsStatusText_(c), 'Google\'s status: searched; no web sources returned');
    eq(B.commsLine_(c), 'outage · Google\'s status: searched; no web sources returned · no approved holding statement found in the Resources documents');
    // never searched (no tool, or the BigQuery fallback): still "not checked"; with sources: unchanged
    eq(B.commsStatusText_(B.commsContextOf_(COMMS, null, null)), 'Google\'s status not checked (no web sources)');
    eq('searched' in B.commsContextOf_(COMMS, null, { queries: ['q'], sources: [{ title: 'Status', uri: 'u' }] }), false);
    // the stored email input keeps it (analyst answers are built from it); the email itself shows no status row
    const input = B.commsEmailInput_(c);
    eq([input.searched, input.outage_confirmed, B.commsLine_(input).includes('searched; no web sources returned')], [true, null, true]);
    eq(B.commsEmailRows_(input), []);
    eq(B.commsEmailRows_(Object.assign({}, input, { holding_statement: 'We are aware of the issue and working on it now.' })).map(r => r[0]),
      ['Issue', 'Holding statement']);
    eq('searched' in B.commsEmailInput_(B.commsContextOf_(COMMS, null, null)), false);
    // end to end: the switch ON, a grounded review that searched but got no sources
    const w = world();
    w.ctx = (base => () => Object.assign(base(), { switches: Object.assign(B.switchesOff_(), { outageComms: true }) }))(w.ctx);
    w.vertex.assess = () => ({ checks: [], comms_context: COMMS });
    w.vertex.grounding = p => (p.tools ? { webSearchQueries: ['gemini app outage'], groundingChunks: [] } : null);
    w.paste(F.P0_OK);
    w.run();
    assert.ok(w.analystPosts()[0].text.includes('Comms / Status Context: outage · Google\'s status: searched; no web sources returned'), w.analystPosts()[0].text);
    assert.ok(!/not checked/.test(w.analystPosts()[0].text));
    assert.ok(w.g.logs.includes('comms / status context: outage · Google\'s status: searched; no web sources returned · no approved holding statement found in the Resources documents'), w.g.logs.join('\n'));
    // Control row 20's note says the same (never "not checked")
    eq((JSON.parse(w.g.props.get('SWITCH_NOTES') || '{}').outageComms || {}).text, '1 today · last: outage · status searched, no web sources');
  });

  // ===========================================================================================================
  // M4: the fallback tiers
  // ===========================================================================================================

  test('B1 M4: no regional tier any more (it was never reached and named a retired model); the BigQuery ML fallback waits on its job (jobs.getQueryResults) and cancels it when it gives up', () => {
    eq([B.ev('typeof VERTEX_FALLBACK_MODEL_'), B.ev('typeof VERTEX_FALLBACK_LOCATION_')], ['undefined', 'undefined']);
    const setup = polls => {
      const g = makeGoogle(NOW);
      const calls = [];
      let n = 0;
      g.services.UrlFetchApp.fetch = (url, params) => {
        const method = String((params && params.method) || 'get').toLowerCase();
        if (url.includes('aiplatform.googleapis.com/')) {
          calls.push(['vertex', url.includes('us-central1') ? 'regional' : 'global']);
          return { getResponseCode: () => 503, getContentText: () => '{"error":"overloaded"}', getHeaders: () => ({}) };
        }
        calls.push([method, url.replace('https://bigquery.googleapis.com/bigquery/v2/projects/', '')]);
        g.clock.now += 10 * 1000;  // each BigQuery call waits up to its timeoutMs
        const body = method === 'post' && /\/queries$/.test(url) ? { jobComplete: false, jobReference: { projectId: 'p1', jobId: 'job_1', location: 'US' } }
          : /\/cancel/.test(url) ? { job: {} }
            : ++n >= polls ? { jobComplete: true, schema: { fields: [{ name: 'res', type: 'STRING' }] }, rows: [{ f: [{ v: '{"answer":"From BigQuery ML"}' }] }] }
              : { jobComplete: false };
        if (method === 'post' && /\/queries$/.test(url)) calls[calls.length - 1].push(JSON.parse(params.payload).query);
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body), getHeaders: () => ({}) };
      };
      return { g, calls, bot: loadBot(g.services, g.clock) };
    };
    // done on the 3rd look: the answer, no cancel; never a regional Vertex call
    const ok = setup(3);
    eq(ok.bot.geminiClient_().answer('What is the KOF rule?', null, []), 'From BigQuery ML');
    eq(ok.calls.map(c => c.slice(0, 2)), [['vertex', 'global'], ['vertex', 'global'], ['vertex', 'global'], ['post', 'brand-social-central-data/queries'],
      ['get', 'p1/queries/job_1?location=US&timeoutMs=10000'], ['get', 'p1/queries/job_1?location=US&timeoutMs=10000'],
      ['get', 'p1/queries/job_1?location=US&timeoutMs=10000']]);
    assert.match(ok.calls[3][2], /STRUCT\(0\.1 AS temperature, 8192 AS max_output_tokens, TRUE AS flatten_json_output\)/);
    // never done: it gives up after about 75 s, cancels the job, and says so in the log; the Vertex error is the one thrown
    const slow = setup(1000);
    assert.throws(() => slow.bot.geminiClient_().answer('What is the KOF rule?', null, []), /^Error: Gemini unavailable after 3 tries: 503 /);
    const bqCalls = slow.calls.filter(c => c[0] !== 'vertex');
    eq([bqCalls[0][1], bqCalls.slice(-1)[0], bqCalls.length], ['brand-social-central-data/queries', ['post', 'p1/jobs/job_1/cancel?location=US'], 9]);
    assert.ok(slow.g.logs.includes('BigQuery ML fallback failed: BigQuery ML.GENERATE_TEXT didn\'t finish in time; its job job_1 was cancelled'), slow.g.logs.join('\n'));
    // with the run's time limit (60 s left), it waits only until 15 s before it, then cancels
    const late = setup(1000);
    assert.throws(() => late.bot.geminiGenerate_('s', 'p', { type: 'OBJECT' }, { deadline: late.g.clock.now + 60 * 1000, tries: 1 }), /after 1 tries/);
    eq([late.calls.filter(c => c[0] === 'get').length, late.calls.slice(-1)[0]], [4, ['post', 'p1/jobs/job_1/cancel?location=US']]);
  });

  // ===========================================================================================================
  // M5: TikTok from its video page when oEmbed no longer gives the caption and cover
  // ===========================================================================================================

  const TT_URL = 'https://www.tiktok.com/@moreperfectunion/video/7551106238768090399';
  const TT_OEMBED = `https://www.tiktok.com/oembed?url=${encodeURIComponent(TT_URL)}`;
  const TT_COVER = 'https://p16-common-sign.tiktokcdn-us.com/tos-useast8-p-0068-tx2/o8AALD6ARiIzDbZKNaBrAlvr4EzMArsVBijEt~tplv-tiktokx-origin.image?dr=9636&x-expires=1792818000';
  const TT_CAPTION = 'In the next fifteen years, data centers are expected to add an additional $160 billion to electric grid costs in the U.S. #corporategreed';
  // What TikTok's oEmbed returns today (2026-10-22): only its player
  const TT_OEMBED_NOW = { embed_product_id: '7551106238768090399', embed_type: 'video', height: 578, provider_name: 'TikTok',
    provider_url: 'https://www.tiktok.com', type: 'video', version: '1.0', width: 325,
    html: '<iframe height="578" width="325" src="https://www.tiktok.com/player/v1/7551106238768090399?embed_from=oembed"></iframe>' };
  // The video page, trimmed to the data it carries for its own scripts (slashes escaped as TikTok does)
  const ttPage = item => '<!DOCTYPE html><html><head><title>TikTok - Make Your Day</title></head><body><div id="app"></div>' +
    '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">' +
    JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.app-context': { language: 'en' }, 'webapp.video-detail': { itemInfo: { itemStruct: item },
      shareMeta: {}, statusCode: item.id ? 0 : 10204, statusMsg: '' } } }).replace(/\//g, '\\u002F') + '</script></body></html>';
  const TT_ITEM = { id: '7551106238768090399', desc: TT_CAPTION, createTime: '1758128951', author: { uniqueId: 'moreperfectunion', nickname: 'More Perfect Union' },
    video: { id: '7551106238768090399', duration: 178, cover: TT_COVER, originCover: `${TT_COVER}&o=1`, playAddr: 'https://v16-webapp-prime.us.tiktok.com/video/x' },
    stats: { diggCount: 88800, commentCount: 2231 } };

  test('B1 M5: TikTok\'s oEmbed gives only its player now: the caption, author and cover come from the video page\'s own data (the bot\'s user agent); a page without it is null; the old oEmbed still works without the page', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    g.pages.set(TT_OEMBED, { body: JSON.stringify(TT_OEMBED_NOW), headers: { 'Content-Type': 'application/json' } });
    g.pages.set(TT_URL, ttPage(TT_ITEM));
    eq(bot.lookupPost_(TT_URL), { platform: 'TikTok', id: '7551106238768090399', url: TT_URL, author: 'moreperfectunion', text: TT_CAPTION,
      thumbnail: TT_COVER, photos: [], video: null, reply_to: null, parent: null, quoted: null, thread_ids: [] });
    eq(g.fetches.map(f => [f.url, f.headers['User-Agent']]), [[TT_OEMBED, UA], [TT_URL, UA]]);
    bot.lookupPost_(TT_URL);
    eq(g.fetches.length, 2);  // cached
    // The page doesn't carry the post (a check page, a removed video, data that can't be read): null, as before
    eq([B.tiktokPostFromPage_('<html><body>Please wait…</body></html>', TT_URL), B.tiktokPostFromPage_(ttPage({}), TT_URL),
      B.tiktokPostFromPage_('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"__DEFAULT_SCOPE__":</script>', TT_URL),
      B.tiktokPostFromPage_(ttPage({ id: '1', desc: '', video: {} }), TT_URL), B.tiktokPostFromPage_('', TT_URL)], [null, null, null, null, null]);
    eq(B.tiktokPostFromPage_(ttPage({ id: '1', desc: 'only words', video: {} }), TT_URL).thumbnail, '');
    // TikTok's oEmbed as it was (caption and cover): the page isn't fetched
    const h = makeGoogle(NOW);
    const old = loadBot(h.services, h.clock);
    h.pages.set(TT_OEMBED, { body: JSON.stringify(POSTS.tiktok_oembed), headers: { 'Content-Type': 'application/json' } });
    eq([old.lookupPost_(TT_URL).author, h.fetches.map(f => f.url)], ['moreperfectunion', [TT_OEMBED]]);
  });

  test('B1 M5 + H4: a TikTok alert: Gemini gets the video\'s cover as its bytes and the caption in its prompt', () => {
    const text = F.MAPS.replace('https://www.reddit.com/r/GoogleMaps/comments/1abcde/street_view_dog/', TT_URL);
    const w = world({ post: true });
    w.g.pages.set(TT_OEMBED, { body: JSON.stringify(TT_OEMBED_NOW), headers: { 'Content-Type': 'application/json' } });
    w.g.pages.set(TT_URL, ttPage(TT_ITEM));
    w.g.pages.set(TT_COVER, image(JPG, 'image/jpeg'));
    w.paste(text);
    w.run();
    const [call] = reviews(w);
    eq(mediaOf(call), [`inline image/jpeg ${b64(JPG)}`]);
    const system = systemOf(call);
    assert.match(system, /attached above is the video's cover image\./);
    assert.match(system, /- TikTok post by @moreperfectunion: "In the next fifteen years, data centers are expected/);
    assert.ok(w.g.logs.some(l => /^post: /.test(l)), w.g.logs.join('\n'));
  });

  // ===========================================================================================================
  // M8: Automated Google Text Transcript Extraction for Video & Audio Clips
  // ===========================================================================================================

  test('B1 M8: Google Speech-to-Text API, YouTube TimedText captions, and WebVTT/SRT extract timestamped transcripts for both video and audio clips; the LLM reads the transcript even when a video is >1 min, >50 MB, <90 s left, or fails multimodal streaming', () => {
    // 1. Google Speech-to-Text response formatting
    const sttResp = {
      results: [
        {
          alternatives: [{
            transcript: 'Welcome back everyone today we are testing the new smartphone.',
            words: [{ word: 'Welcome', startTime: '0.500s', endTime: '1.100s' }, { word: 'smartphone.', startTime: '4.200s', endTime: '5.000s' }],
          }],
          resultEndTime: '5.000s',
        },
        {
          alternatives: [{
            transcript: 'At two minutes fifteen seconds Google Pixel camera crashes repeatedly.',
            words: [{ word: 'At', startTime: '135.000s', endTime: '135.400s' }, { word: 'repeatedly.', startTime: '142.000s', endTime: '143.000s' }],
          }],
          resultEndTime: '143.000s',
        },
      ],
    };
    const formatted = B.formatSpeechApiResults_(sttResp);
    eq(formatted, {
      text: '[00:00] Welcome back everyone today we are testing the new smartphone.\n[02:15] At two minutes fifteen seconds Google Pixel camera crashes repeatedly.',
      duration_s: 143,
    });

    // 2. YouTube TimedText JSON3 & XML parsing
    const ytJson = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Testing YouTube ' }, { utf8: 'timedtext captions' }] },
        { tStartMs: 75000, dDurationMs: 5000, segs: [{ utf8: 'Google Search AI Overview shown on screen' }] },
      ],
    });
    eq(B.parseYouTubeTimedText_(ytJson), {
      text: '[00:00] Testing YouTube timedtext captions\n[01:15] Google Search AI Overview shown on screen',
      duration_s: 80,
    });
    const ytXml = '<transcript><text start="12.0" dur="3.5">First line &amp; intro</text><text start="95.2" dur="4.8">Google Maps routing issue</text></transcript>';
    eq(B.parseYouTubeTimedText_(ytXml), {
      text: '[00:12] First line & intro\n[01:35] Google Maps routing issue',
      duration_s: 100,
    });

    // 3. WebVTT / SRT subtitle parsing
    const vtt = 'WEBVTT\n\n00:00:03.000 --> 00:00:08.000\nHello world\n\n00:02:10.500 --> 00:02:18.000\nGoogle Workspace outage discussed here';
    eq(B.parseWebVttOrSrt_(vtt), {
      text: '[00:03] Hello world\n[02:10] Google Workspace outage discussed here',
      duration_s: 138,
    });

    // 4. End-to-end video review when <90 s left in the run: Speech-to-Text extracts the transcript, Gemini receives it in
    //    EXTRACTED TEXT TRANSCRIPT, and Review.gs applies the [MM:SS] timestamp & story accuracy without asking humans to watch it themselves
    const post = B.xPostFromEmbed_(POSTS.x_original);
    const v = timed({ post: () => post }, 85 * 1000);
    v.g.pages.set(post.video.poster, image(JPG, 'image/jpeg'));
    v.g.pages.set('https://speech.googleapis.com/v1/speech:recognize', {
      code: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sttResp),
    });
    v.vertex.assess = () => ({
      checks: [],
      media_review: {
        watched: true,
        duration_seconds: 193,
        google_timestamp: '02:15',
        what_happens: 'Host tests smartphone and shows Google Pixel camera crashing at 02:15',
        transcript: 'At two minutes fifteen seconds Google Pixel camera crashes repeatedly.',
        story_accuracy: 'needs_review',
        corrected_summary: 'An X user shared a video showing the Google Pixel camera crashing at [02:15].',
        accuracy_note: 'The summary omitted the camera crash shown at 02:15',
      },
    });
    v.paste(F.P0_OK);
    v.run();
    const [vCall] = reviews(v);
    assert.match(systemOf(vCall), /EXTRACTED TEXT TRANSCRIPT \(the post's video \(3:13 long\), source: google_speech_stt, duration: 143s/);
    assert.match(systemOf(vCall), /\[02:15\] At two minutes fifteen seconds Google Pixel camera crashes repeatedly\./);
    const vMsg = v.analystPosts()[0].text;
    assert.ok(!/Check the post yourself/i.test(vMsg), vMsg);
    assert.match(vMsg, /reviewed the extracted text transcript and a still of the post instead/);
    assert.match(vMsg, /Gemini looked at a frame from the post's video \(the video itself couldn't be reviewed\) and read the extracted text transcript: Host tests smartphone/);
    const vRow = v.alertRows()[0];
    assert.ok((vRow.requested || []).some(x => x.field === 'video_timestamp'));
    assert.ok((vRow.requested || []).some(x => x.field === 'summary' && x.new === 'An X user shared a video showing the Google Pixel camera crashing at [02:15].'));

    // 5. End-to-end audio clip review via Google Speech-to-Text API when direct audio streaming fails
    const AUDIO_URL = 'https://cdn.example.com/podcast/google_episode.mp3';
    const audioAlert = F.P0_OK.replace(/https:\/\/x\.com\/[^\s\n]+/, AUDIO_URL);
    const a = world();
    a.g.pages.set(AUDIO_URL, { code: 200, bytes: Buffer.from('ID3-fake-mp3-audio-bytes'), headers: { 'Content-Type': 'audio/mp3', 'Content-Length': '24' } });
    a.g.pages.set('https://speech.googleapis.com/v1/speech:recognize', {
      code: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sttResp),
    });
    a.vertex.fail = p => (hasMedia(p) ? { code: 400, body: { error: { message: 'Audio format unsupported' } } } : null);
    a.vertex.assess = () => ({
      checks: [],
      media_review: {
        watched: true,
        duration_seconds: 143,
        google_timestamp: '02:15',
        what_happens: 'Podcast episode discusses Google Pixel camera crash at 02:15',
        story_accuracy: 'accurate',
      },
    });
    a.paste(audioAlert);
    a.run();
    const aCalls = reviews(a);
    eq(aCalls.length, 2);  // first try with audio/mp3 link fails, second try is text-only with the Speech-to-Text transcript
    assert.match(systemOf(aCalls[1]), /EXTRACTED TEXT TRANSCRIPT \(the linked audio file, source: google_speech_stt/);
    const aMsg = a.analystPosts()[0].text;
    assert.ok(!/Check the post yourself/i.test(aMsg), aMsg);
    assert.match(aMsg, /Gemini couldn't review the linked audio file directly, so it reviewed the extracted text transcript and the alert text instead/);
    assert.match(aMsg, /Gemini read the extracted text transcript of the linked audio file: Podcast episode discusses Google Pixel camera crash at 02:15/);
  });
};

