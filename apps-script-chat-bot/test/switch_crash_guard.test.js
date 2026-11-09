// The crash loop of Oct 24-26 (119 runs ended by "Out of memory error." on one Bluesky video's review; every run for the
// 25 minutes after each skipped, so nothing behind that alert was reviewed for two days):
//   A  memory (Media.gs, Post.gs): a staged video goes from its download to Cloud Storage as a Blob, never as an array
//      of numbers in the script (getContent()); a video whose size is known (Bluesky's record) is never downloaded just to
//      learn its size (Bluesky's server ignores a Range request); an image or screenshot over its cap by its own
//      Content-Length is never read into the script
//   B  a message that crashes the run (Bot.gs crashGuard_): each run notes the message it's on; a note another run left
//      is a try that ended partway: counted on the Message log (3 tries, then forwarded as received, never dropped), and
//      a review that crashed gets less of the post next time (a still, then the alert text), which analysts are told
//   C  run owner (Main.gs claimRun_): a claim under 4 minutes old, found by a run that got the script lock, is a run that
//      ended: taken over at once (not 25 minutes later), and counted as a failed run (5 in a row tell analysts)
'use strict';

module.exports = H => {
  const { test, eq, assert, F, NOW, world, e2e, makeGoogle, loadBot, TEST_FEED, TRIAGED } = H;

  const SAM_ID = '2109952063492993159';  // F.P0_OK's post
  const AIO_ID = '1845000000000000001';  // F.AIO's post
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0xff, 0xd9]);
  const BUCKET = 'brand-social-central-data-slrr-automations';
  const PDS = 'https://lionsmane.us-east.host.bsky.network';
  const VIDEO_URL = `${PDS}/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Ask6jryjhuavqchpa53jlcsyu&cid=bafkreigvideo`;
  const POSTER = 'https://video.bsky.app/watch/did%3Aplc%3Ask6jryjhuavqchpa53jlcsyu/bafkreigvideo/thumbnail.jpg';
  const NOTE = `MEMO:${TRIAGED}:handling`;     // the main flow's note (Main.gs buildCtx_ memo key; no Mirror space)
  const HELD = `MEMO:${TRIAGED}:review_held`;
  const ENDED = 'Apps Script stopped it (out of memory, a time limit or an internal error)';

  /** A Bluesky post with a video of `size` bytes, as Post.gs gives it (the size from the post record, the file from the author's server). */
  const bskyVideoPost = size => ({
    platform: 'Bluesky', id: '3myl3dqinck2p', url: 'https://bsky.app/profile/nothoodlum.bsky.social/post/3myl3dqinck2p',
    author: 'nothoodlum.bsky.social', text: 'A video post', created_at: '', likes: 0, replies: 0, photos: [],
    video: { url: VIDEO_URL, cid: 'bafkreigvideo', did: 'did:plc:sk6jryjhuavqchpa53jlcsyu', poster: POSTER, duration_s: null, size, mime: 'video/mp4' },
    reply_to: null, parent: null, quoted: null, thread_ids: [],
  });
  /**
   * The video's file as Bluesky's server serves it: 200 with the whole file whatever the Range, no Content-Length, no
   * Content-Type. getContent() throws (the script would hold the file as an array of numbers: what ran it out of
   * memory); getBlob() gives the file without allocating it. Returns the request headers of each fetch.
   */
  const videoServer = (g, size) => {
    const calls = [];
    const fetch = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (url !== VIDEO_URL) return fetch(url, params);
      calls.push((params && params.headers) || {});
      g.fetches.push({ url, method: 'get', headers: (params && params.headers) || {} });
      return {
        getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => '',
        getContent: () => { throw new Error(`getContent() on a ${size / 1e6} MB video: an array of numbers in the script`); },
        getBlob: () => ({ isFakeBlob: true, bytes: { length: size }, setContentType() { return this; }, getContentType: () => 'application/octet-stream' }),
      };
    };
    return calls;
  };
  const reviews = g => g.vertex.calls.filter(c => c.payload.generationConfig.responseSchema.properties.checks).map(c => c.payload);
  const reviewOf = (g, id) => reviews(g).filter(p => JSON.stringify(p.contents).includes(id));
  const mediaOf = payload => payload.contents[0].parts.filter(p => p.fileData || p.inlineData)
    .map(p => (p.fileData ? `link ${p.fileData.mimeType} ${p.fileData.fileUri}` : `inline ${p.inlineData.mimeType} ${p.inlineData.data}`));
  const forward = (t, id) => t.chat.botPosts(TRIAGED).find(m => !m.threadReply && m.text.includes(id));
  const msgLog = (t, name) => {
    const tab = t.sheet().getSheetByName('Message log');
    const h = tab.rows[0];
    const row = tab.rows.slice(1).find(r => r[h.indexOf('message')] === name);
    return row ? Object.fromEntries(h.map((c, i) => [c, row[i]])) : null;
  };
  const claim = (id, started) => JSON.stringify({ id, started });
  /** What a run that ended partway through `name` leaves behind: its claim (a minute old) and its note. */
  const endedRun = (t, name, stage, media) => {
    t.g.props.set('RUN_OWNER', claim('ended-run', t.g.clock.now - 60e3));
    t.g.props.set(NOTE, JSON.stringify(Object.assign({ msg: name, run: 'ended-run', stage }, media ? { media } : {}, { at: t.g.clock.now - 30e3 })));
  };
  /** Earlier tries that failed, on the Message log (as markFailed records them). */
  const failedBefore = (t, name, times) => {
    const store = t.bot.makeStore_(t.bot.sheetBackend_(t.sheet()), () => t.g.clock.now, '', '');
    for (let i = 0; i < times; i++) store.markFailed(name, `a run ended partway through this message: ${ENDED}`);
  };
  /** setup(), the stand-in at example.com, and SAM's post (F.P0_OK) a Bluesky video of `size` bytes with its frame. */
  const ready = size => {
    const t = e2e();
    t.bot.setup();
    t.bot.ev('GEN').email.stand_in = 'tester@testing.test';
    const lookup = t.bot.lookupPost_;
    t.bot.lookupPost_ = url => (String(url).includes(SAM_ID) ? bskyVideoPost(size || 30e6) : lookup(url));
    t.g.pages.set(POSTER, { bytes: JPG, headers: { 'Content-Type': 'image/jpeg' } });
    return t;
  };

  // ===========================================================================================================
  // A: memory
  // ===========================================================================================================

  test('crash guard A: a Bluesky video over 15 MB (its size from the post record) is downloaded once, never to learn its size, and goes to Cloud Storage as a Blob, never as an array in the script; Gemini reads that copy, deleted right after', () => {
    const w = world({ post: () => bskyVideoPost(30e6) });
    const asked = videoServer(w.g, 30e6);
    w.vertex.assess = () => ({ checks: [], media_review: { watched: true, duration_seconds: 140, what_happens: 'A man speaks at a rally' } });
    w.paste(F.P0_OK);
    w.run();
    eq(asked.map(h => h.Range || ''), ['']);  // one download, no range request (Bluesky's server would send all of it anyway)
    const up = w.g.fetches.filter(f => f.url.startsWith(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`));
    eq(up.map(f => [f.method, f.payloadKind, f.contentType]), [['post', 'blob', 'video/mp4']]);
    const [call] = reviews(w.g);
    const uri = call.contents[0].parts[0].fileData.fileUri;
    assert.match(uri, new RegExp(`^gs://${BUCKET}/burson-qa-bot/staging/\\d+-[a-z0-9]+\\.mp4$`));
    assert.ok(w.g.logs.includes(`copied the post's video (29 MB) to ${uri} for Gemini`), w.g.logs.join('\n'));
    const name = encodeURIComponent(uri.replace(`gs://${BUCKET}/`, ''));
    eq(w.g.fetches.filter(f => f.url.startsWith('https://storage.googleapis.com/')).map(f => [f.method, f.url.includes(name)]),
      [['post', true], ['delete', true]]);
    assert.match(w.analystPosts()[0].text, /QA: Gemini watched and listened to the post's video: A man speaks at a rally/);
    // Under 15 MB its link goes to Gemini as it is: nothing downloaded at all
    const v = world({ post: () => bskyVideoPost(9e6) });
    const none = videoServer(v.g, 9e6);
    v.paste(F.P0_OK);
    v.run();
    eq([none.length, mediaOf(reviews(v.g)[0])], [0, [`link video/mp4 ${VIDEO_URL}`]]);
  });

  test('crash guard A: videoPart_ checks the size only of a file known by its bitrate, never of one whose size is known; past 50 MB, a frame instead, with nothing downloaded', () => {
    const B = loadBot();
    const sized = [];
    const staged = [];
    const o = { sizeOf: url => { sized.push(url); return null; }, stage: url => { staged.push(url); return `gs://${BUCKET}/burson-qa-bot/staging/1.mp4`; } };
    const part = B.videoPart_(bskyVideoPost(17.2e6).video, o);
    eq([sized, staged, part.uri], [[], [VIDEO_URL], `gs://${BUCKET}/burson-qa-bot/staging/1.mp4`]);
    // 60 MB: too big to copy, so no copy and no download (the post's frame goes instead: Media.gs postMedia_)
    eq([B.videoPart_(bskyVideoPost(60e6).video, o), sized.length, staged.length], [null, 0, 1]);
  });

  test('crash guard A: a Cloud Storage copy reported empty, past 48 MB or of unknown size is deleted and not used; an upload Cloud Storage refuses leaves nothing; the file is never read into the script', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const SRC = 'https://cdn.example.com/video.mp4';
    let size = 0;
    let answer = null;  // the upload's answer, when not the fake's
    const fetch = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (url === SRC) {
        return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => '',
          getContent: () => { throw new Error('read into the script'); },
          getBlob: () => ({ isFakeBlob: true, bytes: { length: size }, setContentType() { return this; } }) };
      }
      if (answer && /\/upload\/storage\/v1\//.test(url)) {
        fetch(url, params);  // logged as the fake logs it
        return { getResponseCode: () => answer.code, getContentText: () => answer.text, getHeaders: () => ({}) };
      }
      return fetch(url, params);
    };
    const storage = () => g.fetches.filter(f => f.url.startsWith('https://storage.googleapis.com/')).map(f => f.method);
    const tryOne = () => { g.fetches.length = 0; return bot.stageMedia_(SRC, 'video/mp4', {}); };
    size = 0;
    eq([tryOne(), storage()], ['', ['post', 'delete']]);
    size = 60e6;
    eq([tryOne(), storage()], ['', ['post', 'delete']]);
    size = 20e6;
    answer = { code: 200, text: '{"kind":"storage#object"}' };
    eq([tryOne(), storage()], ['', ['post', 'delete']]);
    answer = { code: 403, text: '{"error":{"message":"forbidden"}}' };
    eq([tryOne(), storage()], ['', ['post']]);
    answer = null;
    assert.match(tryOne(), new RegExp(`^gs://${BUCKET}/burson-qa-bot/staging/`));
    eq(g.logs.filter(l => /^couldn't copy the post's video/.test(l)), [
      'couldn\'t copy the post\'s video to Cloud Storage: the copy is 0.0 MB, so it isn\'t used',
      'couldn\'t copy the post\'s video to Cloud Storage: the copy is 57.2 MB, so it isn\'t used',
      'couldn\'t copy the post\'s video to Cloud Storage: the copy is of unknown size, so it isn\'t used',
      'couldn\'t copy the post\'s video to Cloud Storage: 403 {"error":{"message":"forbidden"}}']);
  });

  test('crash guard A: an image or a screenshot over its cap by its own Content-Length is skipped without being read into the script; under it, as before', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const IMG = 'https://pbs.twimg.com/media/huge.jpg';
    const SHOT = 'https://api.screenshotmachine.com?key=k&url=x';
    const reads = [];
    const fetch = g.services.UrlFetchApp.fetch;
    const served = { [IMG]: '40000000', [SHOT]: '20000000' };
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (!served[url]) return fetch(url, params);
      return { getResponseCode: () => 200, getContentText: () => '',
        getHeaders: () => ({ 'Content-Type': url === IMG ? 'image/jpeg' : 'image/png', 'Content-Length': served[url] }),
        getContent: () => { reads.push(url); return Array.from(JPG); } };
    };
    eq([bot.fetchImage_(IMG, {}, null, 'the post\'s photo'), bot.fetchScreenshot_({ url: SHOT, label: 'Screenshot of the post' }), reads], [null, null, []]);
    assert.ok(g.logs.includes('couldn\'t attach the post\'s photo for Gemini: too big (40.0 MB; Gemini takes up to 7.0 MB)'), g.logs.join('\n'));
    served[IMG] = String(JPG.length);
    eq([bot.fetchImage_(IMG, {}, null, 'the post\'s photo').mime, reads], ['image/jpeg', [IMG]]);
  });

  // ===========================================================================================================
  // B: a message that crashes the run
  // ===========================================================================================================

  test('crash guard B: while an alert is reviewed the run\'s note says so (the message, this run, the review, all its media); the note is gone once the message is done; a run outside poll() keeps no note', () => {
    const t = ready(9e6);
    const msg = t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    const seen = [];
    const assess = t.g.vertex.assess;
    t.g.vertex.assess = p => { seen.push([JSON.parse(t.g.props.get(NOTE)), t.bot.ev('runId_')]); return assess(p); };
    t.poll();
    eq(seen.map(([n, run]) => [n.msg, n.stage, n.media, !!run && n.run === run]), [[msg.name, 'review', 'full', true]]);
    eq([t.g.props.has(NOTE), t.g.props.has(HELD), !!forward(t, SAM_ID)], [false, false, true]);
    eq(t.bot.ev('runId_'), '');  // cleared at the end of poll()
    // runOnce_ from the editor or a hand-built run: no note, and Gemini gets all the media as before
    const w = world();
    let opts = null;
    const real = w.bot.geminiClient_;
    w.bot.geminiClient_ = () => Object.assign(real(), { assess(parsed, o) { opts = o; return { checks: [] }; } });
    w.paste(F.AIO);
    w.run();
    eq([w.ctx().memo.get('handling'), w.ctx().memo.get('review_held'), w.analystPosts().length], [null, null, 1]);
    eq([opts && opts.media, typeof (opts && opts.deadline)], ['full', 'number']);
  });

  test('crash guard B+C: a run ended in an alert\'s review: the next minute takes over at once, counts try 1, reviews it with a still of the post (the video isn\'t downloaded), tells analysts, and the alerts behind it are reviewed in the same run', () => {
    const t = ready(30e6);
    const msg = t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    t.chat.say(TEST_FEED, F.AIO, { sender: 'users/bot' });
    const video = videoServer(t.g, 30e6);
    endedRun(t, msg.name, 'review', 'full');
    t.poll();
    const logs = t.g.logs.join('\n');
    assert.match(logs, /^the run that started at 2026-10-14T\d\d:\d\d:\d\d\.\d{3}Z ended without finishing \(it no longer holds the script lock\): this run takes over$/m);
    assert.ok(t.g.logs.includes(`a run ended partway through ${msg.name} in its review (with the post's own media): ${ENDED}. ` +
      'Counted as try 1 of 3; its next review gets a still of the post'), logs);
    assert.ok(t.g.logs.includes(`reviewing ${msg.name} with a still of the post: its review crashed the run once before`), logs);
    // the still (the video's frame, as its bytes), never the video: it isn't downloaded or copied
    const [sam] = reviewOf(t.g, SAM_ID);
    eq([mediaOf(sam), video.length], [[`inline image/jpeg ${JPG.toString('base64')}`], 0]);
    assert.match(sam.systemInstruction.parts[0].text, /attached above is a frame from the post's video \(the video itself couldn't be reviewed\)\./);
    assert.ok(!t.g.fetches.some(f => f.url.startsWith('https://storage.googleapis.com/')));
    // analysts are told; the alert is reviewed and forwarded like any other, and the one behind it too
    assert.match(forward(t, SAM_ID).text, /\nQA: The post's own media wasn't reviewed: reviewing it crashed the bot, so Gemini had only a still of the post(\n|$)/);
    assert.ok(forward(t, AIO_ID));
    eq([msgLog(t, msg.name).kind, Number(msgLog(t, msg.name).attempts)], ['alert', 1]);
    // the notes are gone; the run that took over counted the one that ended, then its own success: no notice
    eq([t.g.props.has(NOTE), t.g.props.has(HELD), t.g.props.get('FAIL_STREAK'), t.g.props.has('RUN_OWNER')], [false, false, '0', false]);
    assert.ok(!t.chat.botPosts(TRIAGED).some(m => /has had problems/.test(m.text)));
  });

  test('crash guard B: a second crash in the review (with the still) leaves the alert text only; a third forwards it to analysts as received, never reviewed again, and the next alert is reviewed in the same run', () => {
    // Try 2 ended in the review with the still: try 3 is reviewed from the alert text alone
    const t = ready(30e6);
    const msg = t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    videoServer(t.g, 30e6);
    failedBefore(t, msg.name, 1);
    t.g.props.set(HELD, JSON.stringify({ [msg.name]: { media: 'still', crashes: 1, at: t.g.clock.now } }));
    endedRun(t, msg.name, 'review', 'still');
    t.poll();
    assert.ok(t.g.logs.includes(`a run ended partway through ${msg.name} in its review (with a still of the post): ${ENDED}. ` +
      'Counted as try 2 of 3; its next review gets the alert text only'), t.g.logs.join('\n'));
    const [sam] = reviewOf(t.g, SAM_ID);
    eq(mediaOf(sam), []);
    assert.match(forward(t, SAM_ID).text, /QA: The post's own media wasn't reviewed: reviewing it crashed the bot 2 times, so Gemini had only the alert text/);
    eq([msgLog(t, msg.name).kind, Number(msgLog(t, msg.name).attempts), t.g.props.has(HELD)], ['alert', 2, false]);

    // Try 3 ended too: forwarded to analysts as received (the 3 tries are used up), and the alert behind it is reviewed
    const u = ready(30e6);
    const m3 = u.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    u.chat.say(TEST_FEED, F.AIO, { sender: 'users/bot' });
    failedBefore(u, m3.name, 2);
    u.g.props.set(HELD, JSON.stringify({ [m3.name]: { media: 'none', crashes: 2, at: u.g.clock.now } }));
    endedRun(u, m3.name, 'review', 'none');
    u.poll();
    assert.ok(u.g.logs.includes(`a run ended partway through ${m3.name} in its review (with the alert text only): ${ENDED}. ` +
      'Counted as try 3 of 3; it\'s forwarded as received now'), u.g.logs.join('\n'));
    eq(reviewOf(u.g, SAM_ID).length, 0);
    assert.match(forward(u, SAM_ID).text, /\nQA: couldn't review this alert automatically, so it was forwarded as received\.$/);
    eq([msgLog(u, m3.name).kind, Number(msgLog(u, m3.name).attempts), u.g.props.has(HELD), u.g.props.has(NOTE)], ['raw_forward', 3, false, false]);
    eq(reviewOf(u.g, AIO_ID).length, 1);
    assert.ok(forward(u, AIO_ID));
    u.poll();  // done: never tried again
    eq([reviewOf(u.g, SAM_ID).length, u.chat.botPosts(TRIAGED).filter(m => !m.threadReply && m.text.includes(SAM_ID)).length], [0, 1]);
  });

  test('crash guard B: a run that ended outside the review counts a try but keeps all the media; one that ended while forwarding as received is given up on, and the Control tab says so; a note on a message already done is just cleared', () => {
    // outside the review (e.g. while posting): try 1, and the next try still gets the post's own media
    const t = ready(9e6);
    const msg = t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    endedRun(t, msg.name, 'handling');
    t.poll();
    assert.ok(t.g.logs.includes(`a run ended partway through ${msg.name}: ${ENDED}. Counted as try 1 of 3`), t.g.logs.join('\n'));
    eq([mediaOf(reviewOf(t.g, SAM_ID)[0]), Number(msgLog(t, msg.name).attempts), msgLog(t, msg.name).kind],
      [[`link video/mp4 ${VIDEO_URL}`], 1, 'alert']);
    assert.ok(!/QA: The post's own media wasn't reviewed/.test(forward(t, SAM_ID).text));
    // the note on a message that's done (the run ended after it): cleared, nothing counted or sent again
    const posts = t.chat.botPosts(TRIAGED).length;
    endedRun(t, msg.name, 'handling');
    t.poll();
    eq([t.g.props.has(NOTE), Number(msgLog(t, msg.name).attempts), t.chat.botPosts(TRIAGED).length], [false, 1, posts]);

    // ended while forwarding it as received: given up on (dead), the Control tab says so, never tried again
    const u = ready(9e6);
    const m = u.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    failedBefore(u, m.name, 3);
    endedRun(u, m.name, 'give_up');
    u.poll();
    eq([msgLog(u, m.name).kind, reviewOf(u.g, SAM_ID).length, !!forward(u, SAM_ID)], ['dead', 0, false]);
    assert.match(u.get('B5'), /gave up on a message: a run ended partway through forwarding it as received \(Apps Script stopped it/);
    u.poll();
    eq([msgLog(u, m.name).kind, reviewOf(u.g, SAM_ID).length], ['dead', 0]);
  });

  test('crash guard B: the analysts\' note says what Gemini had instead; the auto-correct space\'s thread note says it too', () => {
    const B = loadBot();
    eq([
      B.mediaHeldNote_({ media: 'still', crashes: 1 }, { checks: [], _media: { label: 'a frame', kind: 'image' } }),
      B.mediaHeldNote_({ media: 'none', crashes: 2 }, { checks: [] }),
      B.mediaHeldNote_({ media: 'still', crashes: 1 }, null),
      B.mediaHeldNote_({ media: 'full', crashes: 1 }, { checks: [] }),
      B.mediaHeldNote_(null, { checks: [] }),
    ], [
      'The post\'s own media wasn\'t reviewed: reviewing it crashed the bot, so Gemini had only a still of the post',
      'The post\'s own media wasn\'t reviewed: reviewing it crashed the bot 2 times, so Gemini had only the alert text',
      'The post\'s own media wasn\'t reviewed: reviewing it crashed the bot',
      '', '']);
    const held = B.reviewAlert_(B.parseAlert_(F.P0_OK), { now: NOW, history: [], llm: { checks: [] }, mediaHeld: { media: 'none', crashes: 1 } });
    eq([held.mediaHeld, held.notes.includes(held.mediaHeld)], [
      'The post\'s own media wasn\'t reviewed: reviewing it crashed the bot, so Gemini had only the alert text', true]);
    eq(B.changeNoteText_(held, false), held.mediaHeld);
    eq('mediaHeld' in B.reviewAlert_(B.parseAlert_(F.P0_OK), { now: NOW, history: [], llm: { checks: [] } }), false);
  });

  // ===========================================================================================================
  // C: run owner
  // ===========================================================================================================

  test('crash guard C: a claim under 4 minutes old found with the script lock is a run that ended: taken over at once; while its run holds the lock nothing happens; 4-25 minutes old still waits', () => {
    const t = ready(9e6);
    t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    // the run that made the claim still holds the lock: this minute does nothing (as before)
    const LS = t.g.services.LockService;
    const real = LS.getScriptLock;
    LS.getScriptLock = () => ({ tryLock: () => false, releaseLock() {} });
    t.g.props.set('RUN_OWNER', claim('alive-run', t.g.clock.now));
    const before = [t.chat.calls.length, t.g.logs.length];
    t.poll();
    eq([t.chat.calls.length, t.g.logs.length, !!forward(t, SAM_ID)], [...before, false]);
    LS.getScriptLock = real;
    // 7 minutes old: the lock can't vouch for it, so it waits as before
    t.g.props.set('RUN_OWNER', claim('old-run', t.g.clock.now - 6 * 60e3));
    t.poll();
    assert.match(t.g.logs.slice(-1)[0], /^run skipped: the run that started at .* is still going$/);
    eq(!!forward(t, SAM_ID), false);
    // 2 minutes old and the lock free: that run ended, so this one takes over now
    t.g.props.set('RUN_OWNER', claim('ended-run', t.g.clock.now - 60e3));
    t.poll();
    assert.ok(t.g.logs.some(l => /^the run that started at .* ended without finishing \(it no longer holds the script lock\): this run takes over$/.test(l)));
    eq([!!forward(t, SAM_ID), t.g.props.has('RUN_OWNER'), t.g.props.get('FAIL_STREAK')], [true, false, '0']);
    // 26 minutes old: taken over as before, and named as a run that ended
    t.g.props.set('RUN_OWNER', claim('stale-run', t.g.clock.now - 25 * 60e3));
    t.poll();
    assert.ok(t.g.logs.some(l => /^the run that started at .* ended without finishing \(its claim is 26 minutes old\): this run takes over$/.test(l)));
  });

  test('crash guard C: runs that end partway count as failed runs, so 5 in a row tell analysts (as 5 errors in a row do), and the next good run says the bot is back', () => {
    const t = ready(9e6);
    t.poll();
    eq(t.g.props.get('LAST_ANALYST_SPACE'), TRIAGED);
    t.g.props.set('FAIL_STREAK', '4');  // four runs in a row ended partway (each counted by the run after it)
    t.g.props.set('RUN_OWNER', claim('ended-run', t.g.clock.now - 60e3));
    t.poll();
    const posts = t.chat.botPosts(TRIAGED).map(m => m.text);
    assert.ok(posts.some(p => /^The Burson QA bot has had problems for 5 runs in a row, so alerts may not be reviewed or forwarded right now\.\n- Last error: the run that started at .* ended without finishing: Apps Script stopped it \(out of memory, a time limit or an internal error\)/.test(p)), posts.join('\n---\n'));
    assert.ok(posts.some(p => p === 'The Burson QA bot is running again and catching up on alerts.'), posts.join('\n---\n'));
    eq([t.g.props.get('FAIL_STREAK'), t.g.props.has('FAIL_NOTICE')], ['0', false]);
  });
};
