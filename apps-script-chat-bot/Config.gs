/**
 * Config.gs — fixed settings. Nothing here needs editing day to day: the bot is managed from the Control tab of its
 * Google Sheet (on/off, its spaces, and which space is S-F Burson). setup() creates that sheet and logs its link.
 */

// Google Cloud project for Gemini (Vertex AI). The Apps Script project must use this Cloud project.
const GCP_PROJECT = 'brand-social-central-data';

// S-F Burson, the real Burson space ([S-F] Burson Automated Alerts V3), is never named in the code: it's the space in
// the Control tab's B25 ("S-F Burson space"), resolved once per run (Main.gs sfBursonFor_) and kept below for that run.
// Blank or not found, no S-F Burson is known and everything that needs it fails closed: the Mirror, Auto-correct and
// Relay don't run, the Burson outbox sends nothing, and the bot is never "live". Whatever B25 says, the bot never posts
// or reacts directly in a space people outside Google can join (guardedChat_ in Main.gs, chatCall_ in Chat.gs).

// What a new Control tab starts with: testing, with the test feed standing in for the Burson space.
const START_BURSON_SPACE = 'SLRR Test Feed (Burson Sim)';
const START_ANALYST_SPACE = 'spaces/AAQAaLn375E';  // SLRR Triaged Alerts

// ---------------------------------------------------------------------------------------------------------------
// This run's S-F Burson (Control tab B25): set once per run, read by Chat.gs's backstop and the flows that need it
// ---------------------------------------------------------------------------------------------------------------

let SF_BURSON_ = null;     // {id, name, externalUserAllowed}: this run's S-F Burson, or null when none is known
let OUTSIDE_SPACES_ = [];  // spaces people outside Google can join that this run knows aren't S-F Burson: never written

/** Sets this run's S-F Burson (null: none is known) and forgets the outside spaces noted before. Returns it. */
function setSfBurson_(space) {
  SF_BURSON_ = space && space.id
    ? { id: String(space.id), name: String(space.name || space.id), externalUserAllowed: !!space.externalUserAllowed } : null;
  OUTSIDE_SPACES_ = [];
  return SF_BURSON_;
}

/** This run's S-F Burson ({id, name, externalUserAllowed}), or null when none is known (B25 blank or not found). */
function sfBurson_() { return SF_BURSON_; }

/** This run's S-F Burson space id, or '' when none is known. */
function sfBursonId_() { return SF_BURSON_ ? SF_BURSON_.id : ''; }

// ---------------------------------------------------------------------------------------------------------------
// This run's mode (Main.gs runMode_): LIVE or Testing, from the Control tab (the Safety valve, row 29, and B26). Set
// for each flow by buildCtx_ (the auto-correct flow is never LIVE), for the code that has no ctx (the T&S form link)
// ---------------------------------------------------------------------------------------------------------------

let RUN_LIVE_ = null;  // true: the flow being run is LIVE; false: Testing; null: no run set it (the config decides)

/** Sets whether the flow being run is LIVE (true / false; anything else: not set). Returns it. */
function setRunLive_(live) {
  RUN_LIVE_ = live === true ? true : live === false ? false : null;
  return RUN_LIVE_;
}

/** What setRunLive_ last set (true / false / null), for a flow that runs after the main run and puts it back after. */
function runLiveSetting_() { return RUN_LIVE_; }

/**
 * True while Testing: every email only to the testers in Control!B30, the test copy of the T&S form, nothing for the
 * leads, nothing to S-F Burson. A run sets it (setRunLive_); outside a run (the editor, a standalone call) it fails
 * closed to Testing.
 */
function runTesting_() {
  if (String((GEN.email && GEN.email.stand_in) || '').trim()) return true;
  if (RUN_LIVE_ !== null) return !RUN_LIVE_;
  return true;
}

/** Notes a space people outside Google can join that isn't S-F Burson: Chat.gs refuses every write to it this run. */
function noteOutsideSpace_(id) {
  if (id && String(id) !== sfBursonId_() && OUTSIDE_SPACES_.indexOf(String(id)) < 0) OUTSIDE_SPACES_.push(String(id));
}

/** True when this run noted `id` as a space people outside Google can join that isn't S-F Burson. */
function outsideSpace_(id) { return !!id && OUTSIDE_SPACES_.indexOf(String(id)) >= 0; }

// ---------------------------------------------------------------------------------------------------------------
// This run's Burson test copy (Control tab B26, TestCopy.gs): a Google-only space that plays S-F Burson for the Relay.
// Set once per run once B26 passes its checks; Chat.gs refuses every write there but the copy of S-F Burson and the
// analysts' side the Relay sends (both inside testCopyWrite_), so the bot's own work never lands there.
// ---------------------------------------------------------------------------------------------------------------

let TEST_COPY_ = null;            // {id, name}: this run's Burson test copy, or null when B26 is blank or fails its checks
let TEST_COPY_WRITING_ = false;   // true only while TestCopy.gs writes the copy or the Relay's analysts' side there

/** Sets this run's Burson test copy (null: none). Returns it. */
function setTestCopy_(space) {
  TEST_COPY_ = space && space.id ? { id: String(space.id), name: String(space.name || space.id) } : null;
  return TEST_COPY_;
}

/** This run's Burson test copy space id, or '' when there's none. */
function testCopyId_() { return TEST_COPY_ ? TEST_COPY_.id : ''; }

/** True only while the copy of S-F Burson, or the Relay's analysts' side, is being written in the test copy. */
function testCopyWriting_() { return TEST_COPY_WRITING_ === true; }

// ---------------------------------------------------------------------------------------------------------------
// Helpers (pure; tested in test/run_tests.js)
// ---------------------------------------------------------------------------------------------------------------

/** True when `spaceId` is the S-F Burson space `sfb` ({id} from B25, or null when none is known: never). Pure. */
function isSfBurson_(sfb, spaceId) { return !!(sfb && sfb.id && spaceId && String(spaceId) === String(sfb.id)); }

/** A space link, 'spaces/X', 'X' or the exact space name -> {id: 'spaces/X'} or {name: '…'}. */
function parseSpaceRef_(value, label) {
  const v = String(value === undefined || value === null ? '' : value).trim();
  if (!v) throw new Error(`${label || 'A space'} is blank. Paste the space's link there.`);
  let m = v.match(/(?:^|\/)spaces\/([A-Za-z0-9_-]+)/);
  if (m) return { id: 'spaces/' + m[1] };
  m = v.match(/^https?:\/\/\S*?(?:\/space\/|\/room\/|\/chat\/|#chat\/space\/)([A-Za-z0-9_-]{6,})/i);
  if (m) return { id: 'spaces/' + m[1] };
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return { id: 'spaces/' + v };
  return { name: v };
}

/**
 * Safety checks on the two spaces ({id, name, externalUserAllowed}; either is missing if it couldn't be opened), with
 * `sfb` the S-F Burson space (Control tab B25: {id}, or null when none is known). Returns {problems: [text], bad:
 * ['burson' | 'analyst']}: what's wrong, and which Control-tab cells need fixing.
 */
function checkSpacePair_(burson, analyst, sfb) {
  const problems = [];
  const bad = [];
  const mark = role => { if (bad.indexOf(role) < 0) bad.push(role); };
  if (burson && analyst && burson.id === analyst.id) {
    problems.push('The Burson space and the analyst space are the same space. Change one of them.');
    mark('burson');
    mark('analyst');
  }
  if (analyst && isSfBurson_(sfb, analyst.id)) {
    problems.push('The analyst space can\'t be the Burson alerts space. Change the analyst space.');
    mark('analyst');
  }
  if (analyst && analyst.externalUserAllowed) {
    problems.push(`The analyst space "${analyst.name || analyst.id}" allows people outside Google, so Burson could see it. ` +
      'Use a space that only Google people can join.');
    mark('analyst');
  }
  return { problems, bad };
}
