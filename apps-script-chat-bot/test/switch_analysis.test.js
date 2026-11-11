// Analysis tab (Analysis.gs) & Google Sheets 3-subtab Sidepanel (apps-script-sheet-sidepanel/Code.gs):
// 1-row frozen comparison header, side-by-side Bot vs. Google Analyst responses, Bot Logic, Knowledge Base snippets,
// and Sidepanel subtabs (Overview, Controls & Filters, Scorecard).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = H => {
  const { test, eq, assert, NOW, makeGoogle, loadBot, FakeSpreadsheet } = H;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  function loadSidepanel(ss) {
    let active = ss.sheets[0];
    const uiCalls = { menus: [], sidebars: [] };
    const sandbox = {
      console,
      SpreadsheetApp: {
        getActiveSpreadsheet: () => Object.assign(ss, {
          getActiveSheet: () => active,
          setActiveSheet: sh => { active = sh; return sh; },
        }),
        getUi: () => ({
          createMenu: title => {
            const m = { title, items: [], addItem(label, fn) { m.items.push([label, fn]); return m; }, addSeparator() { return m; }, addToUi() { uiCalls.menus.push(m); return m; } };
            return m;
          },
          showSidebar: html => { uiCalls.sidebars.push(html); },
        }),
      },
      HtmlService: {
        createTemplateFromFile: file => ({
          initialTab: 'overview',
          evaluate() {
            const out = { file, initialTab: this.initialTab, title: '', setTitle(t) { out.title = t; return out; } };
            return out;
          },
        }),
      },
    };
    const ctx = vm.createContext(sandbox);
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script-sheet-sidepanel', 'Code.gs'), 'utf8');
    vm.runInContext(code, ctx, { filename: 'Code.gs' });
    return { panel: ctx, uiCalls, getActive: () => active };
  }

  function makeAnalysisEnv() {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const ss = new FakeSpreadsheet('sheet-analysis', 'Burson QA bot');
    ss.sheets[0].setName('Control');
    bot.ensureControlTab_(ss, 'bot@runner.test');
    bot.ensureResourcesTab_(ss);
    bot.ensureGuidanceTab_(ss);
    const ctx = {
      now: () => g.clock.now,
      deadline: g.clock.now + 180 * 1000,
      partition: 'spaces/MIRROR > spaces/MIRROR (isolated)',
      outboundBlocked: true,
      switches: { noWait: true, learnIm: true },
      settings: Object.assign({}, bot.ev('GEN.settings'), { speed_days: 7 }),
      log: () => {},
    };
    return { g, bot, ss, ctx };
  }

  function seedKnowledgeCache(bot, ss, docs) {
    const sh = bot.knowledgeTab_(ss);
    const entries = new Map();
    docs.forEach((d, idx) => {
      entries.set(d.url, {
        meta: {
          url: d.url,
          status: 'ok',
          name: d.name,
          covers: d.covers || '',
          burson: !!d.burson,
          label: 'Google Doc',
          read_at: NOW,
          chars: d.text.length,
          order: idx,
          reader: 2,
        },
        text: d.text,
      });
    });
    bot.writeKnowledgeTab_(sh, entries);
  }

  function findTableRows(sh) {
    const headIdx = sh.rows.findIndex(r => r && r[0] === 'Posted / Asked (ET)');
    assert.ok(headIdx >= 0, 'Analysis header row should exist');
    const header = sh.rows[headIdx];
    const data = sh.rows.slice(headIdx + 1).filter(r => r && r.some(v => String(v || '').trim() !== ''));
    return { headRow: headIdx + 1, header, data };
  }

  test('Analysis tab: pairs Bot response (Social Alert, QA fixes, emojis & Q&A) next to Google Analyst response (Relay Chat replies, emojis & IM call), with Bot Logic and verbatim Knowledge Base snippets', () => {
    const { g, bot, ss, ctx } = makeAnalysisEnv();

    // 1. Seed two readable Knowledge Base docs in "Knowledge cache (bot)"
    seedKnowledgeCache(bot, ss, [
      {
        name: 'SLRR Collection Requirements',
        url: 'https://docs.google.com/document/d/doc_collection_reqs_12345/edit',
        covers: 'Exposure tags, product taxonomy, and Social Alert thresholds',
        burson: true,
        text: [
          'Product Taxonomy Rules',
          '',
          'Gems and custom Gemini assistants must always be tagged under Product: Gemini App (never "Gems" as a standalone product).',
          '',
          'Social Alert Escalation Bar',
          '',
          'P0 Security & Privacy Vulnerabilities affecting Gemini App or Search require immediate Social Alert escalation regardless of engagement count, plus a Trust & Safety intake form when prompt injection or account takeover is alleged.',
        ].join('\n'),
      },
      {
        name: 'Gemini Outage Holding Statements',
        url: 'https://docs.google.com/document/d/doc_outage_comms_67890/edit',
        covers: 'Reactive talking points for Gemini App issues',
        burson: false,
        text: [
          'Gemini App Prompt Injection Guidance',
          '',
          'Holding statement: Our security team investigates all reported prompt-injection claims and deploys mitigations continuously.',
        ].join('\n'),
      },
    ]);

    // 2. Seed an active Guidance row and a Learned precedent
    const gSh = ss.getSheetByName('Guidance');
    gSh.appendRow(['Escalate any Gemini App prompt injection claim from security researchers as P0', 'Gemini App', '', 'lead@alerts.test']);
    const lSh = bot.learnedTab_(ss, true);
    bot.writeLearnedTab_(lSh, [{
      key: 'x:999999999999',
      at: NOW - 2 * DAY,
      post: 'https://x.com/prev/status/999999999999',
      product: 'Gemini App',
      exposure_tag: 'Security / Privacy Issue',
      engagements: 1200,
      kof: 'Yes',
      bot_call: 'No Social Alert',
      im_call: 'Social Alert',
      lesson: 'IMs escalated Gemini App security researcher threads even under 2K engagements.',
      active: 'Yes',
    }]);

    // 3. Seed two Alert log rows:
    //    Alert 1: Escalated P0 Gemini App alert with QA fix + Relay analyst emojis & replies + Bot Q&A
    //    Alert 2: Disagreement (IM sent Social Alert, Bot said No Social Alert)
    const alertTable = bot.sheetTable_(ss, 'Alert log', bot.ev('ALERT_COLUMNS_'), 'alert_id', 4000);
    alertTable.append({
      alert_id: 'QA-2001',
      created_at: NOW - 3 * HOUR,
      source_at: NOW - 3 * HOUR - 2 * MIN,
      space: ctx.partition,
      source_message: 'spaces/MIRROR/messages/m1',
      source_thread: 'spaces/MIRROR/threads/t1',
      forward_message: 'spaces/MIRROR/messages/fwd1',
      forward_thread: 'spaces/MIRROR/threads/t1',
      live_message: 'spaces/SFB/messages/live1',
      live_thread: 'spaces/SFB/threads/lt1',
      status: 'ok',
      requested: [
        { field: 'product', old: 'Gems', new: 'Gemini App', reason: 'Gems belongs under Gemini App per SLRR taxonomy' },
      ],
      forwarded_fields: {
        product: 'Gemini App',
        exposure_tag: 'Security / Privacy Issue',
        issue_name: 'Prompt Injection Claim in Gemini App',
        social_network: 'X',
        author: '@sec_researcher',
        post_url: 'https://x.com/sec_researcher/status/1845000000001',
        total_engagement: 4800,
        kof: true,
      },
      email_status: 'sent',
      email_sent_at: NOW - 3 * HOUR + MIN,
      email_subject: '🟥SOCIAL ALERT🟥: Gemini App | Prompt Injection Claim in Gemini App | X | 4,800 Engagements',
      email_groups: 'gup gcpa tns',
      tns_submitted: NOW - 3 * HOUR + MIN,
      feedback: '👍',
      knowledge_used: [
        { document: 'SLRR Collection Requirements', used_for: 'Gems -> Gemini App taxonomy & P0 security escalation bar' },
      ],
      email_input: {
        fields: {
          product: 'Gemini App',
          exposure_tag: 'Security / Privacy Issue',
          issue_name: 'Prompt Injection Claim in Gemini App',
          social_network: 'X',
          author: '@sec_researcher',
          post_url: 'https://x.com/sec_researcher/status/1845000000001',
          total_engagement: 4800,
        },
        escalation: {
          escalated: true,
          priority: 'P0',
          product: 'Gemini App',
          exposure_tag: 'Security / Privacy Issue',
          reasons: ['P0 Exposure Tag: Security / Privacy Issue', 'KOF author (@sec_researcher)'],
          ts_reasons: ['Alleged prompt injection exploit steps shared publicly'],
        },
        ai_reasons: { GCPA: 'Policy & security comms visibility' },
        comms_context: 'Holding statement on prompt-injection mitigations applies.',
      },
    });

    alertTable.append({
      alert_id: 'QA-2002',
      created_at: NOW - 30 * HOUR,
      source_at: NOW - 30 * HOUR,
      space: ctx.partition,
      source_message: 'spaces/MIRROR/messages/m2',
      source_thread: 'spaces/MIRROR/threads/t2',
      forward_message: 'spaces/MIRROR/messages/fwd2',
      forward_thread: 'spaces/MIRROR/threads/t2',
      status: 'ok',
      requested: [],
      forwarded_fields: {
        product: 'Pixel',
        exposure_tag: 'Product Bug / Glitch',
        issue_name: 'Pixel Battery Drain Complaint',
        social_network: 'Reddit',
        author: 'u/pixel_owner',
        post_url: 'https://www.reddit.com/r/GooglePixel/comments/abc123def/battery_drain/',
        total_engagement: 320,
      },
      email_status: '',
      decision: '❌ Below engagement threshold (320 < 2,000) and not a P0 tag or KOF',
      knowledge_used: [],
      email_input: {
        fields: {
          product: 'Pixel',
          exposure_tag: 'Product Bug / Glitch',
          issue_name: 'Pixel Battery Drain Complaint',
          social_network: 'Reddit',
          author: 'u/pixel_owner',
          post_url: 'https://www.reddit.com/r/GooglePixel/comments/abc123def/battery_drain/',
          total_engagement: 320,
        },
        escalation: { escalated: false, suppression: 'Standard P2 bug under engagement floor' },
      },
    });

    // 4. Seed Relay names & Relay rows showing Google analysts' Chat emojis & replies on Alert 1
    const namesTable = bot.sheetTable_(ss, 'Relay names', bot.ev('RELAY_NAMES_COLUMNS_'), 'user', 2000);
    namesTable.append({ user: 'users/google_anisa', name: 'Anisa Washington (xWF)', org: 'Google', seen_in: 'S-F Burson' });
    namesTable.append({ user: 'users/burson_sam', name: 'Sam Carter', org: 'Burson', seen_in: 'S-F Burson' });

    const relayTable = bot.sheetTable_(ss, 'Relay', bot.ev('RELAY_COLUMNS_'), 'key', 3000);
    relayTable.append({
      when: new Date(NOW - 3 * HOUR).toISOString(),
      direction: 'From S-F Burson',
      what: 'emoji',
      who: 'Anisa Washington (xWF) (Google)',
      user: 'users/google_anisa',
      text: '📦',
      status: 'copied',
      burson_message: 'spaces/SFB/messages/live1',
      burson_thread: 'spaces/SFB/threads/lt1',
      test_message: 'spaces/MIRROR/messages/m1',
      test_thread: 'spaces/MIRROR/threads/t1',
      key: 'emo1',
    });
    relayTable.append({
      when: new Date(NOW - 3 * HOUR + 3 * MIN).toISOString(),
      direction: 'To S-F Burson',
      what: 'reply',
      who: 'Anisa Washington (xWF)',
      user: 'users/google_anisa',
      text: 'Confirmed Gemini App taxonomy — drafting P0 Social Alert and submitting T&S now.',
      status: 'sent',
      burson_message: 'spaces/SFB/messages/live_r1',
      burson_thread: 'spaces/SFB/threads/lt1',
      test_message: 'spaces/MIRROR/messages/m_r1',
      test_thread: 'spaces/MIRROR/threads/t1',
      key: 'rep1',
    });

    // 5. Record a live Bot Q&A exchange on Alert 1's thread
    bot.recordAnalysisQa_(ctx, {
      message: 'spaces/MIRROR/messages/q1',
      thread: 'spaces/MIRROR/threads/t1',
      at: NOW - 2 * HOUR,
      space: 'Mirror space',
      who: 'Sam Carter (Burson)',
      question: 'Should Gems posts use Gemini App as the Product field?',
      bot_answer: 'Yes — per SLRR Collection Requirements, Gems and custom Gemini assistants are categorized under Gemini App.',
      alert_id: 'QA-2001',
      docs_used: [{ name: 'SLRR Collection Requirements', whole: true, chars: 420 }],
    });

    // 6. Seed IM drafts cache (IMs sent Social Alerts for BOTH Alert 1 and Alert 2 -> Alert 1 is Aligned, Alert 2 is Disagreement)
    const drafts = () => [
      {
        post_url: 'https://x.com/sec_researcher/status/1845000000001',
        at: NOW - 3 * HOUR + 8 * MIN,
        subject: '🟥SOCIAL ALERT🟥: Gemini App | Prompt Injection Claim | X',
        drafted_by: 'anisa@runner.test',
      },
      {
        post_url: 'https://www.reddit.com/r/GooglePixel/comments/abc123def/battery_drain/',
        at: NOW - 29 * HOUR,
        subject: '\ud83d\udfe8SOCIAL ALERT\ud83d\udfe8: Pixel | Battery Drain Thread | Reddit',
        drafted_by: 'im_lead@runner.test',
      },
    ];

    const res = bot.refreshAnalysis_(ss, ctx, { drafts, logged: () => [] });
    eq([res.alerts, res.qa, res.total, res.shown], [2, 1, 3, 3]);
    eq([res.scorecard.aligned, res.scorecard.decided, res.scorecard.imOnly, res.scorecard.botOnly], [1, 2, 1, 0]);

    const sh = ss.getSheetByName('Analysis');
    assert.ok(sh, 'Analysis sheet created');
    assert.ok(bot.isAnalysisTab_(sh), 'Ownership marker recognized');

    const { headRow, data } = findTableRows(sh);
    eq(headRow, 1);          // Row 1 is immediately the comparison header (zero 16-row preamble)
    eq(sh.frozenRows, 1);    // Only Row 1 is frozen
    eq(data.length, 3);      // Q&A (-2h), Alert 1 (-3h), Alert 2 (-30h)

    // Verify 3-subtab Sidepanel state (Overview, Controls & Filters, Scorecard) + Test Alert menu via Code.gs
    const { panel, uiCalls } = loadSidepanel(ss);
    panel.onOpen();
    eq(uiCalls.menus.length, 2);
    eq(uiCalls.menus[0].title, '📊 Bot Analysis');
    eq(uiCalls.menus[1].title, '🧪 Test Alert');
    panel.openAnalysisScorecard();
    eq(uiCalls.sidebars.length, 1);
    eq(uiCalls.sidebars[0].initialTab, 'scorecard');

    const panelState = panel.getAnalysisSidepanelState();
    assert.strictEqual(panelState.exists, true);
    eq([panelState.overview.kbDocs, panelState.overview.guidanceCount, panelState.overview.learnedCount], [2, 1, 1]);
    eq([panelState.controls.windowLabel, panelState.controls.focus, panelState.controls.shown, panelState.controls.totalInWindow],
      ['7 days', 'All items', 3, 3]);
    eq([panelState.scorecard.aligned, panelState.scorecard.decided, panelState.scorecard.imOnly, panelState.scorecard.mistakes, panelState.scorecard.qaCount],
      [1, 2, 1, 1, 1]);

    const qaRow = data[0];
    eq(qaRow[1], 'Thread Q&A');
    assert.match(qaRow[4], /Asked by Sam Carter \(Burson\): "Should Gems posts use Gemini App/);
    assert.match(qaRow[4], /🤖 Bot answered: "Yes — per SLRR Collection Requirements/);
    assert.match(qaRow[5], /Anisa Washington \(xWF\): "Confirmed Gemini App taxonomy/);
    assert.match(qaRow[8], /📄 SLRR Collection Requirements \(consulted for answer\)/);
    assert.match(qaRow[8], /Gems and custom Gemini assistants must always be tagged under Product: Gemini App/);

    const alert1 = data[1];
    eq(alert1[1], 'Alert');
    // Bot side: Social Alert + QA fix + emojis + Q&A reply
    assert.match(alert1[4], /🚨 Social Alert \(sent in 3 min\)/);
    assert.match(alert1[4], /Product: Gems to Gemini App/);
    assert.match(alert1[4], /✍️ T&S form: auto-submitted/);
    assert.match(alert1[4], /Bot Q&A reply/);
    // Google analyst side: IM Social Alert + Relay emoji + Relay reply + 👍 feedback
    assert.match(alert1[5], /🚨 IM Call: Social Alert \(SLRR draft, by anisa, 10 min\)/);
    assert.match(alert1[5], /📦 \(Anisa Washington \(xWF\)\)/);
    assert.match(alert1[5], /Analyst feedback on bot: 👍/);
    assert.match(alert1[5], /Anisa Washington \(xWF\): "Confirmed Gemini App taxonomy/);
    // Alignment
    assert.match(alert1[6], /^✓ Aligned \(Social Alert\)/);
    // Bot's Logic: escalation rule + QA fix reason + routing + Guidance + Learned precedent
    assert.match(alert1[7], /1\) Call logic: \[P0\]/);
    assert.match(alert1[7], /Product \(Gems → Gemini App\): Gems belongs under Gemini App/);
    assert.match(alert1[7], /3\) Routing logic: GCPA: Policy & security comms visibility · T&S: Alleged prompt injection/);
    assert.match(alert1[7], /📌 Active Guidance \(Gemini App\): "Escalate any Gemini App prompt injection claim/);
    assert.match(alert1[7], /📚 Learned precedent \(Gemini App\): IMs escalated Gemini App security researcher/);
    // Knowledge Base snippet from "Knowledge cache (bot)"
    assert.match(alert1[8], /📄 SLRR Collection Requirements — used for: Gems -> Gemini App taxonomy/);
    assert.match(alert1[8], /Gems and custom Gemini assistants must always be tagged under Product: Gemini App/);

    const alert2 = data[2];
    assert.match(alert2[6], /^⚠️ Disagreement: IM alerted, Bot didn't/);
    assert.match(alert2[7], /Below engagement threshold/);
  });

  test('Analysis Sidepanel interactive controls, live verdict recounting & Layout 1 -> Layout 2 upgrade', () => {
    const { g, bot, ss, ctx } = makeAnalysisEnv();
    ss.insertSheet('Results', 3);

    const alertTable = bot.sheetTable_(ss, 'Alert log', bot.ev('ALERT_COLUMNS_'), 'alert_id', 4000);
    alertTable.append({
      alert_id: 'QA-3001',
      created_at: NOW - 2 * HOUR,
      source_at: NOW - 2 * HOUR,
      space: ctx.partition,
      status: 'ok',
      requested: [{ field: 'product', old: 'Bard', new: 'Gemini App', reason: 'Renamed to Gemini App' }],
      forwarded_fields: {
        product: 'Gemini App',
        exposure_tag: 'Product Bug / Glitch',
        issue_name: 'Gemini Latency Spike',
        social_network: 'X',
        author: '@user1',
        post_url: 'https://x.com/user1/status/3001000001',
      },
      email_status: 'sent',
      email_sent_at: NOW - 2 * HOUR + 3 * MIN,
      email_input: { escalation: { escalated: true, priority: 'P1', reasons: ['High velocity'] } },
    });
    alertTable.append({
      alert_id: 'QA-3002',
      created_at: NOW - 28 * HOUR,
      source_at: NOW - 28 * HOUR,
      space: ctx.partition,
      status: 'ok',
      requested: [],
      forwarded_fields: {
        product: 'Search',
        exposure_tag: 'General Commentary',
        issue_name: 'Routine Search Mention',
        social_network: 'X',
        author: '@user2',
        post_url: 'https://x.com/user2/status/3002000002',
      },
      email_status: 'sent',
      email_sent_at: NOW - 28 * HOUR + 4 * MIN,
      email_input: { escalation: { escalated: true, priority: 'P2', reasons: ['Engagement > 2K'] } },
    });

    // Seed RESULTS_BQ_CACHE_ so maybeRefreshAnalysis_ does zero network calls
    g.services.CacheService.getScriptCache().put('results_bq', JSON.stringify({ at: NOW, d: [], l: [] }), 21600);
    const fetchesBefore = g.fetches.length;

    assert.strictEqual(bot.maybeRefreshAnalysis_(ss, ctx, { activity: true }), true);
    assert.strictEqual(g.fetches.length, fetchesBefore, 'maybeRefreshAnalysis_ must make zero HTTP calls');

    const sh = ss.getSheetByName('Analysis');
    const { panel } = loadSidepanel(ss);
    let parsed = findTableRows(sh);
    eq(parsed.headRow, 1);
    eq(parsed.data.length, 2);

    // Analyst writes Verdict & Notes directly in Columns J & K on Row 2 (QA-3001) and Row 3 (QA-3002)
    sh.getRange(2, 10, 1, 2).setValues([['Bot right', 'Good Bard -> Gemini App catch']]);
    sh.getRange(3, 10, 1, 2).setValues([['Analyst right', 'Routine Search commentary']]);

    // Scorecard subtab reflects live verdicts immediately even BEFORE the next 1-minute poll()!
    const liveSc = panel.getAnalysisSidepanelState().scorecard;
    eq([liveSc.graded, liveSc.botRight, liveSc.analystRight], [2, 1, 1]);

    // Analyst uses Sidepanel Controls subtab to filter to "Disagreements only" -> rebuilds immediately even within 5s!
    g.clock.now += 5 * 1000;
    const saved = panel.saveAnalysisControls({ focus: 'Disagreements only' });
    assert.strictEqual(saved.saved.runNow, true);
    assert.strictEqual(bot.maybeRefreshAnalysis_(ss, ctx, { activity: false, deadline: g.clock.now + 45 * 1000 }), true);
    parsed = findTableRows(sh);
    eq(parsed.headRow, 1);
    eq(parsed.data.length, 1);  // Only QA-3002 (Bot-only disagreement)
    eq([parsed.data[0][9], parsed.data[0][10]], ['Analyst right', 'Routine Search commentary']);
    assert.strictEqual(panel.getAnalysisSidepanelState().controls.runNow, false);  // reset to false after rebuild

    // Analyst switches back to "All items" + "24 hours" -> QA-3001 returns with its saved Verdict & Notes intact!
    g.clock.now += 5 * 1000;
    panel.saveAnalysisControls({ windowLabel: '24 hours', focus: 'All items' });
    assert.strictEqual(bot.maybeRefreshAnalysis_(ss, ctx, { activity: false, deadline: g.clock.now + 45 * 1000 }), true);
    parsed = findTableRows(sh);
    eq(parsed.data.length, 1);  // Only QA-3001 (<24h)
    eq([parsed.data[0][9], parsed.data[0][10]], ['Bot right', 'Good Bard -> Gemini App catch']);

    // Verify seamless upgrade from legacy Layout 1 (15-row top header + B4:B7 filters + Row 16+ data)
    const legacy = ss.getSheetByName('Analysis');
    legacy.clearContents();
    legacy.getRange(1, 1).setValue('Analysis: Bot vs. Google Analysts — responses, logic & Knowledge Base snippets');
    legacy.getRange(4, 2, 4, 1).setValues([['Ready'], ['7 days'], ['All items'], ['Latency']]);
    legacy.getRange(15, 1, 1, 12).setValues([bot.ev('ANALYSIS_HEADER_').slice(0, 12)]);
    legacy.getRange(16, 1, 1, 12).setValues([[
      '2026-10-28 10:00', 'Alert', 'X · @user1', 'Gemini App', 'Bot', 'Analyst', 'Pending', 'Logic', 'KB',
      'Both acceptable', 'Legacy note preserved', 'post:x:3001000001',
    ]]);
    g.services.PropertiesService.getScriptProperties().setProperty('ANALYSIS_LAYOUT', '1');
    g.clock.now += 5 * 1000;
    assert.strictEqual(bot.maybeRefreshAnalysis_(ss, ctx, { activity: false }), true);
    parsed = findTableRows(legacy);
    eq(parsed.headRow, 1);
    eq(legacy.frozenRows, 1);
    eq(parsed.data.length, 1);  // Migrated legacy search='Latency' from B7 -> matched QA-3001!
    eq([parsed.data[0][9], parsed.data[0][10]], ['Both acceptable', 'Legacy note preserved']);
  });

  test('Analysis tab safety invariants: never overwrites a user-created "Analysis" tab, preserves Results/Follow-up/Learned tab order, and caps every cell <= 49,000 chars', () => {
    const { bot, ss, ctx } = makeAnalysisEnv();

    // 1. User-created "Analysis" tab is never touched
    const custom = ss.insertSheet('Analysis');
    custom.getRange(1, 1, 2, 2).setValues([['My Custom Sheet', 'Notes'], ['Keep me', 'Safe']]);
    const blocked = bot.refreshAnalysis_(ss, ctx, { drafts: () => [], logged: () => [] });
    assert.strictEqual(blocked.blocked, true);
    eq(custom.rows, [['My Custom Sheet', 'Notes'], ['Keep me', 'Safe']]);
    assert.strictEqual(bot.maybeRefreshAnalysis_(ss, ctx, { activity: true }), false);

    // 2. Rename user tab out of the way and verify tab insertion order after Results + Learned precedents + Follow-up
    custom.setName('Analyst Scratchpad');
    ss.insertSheet('Results', 3);
    bot.learnedTab_(ss, true);
    const fu = ss.insertSheet('Follow-up', ss.getSheets().map(s => s.getName()).indexOf('Results') + 1);
    fu.getRange(1, 1).setValue('Follow-up: what came of the bot\'s Social Alerts, and the next step');

    // Also include an oversized 80,000-char field to verify 49,000-char cell cap
    const alertTable = bot.sheetTable_(ss, 'Alert log', bot.ev('ALERT_COLUMNS_'), 'alert_id', 4000);
    alertTable.append({
      alert_id: 'QA-4001',
      created_at: NOW - HOUR,
      source_at: NOW - HOUR,
      space: ctx.partition,
      status: 'ok',
      decision: '❌ ' + 'A'.repeat(60000),
      forwarded_fields: { product: 'YouTube', issue_name: '=SUM(1,2)', post_url: 'https://x.com/u/status/4001001' },
    });

    const ok = bot.refreshAnalysis_(ss, ctx, { drafts: () => [], logged: () => [] });
    assert.ok(!ok.blocked);
    const names = ss.getSheets().map(s => s.getName());
    // Follow-up stays immediately after Results, and Analysis sits right after Results/Follow-up/Learned precedents
    assert.strictEqual(names.indexOf('Follow-up'), names.indexOf('Results') + 1);
    assert.ok(names.indexOf('Analysis') > names.indexOf('Learned precedents'));

    const sh = ss.getSheetByName('Analysis');
    sh.rows.forEach((row, rIdx) => {
      (row || []).forEach((cell, cIdx) => {
        assert.ok(String(cell || '').length <= 49000, `Row ${rIdx + 1} col ${cIdx + 1} exceeded 49,000 chars`);
      });
    });
  });
};
