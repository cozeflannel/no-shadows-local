// While a look of the watch fails as a whole, C34 and the Watch sources tab say since when in one form ("Oct 14, 8:04 AM
// EDT", ProactiveWatch.gs pwWhen_ with its zone), and why in plain words (pwPlainWhy_); the error's own text, as
// BigQuery or Secret Manager wrote it, is in the run log only. Nothing here posts anything.
'use strict';

module.exports = H => {
  const { test, eq, assert, B } = H;

  test('watch plain why: an outside error is put in plain words, the bot\'s own words stay as they are, and nothing of the outside text reaches C34 or the tab', () => {
    const plain = what => B.pwPlainWhy_(what);
    const DENIED = 'BigQuery refused access (a permission is missing)';
    eq([
      'BigQuery HTTP 403: Access Denied: Table bsip-s-bsip-gg-26-2cf3:google_bg.sonar_raw: User does not have permission to query table',
      'BigQuery HTTP 401: Request had invalid authentication credentials.',
      'BigQuery HTTP 400: Access Denied: Project brand-social-central-data: User does not have bigquery.jobs.create permission',
      'BigQuery HTTP 404: Not found: Dataset brand-social-central-data:proactive_watch',
      'BigQuery HTTP 400: Query error: the table was not found',
      'BigQuery HTTP 400: Query error: AI.IF: quota exceeded for the Gemini model in us-central1',
      'BigQuery HTTP 429: Too many requests',
      'BigQuery HTTP 500: Backend error',
      'BigQuery HTTP 503',
      'BigQuery HTTP 400: Syntax error: Unexpected keyword at [3:14]',
      'BigQuery took more than 4 minutes',
      'BigQuery gave no job to collect',
      'Secret Manager HTTP 403 reading the shared Brandwatch token: denied',
      'the shared Brandwatch token in Secret Manager is empty',
      'Exception: Address unavailable: https://bigquery.googleapis.com/bigquery/v2/projects',
      'Request timed out',
      'TypeError: Cannot read properties of undefined (reading \'rows\')',
      '',
      null,
      undefined,
    ].map(plain), [
      DENIED, DENIED, DENIED,
      'BigQuery could not find a table the look reads', 'BigQuery could not find a table the look reads',
      'BigQuery reached a quota or rate limit', 'BigQuery reached a quota or rate limit',
      'BigQuery had a problem of its own', 'BigQuery had a problem of its own',
      'BigQuery refused the look\'s query',
      'BigQuery took more than 4 minutes', 'BigQuery gave no job to collect',
      'the shared Brandwatch key could not be read', 'the shared Brandwatch key is empty',
      'BigQuery could not be reached', 'BigQuery could not be reached',
      'an unexpected error (the run log has its words)', 'an unexpected error (the run log has its words)',
      'an unexpected error (the run log has its words)', 'an unexpected error (the run log has its words)',
    ]);
  });

  test('watch plain why: C34 and the Watch sources tab write the time a look began to fail the same way, with its zone', () => {
    const since = Date.UTC(2026, 9, 14, 11, 0);  // 7:00 AM EDT
    const fail = { since, why: 'BigQuery refused access (a permission is missing)' };
    const src = B.ev('PW_SOURCES_').find(s => s.lane === 'c1');
    const tab = B.pwSourceStatus_(src, null, since + 60000, fail).text;
    const note = B.pwNoteText_({ flagged: 0, near: 0 }, null, '', '', { c1: fail });
    eq(tab, '⚠️ failing: the look at Sonar and Tubular has failed since Oct 14, 7:00 AM EDT: BigQuery refused access (a permission is missing) ' +
      '(tried again at the next look)');
    assert.ok(note.includes('has failed since Oct 14, 7:00 AM EDT: BigQuery refused access (a permission is missing)'), note);
  });
};
