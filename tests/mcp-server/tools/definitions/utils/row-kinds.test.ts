/**
 * @fileoverview Tests for the row-kind helper — which itemized rows are memo
 * entries or 24/48-hour notices, the header marker each gets, and the page
 * sentence for a kind mixed with other rows. Every case is tabled here once;
 * the schedule tools' tests prove only their wiring.
 * @module tests/mcp-server/tools/definitions/utils/row-kinds.test
 */

import { describe, expect, it } from 'vitest';
import { markRowKinds, rowKindSentences } from '@/mcp-server/tools/definitions/utils/row-kinds.js';

type Row = Record<string, unknown>;

const MEMO = (n: number, m: number) =>
  `${n} of ${m} rows on this page are memo entries (memo_code "X"): each itemizes another row, named by back_reference_transaction_id when filed, or restates earlier activity, and FEC leaves memo entries out of report totals. Do not add them to the other rows.`;

const NOTICE = (n: number, m: number) =>
  `${n} of ${m} rows on this page are 24/48-hour notices (is_notice: true): most notice spending is reported again on the spender's next periodic report, so do not add notice rows to report rows. Pass is_notice: false for report rows or is_notice: true for notices only.`;

/** Schedule A/B/E memo row: both memo fields set. */
const memo: Row = { memo_code: 'X', memoed_subtotal: true };
/** Schedule F memo row: no memoed_subtotal field at all. */
const memoF: Row = { memo_code: 'X' };
const plain: Row = { memo_code: null, memoed_subtotal: false };
const notice: Row = { is_notice: true };
const report: Row = { is_notice: false };

const times = (row: Row, n: number) => Array.from({ length: n }, () => ({ ...row }));

describe('markRowKinds', () => {
  it.each([
    ['a Schedule A/B/E memo row', memo, '**H** · memo entry'],
    ['a Schedule F memo row with no memoed_subtotal', memoF, '**H** · memo entry'],
    ['a 24/48-hour notice row', notice, '**H** · 24/48-hour notice'],
    ['a row that is both', { ...memo, ...notice }, '**H** · memo entry · 24/48-hour notice'],
    ['a plain row', plain, '**H**'],
    ['a periodic report row', report, '**H**'],
    ['a row with neither field', {}, '**H**'],
    [
      'a row whose memoed_subtotal is set without memo_code "X"',
      { memoed_subtotal: true },
      '**H**',
    ],
    ['a memo_code other than "X"', { memo_code: 'x' }, '**H**'],
    ['an is_notice that is not the boolean true', { is_notice: 'true' }, '**H**'],
    ['a null is_notice', { is_notice: null }, '**H**'],
  ])('marks %s', (_label, row, expected) => {
    expect(markRowKinds('**H**', row)).toBe(expected);
  });
});

describe('rowKindSentences', () => {
  it.each([
    ['memo rows among other rows', [...times(memo, 3), ...times(plain, 2)], [MEMO(3, 5)]],
    ['one Schedule F memo row among thirty', [memoF, ...times({}, 29)], [MEMO(1, 30)]],
    ['notice rows among report rows', [notice, report, report], [NOTICE(1, 3)]],
    [
      'both kinds on one page, memo first',
      [{ ...memo, ...report }, { ...notice }, { ...notice }, { ...report }],
      [MEMO(1, 4), NOTICE(2, 4)],
    ],
    [
      'a row that is both, counted in each kind',
      [{ ...memo, ...notice }, report, report],
      [MEMO(1, 3), NOTICE(1, 3)],
    ],
    ['an all-memo page', times(memo, 4), []],
    ['an all-notice page', times(notice, 4), []],
    ['an all-report page', times(report, 4), []],
    ['a page with neither kind', times(plain, 4), []],
    ['an empty page', [], []],
    [
      'an all-notice page with memo rows among them — only the memo sentence',
      [{ ...notice, ...memo }, notice, notice],
      [MEMO(1, 3)],
    ],
  ])('for %s', (_label, rows, expected) => {
    expect(rowKindSentences(rows)).toEqual(expected);
  });
});
