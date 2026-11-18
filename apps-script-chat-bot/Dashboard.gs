/**
 * Dashboard.gs — the live dashboard web app's entry point and shared base (Control row 54, Live dashboard; row 55, Slide
 * deliveries). The web app is part of the bot: one Apps Script web app served by this project (doGet), running as the
 * bot's own account (manifest "webapp": executeAs USER_DEPLOYING) and open only to people the bot's sheet is shared with
 * (dashAccess_). The page carries no data: it asks the dash* functions (DashboardData.gs: Live, read-only;
 * SlideDeliveries.gs: Slide deliveries) through google.script.run.
 *
 *   doGet(e)                 the page (Dashboard.html with DashboardCss.html and DashboardJs.html)
 *   include_(name)           an HTML partial's content, for the page template
 *   dashAccess_()            {ok, email, why}: may this viewer see the dashboard? (the same people as the bot's sheet)
 *   webViewerCall_()         true when a dashboard viewer (not the bot's own account) is calling: every other public
 *                            function of the bot refuses such a call (its first line)
 *   dashCtx_()               the read-only context every dash* function starts from: {ss, control, switches, mode, now}
 *   dashBuildInfo_()         {web, bot, behind, url}: is this link's code older than the bot's?
 *   dashServed_(answer)      the answer with servedAt: the bot's clock as it is sent (the page's "N min ago" counts
 *                            from it, never from the viewer's device clock)
 *
 * Nothing here writes to the sheet, Chat or Gmail. The only writes are short-lived read caches (keys `dash1:`).
 */

// The dashboard's own build id: changed by hand whenever the dashboard's code changes. poll() writes it to the property
// BOT_BUILD while row 54 is ON (the time trigger runs the newest code); the web app compares it with its own copy (a
// deployment serves the code of its version), and says so when the link runs an older version than the bot
const DASH_BUILD_ = '2026-11-18.1';
const DASH_BUILD_PROP_ = 'BOT_BUILD';
const DASH_ACL_CACHE_SEC_ = 600;
const DASH_TITLE_ = 'Burson QA bot · Live';

/** The web app's page. Access is checked first: a viewer the bot's sheet is not shared with sees why, and nothing else. */
function doGet(e) {
  const access = dashAccess_();
  if (!access.ok) {
    return HtmlService.createHtmlOutput(dashDeniedHtml_(access))
      .setTitle(DASH_TITLE_)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  const page = HtmlService.createTemplateFromFile('Dashboard');
  page.viewerEmail = access.email || '';
  return page.evaluate()
    .setTitle(DASH_TITLE_)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** An HTML partial's content (Dashboard.html includes DashboardCss and DashboardJs with it). */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** The page shown to a viewer who may not see the dashboard: why, and what to do. Pure. */
function dashDeniedHtml_(access) {
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  return '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{font-family:"Google Sans Flex","Google Sans",Roboto,Arial,sans-serif;margin:0;padding:48px 16px;background:#f8fafd;color:#1f1f1f}' +
    '@media (prefers-color-scheme:dark){body{background:#131314;color:#e3e3e3}}' +
    'main{max-width:560px;margin:0 auto;line-height:1.5}h1{font-size:22px;font-weight:500}</style></head><body><main>' +
    `<h1>You can't open the live dashboard yet</h1><p>${esc(access.why)}</p></main></body></html>`;
}

/**
 * May this viewer see the dashboard? The same people as the bot's sheet: the bot's own account, anyone the sheet is
 * shared with (its editors and viewers), or everyone when the sheet is shared with the whole domain or with anyone who
 * has the link. {ok, email, self, why}. The answer is cached 10 minutes per viewer. Never throws.
 */
function dashAccess_() {
  let email = '';
  let self = '';
  try { email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { email = ''; }
  try { self = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { self = ''; }
  if (!email) {
    return { ok: false, email: '', self: false,
      why: 'Google did not tell the dashboard who you are, so it cannot check that the bot\'s sheet is shared with you. ' +
        'Open the link while signed in to your work Google account, in the same organisation as the bot\'s account.' };
  }
  if (self && email === self) return { ok: true, email, self: true, why: '' };
  const key = `dash1:acl:${hashText_(email)}`;
  let cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  try {
    const hit = cache ? cache.get(key) : null;
    if (hit === '1') return { ok: true, email, self: false, why: '' };
    if (hit === '0') return dashDenied_(email);
  } catch (e) { /* asked again below */ }
  let ok = false;
  try {
    const id = PropertiesService.getScriptProperties().getProperty(STORE_SHEET_PROP_);
    if (id) {
      const file = DriveApp.getFileById(id);
      const wide = String(file.getSharingAccess());
      if (wide === String(DriveApp.Access.DOMAIN) || wide === String(DriveApp.Access.DOMAIN_WITH_LINK) ||
        wide === String(DriveApp.Access.ANYONE) || wide === String(DriveApp.Access.ANYONE_WITH_LINK)) {
        ok = true;
      } else {
        const people = [].concat(file.getEditors() || [], file.getViewers() || []);
        try { people.push(file.getOwner()); } catch (e) { /* a shared drive file has no owner */ }
        ok = people.some(u => { try { return String(u && u.getEmail() || '').trim().toLowerCase() === email; } catch (e) { return false; } });
      }
    }
  } catch (e) {
    ok = false;
  }
  try { if (cache) cache.put(key, ok ? '1' : '0', DASH_ACL_CACHE_SEC_); } catch (e) { /* asked again next time */ }
  return ok ? { ok: true, email, self: false, why: '' } : dashDenied_(email);
}

/** The "not shared with you" answer (the viewer's own address only; never another one). Pure. */
function dashDenied_(email) {
  return { ok: false, email, self: false,
    why: `The live dashboard shows the bot's work to the people its sheet is shared with, and the sheet is not shared with ${email}. ` +
      'Ask the owner of the bot\'s sheet (the Google Sheet with the Control tab) to share it with you, then open this link again ' +
      '(it can take up to 10 minutes to let you in).' };
}

/**
 * True when a dashboard viewer is calling: the person running the code (the active user) is known and is not the
 * account the bot runs as. Every public function of the bot other than the dashboard's own refuses such a call (the web
 * app runs as the bot's account, so google.script.run could otherwise reach them). Trigger runs and the owner's own runs
 * in the editor are never refused. Never throws.
 */
function webViewerCall_() {
  try {
    const active = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
    if (!active) return false;
    const self = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
    return !!self && active !== self;
  } catch (e) {
    return false;
  }
}

/**
 * The read-only context every dash* function starts from: the bot's sheet, its Control tab, the switches as the tab
 * says now, and the mode (testing / live) as the bot last wrote it in C29. Throws when the sheet can't be opened (the
 * caller turns that into a plain message).
 */
function dashCtx_() {
  const ss = openStore_(false);
  const control = controlTab_(ss);
  const switches = control ? readSwitches_(control) : switchesOff_();
  let mode = 'unknown';
  try {
    const c29 = control ? String(control.getRange(29, 3).getValue() || '') : '';
    if (/Testing/.test(c29)) mode = 'testing';
    else if (/\bLIVE\b/.test(c29)) mode = 'live';
  } catch (e) { mode = 'unknown'; }
  return { ss, control, switches, mode, now: Date.now() };
}

/**
 * {web, bot, behind, url}: the dashboard code this link runs vs the newest code the bot runs (BOT_BUILD), and the web
 * app's own link (the page reads the deployment id from it for the exact `clasp deploy -i <id>` command). Never throws.
 */
function dashBuildInfo_() {
  let bot = '';
  try { bot = String(PropertiesService.getScriptProperties().getProperty(DASH_BUILD_PROP_) || ''); } catch (e) { bot = ''; }
  return { web: DASH_BUILD_, bot, behind: !!bot && bot !== DASH_BUILD_, url: dashWebAppUrl_() };
}

/** The web app's own link (empty when no web app deployment exists yet). Never throws. */
function dashWebAppUrl_() {
  try { return String(ScriptApp.getService().getUrl() || ''); } catch (e) { return ''; }
}

/** True when the bot's account has approved editing Google Slides (needed by Slide deliveries). Never throws. */
function dashScopeOk_() {
  try {
    const info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL, ['https://www.googleapis.com/auth/presentations']);
    return String(info.getAuthorizationStatus()) === String(ScriptApp.AuthorizationStatus.NOT_REQUIRED);
  } catch (e) {
    return false;
  }
}

/**
 * An answer that is ok, with `servedAt`: the bot's clock (ms) as it is sent. The page counts every "Updated 14 s ago"
 * and "3 min ago" from it plus the seconds since it arrived, never from the viewer's device clock (which can be wrong).
 * A refusal or a failure is returned as it is (it shows no times). Returns the same object.
 */
function dashServed_(answer) {
  if (answer && typeof answer === 'object' && !Array.isArray(answer) && answer.ok === true) answer.servedAt = Date.now();
  return answer;
}

/** A dash* function's refusal, in the shape the page reads: {ok: false, denied, why}. Pure. */
function dashRefusal_(access) {
  return { ok: false, denied: true, why: (access && access.why) || 'You can\'t open the live dashboard.' };
}
