/**
 * Sheets.gs — the bot's Google Sheet ("Burson QA bot"): the Control tab (Control.gs) plus two log tabs, "Alert log"
 * and "Message log", that the store (Store.gs) reads and writes.
 *
 * setup() creates the sheet and keeps its id in the script property STORE_SHEET_ID. Columns are matched by header
 * name, so new columns are simply added at the end. Each run reads only recent rows. Before a row is updated, its
 * key is checked, so a row someone moved or deleted can't be overwritten by mistake. The log tabs are protected
 * with a warning: people can still look and filter, but get asked before editing.
 */

const STORE_SHEET_PROP_ = 'STORE_SHEET_ID';
const ALERT_SEQ_PROP_ = 'ALERT_SEQ';
const ALERT_TAB_ = 'Alert log';
const MESSAGE_TAB_ = 'Message log';
const ALERT_READ_ROWS_ = 4000;    // ~2-3 weeks of alerts: covers the 14-day "already reported" check
const MESSAGE_READ_ROWS_ = 2000;  // a few days of messages: covers retries and the cursor overlap

/** The bot's sheet (created when `create` is true and there isn't one yet). */
function openStore_(create) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(STORE_SHEET_PROP_);
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      throw new Error(`Can't open the bot's sheet ${id} (${e.message}). If it was deleted, delete the script property ` +
        `${STORE_SHEET_PROP_} and run setup() to create a new one.`);
    }
  }
  if (!create) throw new Error('The bot has no sheet yet: run setup() first.');
  const ss = SpreadsheetApp.create('Burson QA bot');
  ss.getSheets()[0].setName(CONTROL_TAB_);
  props.setProperty(STORE_SHEET_PROP_, ss.getId());
  return ss;
}

function sheetBackend_(ss) {
  const alerts = sheetTable_(ss, ALERT_TAB_, ALERT_COLUMNS_, 'alert_id', ALERT_READ_ROWS_);
  const messages = sheetTable_(ss, MESSAGE_TAB_, MESSAGE_COLUMNS_, 'message', MESSAGE_READ_ROWS_);
  return {
    loadAlerts: () => alerts.load(),
    loadMessages: () => messages.load(),
    appendAlert: obj => alerts.append(obj),
    appendMessage: obj => messages.append(obj),
    updateAlert: (row, patch) => alerts.update(row, patch),
    updateMessage: (row, patch) => messages.update(row, patch),
    nextId: () => nextAlertSeq_(),
  };
}

function nextAlertSeq_() {
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty(ALERT_SEQ_PROP_) || 1000) + 1;
  props.setProperty(ALERT_SEQ_PROP_, String(n));
  return 'QA-' + n;
}

function sheetTable_(ss, name, columns, keyColumn, readRows) {
  let sh = ss.getSheetByName(name);
  const created = !sh;
  if (!sh) sh = ss.insertSheet(name);
  let header = sh.getLastRow() >= 1 ? sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String) : [];
  while (header.length && !header[header.length - 1]) header.pop();
  const missing = columns.filter(c => header.indexOf(c) < 0);
  if (missing.length) {
    header = header.concat(missing);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
  }
  if (created) sh.protect().setDescription('Written by the Burson QA bot').setWarningOnly(true);
  return tableOver_(sheetIO_(sh), header, keyColumn, readRows);
}

function sheetIO_(sh) {
  return {
    lastRow: () => sh.getLastRow(),
    read: (first, count, width) => sh.getRange(first, 1, count, width).getValues(),
    append: values => { sh.appendRow(values); return sh.getLastRow(); },
    write: (row, values) => sh.getRange(row, 1, 1, values.length).setValues([values]),
    keyAt: (row, col) => (row >= 2 && row <= sh.getLastRow() ? sh.getRange(row, col).getValue() : null),
    findRow: (col, value) => {
      const found = sh.getRange(2, col, Math.max(1, sh.getLastRow() - 1), 1).createTextFinder(String(value)).matchEntireCell(true).findNext();
      return found ? found.getRow() : null;
    },
  };
}

/** Row objects over a sheet-like io {lastRow, read, append, write, keyAt, findRow} (pure; tests pass an in-memory io). */
function tableOver_(io, header, keyColumn, readRows) {
  const encode = obj => header.map(h => encodeCell_(h, obj[h]));
  const keyCol = header.indexOf(keyColumn) + 1;
  return {
    header,
    load() {
      const last = io.lastRow();
      if (last < 2) return [];
      const first = Math.max(2, last - (readRows || 5000) + 1);
      return io.read(first, last - first + 1, header.length).map((values, i) => {
        const row = { _row: first + i };
        header.forEach((h, j) => { row[h] = decodeCell_(h, values[j]); });
        return row;
      });
    },
    append(obj) {
      const rowNum = io.append(encode(obj));
      return Object.assign({}, obj, { _row: rowNum });
    },
    update(row, patch) {
      Object.assign(row, patch);
      if (keyCol > 0 && String(io.keyAt(row._row, keyCol)) !== String(row[keyColumn])) {  // the row moved
        const at = io.findRow(keyCol, row[keyColumn]);
        if (!at) { row._row = io.append(encode(row)); return; }
        row._row = at;
      }
      io.write(row._row, encode(row));
    },
  };
}

function encodeCell_(column, value) {
  if (value === undefined || value === null) return '';
  if (JSON_COLUMNS_.indexOf(column) >= 0) return capJson_(value, SHEET_CELL_MAX_CHARS_);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const s = String(value);
  return capCell_(/^[=+\-@]/.test(s) ? "'" + s : s);  // a value is never read as a formula
}

/** Sheets refuses a cell over 50,000 characters (and the whole write with it), so every cell the bot writes stays under this. */
const SHEET_CELL_MAX_CHARS_ = 49000;

/** A text cut to fit one cell (Pure). */
function capCell_(s, max) {
  const n = max || SHEET_CELL_MAX_CHARS_;
  return typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * A JSON column's value as JSON that fits one cell and still parses (Pure). Too long: inline image data (`base64`) goes
 * first, then the longest texts are cut (the alert's text, a long summary), then the longest lists; past that it's an
 * empty object or list, as decodeCell_ reads a blank cell.
 */
function capJson_(value, max) {
  const n = max || SHEET_CELL_MAX_CHARS_;
  let s = JSON.stringify(value);
  if (s === undefined || s.length <= n) return s;
  const box = { v: JSON.parse(s) };  // the value itself is a leaf too (a list that's too long)
  const leaves = () => {  // [{holder, key, value}] for every string and list in the value
    const out = [];
    const walk = holder => Object.keys(holder).forEach(k => {
      const x = holder[k];
      if (typeof x === 'string' || Array.isArray(x)) out.push({ holder, key: k, value: x });
      if (x && typeof x === 'object') walk(x);
    });
    walk(box);
    return out;
  };
  leaves().filter(l => l.key === 'base64' && !Array.isArray(l.holder)).forEach(l => { delete l.holder[l.key]; });
  s = JSON.stringify(box.v);
  for (let i = 0; s.length > n && i < 200; i++) {
    const texts = leaves().filter(l => typeof l.value === 'string' && l.value.length > 400);
    const lists = leaves().filter(l => Array.isArray(l.value) && l.value.length > 1);
    const longest = arr => arr.reduce((a, b) => (!a || JSON.stringify(b.value).length > JSON.stringify(a.value).length ? b : a), null);
    const text = longest(texts);
    const list = text ? null : longest(lists);
    if (text) text.holder[text.key] = text.value.slice(0, Math.max(200, Math.floor(text.value.length / 2))) + '…';
    else if (list) list.holder[list.key] = list.value.slice(0, Math.ceil(list.value.length / 2));
    else break;
    s = JSON.stringify(box.v);
  }
  if (s.length <= n) return s;
  return Array.isArray(box.v) ? '[]' : '{}';
}

function decodeCell_(column, value) {
  if (JSON_COLUMNS_.indexOf(column) >= 0) {
    const empty = OBJECT_COLUMNS_.indexOf(column) >= 0 ? {} : [];
    if (value === '' || value === null || value === undefined) return empty;
    try { return JSON.parse(value); } catch (e) { return empty; }
  }
  if (value instanceof Date) return value.getTime();
  return value;
}
