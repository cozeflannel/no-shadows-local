// Pictures under the bot's own alerts (Post.gs alertPicture_): a watch alert (WatchAlerts.gs; in a run:
// switch_watch_alerts.test.js), a Direct BigQuery card (BigQuery.gs bqPostCard_) and an Early Detection story card get
// the post's own imagery only: its photo, its video's frame or cover, else what it still shows with no media of its own
// (its preview: an X video's frame, the photo or frame of the post it quotes, an X or Bluesky link card's image, a
// TikTok photo post's image). The picture its page shows link previews (pagePicture_: og:image / twitter:image, never a
// site's logo, a banner or a profile picture) only when alertPicture_ is asked for it (pageOk true), which none of the
// bot's cards does. Gemini's media and the post in its prompt don't change; Chat refusing a picture leaves the alert as
// text, never a missed one.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, NOW, e2e, makeGoogle, loadBot, TEST_FEED, REAL } = H;
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0xff, 0xd9]);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const AVIF = Buffer.from([0, 0, 0, 28, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0]);
  const image = (bytes, type) => ({ code: 200, bytes, headers: { 'Content-Type': type } });
  const UA = 'Mozilla/5.0 (compatible; SLRR-QA-bot/1.0)';
  const embed = id => `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${B.xEmbedToken_(id)}`;
  const page = metas => `<!DOCTYPE html><html><head><title>A post</title>${metas}</head><body>…</body></html>`;
  const og = (prop, content) => `<meta property="${prop}" content="${content}">`;

  // ===========================================================================================================
  // What a post still shows with no media of its own (its preview)
  // ===========================================================================================================

  test('alert pictures: an X post with no photo or small-enough video file shows its video\'s frame, else the quoted post\'s photo or frame, else its link card\'s image (its preview, for its picture only: Gemini\'s media, clip and prompt never read it); a post with media of its own has none', () => {
    const base = { id_str: '1', text: 'Read this', user: { screen_name: 'a' } };
    const CARD = 'https://pbs.twimg.com/card_img/1/large.jpg';
    const card = { name: 'summary_large_image', binding_values: {
      thumbnail_image: { type: 'IMAGE', image_value: { url: 'https://pbs.twimg.com/card_img/1/small.jpg' } },
      photo_image_full_size_large: { type: 'IMAGE', image_value: { url: CARD } },
      title: { type: 'STRING', string_value: 'An article' } } };
    const FRAME = 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/f.jpg';
    // its own video, only as a stream or in files too big for Gemini: its frame (and still no video file for Gemini)
    const big = B.xPostFromEmbed_(Object.assign({}, base, { mediaDetails: [{ type: 'video', media_url_https: FRAME, video_info: { variants: [
      { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/1.m3u8' },
      { content_type: 'video/mp4', url: 'https://video.twimg.com/1080.mp4', bitrate: 10368000 }] } }] }));
    eq([big.video, big.photos, big.preview], [null, [], { url: FRAME, label: 'Frame from the post\'s video', video: true }]);
    // a quote of a photo post, of a video post; else its link card (a medium size first), or the quoted post's
    const quote = q => B.xPostFromEmbed_(Object.assign({}, base, { card,
      quoted_tweet: Object.assign({ id_str: '2', text: 'q', user: { screen_name: 'b' } }, q) }));
    eq(quote({ mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/Q.jpg' }] }).preview,
      { url: 'https://pbs.twimg.com/media/Q.jpg', label: 'Image from the post it quotes', video: false });
    eq(quote({ video: { poster: 'https://pbs.twimg.com/amplify_video_thumb/2/img/p.jpg' } }).preview,
      { url: 'https://pbs.twimg.com/amplify_video_thumb/2/img/p.jpg', label: 'Frame from the video in the post it quotes', video: false });
    eq(quote({}).preview, { url: CARD, label: 'Image from the link in the post', video: false });
    eq(B.xPostFromEmbed_(Object.assign({}, base, { quoted_tweet: { id_str: '2', text: 'q', user: { screen_name: 'b' }, card } })).preview.url, CARD);
    // media of its own, or nothing to show: no preview at all (the post exactly as before)
    const photo = B.xPostFromEmbed_(Object.assign({}, base, { card, mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/P.jpg' }] }));
    eq(['preview' in photo, 'preview' in B.xPostFromEmbed_(base)], [false, false]);
    // the picture of the post reads it after the post's own media, and Burson's screenshot still comes first
    eq(B.screenshotFor_({ post: big }), { url: FRAME, label: 'Frame from the post\'s video', video: true });
    eq(B.screenshotFor_({ post: photo }), { url: 'https://pbs.twimg.com/media/P.jpg', label: 'Image from the post' });
    const shot = 'https://api.screenshotmachine.com?key=1&url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1';
    eq(B.screenshotFor_({ post: quote({}), extra: { screenshot_url: shot }, fields: { social_network: 'X' } }), { url: shot, label: 'Screenshot of the post' });
    // Gemini's media, its clip and its prompt never read it: nothing is downloaded for it
    const none = () => { throw new Error('nothing should be downloaded'); };
    eq([B.mediaFor_({ post_url: 'https://x.com/a/status/1' }, null, { post: quote({}), fetchBinary: none }),
      B.reviewClipOf_({ fields: { post_url: 'https://x.com/a/status/1' }, post: quote({}) })], [null, '']);
    assert.ok(!/card_img|preview/i.test(B.postPrompt_(quote({}))), B.postPrompt_(quote({})));
  });

  test('alert pictures: a Bluesky post with no images or video of its own shows its link card\'s image, else the quoted post\'s image, video frame or link card', () => {
    const thread = e => ({ post: { uri: 'at://did:plc:abc/app.bsky.feed.post/3mabcdefgh2x', author: { handle: 'a.bsky.social' },
      record: { text: 'Look', createdAt: '2026-11-02T10:00:00Z' }, embed: e } });
    const ext = thumb => ({ $type: 'app.bsky.embed.external#view', external: { uri: 'https://example.com/a', title: 'A', description: '', thumb } });
    const quoted = embeds => ({ $type: 'app.bsky.embed.record#viewRecord', uri: 'at://did:plc:xyz/app.bsky.feed.post/3mquotedpost2',
      author: { handle: 'b.bsky.social' }, value: { text: 'q' }, embeds });
    const quote = embeds => thread({ $type: 'app.bsky.embed.record#view', record: quoted(embeds) });
    const LINK = 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc/bafkreilink@jpeg';
    const FULL = 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:xyz/bafkreiq@jpeg';
    eq(B.bskyPostFromThread_(thread(ext(LINK))).preview, { url: LINK, label: 'Image from the link in the post', video: false });
    eq(B.bskyPostFromThread_(quote([{ $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/q@jpeg',
      fullsize: FULL }] }])).preview, { url: FULL, label: 'Image from the post it quotes', video: false });
    eq(B.bskyPostFromThread_(quote([{ $type: 'app.bsky.embed.video#view', cid: 'bafv', playlist: 'https://video.bsky.app/watch/x/playlist.m3u8',
      thumbnail: 'https://video.bsky.app/watch/x/thumbnail.jpg' }])).preview,
    { url: 'https://video.bsky.app/watch/x/thumbnail.jpg', label: 'Frame from the video in the post it quotes', video: false });
    eq(B.bskyPostFromThread_(quote([ext(LINK)])).preview.label, 'Image from the link in the post it quotes');
    // a quote with media of its own (recordWithMedia): its own link card first
    const OWN = 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc/own@jpeg';
    eq(B.bskyPostFromThread_(thread({ $type: 'app.bsky.embed.recordWithMedia#view', media: ext(OWN),
      record: { record: quoted([{ $type: 'app.bsky.embed.images#view', images: [{ fullsize: FULL }] }]) } })).preview.url, OWN);
    // images of its own, a link card with no image, a quote with nothing to show, a plain post: no preview
    eq([B.bskyPostFromThread_(thread({ $type: 'app.bsky.embed.images#view', images: [{ fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/own@jpeg' }] })),
      B.bskyPostFromThread_(thread(ext(undefined))), B.bskyPostFromThread_(quote([])), B.bskyPostFromThread_(thread(undefined))].map(p => 'preview' in p),
    [false, false, false, false]);
  });

  test('alert pictures: a TikTok photo post\'s page data gives its first image (a JPEG first) when it has no cover; which posts come back is as before', () => {
    const ttPage = item => '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">' +
      JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: item } } } }).replace(/\//g, '\\u002F') + '</script>';
    const URL = 'https://www.tiktok.com/@24ghanta_nepal/photo/7703496719899659538';
    const JPG = 'https://p16-sign.tiktokcdn-us.com/obj/a~tplv-photomode-image.jpeg';
    const images = [{ imageURL: { urlList: ['https://p16-sign.tiktokcdn-us.com/obj/a~tplv-photomode-image.webp', JPG] } }];
    const post = B.tiktokPostFromPage_(ttPage({ id: '7703496719899659538', desc: 'Free AI training', author: { uniqueId: '24ghanta_nepal' },
      imagePost: { images } }), URL);
    eq([post.thumbnail, post.preview, B.screenshotFor_({ post }).url], ['', { url: JPG, label: 'Image from the post', video: false }, JPG]);
    // a cover wins (as before); no words and no cover: null, as before
    const withCover = B.tiktokPostFromPage_(ttPage({ id: '1', desc: 'x', video: { cover: 'https://p16-sign.tiktokcdn-us.com/obj/cover.jpeg' },
      imagePost: { images } }), URL);
    eq(['preview' in withCover, B.tiktokPostFromPage_(ttPage({ id: '1', desc: '', imagePost: { images } }), URL)], [false, null]);
  });

  // ===========================================================================================================
  // The picture a post's page shows link previews
  // ===========================================================================================================

  test('alert pictures: a page\'s picture for link previews: og:image (entities decoded, made https, a relative link on its own site), else twitter:image; never a logo, a banner or a profile picture; a video\'s page by og:type, og:video, a player card or its link', () => {
    const FB = 'https://www.facebook.com/meidastouch/videos/2107937259924586';
    const THUMB = 'https://scontent-iad3-1.xx.fbcdn.net/v/t15.5256-10/123_n.jpg?stp=dst-jpg&_nc_cat=1';
    eq(B.pagePictureFrom_(page(og('og:type', 'video.other') + og('og:image', THUMB.replace(/&/g, '&amp;'))), FB),
      { url: THUMB, label: 'The video\'s thumbnail', video: true });
    const NEWS = 'https://www.example-news.com/2026/11/02/story.html';
    // content before name, single quotes, twitter:image, a relative or protocol-relative link, http
    eq(B.pagePictureFrom_(page('<meta content=\'/img/story.jpg\' name=\'twitter:image\'>'), NEWS),
      { url: 'https://www.example-news.com/img/story.jpg', label: 'Image from the post\'s page', video: false });
    eq([B.pagePictureFrom_(page(og('og:image', 'http://cdn.example-news.com/a.jpg')), NEWS).url,
      B.pagePictureFrom_(page(og('og:image', '//cdn.example-news.com/b.jpg')), NEWS).url],
    ['https://cdn.example-news.com/a.jpg', 'https://cdn.example-news.com/b.jpg']);
    // never a site's logo, a banner or a profile picture: none, or the next tag
    const notPosts = ['https://share.redd.it/preview/post/1oabc12', 'https://www.redditstatic.com/icon.png',
      'https://styles.redditmedia.com/t5_2qh1i/styles/communityIcon_x.png', 'https://static.xx.fbcdn.net/rsrc.php/v4/y1/r/x.png',
      'https://www.facebook.com/images/fb_icon_325x325.png', 'https://static.cdninstagram.com/rsrc.php/v4/yR/r/x.png',
      'https://cdn.bsky.app/img/avatar/plain/did:plc:a/b@jpeg', 'https://pbs.twimg.com/profile_images/1/a_400x400.jpg',
      'https://static-assets-1.truthsocial.com/tmtg:prime-ts-assets/accounts/avatars/1/2/3/original/a.jpg',
      'https://scontent.cdninstagram.com/v/t51.2885-19/123_n.jpg', 'https://scontent.xx.fbcdn.net/v/t39.30808-1/123_n.jpg',
      'https://www.example-news.com/assets/site-logo-1200.png', 'https://static.licdn.com/aero-v1/sc/h/al2o9zrvru7aqj8e1x2rzsrca',
      'https://www.example-news.com/favicon-192.png'];
    notPosts.forEach(u => eq(B.pagePictureFrom_(page(og('og:image', u)), NEWS), null, u));
    eq(B.pagePictureFrom_(page(og('og:image', notPosts[0]) + '<meta name="twitter:image" content="https://i.redd.it/o0h58lzmax6a1.png">'),
      'https://www.reddit.com/r/science/comments/1xlz2zh/x/').url, 'https://i.redd.it/o0h58lzmax6a1.png');
    // a video's page: og:video, a player card, or a video's link (a TikTok video, an Instagram reel, a Facebook reel)
    const pic = og('og:image', 'https://cdn.example.com/p.jpg');
    eq([B.pagePictureFrom_(page(pic + og('og:video', 'https://cdn.example.com/v.mp4')), NEWS).video,
      B.pagePictureFrom_(page(pic + '<meta name="twitter:card" content="player">'), NEWS).video,
      B.pagePictureFrom_(page(pic), 'https://www.tiktok.com/@a/video/7551106238768090399').video,
      B.pagePictureFrom_(page(pic), 'https://www.instagram.com/reel/DemYWfcCMiM/').video,
      B.pagePictureFrom_(page(pic), 'https://www.facebook.com/reel/4087902134846187').video,
      B.pagePictureFrom_(page(pic), 'https://www.tiktok.com/@a/photo/7703496719899659538').video,
      B.pagePictureFrom_(page(pic), 'https://www.facebook.com/videoslover/posts/123').video,
      B.pagePictureFrom_(page(pic), NEWS).video], [true, true, true, true, true, false, false, false]);
    eq([B.pagePictureFrom_('', NEWS), B.pagePictureFrom_(page('<meta property="og:title" content="A post">'), NEWS)], [null, null]);
  });

  test('alert pictures: pagePicture_ reads a social site\'s page as a link preview reads it, another site\'s as the bot and then as a link preview; never X\'s, Bluesky\'s or YouTube\'s pages; a picture is kept for 30 minutes, none isn\'t', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const FB = 'https://www.facebook.com/reel/4087902134846187';
    const FB_THUMB = 'https://scontent.xx.fbcdn.net/v/t15.5256-10/r_n.jpg';
    const NEWS = 'https://www.example-news.com/story';
    const NEWS_IMG = 'https://www.example-news.com/i.jpg';
    g.pages.set(FB, page(og('og:image', FB_THUMB)));
    g.pages.set(NEWS, page(og('og:image', NEWS_IMG)));
    g.pages.set(`${NEWS}#as-the-bot`, page('<meta name="description" content="no picture for bots">'));
    const reads = [];
    const fetch = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      const ua = String(((params || {}).headers || {})['User-Agent'] || '');
      reads.push([url, /^facebookexternalhit\//.test(ua) ? 'link preview' : ua === UA ? 'bot' : ua]);
      return fetch(url === NEWS && ua === UA ? `${NEWS}#as-the-bot` : url, params);
    };
    eq(bot.pagePicture_(FB), { url: FB_THUMB, label: 'The video\'s thumbnail', video: true });
    eq(bot.pagePicture_(NEWS), { url: NEWS_IMG, label: 'Image from the post\'s page', video: false });
    eq(reads, [[FB, 'link preview'], [NEWS, 'bot'], [NEWS, 'link preview']]);
    // kept: not read again
    eq([bot.pagePicture_(FB).url, bot.pagePicture_(NEWS).url, reads.length], [FB_THUMB, NEWS_IMG, 3]);
    // never X's, Bluesky's or YouTube's pages
    eq(['https://x.com/a/status/1', 'https://mobile.twitter.com/a/status/1', 'https://bsky.app/profile/a.bsky.social/post/3mabcdefgh2x',
      'https://youtu.be/dQw4w9WgXcQ', 'not a link', ''].map(u => bot.pagePicture_(u)), [null, null, null, null, null, null]);
    eq(reads.length, 3);
    // a page with only a banner, or no page at all: no picture, and not kept (read again next time)
    const TEXT_POST = 'https://www.reddit.com/r/California/comments/1oabc12/the_midterms/';
    g.pages.set(TEXT_POST, page(og('og:image', 'https://share.redd.it/preview/post/1oabc12')));
    eq([bot.pagePicture_(TEXT_POST), bot.pagePicture_(TEXT_POST), bot.pagePicture_('https://www.example.org/gone')], [null, null, null]);
    eq(reads.slice(3).map(r => r[1]), ['link preview', 'link preview', 'bot', 'link preview']);
  });

  // ===========================================================================================================
  // Downloading it, and the picture for an alert
  // ===========================================================================================================

  test('alert pictures: fetchScreenshot_ asks for JPEG and PNG first and goes by the bytes\' own type: a generic binary type or image/jpg passes, AVIF or a page doesn\'t', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const at = n => `https://img.example.com/${n}`;
    g.pages.set(at('octet'), image(JPEG, 'application/octet-stream'));
    g.pages.set(at('jpg'), image(JPEG, 'image/jpg'));
    g.pages.set(at('png-said-jpeg'), image(PNG, 'image/jpeg'));
    g.pages.set(at('avif'), image(AVIF, 'image/avif'));
    g.pages.set(at('html'), { code: 200, body: '<html><body>Sign in</body></html>', headers: { 'Content-Type': 'text/html' } });
    const got = n => { const s = bot.fetchScreenshot_({ url: at(n), label: 'x' }); return s && [s.mime, s.name]; };
    eq(['octet', 'jpg', 'png-said-jpeg', 'avif', 'html'].map(got),
      [['image/jpeg', 'post.jpg'], ['image/jpeg', 'post.jpg'], ['image/png', 'post.png'], null, null]);
    eq([g.fetches[0].headers['User-Agent'], g.fetches[0].headers.Accept], [UA, 'image/jpeg,image/png,image/webp,image/gif;q=0.9,*/*;q=0.5']);
  });

  test('alert pictures: alertPicture_ takes the post\'s own picture, else its preview, and nothing else: never its page\'s picture for link previews (no page is read) unless asked for it (pageOk true); one that won\'t download: none, the alert goes as text; "video" for a video\'s picture or link; it never makes a picture', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const IG = 'https://www.instagram.com/p/DfQi552mksL/';
    const IG_IMG = 'https://scontent-iad3-2.cdninstagram.com/v/t51.29350-15/p_n.jpg';
    g.pages.set(IG, page(og('og:image', IG_IMG)));
    g.pages.set(IG_IMG, image(JPEG, 'image/jpeg'));
    // the post couldn't be looked up (Instagram didn't serve its embed page): no picture, and its page is never read
    // (as the bot's cards all call it: a watch alert, a Direct BigQuery card, a story card; and with pageOk false)
    eq([bot.alertPicture_(IG, null), bot.alertPicture_(IG, null, false), bot.alertPicture_('https://www.facebook.com/abc/posts/1', null)],
      [null, null, null]);
    eq(g.fetches.filter(f => /instagram\.com|facebook\.com/.test(f.url)).length, 0);
    // asked for it (pageOk true): its page's picture, read as a link preview
    const ig = bot.alertPicture_(IG, null, true);
    eq([ig.img.mime, ig.img.label, ig.video, /^facebookexternalhit\//.test(g.fetches.find(f => f.url === IG).headers['User-Agent'])],
      ['image/jpeg', 'Image from the post\'s page', false, true]);
    // the post's own picture first; one that won't download: none (its page isn't read), unless asked for the page's
    const FB = 'https://www.facebook.com/reel/4087902134846187';
    const FB_THUMB = 'https://scontent.xx.fbcdn.net/v/t15.5256-10/r_n.jpg';
    g.pages.set(FB, page(og('og:image', FB_THUMB)));
    g.pages.set(FB_THUMB, image(PNG, 'image/png'));
    const gone = { platform: 'Facebook', photos: ['https://scontent.xx.fbcdn.net/v/gone.jpg'] };
    eq([bot.alertPicture_(FB, gone), g.fetches.some(f => f.url === FB)], [null, false]);
    const fb = bot.alertPicture_(FB, gone, true);
    eq([fb.img.mime, fb.video], ['image/png', true]);
    // a photo of the post's own that downloads: that one, with its video flag from its link (a reel's: a video's)
    const OWN = 'https://scontent.xx.fbcdn.net/v/own.jpg';
    g.pages.set(OWN, image(JPEG, 'image/jpeg'));
    const own = bot.alertPicture_(FB, { platform: 'Facebook', photos: [OWN] });
    eq([own.img.mime, own.img.label, own.video], ['image/jpeg', 'Image from the post', true]);
    // nothing in the bot asks an image model for one: no request to make a picture anywhere
    const src = require('fs').readdirSync(require('path').join(__dirname, '..')).filter(f => /\.gs$/.test(f))
      .map(f => require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8')).join('\n');
    assert.ok(!/models\/imagen|responseModalities|generateImages?\(|sampleCount/i.test(src), 'no image generation');
    // an X post's preview (its link card): the page is never read
    const x = bot.alertPicture_('https://x.com/a/status/1', { platform: 'X', photos: [], video: null,
      preview: { url: IG_IMG, label: 'Image from the link in the post', video: false } });
    eq([x.img.label, x.video], ['Image from the link in the post', false]);
  });

  // ===========================================================================================================
  // Direct BigQuery cards
  // ===========================================================================================================

  test('Direct BigQuery cards (bqPostCard_): the post\'s picture under the card when the run has time for it (uploaded to that space only), else the card alone with nothing fetched for it; Chat refusing the card with its picture posts it as text, once; never in S-F Burson', () => {
    const t = e2e();
    t.bot.setup();
    const id = '2112000000000000001';
    const URL = `https://x.com/mapsfan/status/${id}`;
    const PHOTO = 'https://pbs.twimg.com/media/Maps1.jpg';
    t.g.pages.set(embed(id), JSON.stringify({ id_str: id, text: 'Google Maps sent us onto a closed bridge', user: { screen_name: 'mapsfan' },
      mediaDetails: [{ type: 'photo', media_url_https: PHOTO }] }));
    t.g.pages.set(PHOTO, image(JPEG, 'image/jpeg'));
    const cards = text => t.chat.botPosts(TEST_FEED).filter(m => m.text === text);
    const uploads = () => (t.chat.uploads || []).map(u => [u.space, u.filename, u.contentType]);
    t.bot.bqPostCard_(TEST_FEED, 'card 1', 'bq:BSIP:k1', URL, true);
    const c1 = cards('card 1');
    eq([c1.length, (c1[0].attachment || []).map(a => [a.contentName, a.contentType]), /^client-zmir-/.test(c1[0].clientAssignedMessageId || '')],
      [1, [['post.jpg', 'image/jpeg']], true]);
    eq(uploads(), [[TEST_FEED, 'post.jpg', 'image/jpeg']]);
    // no time for it: the card alone, nothing fetched for it
    const before = t.g.fetches.length;
    t.bot.bqPostCard_(TEST_FEED, 'card 2', 'bq:BSIP:k2', URL, false);
    eq([cards('card 2').length, cards('card 2')[0].attachment,
      t.g.fetches.slice(before).filter(f => !f.url.startsWith('https://chat.googleapis.com/')).length], [1, undefined, 0]);
    // Chat refusing the card with its picture: it goes as text, once
    t.chat.fail = (method, path, query, body) => (body && body.attachment ? { code: 400, body: { error: { code: 400, message: 'Invalid attachment' } } } : null);
    t.bot.bqPostCard_(TEST_FEED, 'card 3', 'bq:BSIP:k3', URL, true);
    t.chat.fail = null;
    eq([cards('card 3').length, cards('card 3')[0].attachment], [1, undefined]);
    assert.ok(t.g.logs.some(l => /Chat refused the card for \S+ with the post's picture, so it goes as text/.test(l)), t.g.logs.join('\n'));
    // never in S-F Burson: nothing uploaded or posted there
    t.bot.setSfBurson_({ id: REAL, name: '[S-F] Burson Automated Alerts V3', externalUserAllowed: true });
    assert.throws(() => t.bot.bqPostCard_(REAL, 'card 4', 'bq:BSIP:k4', URL, true), /Refusing/);
    eq([(t.chat.uploads || []).filter(u => u.space === REAL).length, t.chat.botPosts(REAL).length], [0, 0]);
  });

  test('Direct BigQuery cards (bqPostCard_): only the post\'s own imagery: a post the lookup shows no picture for (a Facebook video, a news story) goes as text, its page never read for the picture link previews show; the card is Burson\'s format as before (no line of the post\'s words), and reads back the same', () => {
    const t = e2e();
    t.bot.setup();
    const FB = 'https://www.facebook.com/meidastouch/videos/2107937259924586';
    const NEWS = 'https://www.example-news.com/2026/11/02/google-story.html';
    const THUMB = 'https://scontent-iad3-1.xx.fbcdn.net/v/t15.5256-10/123_n.jpg';
    const NEWS_IMG = 'https://www.example-news.com/i/stock-photo.jpg';
    t.g.pages.set(FB, page(og('og:type', 'video.other') + og('og:image', THUMB)));
    t.g.pages.set(NEWS, page(og('og:image', NEWS_IMG)));
    [THUMB, NEWS_IMG].forEach(u => t.g.pages.set(u, image(JPEG, 'image/jpeg')));
    const text = url => t.bot.formatBsipSonarAlertText_({ url, handle: 'MeidasTouch', network: 'Facebook', total: 900, followers: 4000,
      alert_names_json: '["Gemini App - Accuracy"]', summary: 'A Facebook video says Gemini told users the election was rigged.',
      issue_name: 'Gemini election claim', post_time: '2026-11-02 10:00:00' });
    [[FB, 'k1'], [NEWS, 'k2']].forEach(([url, k]) => t.bot.bqPostCard_(TEST_FEED, text(url), `bq:BSIP:${k}`, url, true));
    const cards = t.chat.botPosts(TEST_FEED).filter(m => /Gemini election claim/.test(m.text));
    eq([cards.length, cards.map(m => m.attachment), (t.chat.uploads || []).length], [2, [undefined, undefined], 0]);
    eq(t.g.fetches.filter(f => [FB, NEWS, THUMB, NEWS_IMG].indexOf(f.url) >= 0).map(f => f.url), []);
    // Burson's format exactly as built, so the review reads the same summary and fields from it
    eq(cards.map(m => m.text), [text(FB), text(NEWS)]);
    assert.ok(!/\*?Post:\*? "/.test(cards[0].text), cards[0].text);
    eq([B.parseAlert_(cards[0].text).fields.summary, B.parseAlert_(cards[0].text).fields.post_content],
      ['A Facebook video says Gemini told users the election was rigged.', undefined]);
  });
};
