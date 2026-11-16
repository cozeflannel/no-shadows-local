// AlertMemory.gs, Knowledge.gs compliance & strict 6-table BigQuery invariant tests:
// - Repo-wide 6 approved social tables check across all .gs files
// - URL canonicalization across tracking params and domains (amPostKey_)
// - 24h semantic story folding + Chat thread reply citing folded member post
// - Stakes-rising single update + 120m cooldown + P0/KOF exemption
// - B30-blank queue flush send-gate dedup & foreign tab ownership safeguard
// - Direct-BQ Step-1 structured knowledge retrieval, pinned whole docs, and hybrid RRF semantic + lexical passage selection
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = H => {
  const { test, eq, assert, B, F, NOW, e2e, makeGoogle, loadBot, KB, REAL, TEST_FEED, TRIAGED } = H;

  test('BigQuery approved-tables invariant: all .gs files reference ONLY the 6 approved social-data tables (+ slrr_alerts/alert_sends memory, DSD.gemini_analyzer fallback, and write-only early_wave.{story_snapshots,story_posts,signals,signal_events,triage_verdicts})', () => {
    const approved = new Set([
      'brand-social-central-data.reporting_data.sprinklr_inbound_comments',
      'brand-social-central-data.raw_data.brandwatch_raw_mentions_base',
      'brand-social-central-data.reporting_data.sprinklr_outbound_reporting',
      'bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw',
      'brand-social-central-data.google_tubular_mentions.tubular_videos',
      'brand-social-central-data.DSD.DSD-story-selection',
      // Approved alert-history / IM write-back & ML model fallback
      'brand-social-central-data.slrr_alerts.slrr_alerts',
      'brand-social-central-data.slrr_feedback.alert_sends',
      'brand-social-central-data.DSD.gemini_analyzer',
      // Write-only early_wave tables (row 46)
      'brand-social-central-data.early_wave.story_snapshots',
      'brand-social-central-data.early_wave.story_posts',
      'brand-social-central-data.early_wave.signals',
      'brand-social-central-data.early_wave.signal_events',
      'brand-social-central-data.early_wave.triage_verdicts',
    ]);
    const approvedEarlyWaveShort = new Set([
      'early_wave.story_snapshots',
      'early_wave.story_posts',
      'early_wave.signals',
      'early_wave.signal_events',
      'early_wave.triage_verdicts',
    ]);
    const dir = path.join(__dirname, '..');
    const gsFiles = fs.readdirSync(dir).filter(f => f.endsWith('.gs'));
    assert.ok(gsFiles.length >= 25);
    const bad = [];
    const tableRx = /\b(?:brand-social-central-data|bsip-s-bsip-gg-26-2cf3)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
    const ewShortRx = /\bearly_wave\.[A-Za-z0-9_-]+/g;
    // The one exception: the hand-run, read-only live check of the new sources (LiveVerify.gs verifyNewSourcesLive) looks
    // at the AMIE table the owner approved on 16 November; until its readers are built (step 1c adds it to `approved`),
    // no other file may name it
    const liveCheckOnly = { 'LiveVerify.gs': "'brand-social-central-data.social_alerts_dataset.all_sundar_mentions'" };
    for (const file of gsFiles) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8')
        // Strip // line comments and /* ... */ block comments so doc comments about retired tables don't mask code checks
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .split(liveCheckOnly[file] || '\u0000').join("''");
      let m;
      while ((m = tableRx.exec(src)) !== null) {
        const ref = m[0];
        if (/^brand-social-central-data\.[A-Za-z0-9_-]+\.__TABLES__$/.test(ref)) continue;
        if (/^bsip-s-bsip-gg-26-2cf3\.[A-Za-z0-9_-]+\.__TABLES__$/.test(ref)) continue;
        if (!approved.has(ref)) bad.push(`${file}: ${ref}`);
      }
      while ((m = ewShortRx.exec(src)) !== null) {
        if (!approvedEarlyWaveShort.has(m[0])) bad.push(`${file}: ${m[0]}`);
      }
      if (/\b(?:FROM|JOIN)\s+`?(?:brand-social-central-data\.)?early_wave\b/i.test(src) ||
          /\bSELECT\b[\s\S]{0,400}\bearly_wave\./i.test(src)) {
        bad.push(`${file}: reads from early_wave`);
      }
      assert.ok(!/vw_chatbot_pending_early_alerts|all_sundar_mentions|sonar_post_aggregates_7d_materialized|content_vectors|evergreen_topics|reddit_items_raw/.test(src),
        `Retired table token still in executable code of ${file}`);
    }
    eq(bad, []);
  });

  test('AlertMemory URL canonicalization (amPostKey_): strips tracking params and normalizes X/Twitter, YouTube, Reddit, Instagram, TikTok, Threads', () => {
    eq(B.amPostKey_('https://twitter.com/UserOne/statuses/2109500000000000001?s=20&t=xyz&utm_source=share'),
      B.amPostKey_('https://mobile.x.com/i/web/status/2109500000000000001/'));
    eq(B.amPostKey_('https://youtu.be/dQw4w9WgXcQ?si=tracking123'),
      B.amPostKey_('https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=youtu.be'));
    eq(B.amPostKey_('https://old.reddit.com/r/GooglePixel/comments/1x9vsi4/pixel_10_pro_gps/?utm_medium=android_app'),
      B.amPostKey_('https://www.reddit.com/comments/1x9vsi4'));
    eq(B.amPostKey_('https://www.instagram.com/reel/DPq1aBcDeFg/?igsh=NTc4MTIwNjQ2YQ=='),
      B.amPostKey_('https://instagram.com/p/DPq1aBcDeFg/'));
    assert.notStrictEqual(
      B.amPostKey_('https://x.com/a/status/2109500000000000001'),
      B.amPostKey_('https://x.com/a/status/2109500000000000002')
    );
  });

  test('AlertMemory 24h semantic story folding + stakes-rising single update: folds second post into first alert thread citing member link, then sends ONE threaded update when stakes cross 10k or KOF', () => {
    const t = e2e();
    t.bot.setup();
    t.set('B25', REAL);
    t.set('B29', 'ON');
    t.set('B30', 'tester@testing.test');
    t.control().getRange(23, 2).setValue('ON');  // Never wait on Burson (matches live Control tab)
    const MIRROR = 'spaces/AAQAmirFold1';
    t.chat.addSpace(MIRROR, 'Mirror Fold');
    t.g.clock.now += 3600e3;
    t.bot.startMirror('Mirror Fold');
    const ZAP = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };

    const post1 = F.P0_OK;
    const url2 = 'https://www.reddit.com/r/technology/comments/1paris2/search_bias_paris_riots/';
    const post2 = F.P0_OK
      .replace('https://x.com/WasSamLowryEsq/status/2109952063492993159', url2)
      .replace('| X |', '| Reddit |')
      .replace('[Social Network]: X', '[Social Network]: Reddit')
      .replace('X user @WasSamLowryEsq (652 followers)', 'Reddit user u/pariswatcher')
      .replace(',1,WasSamLowryEsq,-,', ',45,u/pariswatcher,-,');

    t.chat.say(REAL, post1, ZAP);
    t.poll();
    eq(t.g.gmail.sentMessages().length, 1);
    const leadCopy = t.chat.botPosts(MIRROR).filter(m => !m.threadReply).slice(-1)[0];
    eq(t.chat.botReactions(leadCopy.name).includes('📦'), true);

    // 10 minutes later: different author & platform, same story, same stakes -> folded (no 2nd email) + member cited in lead thread!
    t.g.clock.now += 10 * 60e3;
    t.chat.say(REAL, post2, ZAP);
    t.poll();
    eq(t.g.gmail.sentMessages().length, 1, 'second post on same story folded without sending a duplicate email');
    const foldCopy = t.chat.botPosts(MIRROR).filter(m => !m.threadReply).slice(-1)[0];
    eq(t.chat.botReactions(foldCopy.name), ['❌']);
    const leadThreadReplies = t.chat.botPosts(MIRROR).filter(m => m.threadReply && m.thread.name === leadCopy.thread.name);
    assert.ok(leadThreadReplies.some(m => m.text.includes('🔗 *Same story, no new email:*') && m.text.includes(url2)),
      JSON.stringify(leadThreadReplies.map(m => m.text)));

    // 20 minutes later: third post on the same story crosses 15,000 engagements (stakes rose: 10k+ tier!) -> ONE threaded update email!
    t.g.clock.now += 20 * 60e3;
    const url3 = 'https://x.com/breakingparis/status/2109952063492999999';
    const post3 = F.P0_OK
      .replace('https://x.com/WasSamLowryEsq/status/2109952063492993159', url3)
      .replace('1 Engagements', '15,000 Engagements')
      .replace('VERY LOW (1 engagements)', 'HIGH (15,000 engagements)')
      .replace(',1,WasSamLowryEsq,-,', ',15000,breakingparis,-,');
    t.chat.say(REAL, post3, ZAP);
    t.poll();
    eq(t.g.gmail.sentMessages().length, 2, 'stakes rising to 15,000 engagements sends one update email');
    eq(t.g.gmail.sentMessages()[1].threadId, t.g.gmail.sentMessages()[0].threadId, 'update replies on original Gmail thread');
    assert.ok(!t.g.logs.some(l => /seedRows is not a function/.test(l)), t.g.logs.join('\n'));
  });

  test('AlertMemory B30-blank flush dedup & foreign tab safeguard: flushing two queued rows for the same post sends only once, and a user-created tab named Alert memory (bot) is never overwritten', () => {
    const t = e2e();
    t.bot.setup();
    t.set('B25', REAL);
    t.set('B29', 'ON');
    t.set('B30', '');  // Testing with B30 blank: emails wait in pending queue
    const MIRROR = 'spaces/AAQAmirFlush1';
    const AC = 'spaces/AAQAacFlush1';
    t.chat.addSpace(MIRROR, 'Mirror Flush');
    t.chat.addSpace(AC, 'AC Flush');
    t.g.clock.now += 3600e3;
    t.bot.startMirror('Mirror Flush');
    t.bot.startAutoCorrect('AC Flush');
    t.chat.say(REAL, F.P0_OK, { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' });
    t.poll();
    eq(t.g.gmail.sentMessages().length, 0);

    // Now set B30: flushing pending rows across Mirror and AC sends ONLY 1 email, never 2!
    t.set('B30', 'tester@testing.test');
    t.poll();
    eq(t.g.gmail.sentMessages().length, 1);

    // Foreign tab ownership safeguard: user tab with same name is untouched
    const t2 = e2e();
    t2.bot.setup();
    const foreign = t2.sheet().insertSheet('Alert memory (bot)');
    foreign.getRange(1, 1, 2, 2).setValues([['User Col A', 'User Col B'], ['keep1', 'keep2']]);
    t2.set('B30', 'tester@testing.test');
    t2.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    t2.poll();
    eq(foreign.getRange(1, 1, 2, 2).getValues(), [['User Col A', 'User Col B'], ['keep1', 'keep2']]);
  });

  test('Knowledge compliance: Direct-BQ Step-1 builds structured query from records, pinned Resources docs stay whole, and hybrid RRF vector+BM25 passage selection runs when vectors are warm', () => {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);

    // 1. Direct-BQ Step-1 query builder extracts handles, products, and text (never "[object Object]")
    const q = H.plain(b.knowledgeQueryForRecords_([
      { author: '@TheChiefNerd', url: 'https://x.com/TheChiefNerd/status/2109', issue: 'AI Overview health advice',
        text: 'Gemini gave dangerous medical advice', record: { product: 'Gemini App', tags: 'Product - Dangerous results (e.g. medical/legal)' } },
    ]));
    assert.ok(!q.text.includes('[object Object]'), q.text);
    assert.ok(q.handles.includes('@TheChiefNerd'), JSON.stringify(q.handles));
    assert.ok(q.phrases.some(p => /Gemini/i.test(p)), JSON.stringify(q.phrases));

    // 2. Pinned document ("always read in full: ...") stays whole even above KNOWLEDGE_SHORT_CHARS_
    const longPolicy = 'Escalation Policy\n' + Array.from({ length: 120 }, (_, i) => `Rule ${i}: All P0 safety issues require immediate escalation to Comms.`).join('\n');
    const kbPinned = {
      docs: [
        { name: 'Core Policy', url: 'https://docs.google.com/document/d/1PinDoc/edit', covers: 'always read in full: core rules', text: longPolicy },
        KB().docs[2],
      ],
    };
    const selPin = b.knowledgeFor_(kbPinned, { text: 'Waymo remote operators', phrases: ['Waymo'], handles: [] }, { budget: 18000, pin: true });
    eq(selPin.docs[0].whole, true);

    // 3. Hybrid RRF semantic + lexical retrieval when passage vectors are warm in script cache
    const kb = KB();
    kb.docs[2] = Object.assign({}, kb.docs[2], { text: kb.docs[2].text + '\n' + 'Maps routing guidelines for regional closures.\n'.repeat(500) });
    const idx = b.knowledgeVecIndex_(kb.docs);
    const ensured = b.knowledgeVecEnsure_(idx, {});
    eq(ensured.ok, true);
    const ctx = { knowledge: kb, deadline: NOW + 60000, log: () => {} };
    const hybrid = b.knowledgeForCtx_(ctx, { text: 'AI Overviews gave dangerous medical advice', phrases: ['AI Overviews'], handles: ['@TheChiefNerd'] }, { budget: 3600 });
    eq(hybrid.mode, 'hybrid');
    assert.ok(hybrid.text.includes('Any AI Overview that gives dangerous medical advice is P0'));
  });
};
