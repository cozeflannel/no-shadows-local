/**
 * TnsForm.gs — the pre-filled Trust & Safety Intake Form link in the bot's ✍️ T&S note. A person opens the link, checks
 * the answers and clicks Submit. With the Control tab's "Auto-submit T&S form" ON (OFF until someone turns it on), the
 * bot submits those same answers itself instead (Drafts.gs autoSubmitTns_, submitTnsForm_ here): the test copy while
 * testing, the real form only live, and only once its editor id is in the script property TNS_LIVE_FORM_ID.
 *
 * Testing (escalation.stand_in set, as now): the link opens a test copy of the form in the tester's Drive, never the real
 * one. Same questions and choices; the bot makes it the first time it needs it (or run setupTnsTestForm()). It isn't
 * shared with anyone. Submitting it sends nothing to Trust & Safety: the tester gets a stand-in for T&S's
 * "Issue [#…]: WD Intake Request" email instead, so the bot's ✍️ marking can be tried end to end.
 * Live (no stand-in): the link opens the real form, go/WD-Triage.
 *
 *   tnsPrefillUrl_(input)     the pre-filled link for an alert's email input ('' while testing if there's no test copy)
 *   tnsFormValues_(input)     what goes in each question: {team, product, topic, url, issue, notes}
 *   submitTnsForm_(id, v)     submits those answers to the form with editor id `id` (Auto-submit T&S form; throws)
 *   setupTnsTestForm()        makes the test copy now (or finds it) and logs its links
 *   onTnsTestFormSubmit(e)    the test copy's submit trigger: the stand-in confirmation email, to the tester only
 */

// The real form (go/WD-Triage). Its question ids and choices were read off the form on Oct 18, 2026. (The SLRR
// Assistant's old link picked Marketing with entry.290320498, which is no longer a question on the form.)
const TNS_FORM_BASE_URL_ = 'https://docs.google.com/forms/d/e/1FAIpQLScd0beRIurDyc5beuY9_tYDEvp-UFAIKY2FWTdLvsUV4whSkw/viewform';
const TNS_FORM_URL_ = TNS_FORM_BASE_URL_ + '?entry.891514386=Marketing';  // Team only
const TNS_FORM_FIELDS_ = {
  team: 'entry.891514386',     // "[Title_Prefix] WD Intake Request": Marketing ("so we get credit")
  product: 'entry.966872365',  // "Google Product:"
  topic: 'entry.595767202',    // "Topic Impacted:"
  url: 'entry.214972794',      // "Link / URL(s) in question:"
  issue: 'entry.2113132974',   // "What's the Issue?"
  notes: 'entry.392523390',    // "Additional screenshots/notes etc:"
};
// The form's questions in order, with their choices, exactly as on the real form (the test copy is made from these)
const TNS_QUESTIONS_ = [
  { key: 'product', title: 'Google Product:', choices: ['Ads', 'AI Studio', 'Gemini', 'Geo (Maps)', 'Pixel (Screenshots)',
    'Pixel (Smart notes)', 'Pixel (Studio Image)', 'Play', 'Search', 'Search (AI Overviews)', 'Search (AI Mode)', 'Workspace', 'Other'] },
  { key: 'topic', title: 'Topic Impacted:', choices: ['Geopolitical Dynamics', 'Major Civic Events',
    'Vulnerable or Marginalized Groups', 'Global Perception of Bias', 'Violence, Extremism & Hate', 'Information Quality',
    'Frauds, Scams and Misuse of User Data', 'Miscellaneous'] },
  { key: 'url', title: 'Link / URL(s) in question:' },
  { key: 'issue', title: 'What\'s the Issue? ', paragraph: true },
  { key: 'notes', title: 'Additional screenshots/notes etc:', paragraph: true, optional: true },
  { key: 'team', title: '[Title_Prefix] WD Intake Request', radio: true, choices: ['Marketing', 'T&S Analysis & Investigations',
    'VRP (Special Collections)', 'Ads Tactical Intel  (Scaled Collections)', 'CART', 'gUP'] },
];
const TNS_ORDER_ = ['team', 'product', 'topic', 'url', 'issue', 'notes'];
const TNS_URL_MAX_ = 2000;  // the whole link: fits in the Chat note (cut at 4,000 characters) with the rest, and any browser
const TNS_TEST_RETRY_MS_ = 60 * 60 * 1000;  // a test copy that couldn't be made is tried again an hour later

// The bot's product (after aliases) -> "Google Product:". Anything not here is Other.
const TNS_PRODUCTS_ = {
  'Ads/Merchant Center': 'Ads', 'AI Mode': 'Search (AI Mode)', 'AI Overviews': 'Search (AI Overviews)', 'Search': 'Search',
  'Search Images': 'Search', 'Search Knowledge Panel': 'Search', 'Gemini App': 'Gemini', 'Gemini Model': 'Gemini',
  'Gems': 'Gemini', 'Nano Banana': 'Gemini', 'Veo': 'Gemini', 'Maps/Geo': 'Geo (Maps)', 'Play Store': 'Play',
  'Workspace': 'Workspace', 'Calendar': 'Workspace',
};
// Politics about countries, wars and borders is "Geopolitical Dynamics"; the rest of politics "Major Civic Events"
const TNS_GEO_RX_ = /\b(wars?|israel\w*|gaza|palestin\w*|ukrain\w*|russia\w*|china|chinese|taiwan\w*|iran\w*|venezuela\w*|borders?|sanctions?|military|invasions?|territor\w*|nato|united nations|gulf of (america|mexico))\b/i;

/** Testing (Config.gs runTesting_: the run's mode; outside a run, escalation.stand_in): the test copy of the form. */
function tnsTesting_() { return runTesting_(); }

function tnsJson_(s) { try { return JSON.parse(s || 'null'); } catch (e) { return null; } }

/** A value for the link, with Chat's formatting characters (* _ ~ and brackets) encoded too: nothing in it reads as markup. */
function tnsEncode_(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*_~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** "Google Product:" for an alert: the product's form choice, a Pixel feature named in the alert, else Other. Pure. */
function tnsProduct_(f, esc) {
  const mapOne = rawVal => {
    const raw = String(rawVal || '').trim();
    if (!raw) return 'Other';
    const known = typeof lookupProduct_ === 'function' ? lookupProduct_(raw) : null;
    const name = (known && known.name) || raw;
    const text = [f.summary, f.issue_name, f.post_content].filter(Boolean).join(' ');
    if (/\bAI Studio\b/i.test(text) && /^(Gemini Model|Devs Products|Central AI)$/.test(name)) return 'AI Studio';
    if (name === 'Pixel') {
      if (/\bPixel Studio\b/i.test(text)) return 'Pixel (Studio Image)';
      if (/\bSmart Notes\b/i.test(text)) return 'Pixel (Smart notes)';
      if (/\bPixel Screenshots\b|\bScreenshots app\b/i.test(text)) return 'Pixel (Screenshots)';
    }
    if (TNS_PRODUCTS_[name]) return TNS_PRODUCTS_[name];
    if (!known && /\b(gemini|nano banana|veo|imagen|lyria)\b/i.test(raw)) return 'Gemini';  // "Gemini (Imagen, Nano Banana, …)"
    return 'Other';
  };
  const primary = mapOne(f.product || esc.product || '');
  if (primary !== 'Other') return primary;
  const others = typeof allProductsList_ === 'function' ? allProductsList_(f, esc).slice(1) : [];
  for (const op of others) {
    const mapped = mapOne(op);
    if (mapped !== 'Other') return mapped;
  }
  return 'Other';
}

/**
 * "Topic Impacted:" for an alert, from its Sensitive Topics and exposure tag (first match): Child Safety; perceived
 * bias; violence, hate or crime; scams, privacy, review abuse or malware; politics (geopolitical or civic); wrong,
 * dangerous or offensive results and medical claims; else Miscellaneous. Pure.
 */
function tnsTopic_(f, esc) {
  const tag = String(f.exposure_tag || esc.exposure_tag || '');
  const topics = [].concat(esc.sensitive_topics || [], asList_(f.risk_tags)).join(' | ');
  const text = [f.summary, f.issue_name].filter(Boolean).join(' ');
  if (/child safety/i.test(topics)) return 'Vulnerable or Marginalized Groups';
  if (/perceived bias/i.test(tag)) return 'Global Perception of Bias';
  if (/violence|weapons|hate speech|criminal|dangerous activity/i.test(topics)) return 'Violence, Extremism & Hate';
  if (/scams|privacy|review abuse/i.test(tag) || /privacy|malicious/i.test(topics)) return 'Frauds, Scams and Misuse of User Data';
  if (/politics/i.test(topics)) return TNS_GEO_RX_.test(text) ? 'Geopolitical Dynamics' : 'Major Civic Events';
  if (/dangerous results|factual inaccuracies|unexpected responses|offensive or explicit|fake news|conspiratorial/i.test(tag) ||
    /medical/i.test(topics)) return 'Information Quality';
  return 'Miscellaneous';
}

/**
 * What goes in each question: Team Marketing; Google Product; Topic Impacted; the post's link; What's the Issue (the
 * summary, the engagements and network, the video timestamp when the summary lacks it); notes (the screenshot's link).
 * The summary lacks the timestamp when it doesn't have its digits; for an alert reviewed with "Never wait on Burson" ON
 * (input.no_wait, Email.gs emailInput_), when it gives no [MM:SS] at all (Email.gs videoStamp_). Pure.
 */
function tnsFormValues_(input) {
  const f = (input && input.fields) || {};
  const esc = (input && input.escalation) || {};
  // screenshotFor_: {url, label}; never Burson's screenshot of a sign-in prompt (Post.gs savedScreenshot_)
  const shot = typeof savedScreenshot_ === 'function' ? savedScreenshot_(input) : input && input.screenshot;
  const shotUrl = String((shot && typeof shot === 'object' ? shot.url : shot) || '').trim();
  const summary = String(f.summary || f.issue_name || esc.issue_name || '').trim();
  const count = Number(f.total_engagement) || Number(esc.engagement_total) || 0;
  const network = String(f.social_network || esc.platform || '').trim();
  const stamp = String(f.video_timestamp || '').trim();
  const lacksStamp = input && input.no_wait ? !!videoStamp_({ video_timestamp: stamp, summary })
    : !!stamp && !summary.includes(stamp.replace(/[[\]]/g, ''));
  const issue = [summary,
    count ? `${fmtInt_(count)} engagements${network ? ` on ${network}` : ''}.` : '',
    lacksStamp ? `Timestamp in the video: ${stamp}.` : '',
  ].filter(Boolean).join(' ');
  return {
    team: 'Marketing', product: tnsProduct_(f, esc), topic: tnsTopic_(f, esc), url: String(f.post_url || '').trim(), issue,
    notes: shotUrl ? `${(shot && shot.label) || 'Screenshot'}: ${shotUrl}` : '',
  };
}

/** The real form's question ids: TNS_FORM_FIELDS_, or the script property TNS_FORM_ENTRIES (JSON) if the form changes. */
function tnsLiveIds_() {
  const ids = Object.assign({}, TNS_FORM_FIELDS_);
  try {
    const set = JSON.parse(PropertiesService.getScriptProperties().getProperty('TNS_FORM_ENTRIES') || '{}') || {};
    Object.keys(set).forEach(k => { if (TNS_ORDER_.includes(k) && /^entry\.\d+$/.test(String(set[k]))) ids[k] = String(set[k]); });
  } catch (e) { /* not valid JSON: the ids above */ }
  return ids;
}

/**
 * The pre-filled link: the test copy while testing ('' when it can't be made: never the real form), else the real form.
 * Kept under TNS_URL_MAX_ by shortening What's the Issue first, then the notes.
 */
function tnsPrefillUrl_(input) {
  const form = tnsTesting_() ? tnsTestForm_() : { base: TNS_FORM_BASE_URL_, ids: tnsLiveIds_() };
  if (!form) return '';
  const v = tnsFormValues_(input);
  const build = () => `${form.base}?usp=pp_url&` +
    TNS_ORDER_.filter(k => form.ids[k] && v[k]).map(k => `${form.ids[k]}=${tnsEncode_(v[k])}`).join('&');
  let url = build();
  ['issue', 'notes'].forEach(k => {
    if (url.length <= TNS_URL_MAX_ || !form.ids[k] || !v[k]) return;
    const full = v[k];
    let lo = 0;
    let hi = full.length;
    while (lo < hi) {  // the longest start of the text that still fits
      const mid = Math.ceil((lo + hi) / 2);
      v[k] = truncate_(full, mid);
      if (build().length <= TNS_URL_MAX_) lo = mid; else hi = mid - 1;
    }
    v[k] = lo ? truncate_(full, lo) : '';
    url = build();
  });
  return url;
}

/**
 * Auto-submit T&S form: submits `v` (tnsFormValues_) to the form with editor id `formId` (the test copy, or the real form
 * live), each answer to the question with its title on TNS_QUESTIONS_. Throws, before anything is submitted, when the
 * form can't be opened or a question it must have (all but the notes) has no answer; and when Forms refuses it. Returns
 * the link to the bot's submission on the form's Responses tab (it opens for the form's owner and editors: the tester,
 * for the test copy), or '' when Forms gave no id for it.
 */
function submitTnsForm_(formId, v) {
  const form = FormApp.openById(formId);
  const T = FormApp.ItemType;
  const byTitle = {};
  TNS_QUESTIONS_.forEach(q => { byTitle[q.title.trim().toLowerCase()] = q; });
  let response = form.createResponse();
  const answered = [];
  form.getItems().forEach(item => {
    const q = byTitle[String(item.getTitle() || '').trim().toLowerCase()];
    const value = q ? String(v[q.key] || '').trim() : '';
    if (!q || !value || answered.includes(q.key)) return;
    const type = item.getType();
    const typed = type === T.LIST ? item.asListItem() : type === T.MULTIPLE_CHOICE ? item.asMultipleChoiceItem()
      : type === T.PARAGRAPH_TEXT ? item.asParagraphTextItem() : type === T.TEXT ? item.asTextItem() : null;
    if (!typed) return;
    response = response.withItemResponse(typed.createResponse(value));
    answered.push(q.key);
  });
  const missing = TNS_QUESTIONS_.filter(q => !q.optional && !answered.includes(q.key)).map(q => `"${q.title.trim()}"`);
  if (missing.length) throw new Error(`no answer for ${missing.join(', ')} on the form, so it wasn't submitted`);
  const sent = response.submit();
  try {  // it went in: the link is only a nicety, never a reason to call the submit failed
    const id = sent && typeof sent.getId === 'function' ? String(sent.getId() || '') : '';
    return id ? `${form.getEditUrl()}#response=${encodeURIComponent(id)}` : '';
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The test copy (testing only)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The test copy {id, base, edit, ids} (script property TNS_TEST_FORM), made now if there's none. null when it can't be
 * made; then it's tried again an hour later (force: now).
 */
function tnsTestForm_(force) {
  const props = PropertiesService.getScriptProperties();
  const saved = tnsJson_(props.getProperty('TNS_TEST_FORM'));
  if (!force && saved && saved.base && saved.ids && saved.ids.team) return saved;
  if (!force && Date.now() - (Number(props.getProperty('TNS_TEST_FORM_TRIED')) || 0) < TNS_TEST_RETRY_MS_) return null;
  props.setProperty('TNS_TEST_FORM_TRIED', String(Date.now()));
  try {
    return makeTnsTestForm_(props);
  } catch (e) {
    console.error('The T&S test form could not be made: ' + ((e && e.message) || e));
    return null;
  }
}

/** Makes the test copy in the tester's Drive (or rebuilds one an earlier try left half-made), with its submit trigger. */
function makeTnsTestForm_(props) {
  let form = null;
  const id = props.getProperty('TNS_TEST_FORM_ID');
  if (id) { try { form = FormApp.openById(id); } catch (e) { form = null; } }
  if (!form) {
    form = FormApp.create('T&S Intake Form (test copy, only you)');
    props.setProperty('TNS_TEST_FORM_ID', form.getId());
  }
  form.setDescription('Test copy of the Trust & Safety Intake Form (go/WD-Triage) for the Burson QA bot, in your Drive. ' +
    'Nothing submitted here goes to Trust & Safety: you get a test confirmation email instead.');
  try { form.setRequireLogin(true); } catch (e) { /* not settable for every account */ }
  form.getItems().forEach(item => form.deleteItem(item));
  const items = {};
  TNS_QUESTIONS_.forEach(q => {
    const item = q.choices ? (q.radio ? form.addMultipleChoiceItem() : form.addListItem()).setChoiceValues(q.choices)
      : (q.paragraph ? form.addParagraphTextItem() : form.addTextItem());
    items[q.key] = item.setTitle(q.title).setRequired(!q.optional);
  });
  try { if (typeof form.setPublished === 'function') form.setPublished(true); } catch (e) { /* older forms always are */ }
  form.setAcceptingResponses(true);
  // The question ids (entry.N) the link needs, read off a pre-filled link of a made-up answer to each question
  const marks = {};
  let response = form.createResponse();
  TNS_QUESTIONS_.forEach(q => {
    marks[q.key] = q.choices ? q.choices[0] : `answer-${q.key}`;
    response = response.withItemResponse(items[q.key].createResponse(marks[q.key]));
  });
  const prefilled = String(response.toPrefilledUrl());
  const ids = {};
  (prefilled.split('?')[1] || '').split('&').forEach(pair => {
    const at = pair.indexOf('=');
    if (at <= 0) return;
    const value = decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
    const key = Object.keys(marks).find(k => marks[k] === value);
    if (key && /^entry\.\d+$/.test(pair.slice(0, at))) ids[key] = pair.slice(0, at);
  });
  if (TNS_QUESTIONS_.some(q => !ids[q.key])) throw new Error(`couldn't read the test form's question ids from ${prefilled}`);
  ensureTnsTestTrigger_(form);
  const saved = { id: form.getId(), base: prefilled.split('?')[0], edit: form.getEditUrl(), ids };
  props.setProperty('TNS_TEST_FORM', JSON.stringify(saved));
  return saved;
}

/** One submit trigger, on the current test copy (an older copy's trigger is removed). */
function ensureTnsTestTrigger_(form) {
  let has = false;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() !== 'onTnsTestFormSubmit') return;
    if (!has && t.getTriggerSourceId() === form.getId()) has = true;
    else ScriptApp.deleteTrigger(t);
  });
  if (!has) ScriptApp.newTrigger('onTnsTestFormSubmit').forForm(form).onFormSubmit().create();
}

/** Run this to make the test copy now (or find it): logs its link and where to see what was submitted. */
function setupTnsTestForm() {
  const props = PropertiesService.getScriptProperties();
  let form = tnsJson_(props.getProperty('TNS_TEST_FORM'));
  let open = null;
  if (form) { try { open = FormApp.openById(form.id); } catch (e) { open = null; } }
  if (open) ensureTnsTestTrigger_(open);
  else form = tnsTestForm_(true);
  if (!form) throw new Error('The T&S test form could not be made: see the log above.');
  console.log(`T&S test form (in your Drive, only you): ${form.base}\nEdit it or see what was submitted: ${form.edit}`);
  return form.base;
}

/**
 * The test copy's submit trigger: a stand-in for T&S's "Issue [#…]: WD Intake Request" confirmation, with the answers
 * (so the post's link is in it), sent to the tester only. The bot then marks ✍️ as it would for the real email.
 */
function onTnsTestFormSubmit(e) {
  let raw = '';
  try { raw = readTestersCell_(controlTab_(openStore_(false))); } catch (err) { raw = ''; }
  const to = testersFor_(raw).testers;
  if (!to.length || !e || !e.response) return;  // live there's no test copy to answer
  const answers = e.response.getItemResponses().map(r => `${String(r.getItem().getTitle()).trim()} ${r.getResponse()}`);
  const subject = `Issue [#TEST-${String(Date.now()).slice(-7)}]: WD Intake Request (test copy)`;
  const text = ['This is a test confirmation from the test copy of the T&S Intake Form in the bot account\'s Drive. Nothing was sent ' +
    'to Trust & Safety. Live, T&S emails "Issue [#…]: WD Intake Request" when the form is submitted.', '', 'Your answers:']
    .concat(answers).join('\n');
  gmailClient_({ onlyTo: to }).sendMessage(buildMime_({ from: to[0], to, subject, text,
    html: htmlEsc_(text).replace(/\n/g, '<br>') }), null);
}
