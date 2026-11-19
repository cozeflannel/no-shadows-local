// The escalation thresholds in Gemini's playbook (Review.gs playbookText_): the four "Escalation thresholds" lines
// Voice.gs escalationRuleLines_ writes from the config (the 2,000-engagement bar, the ongoing-issue rule, the Sensitive
// Topic rule, the owned-post rule) reach every prompt that carries the playbook: the alert review, the Early Detection
// review, the Watch triage and Step 1 of the Direct BigQuery evaluation. Where Gemini's own call decides (a story, a
// watch flag, a Step 1 record), one sentence beside the playbook says the thresholds are about the Social Alert email
// and never by themselves a reason to drop it. requirementsLines_ (which also feeds the answers to Burson) is as it was.
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = H => {
  const { test, eq, assert, B, F, parse } = H;
  const golden = require('./golden_flows')(H);

  const STEP1_GUARD = 'The escalation thresholds decide the Social Alert email later; they are never a reason to discard a record here.';
  const STORY_GUARD = 'The escalation thresholds in the playbook decide the Social Alert email for a single post; they are never by ' +
    'themselves a reason to dismiss an early build-up among small accounts.';
  const WATCH_GUARD = 'The escalation thresholds in the playbook decide the Social Alert email for a single post; they are never by ' +
    'themselves a reason to call a watch flag no action.';
  const GUARDS = [STEP1_GUARD, STORY_GUARD, WATCH_GUARD];

  // requirementsLines_ at f93e31a (before the playbook carried the thresholds): its 16 lines that are not taxonomy
  // bullets, as text (the bullets are the config's exposure tags and Sensitive Topics, checked against the config
  // below). The lines are built from the config (product names, platform domains, the always-alert tags, the briefed
  // topics that are on), so a config change moves them too: a difference names the line and shows where it differs.
  // When a line is meant to change, record the lines again and name the change in the commit:
  //   REQUIREMENT_LINES_UPDATE=1 node apps-script-chat-bot/test/run_tests.js "playbook thresholds: requirementsLines_"
  // The record guards this round's promise that the fix plan leaves these lines alone; once the round is merged and
  // released it can go, with the comparison below.
  const REQUIREMENT_LINES_FILE = path.join(__dirname, 'requirement_lines_f93e31a.json');
  /** Where two lists of lines differ: [] when they are the same, else one sentence a line, with the words around the place. */
  const lineDifferences = (actual, expected) => {
    const out = [];
    const head = l => String(l).split(/[:(,]/)[0].trim();
    for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
      const a = actual[i];
      const e = expected[i];
      if (a === e) continue;
      if (a === undefined) { out.push(`line ${i + 1} ("${head(e)}") is missing`); continue; }
      if (e === undefined) { out.push(`line ${i + 1} ("${head(a)}") is new: ${JSON.stringify(a.slice(0, 160))}`); continue; }
      let at = 0;
      while (at < a.length && a[at] === e[at]) at++;
      const from = Math.max(0, at - 40);
      out.push(`line ${i + 1} ("${head(e)}") differs at character ${at + 1}: now ${JSON.stringify(a.slice(from, at + 80))}, ` +
        `recorded ${JSON.stringify(e.slice(from, at + 80))}`);
    }
    return out;
  };

  /** The four prompts that carry the playbook (their system text), and the evaluation's prompt when both tracks are asked for. */
  const prompts = () => {
    const views = [B.bqRecordView_({ id: 'c0', source_kind: 'BSIP', url: 'https://x.com/mapsfan/status/2112000000000000001', handle: 'mapsfan',
      summary: 'An X user says Google Maps sent drivers onto a closed bridge.', issue_name: 'Maps routing onto a closed bridge', total: 900 }, 0)];
    return {
      review: B.assessPrompts_(parse(F.P0_OK)).system,
      story: B.edReviewPrompts_({ kind: 'early_detection', ed: { alertId: 'ED-1', headline: 'Pixel owners report a frozen dialer', distinctAuthors: 6 }, fields: {} }).system,
      triage: B.otherTriagePrompts_({ kind: 'other', other: { topic: 'Google brand safety (all)', text: 'A post about Gemini', watch: { name: 'Google brand safety (all)' } } }).system,
      step1: B.bqAlertPrompts_(views, null, [], [], { soloOnly: true }).system,
      bothTracks: B.bqAlertPrompts_(views, null, [], [], {}).system,
    };
  };

  test('playbook thresholds: the playbook Gemini is given carries the four "Escalation thresholds" lines as the config words them (the 2,000-engagement bar, the ongoing-issue rule, the Sensitive Topic rule, the owned-post rule), and each of the four prompts that carries the playbook has them: the alert review, the Early Detection review, the Watch triage and Step 1 of the Direct BigQuery evaluation', () => {
    const lines = B.escalationRuleLines_();
    const playbook = B.playbookText_();
    eq([lines.length, lines.every(l => /^Escalation thresholds/.test(l))], [4, true]);
    eq(playbook.split('\n').filter(l => /^- Escalation thresholds/.test(l)), lines.map(l => `- ${l}`));
    const bar = `${B.ev('GEN').escalation_rules.high_engagement_threshold.toLocaleString('en-US')}+ engagements`;
    eq(bar, '2,000+ engagements');
    const ongoing = `Escalation thresholds, ongoing issues: when the same issue was already alerted in the last ${B.ev('GEN').novelty_days} days, it is ` +
      `escalated again only for a KOF author or at ${bar}`;
    [`HIGH ENGAGEMENT at ${bar} for any other issue`, ongoing, 'Escalation thresholds, Sensitive Topics: Politics counts only for a',
      'Escalation thresholds, owned social posts: '].forEach(s => assert.ok(playbook.includes(s), s));
    // the lines it carried before are still there, in the order the requirements give them, then the process notes
    eq(playbook.split('\n').map(l => l.split(/[:(,]/)[0]).filter(h => /^- (?:KOF|Issue status|Escalation thresholds|Trust & Safety|YouTube protocol)/.test(h)),
      ['- KOF ', '- Issue status', '- Escalation thresholds ', '- Escalation thresholds', '- Escalation thresholds', '- Escalation thresholds',
        '- Trust & Safety ', '- YouTube protocol']);
    eq(playbook.split('\n').length, 13);  // 9 at f93e31a, and the four
    const p = prompts();
    ['review', 'story', 'triage', 'step1', 'bothTracks'].forEach(k => {
      assert.ok(p[k].includes(playbook), `${k}: the whole playbook`);
      assert.ok(p[k].includes(`HIGH ENGAGEMENT at ${bar}`) && p[k].includes(ongoing), `${k}: the bar and the ongoing-issue rule`);
    });
  });

  test('playbook thresholds: one sentence beside the playbook where Gemini\'s own call decides: Step 1 ("never a reason to discard a record here", on its MODE line), the Early Detection review ("never by themselves a reason to dismiss an early build-up among small accounts") and the Watch triage ("... to call a watch flag no action"), each right under the playbook; the alert review and the evaluation with both tracks have none', () => {
    const p = prompts();
    const playbook = B.playbookText_();
    assert.ok(p.step1.includes('other record\'s id in `discarded_ids`. `group_waves` must be empty. ' + STEP1_GUARD + `\n\n${playbook}\n`), 'Step 1');
    assert.ok(p.story.includes(`SLRR PLAYBOOK:\n${playbook}\n${STORY_GUARD}\n\nTEAMS (recommended_groups):`), 'the Early Detection review');
    assert.ok(p.triage.includes(`SLRR PLAYBOOK:\n${playbook}\n${WATCH_GUARD}\n\nTEAMS (recommended_groups):`), 'the Watch triage');
    const has = k => GUARDS.map(g => p[k].includes(g));
    eq([has('step1'), has('story'), has('triage'), has('review'), has('bothTracks')],
      [[true, false, false], [false, true, false], [false, false, true], [false, false, false], [false, false, false]]);
    // each sentence once
    eq([p.step1.split(STEP1_GUARD).length, p.story.split(STORY_GUARD).length, p.triage.split(WATCH_GUARD).length], [2, 2, 2]);
  });

  test('playbook thresholds: requirementsLines_ is as it was at f93e31a (it also feeds the answers to Burson): the same lines in the same order and words, its four threshold lines exactly escalationRuleLines_\'s, no collection-threshold line brought back; Burson\'s answer prompt carries no guard sentence', () => {
    const lines = B.requirementsLines_();
    const own = lines.filter(l => !/^- /.test(l));
    eq(own.map(l => l.split(/[:(,]/)[0].trim()), ['Exposure tags', 'Renamed exposure tags', 'Sensitive Topics', 'Product names',
      'Products no longer used', 'Engagement levels', 'KOF', 'Social Network must match the link', 'Issue status', 'Summary & formatting',
      'Escalation thresholds', 'Escalation thresholds', 'Escalation thresholds', 'Escalation thresholds', 'Trust & Safety', 'Emoji reactions on alerts']);
    if (process.env.REQUIREMENT_LINES_UPDATE === '1') fs.writeFileSync(REQUIREMENT_LINES_FILE, `${JSON.stringify(own, null, 1)}\n`);
    const recorded = JSON.parse(fs.readFileSync(REQUIREMENT_LINES_FILE, 'utf8'));
    eq(lineDifferences(own, recorded), []);
    // ...and a difference says which line and where: a product added to the config, a line gone, a line more
    const added = own.map(l => (/^Product names: /.test(l) ? l.replace('Product names: ', 'Product names: Pixel Glass, ') : l));
    const said = lineDifferences(added, recorded);
    eq([said.length, /^line 4 \("Product names"\) differs at character 16: now "Product names: Pixel Glass, Ads\/Merchant Center, [^"]+", recorded "Product names: Ads\/Merchant Center, [^"]+"$/.test(said[0])],
      [1, true], said[0]);
    eq([lineDifferences(own.slice(0, -1), recorded), lineDifferences(own.concat(['Reviews: none']), recorded)],
      [['line 16 ("Emoji reactions on alerts") is missing'], ['line 17 ("Reviews") is new: "Reviews: none"']]);
    eq(lines.filter(l => /^Escalation thresholds/.test(l)), B.escalationRuleLines_());
    assert.ok(!lines.some(l => /^(?:Collection thresholds|When alerts are escalated)/.test(l)));
    // the taxonomy bullets are the config's: one for each exposure tag and each Sensitive Topic
    const G = B.ev('GEN');
    eq(lines.filter(l => /^- /.test(l)).length, G.exposure_tags.length + G.sensitive_topics.length);
    const answer = B.answerPrompts_('where does the 2,000 rule come from?', { requested: [] }, []);
    GUARDS.forEach(g => assert.ok(!`${answer.system}\n${answer.prompt}`.includes(g), g));
  });

  test('playbook thresholds: in a run, the prompts the bot sends carry them: in the one-space setup every alert review, every story review, every watch triage and every Step 1 call has the threshold lines, and the story review, the watch triage and Step 1 each their sentence; what the bot posts is unchanged (the golden flows)', () => {
    const { t, out } = golden.oneSpaceRun(golden.SETTINGS_OFF);
    eq(golden.differences(out, golden.recorded.one_space), []);
    const playbook = t.bot.playbookText_();
    const systems = prop => t.g.vertex.calls.filter(c => ((c.payload.generationConfig.responseSchema || {}).properties || {})[prop])
      .map(c => c.payload.systemInstruction.parts[0].text);
    const kinds = { review: systems('checks'), story: systems('early_detection_call'), triage: systems('stream_call'), step1: systems('group_waves') };
    eq(Object.keys(kinds).map(k => [k, kinds[k].length > 0, kinds[k].every(s => s.includes(playbook) && s.includes('2,000+ engagements'))]),
      [['review', true, true], ['story', true, true], ['triage', true, true], ['step1', true, true]]);
    eq([kinds.story.every(s => s.includes(STORY_GUARD)), kinds.triage.every(s => s.includes(WATCH_GUARD)), kinds.step1.every(s => s.includes(STEP1_GUARD)),
      kinds.review.some(s => GUARDS.some(g => s.includes(g)))], [true, true, true, false]);
  });
};
