/**
 * @fileoverview Itemized schedule rows that must not be summed with the rest of
 * their page: memo entries (Schedules A, B, E, F), which itemize or restate
 * another row and sit outside FEC report totals, and 24/48-hour notices
 * (Schedule E), most of which reappear on the spender's next periodic report.
 * OpenFEC takes no memo filter and notices are the newest spending, so these
 * rows are labelled, not dropped: a marker in each one's `content[]` header,
 * and a sentence for each kind a page mixes with other rows.
 * @module src/mcp-server/tools/definitions/utils/row-kinds
 */

type Row = Record<string, unknown>;

interface RowKind {
  /** The marker appended to a matching row's `content[]` header. */
  marker: string;
  matches: (row: Row) => boolean;
  /** The page sentence for `n` matching rows among `m`. */
  sentence: (n: number, m: number) => string;
}

/**
 * Judged separately: a row can be both a memo entry and a notice. `memo_code
 * === "X"` is the memo test that holds on all four schedules — Schedule F rows
 * carry no `memoed_subtotal`.
 */
const ROW_KINDS: readonly RowKind[] = [
  {
    marker: 'memo entry',
    matches: (row) => row.memo_code === 'X',
    sentence: (n, m) =>
      `${n} of ${m} rows on this page are memo entries (memo_code "X"): each itemizes another row, named by back_reference_transaction_id when filed, or restates earlier activity, and FEC leaves memo entries out of report totals. Do not add them to the other rows.`,
  },
  {
    marker: '24/48-hour notice',
    matches: (row) => row.is_notice === true,
    sentence: (n, m) =>
      `${n} of ${m} rows on this page are 24/48-hour notices (is_notice: true): most notice spending is reported again on the spender's next periodic report, so do not add notice rows to report rows. Pass is_notice: false for report rows or is_notice: true for notices only.`,
  },
];

/** A row's `content[]` header with a marker for each kind the row is: `**NAME** · memo entry`. */
export function markRowKinds(header: string, row: Row): string {
  const markers = ROW_KINDS.filter((kind) => kind.matches(row)).map((kind) => kind.marker);
  return [header, ...markers].join(' · ');
}

/**
 * One sentence for each kind the page mixes with other rows, counted on the
 * returned rows. A page of one kind sums consistently within itself, and an
 * empty page has nothing to sum, so neither gets one. `ctx.enrich.notice` is
 * last-wins: join these with the page's other notice sentences into one call.
 */
export function rowKindSentences(rows: readonly Row[]): string[] {
  return ROW_KINDS.flatMap((kind) => {
    const n = rows.filter(kind.matches).length;
    return n > 0 && n < rows.length ? [kind.sentence(n, rows.length)] : [];
  });
}
