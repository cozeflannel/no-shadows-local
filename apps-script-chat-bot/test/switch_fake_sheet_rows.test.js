// The test harness's sheet (fakes.js FakeSheet): insertRowsBefore and deleteRows as Google Sheets does them, for the
// tabs that are written newest first and trimmed at the bottom.
'use strict';

module.exports = H => {
  const { test, eq, assert, FakeSpreadsheet } = H;
  const LINK = 'https://docs.google.com/document/d/doc1/edit';

  /** A tab with a title row, a header row and three data rows (the second with a formula, a dropdown, a link chip, a height). */
  const tab = () => {
    const sh = new FakeSpreadsheet('ss1', 'Book').insertSheet('Log');
    sh.getRange(1, 1, 5, 2).setValues([['Title', ''], ['When', 'What'], ['r3', 'a'], ['r4', '=HYPERLINK("https://x.com/a/status/1","a post")'], ['r5', 'c']]);
    sh.setFrozenRows(2);
    sh.getRange(4, 2).setDataValidation({ values: ['ON', 'OFF'] });
    sh.links['4,1'] = LINK;
    sh.setRowHeight(4, 42);
    sh.getRange(1, 1, 1, 2).merge();
    sh.getRange(4, 1, 2, 1).merge();
    return sh;
  };
  const col = (sh, c) => sh.rows.map(r => (r[c - 1] === undefined ? '' : r[c - 1]));

  test('fake sheet: insertRowsBefore puts blank rows in and moves the row there and every row below it down, with its values, formulas, dropdowns, link chips, row heights and merges; rows above stay; rows put in below the last row with content change nothing', () => {
    const sh = tab();
    assert.strictEqual(sh.insertRowsBefore(3, 2), sh);  // returns the sheet, as in Sheets
    eq([sh.getLastRow(), col(sh, 1)], [7, ['Title', 'When', '', '', 'r3', 'r4', 'r5']]);
    eq(sh.getRange(3, 1, 2, 2).getValues(), [['', ''], ['', '']]);
    eq([sh.cell(6, 2), sh.getRange(6, 2).getDataValidation().values, sh.getRange(4, 2).getDataValidation(),
      sh.getRange(6, 1).getRichTextValues()[0][0].getLinkUrl(), sh.getRange(4, 1).getRichTextValues()[0][0].getLinkUrl(),
      sh.heights, sh.merges, sh.frozenRows],
    ['=HYPERLINK("https://x.com/a/status/1","a post")', ['ON', 'OFF'], null, LINK, null, { 6: 42 }, ['1,1,1,2', '6,1,2,1'], 2]);
    // rows put in inside a merge make it taller; among the frozen rows, they are frozen too
    sh.insertRowsBefore(7, 1);
    eq([sh.merges, col(sh, 1).slice(5)], [['1,1,1,2', '6,1,3,1'], ['r4', '', 'r5']]);
    sh.insertRowsBefore(2, 1);
    eq([sh.frozenRows, col(sh, 1).slice(0, 3), sh.merges], [3, ['Title', '', 'When'], ['1,1,1,2', '7,1,3,1']]);
    // below the last row with content: the rows are there, blank, and nothing moves
    const quiet = tab();
    quiet.insertRowsBefore(6, 3);
    quiet.insertRowsBefore(40, 1);
    eq([quiet.getLastRow(), quiet.rows, quiet.validations, quiet.links, quiet.heights, quiet.merges],
      [5, tab().rows, tab().validations, tab().links, tab().heights, tab().merges]);
  });

  test('fake sheet: deleteRows takes the rows out and moves every row below them up, with its values, formulas, dropdowns, link chips, row heights and merges; what the deleted rows had is gone; rows deleted below the last row with content change nothing', () => {
    const sh = tab();
    assert.strictEqual(sh.deleteRows(3, 1), undefined);  // returns nothing, as in Sheets
    eq([sh.getLastRow(), col(sh, 1), sh.cell(3, 2), sh.getRange(3, 2).getDataValidation().values,
      sh.getRange(3, 1).getRichTextValues()[0][0].getLinkUrl(), sh.heights, sh.merges, sh.frozenRows],
    [4, ['Title', 'When', 'r4', 'r5'], '=HYPERLINK("https://x.com/a/status/1","a post")', ['ON', 'OFF'], LINK, { 3: 42 }, ['1,1,1,2', '3,1,2,1'], 2]);
    // the row with the dropdown, the link chip and the height goes: so do they; the merge keeps the row it has left
    sh.deleteRows(3, 1);
    eq([col(sh, 1), sh.validations, sh.links, sh.heights, sh.merges], [['Title', 'When', 'r5'], {}, {}, {}, ['1,1,1,2', '3,1,1,1']]);
    // more rows than there are with content, and a frozen row: the last row with content is the last one left
    const cut = tab();
    cut.deleteRows(2, 10);
    eq([cut.getLastRow(), cut.rows, cut.frozenRows, cut.merges], [1, [['Title', '']], 1, ['1,1,1,2']]);
    const below = tab();
    below.deleteRows(6, 5);
    eq([below.getLastRow(), below.rows, below.merges], [5, tab().rows, tab().merges]);
    // newest first, trimmed at the bottom: two rows in under the header, then the last two rows out
    const log = tab();
    log.insertRowsBefore(3, 2).getRange(3, 1, 2, 2).setValues([['new1', 'x'], ['new2', 'y']]);
    log.deleteRows(log.getLastRow() - 1, 2);
    eq(col(log, 1), ['Title', 'When', 'new1', 'new2', 'r3']);
  });

  test('fake sheet: insertRowsBefore and deleteRows refuse what Sheets refuses: a row before the first, fewer than one row, and anything that is not a whole number (so a miscounted trim fails in a test as it would on the live sheet)', () => {
    const sh = tab();
    const rows = JSON.stringify(sh.rows);
    [[0, 1, /starting row of the range is too small/], [3, 0, /number of rows in the range must be at least 1/],
      [3, -2, /at least 1/], [3, undefined, /don't match the method signature/], ['3', 1, /don't match the method signature/],
      [2.5, 1, /don't match the method signature/]].forEach(([r, n, why]) => {
      assert.throws(() => sh.insertRowsBefore(r, n), why, `insertRowsBefore(${r}, ${n})`);
      assert.throws(() => sh.deleteRows(r, n), why, `deleteRows(${r}, ${n})`);
    });
    eq(JSON.stringify(sh.rows), rows);
  });
};
