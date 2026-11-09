// A run too short for a post's video (Oct 26): until then, a review that started with less than GEMINI_MEDIA_MIN_LEFT_MS_
// (90 s) of its run left the post's media out altogether, photos and screenshots included, and nobody was told (89
// reviews in Oct 21-24, 63 of them of posts with no video at all). Now:
//   - pictures (photos, a frame, a cover, Burson's screenshot) go whatever time is left: a review with them takes no
//     longer than one without (Oct 21-24: median 37 s / p95 80 s with photos, 46 s / 133 s from the text alone);
//   - only a video or audio clip needs the 90 s. Short of it, the alert waits for the next run (which reviews it first,
//     with its video) when that helps and can't pile up: never the first message a run handles, only in a pass that had
//     the time for a video review when it started, at most once, and only while the alert is under 10 minutes old;
//   - otherwise Gemini gets a still of the post, and the forwarded alert (and the auto-correct space's thread note) says
//     what Gemini didn't get and why; so does a review whose media Gemini couldn't open.
'use strict';

module.exports = H => {
  const { test, eq, assert, F, NOW, world, e2e, loadBot, TEST_FEED, TRIAGED } = H;

  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0xff, 0xd9]);
  const b64 = buf => buf.toString('base64');
  const SAM = '2109952063492993159';    // F.P0_OK's post
  const AIO = '1845000000000000001';    // F.AIO's post
  const WAYMO = '2111814207448514693';  // F.WAYMO_KOF's post
  const BUCKET = 'brand-social-central-data-slrr-automations';
  const idOf = url => (String(url).match(/status\/(\d+)/) || [])[1] || '';
  const vidUrl = id => `https://video.twimg.com/amplify_video/${id}/vid/avc1/640x360/v.mp4`;
  const posterUrl = id => `https://pbs.twimg.com/amplify_video_thumb/${id}/img/frame.jpg`;
  const photoUrl = id => `https://pbs.twimg.com/media/${id}.jpg`;
  /** An X post as Post.gs gives it: a 0:30 video (small enough to go as its link: nothing is downloaded for it) or a photo. */
  const xPost = (url, kind) => {
    const id = idOf(url);
    return { platform: 'X', id, url, author: 'someone', text: `A post (${kind})`, photos: kind === 'photo' ? [photoUrl(id)] : [],
      video: kind === 'video' ? { url: vidUrl(id), variants: [{ url: vidUrl(id), bitrate: 832000 }], poster: posterUrl(id), duration_s: 30, gif: false } : null,
      reply_to: null, parent: null, quoted: null, thread_ids: [] };
  };
  const reviews = g => g.vertex.calls.filter(c => c.payload.generationConfig.responseSchema.properties.checks).map(c => c.payload);
  const reviewOf = (g, id) => reviews(g).filter(p => JSON.stringify(p.contents).includes(id));
  const mediaOf = payload => payload.contents[0].parts.filter(p => p.fileData || p.inlineData)
    .map(p => (p.fileData ? `link ${p.fileData.mimeType} ${p.fileData.fileUri}` : `inline ${p.inlineData.mimeType} ${p.inlineData.data}`));
  const hasVideo = payload => payload.contents[0].parts.some(p => p.fileData && /^video\//.test(p.fileData.mimeType));
  const VIDEO_NOTE = 'The bot was short of time, so Gemini didn\'t review the post\'s video (0:30 long) and had only a still of the post';
  /**
   * A world whose posts are `kinds` ({id: 'video' | 'photo'}; anything else: no lookup), their frames and photos served,
   * and whose Gemini calls with a video take `videoMs` (others take no time).
   */
  const setup = (kinds, videoMs, opts) => {
    const w = world(Object.assign({ post: url => (kinds[idOf(url)] ? xPost(url, kinds[idOf(url)]) : null) }, opts || {}));
    Object.keys(kinds).forEach(id => {
      w.g.pages.set(posterUrl(id), { bytes: JPG, headers: { 'Content-Type': 'image/jpeg' } });
      w.g.pages.set(photoUrl(id), { bytes: JPG, headers: { 'Content-Type': 'image/jpeg' } });
    });
    w.vertex.fail = payload => { if (hasVideo(payload)) w.g.clock.now += videoMs; return null; };
    return w;
  };
  const forwardOf = (w, id) => w.analystPosts().find(m => !m.threadReply && m.text.includes(id));
  const waitsKey = 'review_waits';

  // ===========================================================================================================
  // Holding an alert for the next run
  // ===========================================================================================================

  test('review hold: a run too short for the second alert\'s video holds it for the next run (no Gemini call, not a failure, not counted, nothing after it handled); the next run reviews it first with its video, keeps its first pickup as seen_at, and says nothing to analysts about media', () => {
    const w = setup({ [SAM]: 'video', [AIO]: 'video', [WAYMO]: 'photo' }, 100e3);
    w.paste(F.P0_OK);
    const second = w.paste(F.AIO);
    const third = w.paste(F.WAYMO_KOF);
    const r1 = w.run();
    const pickedUp = w.g.logs.length;
    // the first alert: reviewed with its video (100 s); the second would start with under 90 s: held, nothing called for it
    eq([reviewOf(w.g, SAM).map(p => mediaOf(p)[0].split(' ').slice(0, 2).join(' ')), reviewOf(w.g, AIO).length, reviewOf(w.g, WAYMO).length],
      [['link video/mp4'], 0, 0]);
    assert.ok(w.g.logs.some(l => new RegExp(`^held ${second.name} for the next run: less than 90 s left in this run \\(7\\d s\\), not enough for the post's video \\(0:30 long\\)$`).test(l)), w.g.logs.join('\n'));
    eq([r1.held, r1.alerts, r1.handled, r1.errors], [1, 1, 1, []]);
    eq([!!forwardOf(w, SAM), !!forwardOf(w, AIO), !!forwardOf(w, WAYMO)], [true, false, false]);
    eq(w.backend.messages.filter(m => m.message === second.name || m.message === third.name), []);  // no failure, nothing done
    const memo = JSON.parse(w.ctx().memo.get(waitsKey));
    eq(Object.keys(memo), [second.name]);
    const firstSeen = memo[second.name].seen;
    // the next run: the held alert first, with its video; then the photo post behind it (pictures never wait)
    w.g.clock.now += 4 * 60e3;
    const r2 = w.run();
    eq(reviewOf(w.g, AIO).map(p => mediaOf(p)[0].split(' ').slice(0, 2).join(' ')), ['link video/mp4']);
    eq(reviewOf(w.g, WAYMO).map(mediaOf), [[`inline image/jpeg ${b64(JPG)}`]]);
    assert.ok(w.g.logs.slice(pickedUp).some(l => new RegExp(`^reviewed ${second.name} 4 min after it was held for this run$`).test(l)), w.g.logs.join('\n'));
    eq([r2.held || 0, r2.alerts], [0, 2]);
    const row = w.alertRows().find(a => a.source_message === second.name);
    eq([row.seen_at, row.seen_at < w.alertRows().find(a => a.source_message === third.name).seen_at], [firstSeen, true]);
    assert.ok(!/QA: (The bot was short of time|Gemini couldn't review)/.test(forwardOf(w, AIO).text), forwardOf(w, AIO).text);
    eq(w.ctx().memo.get(waitsKey), '');  // forgotten once reviewed (no delete on this memo: emptied)
  });

  test('review hold: never the first message a run handles (every run reviews at least one): its frame goes instead, the forward says what Gemini didn\'t get, the log why it wasn\'t held', () => {
    const w = setup({ [SAM]: 'video' }, 0);
    const base = w.ctx;
    w.ctx = () => Object.assign(base(), { deadline: w.g.clock.now + 85e3 });
    const msg = w.paste(F.P0_OK);
    const r = w.run();
    eq([reviewOf(w.g, SAM).map(mediaOf), r.held || 0, r.alerts], [[[`inline image/jpeg ${b64(JPG)}`]], 0, 1]);
    assert.ok(w.g.logs.includes(`${msg.name} wasn't held for the next run: it's the first message this run handled (every run reviews at least one)`), w.g.logs.join('\n'));
    assert.ok(forwardOf(w, SAM).text.split('\n').includes(`QA: ${VIDEO_NOTE}`), forwardOf(w, SAM).text);
    // the prompt tells Gemini it has only a frame
    assert.match(reviewOf(w.g, SAM)[0].systemInstruction.parts[0].text, /attached above is a frame from the post's video \(the video itself couldn't be reviewed\)\./);
  });

  test('review hold: at most once: an alert held before isn\'t held again (its frame goes, the forward says so), and keeps the seen_at of its first pickup', () => {
    const w = setup({ [SAM]: 'video', [AIO]: 'video' }, 100e3);
    w.paste(F.P0_OK);
    const second = w.paste(F.AIO);
    const ctx = w.ctx();
    ctx.memo.set(waitsKey, JSON.stringify({ [second.name]: { seen: NOW - 5 * 60e3, at: NOW - 5 * 60e3 } }));
    const r = w.run();
    eq([r.held || 0, reviewOf(w.g, AIO).map(mediaOf)], [0, [[`inline image/jpeg ${b64(JPG)}`]]]);
    assert.ok(w.g.logs.includes(`${second.name} wasn't held for the next run: it was held once already`), w.g.logs.join('\n'));
    assert.ok(forwardOf(w, AIO).text.split('\n').includes(`QA: ${VIDEO_NOTE}`), forwardOf(w, AIO).text);
    eq(w.alertRows().find(a => a.source_message === second.name).seen_at, NOW - 5 * 60e3);
  });

  test('review hold: a backlog isn\'t held up: an alert that reached the Burson space 10 minutes ago or more goes on with its frame (the forward says so); a pass that started with under 120 s (the auto-correct space while the main flow is busy) never holds either', () => {
    const w = setup({ [SAM]: 'video', [AIO]: 'video' }, 100e3);
    w.paste(F.P0_OK);
    const second = w.paste(F.AIO);
    w.g.clock.now += 15 * 60e3;
    const r = w.run();
    eq([r.held || 0, reviewOf(w.g, AIO).map(mediaOf)], [0, [[`inline image/jpeg ${b64(JPG)}`]]]);
    assert.ok(w.g.logs.some(l => new RegExp(`^${second.name} wasn't held for the next run: it reached the Burson space 1\\d minutes ago \\(a backlog isn't held up\\)$`).test(l)), w.g.logs.join('\n'));
    assert.ok(forwardOf(w, AIO).text.split('\n').includes(`QA: ${VIDEO_NOTE}`));
    // a pass with 100 s for alerts: the first review takes 30 s, the second has under 90 s and isn't held
    const v = setup({ [SAM]: 'video', [AIO]: 'video' }, 30e3);
    const base = v.ctx;
    v.ctx = () => Object.assign(base(), { deadline: v.g.clock.now + 100e3 });
    v.paste(F.P0_OK);
    const m2 = v.paste(F.AIO);
    const r2 = v.run();
    eq([r2.held || 0, reviewOf(v.g, AIO).map(mediaOf)], [0, [[`inline image/jpeg ${b64(JPG)}`]]]);
    assert.ok(v.g.logs.some(l => new RegExp(`^${m2.name} wasn't held for the next run: this pass had 10\\d s when it started, under the 120 s a video review needs$`).test(l)), v.g.logs.join('\n'));
  });

  test('review hold: a video that took the time to copy to Cloud Storage (the run is now under 90 s) holds the alert too: the copy is deleted, nothing is sent to Gemini; the next run copies it again and reviews it', () => {
    const w = setup({ [SAM]: 'video' }, 100e3);
    // F.AIO's post: a 30 MB Bluesky-style video (its size known), copied to Cloud Storage in 20 s
    const BIG = 'https://cdn.example.com/aio-video.mp4';
    const post = w.ctx().post;
    w.ctx = (base => () => Object.assign(base(), { post: url => (idOf(url) === AIO
      ? Object.assign(xPost(url, 'video'), { video: { url: BIG, size: 30e6, poster: posterUrl(AIO), duration_s: 140, mime: 'video/mp4' } })
      : post(url)) }))(w.ctx);
    w.g.pages.set(posterUrl(AIO), { bytes: JPG, headers: { 'Content-Type': 'image/jpeg' } });
    const fetch = w.g.services.UrlFetchApp.fetch;
    w.g.services.UrlFetchApp.fetch = (url, params) => {
      if (url === BIG) {
        w.g.fetches.push({ url, method: 'get', headers: (params && params.headers) || {} });
        return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => '',
          getContent: () => { throw new Error('read into the script'); },
          getBlob: () => ({ isFakeBlob: true, bytes: { length: 30e6 }, setContentType() { return this; } }) };
      }
      if (/\/upload\/storage\/v1\//.test(url)) w.g.clock.now += 20e3;
      return fetch(url, params);
    };
    // the first review (SAM's video) takes 70 s: AIO's review starts with ~107 s, its copy leaves it ~87 s
    w.vertex.fail = payload => { if (hasVideo(payload)) w.g.clock.now += 70e3; return null; };
    w.paste(F.P0_OK);
    const second = w.paste(F.AIO);
    const r = w.run();
    eq([r.held, reviewOf(w.g, AIO).length], [1, 0]);
    assert.ok(w.g.logs.some(l => new RegExp(`^held ${second.name} for the next run: less than 90 s left in this run \\(8\\d s\\), not enough for the post's video \\(2:20 long\\)$`).test(l)), w.g.logs.join('\n'));
    const storage = w.g.fetches.filter(f => f.url.startsWith('https://storage.googleapis.com/')).map(f => f.method);
    eq(storage, ['post', 'delete']);  // copied, then deleted: never left behind
    // the next run: copied again and reviewed from that copy, deleted after
    w.g.clock.now += 4 * 60e3;
    w.run();
    const [call] = reviewOf(w.g, AIO);
    assert.match(mediaOf(call)[0], new RegExp(`^link video/mp4 gs://${BUCKET}/burson-qa-bot/staging/`));
    eq(w.g.fetches.filter(f => f.url.startsWith('https://storage.googleapis.com/')).map(f => f.method), ['post', 'delete', 'post', 'delete']);
  });

  // ===========================================================================================================
  // What analysts are told
  // ===========================================================================================================

  test('review hold: a video Gemini couldn\'t review: the forward says so and what Gemini had instead (its frame, else the alert text); a photo it couldn\'t review: the alert text', () => {
    const fails = (kinds, failWhat) => {
      const w = setup(kinds, 0);
      w.vertex.fail = payload => (failWhat(payload) ? { code: 400, body: { error: { message: 'Unable to process the input' } } } : null);
      return w;
    };
    const isVideo = p => hasVideo(p);
    const anyMedia = p => p.contents[0].parts.some(x => x.fileData || x.inlineData);
    const a = fails({ [SAM]: 'video' }, isVideo);
    a.paste(F.P0_OK);
    a.run();
    eq(reviewOf(a.g, SAM).map(p => (mediaOf(p)[0] || 'text').split(' ').slice(0, 2).join(' ')), ['link video/mp4', 'inline image/jpeg']);
    assert.ok(forwardOf(a, SAM).text.split('\n').includes('QA: Gemini couldn\'t review the post\'s video (0:30 long), so it had only a still of the post'), forwardOf(a, SAM).text);
    const b = fails({ [SAM]: 'video' }, anyMedia);
    b.paste(F.P0_OK);
    b.run();
    eq(reviewOf(b.g, SAM).map(p => (mediaOf(p)[0] || 'text').split(' ').slice(0, 2).join(' ')), ['link video/mp4', 'inline image/jpeg', 'text']);
    assert.ok(forwardOf(b, SAM).text.split('\n').includes('QA: Gemini couldn\'t review the post\'s video (0:30 long), so it had only the alert text'), forwardOf(b, SAM).text);
    const c = fails({ [SAM]: 'photo' }, anyMedia);
    c.paste(F.P0_OK);
    c.run();
    assert.ok(forwardOf(c, SAM).text.split('\n').includes('QA: Gemini couldn\'t review the post\'s photo, so it had only the alert text'), forwardOf(c, SAM).text);
    // all of it reviewed: no such note
    const d = setup({ [SAM]: 'video' }, 0);
    d.paste(F.P0_OK);
    d.run();
    assert.ok(!/QA: (The bot was short of time|Gemini couldn't review)/.test(forwardOf(d, SAM).text), forwardOf(d, SAM).text);
  });

  test('review hold: the notes, pure; the crash note wins over this one; the auto-correct space\'s thread note carries it', () => {
    const B = loadBot();
    eq([
      B.mediaMissedNote_({ _missed: { label: 'the post\'s video (1:23 long)', why: 'time' }, _media: { label: 'a frame', kind: 'image' } }),
      B.mediaMissedNote_({ _missed: { label: 'the YouTube video', why: 'time' } }),
      B.mediaMissedNote_({ _missed: { label: 'the post\'s 2 photos', why: 'failed' } }),
      B.mediaMissedNote_({ _missed: { label: 'the post\'s video (1:23 long)', why: 'time' }, _media: { label: 'a frame', kind: 'image' }, _transcript: { label: 'the post\'s video (1:23 long)', kind: 'video' } }),
      B.mediaMissedNote_({ checks: [] }), B.mediaMissedNote_(null),
    ], [
      'The bot was short of time, so Gemini didn\'t review the post\'s video (1:23 long) and had only a still of the post',
      'The bot was short of time, so Gemini didn\'t review the YouTube video and had only the alert text',
      'Gemini couldn\'t review the post\'s 2 photos, so it had only the alert text',
      'The bot was short of time, so Gemini didn\'t review the post\'s video (1:23 long) directly and reviewed the extracted text transcript and a still of the post instead',
      '', '']);
    const llm = { checks: [], _missed: { label: 'the post\'s video (1:23 long)', why: 'time' } };
    const r = B.reviewAlert_(B.parseAlert_(F.P0_OK), { now: NOW, history: [], llm });
    eq([r.mediaMissed, r.notes.includes(r.mediaMissed), 'mediaHeld' in r], [B.mediaMissedNote_(llm), true, false]);
    eq(B.changeNoteText_(r, false), `${r.mediaMissed}`);
    const both = B.reviewAlert_(B.parseAlert_(F.P0_OK), { now: NOW, history: [], llm, mediaHeld: { media: 'still', crashes: 1 } });
    eq(['mediaMissed' in both, both.notes.filter(n => /wasn't reviewed|didn't review/.test(n)).length], [false, 1]);
  });

  test('review hold: reviewClipOf_ names the clip mediaFor_ would send first, from what\'s known before any download; none for pictures, a video too big to copy, or no link', () => {
    const B = loadBot();
    const X = 'https://x.com/a/status/1';
    const clip = (fields, extra) => B.reviewClipOf_(Object.assign({ fields }, extra || {}));
    eq([
      clip({ post_url: X, gcs_media_uri: 'gs://b/v.mp4' }),
      clip({ post_url: X }, { bq: { gcs_video_uri: 'gs://b/a.mp3', gcs_video_mime: 'audio/mp3' } }),
      clip({ post_url: X, gcs_media_uri: 'gs://b/p.png' }),
      clip({ post_url: 'gs://b/clip.mov' }),
      clip({ post_url: 'not a link' }),
      clip({ post_url: 'https://youtu.be/dQw4w9WgXcQ' }),
      clip({ post_url: X }, { post: xPost(X, 'video') }),
      clip({ post_url: X }, { post: Object.assign(xPost(X, 'video'), { video: { url: 'https://v/x.mp4', size: 60e6, duration_s: 90 } }) }),
      clip({ post_url: X }, { post: Object.assign(xPost(X, 'video'), { video: { url: 'https://v/g.mp4', gif: true } }) }),
      clip({ post_url: X }, { post: xPost(X, 'photo') }),
      clip({ post_url: 'https://cdn.example.com/talk.mp3' }),
      clip({ post_url: 'https://cdn.example.com/pic.jpg' }),
      clip({ post_url: 'https://news.example.com/story' }),
    ], [
      'the Cloud Storage video', 'the Cloud Storage audio', '', 'the Cloud Storage video', '', 'the YouTube video',
      'the post\'s video (0:30 long)', '', 'the post\'s GIF', '', 'the linked audio file', '', '']);
  });

  test('review hold: mediaFor_ with picturesOnly fetches nothing for a clip (a linked video file, a page\'s og:video, a YouTube link) and gives the next picture', () => {
    const w = world();
    const B = w.bot;
    const page = 'https://news.example.com/story';
    const html = '<meta property="og:video" content="https://news.example.com/v.mp4"><meta property="og:image" content="https://news.example.com/i.jpg">';
    w.g.pages.set('https://news.example.com/i.jpg', { bytes: JPG, headers: { 'Content-Type': 'image/jpeg' } });
    const got = B.mediaFor_({ post_url: page }, () => html, { picturesOnly: true });
    eq([got.kind, got.label], ['image', 'the post\'s image']);
    eq(B.mediaFor_({ post_url: 'https://cdn.example.com/talk.mp4' }, () => '', { picturesOnly: true }), null);
    eq(B.mediaFor_({ post_url: 'https://youtu.be/dQw4w9WgXcQ' }, () => '', { picturesOnly: true }), null);
    assert.ok(!w.g.fetches.some(f => /\.mp4$/.test(f.url)), 'nothing fetched for a clip');
    // without it, as before: the page's video
    eq(B.mediaFor_({ post_url: page }, () => html, {}).kind, 'video');
  });

  // ===========================================================================================================
  // The real run (poll)
  // ===========================================================================================================

  test('review hold in poll(): the held alert leaves no crash note (the next run counts no failed try), its wait is noted in the flow\'s memo and cleared once reviewed; the Alert log keeps its first pickup; the Control tab counts it once', () => {
    const t = e2e();
    t.bot.setup();
    t.bot.ev('GEN').email.stand_in = 'tester@testing.test';
    const lookup = t.bot.lookupPost_;
    t.bot.lookupPost_ = url => (idOf(url) === SAM || idOf(url) === AIO ? xPost(url, 'video') : lookup(url));
    [SAM, AIO].forEach(id => t.g.pages.set(posterUrl(id), { bytes: JPG, headers: { 'Content-Type': 'image/jpeg' } }));
    t.g.vertex.fail = payload => { if (hasVideo(payload)) t.g.clock.now += 100e3; return null; };
    t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    const second = t.chat.say(TEST_FEED, F.AIO, { sender: 'users/bot' });
    t.poll();
    const WAITS = `MEMO:${TRIAGED}:review_waits`;
    eq([reviewOf(t.g, AIO).length, Object.keys(JSON.parse(t.g.props.get(WAITS) || '{}')), t.g.props.has(`MEMO:${TRIAGED}:handling`)],
      [0, [second.name], false]);
    assert.ok(t.g.logs.some(l => /"held":1/.test(l)), 'the run report says one alert was held');
    assert.match(t.get('B7'), /^1 alert reviewed/);
    t.poll();
    eq([reviewOf(t.g, AIO).map(p => mediaOf(p)[0].split(' ').slice(0, 2).join(' ')), t.g.props.has(WAITS)], [['link video/mp4'], false]);
    assert.ok(!t.g.logs.some(l => /a run ended partway through/.test(l)), 'no crash counted');
    const tab = t.sheet().getSheetByName('Alert log');
    const h = tab.rows[0];
    const row = tab.rows.slice(1).find(r => r[h.indexOf('source_message')] === second.name);
    assert.ok(Number(row[h.indexOf('seen_at')]) < Number(row[h.indexOf('created_at')]) - 60e3, 'seen_at is the first pickup, a run earlier');
    const msgs = t.sheet().getSheetByName('Message log');
    const mh = msgs.rows[0];
    const mrow = msgs.rows.slice(1).find(r => r[mh.indexOf('message')] === second.name);
    eq([mrow[mh.indexOf('kind')], Number(mrow[mh.indexOf('attempts')] || 0)], ['alert', 0]);
    assert.match(t.get('B7'), /^2 alerts reviewed/);
  });
};
