/**
 * BqLookback.gs — Control tab row 31 ("BigQuery lookback") and lookback window clamping (15 to 60 minutes).
 *
 * B31 uses a strict Google Sheets data validation dropdown in 15-minute increments starting at 15 minutes
 * (15 minutes, 30 minutes, 45 minutes, 60 minutes) with invalid entries (including 0) rejected by the sheet UI.
 * Any value read programmatically or left over from an older sheet is clamped to 15-60 minutes (blank or <= 0: 60).
 */

const BQ_LOOKBACK_ROW_ = 31;
const BQ_LOOKBACK_LABEL_ = 'BigQuery lookback';
const BQ_LOOKBACK_SHORTEST_MIN_ = 15;
const BQ_LOOKBACK_LONGEST_MIN_ = 60;
const BQ_LOOKBACK_DEFAULT_MIN_ = 60;
const BQ_LOOKBACK_START_ = '60 minutes';
const BQ_LOOKBACK_CHOICES_ = ['15 minutes', '30 minutes', '45 minutes', '60 minutes'];

/** This run's BigQuery lookback in minutes (settings.bq_lookback_minutes), held to 15-60; 60 when unset or <= 0. Pure. */
function bqLookbackMinutes_(S) {
  const n = Math.round(Number(S && S.bq_lookback_minutes));
  if (!isFinite(n) || n <= 0) return BQ_LOOKBACK_DEFAULT_MIN_;
  return Math.min(BQ_LOOKBACK_LONGEST_MIN_, Math.max(BQ_LOOKBACK_SHORTEST_MIN_, n));
}

/** Human-readable lookback phrase: "the last hour" (60 minutes) or "the last N minutes". Pure. */
function bqLookbackText_(minutes) {
  const n = Math.round(Number(minutes)) || BQ_LOOKBACK_DEFAULT_MIN_;
  return n === 60 ? 'the last hour' : `the last ${n} minutes`;
}

/** Strict Google Sheets dropdown rule for B31: 15, 30, 45, or 60 minutes (rejects 0 and arbitrary text in Sheet UI). */
function bqLookbackRule_() {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(BQ_LOOKBACK_CHOICES_, true)
    .setAllowInvalid(false)
    .build();
}

/** True when `cell` already carries the strict 15/30/45/60-minute dropdown so steady-state runs make zero writes. */
function bqLookbackValidationCurrent_(cell) {
  if (!cell || typeof cell.getDataValidation !== 'function') return true;
  const rule = cell.getDataValidation();
  if (!rule) return false;
  const allow = typeof rule.getAllowInvalid === 'function' ? rule.getAllowInvalid() : !!rule.allowInvalid;
  if (allow) return false;
  const vals = typeof rule.getCriteriaValues === 'function' ? (rule.getCriteriaValues() || [])[0] : rule.values;
  return Array.isArray(vals) && vals.length === BQ_LOOKBACK_CHOICES_.length &&
    BQ_LOOKBACK_CHOICES_.every((v, i) => vals[i] === v);
}

/**
 * Parses B31 (BigQuery lookback): "15 minutes", "30 minutes", "45 minutes", "60 minutes", bare numbers, "0:15" / "0:45",
 * "quarter of an hour", "half an hour", "1 hour", or a Sheets time Date cell. Held to 15-60 minutes; blank, 0, negative,
 * or unreadable falls back to BQ_LOOKBACK_DEFAULT_MIN_ (60). Returns {minutes, blank, note}. Pure.
 */
function bqLookbackFrom_(raw) {
  const lo = BQ_LOOKBACK_SHORTEST_MIN_;
  const hi = BQ_LOOKBACK_LONGEST_MIN_;
  const dflt = BQ_LOOKBACK_DEFAULT_MIN_;
  const using = n => `Direct BigQuery alerts (row 15) and Early detection (row 19) look at posts from ${bqLookbackText_(n)}`;
  const isDate = Object.prototype.toString.call(raw) === '[object Date]';
  const text = isDate ? '' : String(raw === undefined || raw === null ? '' : raw).trim();
  if (!isDate && !text) {
    return { minutes: dflt, blank: true, note: `Blank: ${using(dflt)} (choose 15, 30, 45 or 60 minutes)` };
  }
  let n = NaN;
  if (isDate) {
    n = isNaN(raw.getTime()) ? NaN : raw.getHours() * 60 + raw.getMinutes();
  } else if (typeof raw === 'number') {
    n = raw;
  } else {
    const t = text.toLowerCase().replace(/\s+/g, ' ');
    const m = t.match(/^(\d+(?:\.\d+)?) ?(m|min|mins|minutes?|h|hr|hrs|hours?)?$/);
    const hm = t.match(/^(\d{1,2}):(\d{2})$/);
    if (m) n = Number(m[1]) * (m[2] && m[2].charAt(0) === 'h' ? 60 : 1);
    else if (hm) n = Number(hm[1]) * 60 + Number(hm[2]);
    else if (/^(?:an?|one) (?:hour|hr)$/.test(t)) n = 60;
    else if (/^half an? hour$/.test(t)) n = 30;
    else if (/^(?:a )?quarter (?:of an? )?hour$/.test(t)) n = 15;
  }
  if (!isFinite(n) || n <= 0) {
    return {
      minutes: dflt,
      blank: false,
      note: `⚠️ Couldn't read "${truncate_(text || String(raw), 40)}": ${using(dflt)}. Choose 15, 30, 45 or 60 minutes.`,
    };
  }
  const r = Math.round(n);
  if (r > hi) return { minutes: hi, blank: false, note: `⚠️ ${r} minutes is more than the longest lookback (${hi}): ${using(hi)}` };
  if (r < lo) return { minutes: lo, blank: false, note: `⚠️ ${r} minutes is less than the shortest lookback (${lo}): ${using(lo)}` };
  return { minutes: r, blank: false, note: `✓ ${using(r)}` };
}

/**
 * Ensures Row 31 (BigQuery lookback) exists with the strict 15/30/45/60-minute dropdown. Upgrades older 3-item /
 * allow-invalid dropdowns in place once, preserves any user-set value in B31, and moves "How it works" to row 33.
 */
function ensureBqLookbackRow_(sh) {
  if (!sh) return;
  const label = String(sh.getRange(BQ_LOOKBACK_ROW_, 1).getValue() || '').trim();
  if (label === BQ_LOOKBACK_LABEL_) {
    const cell = sh.getRange(BQ_LOOKBACK_ROW_, 2);
    if (!bqLookbackValidationCurrent_(cell)) {
      cell.setDataValidation(bqLookbackRule_());
      writeControlHelp_(sh);
    }
    return;
  }
  const b = sh.getRange(BQ_LOOKBACK_ROW_, 2).getValue();
  const had = Object.prototype.toString.call(b) === '[object Date]' ? b : String(b === undefined || b === null ? '' : b).trim();
  const value = had === '' ? BQ_LOOKBACK_START_ : had;
  sh.getRange(BQ_LOOKBACK_ROW_, 1, 1, 3).setValues([[BQ_LOOKBACK_LABEL_, value, bqLookbackFrom_(value).note]]);
  sh.getRange(BQ_LOOKBACK_ROW_, 1).setFontWeight('bold');
  sh.getRange(BQ_LOOKBACK_ROW_, 2).setBackground('#fff8e1');
  sh.getRange(BQ_LOOKBACK_ROW_, 2).setDataValidation(bqLookbackRule_());
  writeControlHelp_(sh);
}

/** Writes C31 only when the resolved note changed. */
function writeBqLookbackNote_(sh, note) {
  if (!sh) return;
  const cell = sh.getRange(BQ_LOOKBACK_ROW_, 3);
  if (String(cell.getValue() || '') !== String(note || '')) cell.setValue(note || '');
}

/** Resolves B31 (`raw`) for this run and updates C31 when changed. Never throws. */
function bqLookbackFor_(raw, sh) {
  let out;
  try {
    out = bqLookbackFrom_(raw);
  } catch (e) {
    out = { minutes: BQ_LOOKBACK_DEFAULT_MIN_, blank: false, note: '' };
  }
  if (sh && out.note) {
    try {
      writeBqLookbackNote_(sh, out.note);
    } catch (e) {
      console.error('could not write C31 (BigQuery lookback): ' + ((e && e.message) || e));
    }
  }
  return out;
}
