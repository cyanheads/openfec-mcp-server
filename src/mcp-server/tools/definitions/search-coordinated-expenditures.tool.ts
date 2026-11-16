/**
 * @fileoverview Search coordinated party expenditures (Schedule F) — spending a
 * party committee makes on behalf of its own candidate, under a separate legal
 * limit from contributions and distinct from independent expenditures.
 * @module mcp-server/tools/definitions/search-coordinated-expenditures.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import {
  buildSearchCriteria,
  describeExhaustedPosition,
  exhaustedPage,
  fmt$,
  fmtTotal,
  formatEmptyResult,
  formatExhaustedResult,
  formatSearchCriteria,
  PaginationSchema,
  renderRecord,
  SearchCriteriaSchema,
  str,
  toPagination,
} from './utils/format-helpers.js';
import { validateCandidateId, validateCommitteeId } from './utils/id-validators.js';
import { validateScheduleRanges } from './utils/range-validators.js';
import { markRowKinds, rowKindSentences } from './utils/row-kinds.js';
import {
  COMMITTEES,
  CommitteeMapSchema,
  committeeRenderers,
  formatCommitteeMaps,
  formatHoistedCommittee,
  HoistedCommitteeSchema,
  trimScheduleRows,
} from './utils/trim-schedule-row.js';

export const searchCoordinatedExpenditures = tool('openfec_search_coordinated_expenditures', {
  description:
    'Search coordinated party expenditures (Schedule F) — spending a party committee makes on behalf of a candidate it supports, in coordination with that campaign. Distinct from independent expenditures (openfec_search_expenditures), which cannot be coordinated with the candidate, and from direct contributions: coordinated expenditures carry their own statutory limits and can run into tens of millions per party in a presidential cycle. Scope with a spending committee_id, a benefiting candidate_id, or a cycle; unscoped queries span all years.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    committee_id: z
      .string()
      .optional()
      .describe(
        'Spending party committee ID (e.g., C00003418). Get IDs from openfec_search_committees results — party committees carry committee_type X or Y.',
      ),
    candidate_id: z
      .string()
      .optional()
      .describe(
        'Benefiting candidate ID (e.g., P00003392). Get IDs from openfec_search_candidates results.',
      ),
    cycle: z
      .number()
      .optional()
      .describe(
        'Two-year election cycle (e.g., 2024). Even years only. Omitting it searches every cycle on record.',
      ),
    payee_name: z
      .string()
      .optional()
      .describe('Full-text payee name search (the vendor the party paid).'),
    min_date: z.string().optional().describe('Earliest expenditure date (YYYY-MM-DD).'),
    max_date: z.string().optional().describe('Latest expenditure date (YYYY-MM-DD).'),
    min_amount: z.number().optional().describe('Minimum expenditure amount in dollars.'),
    max_amount: z.number().optional().describe('Maximum expenditure amount in dollars.'),
    sort: z
      .enum(['expenditure_date', '-expenditure_date', 'expenditure_amount', '-expenditure_amount'])
      .optional()
      .describe(
        'Sort field. A "-" prefix sorts descending: use "-expenditure_amount" for the largest coordinated spending first, since the ascending form leads with the most negative rows (corrections and voided entries). OpenFEC sorts by "-expenditure_date" when omitted.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Page number (1-indexed). Read pagination.pages in the response to see how many pages exist.',
      ),
    per_page: z.number().int().min(1).max(100).default(20).describe('Results per page.'),
  }),

  output: z.object({
    results: z
      .array(
        z
          .looseObject({})
          .describe(
            'Coordinated expenditure record; common keys include expenditure_date, expenditure_amount, payee_name, candidate_id, candidate_name, candidate_office, expenditure_type_full, pdf_url, and subordinate_committee_id — the committee the expenditure was attributed to, which is usually the spender but can be another committee; look it up with openfec_search_committees. The spender is committee_id: its record is the hoisted committee on a query scoped to one committee_id, otherwise its entry in committees. A row with memo_code "X" is a memo entry: it itemizes another row, named by back_reference_transaction_id when filed, or restates earlier activity, and FEC leaves it out of report totals — never add it to the other rows.',
          ),
      )
      .describe('Coordinated expenditure result set; one record per itemized transaction.'),
    committee: HoistedCommitteeSchema,
    committees: CommitteeMapSchema.describe(
      "The spending party committees, keyed by the committee_id each row carries: every distinct spender once, in full, instead of a copy on each row. Present when the query was not scoped to a single committee_id. A row whose record differs from its ID's entry — the same committee's record for another cycle, on a page spanning cycles — keeps its own.",
    ),
    pagination: PaginationSchema,
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching coordinated expenditures before pagination.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the response needs context: how to broaden a search that matched nothing, which requested position ran out when expenditures did match, or how many rows on the page are memo entries not to be added to the rest.',
      ),
  },

  async handler(input, ctx) {
    if (input.committee_id) validateCommitteeId(input.committee_id);
    if (input.candidate_id) validateCandidateId(input.candidate_id);

    validateScheduleRanges(input);

    const fec = getOpenFecService();

    const params: FecParams = { page: input.page, per_page: input.per_page };
    if (input.committee_id) params.committee_id = input.committee_id;
    if (input.candidate_id) params.candidate_id = input.candidate_id;
    if (input.cycle !== undefined) params.cycle = input.cycle;
    if (input.payee_name) params.payee_name = input.payee_name;
    if (input.min_date) params.min_date = input.min_date;
    if (input.max_date) params.max_date = input.max_date;
    if (input.min_amount !== undefined) params.min_amount = input.min_amount;
    if (input.max_amount !== undefined) params.max_amount = input.max_amount;
    if (input.sort) params.sort = input.sort;

    ctx.log.info('Searching coordinated expenditures', {
      committee_id: input.committee_id,
      candidate_id: input.candidate_id,
      cycle: input.cycle,
    });

    const result = await fec.searchCoordinatedExpenditures(params, ctx);

    /**
     * Rows carry the spending committee as `committee`: hoisted when the caller
     * pinned one, otherwise collected once per spender into `committees`.
     * `subordinate_committee` is a second embedded committee object: null on
     * most rows, the spender again on most of the rest, occasionally a
     * different committee. It is dropped because the row's own
     * `subordinate_committee_id` always matches it, and that ID resolves through
     * openfec_search_committees.
     */
    const trimmed = trimScheduleRows(result.results as Record<string, unknown>[], {
      hoistCommittee: Boolean(input.committee_id),
      drop: ['subordinate_committee'],
      collect: [COMMITTEES],
    });

    ctx.enrich.total(result.pagination.count);
    const exhausted = exhaustedPage(result.pagination, trimmed.results.length);
    if (exhausted) {
      ctx.enrich.notice(describeExhaustedPosition(exhausted));
    } else if (trimmed.results.length === 0) {
      ctx.enrich.notice(
        'No coordinated party expenditures matched. Try a different cycle, drop the committee_id or candidate_id filter, or confirm the committee is a party committee — only party committees report Schedule F.',
      );
    } else {
      const notices = rowKindSentences(trimmed.results);
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    }

    return {
      results: trimmed.results,
      ...(trimmed.committee ? { committee: trimmed.committee } : {}),
      ...(trimmed.committees ? { committees: trimmed.committees } : {}),
      pagination: toPagination(result.pagination),
      search_criteria: buildSearchCriteria(input),
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      const exhausted = exhaustedPage(result.pagination, 0);
      if (exhausted) return formatExhaustedResult(result.search_criteria, exhausted);
      return formatEmptyResult(
        result.search_criteria,
        'Try a different cycle, drop the committee_id or candidate_id filter, or confirm the committee is a party committee — only party committees report Schedule F.',
      );
    }

    const headerKeys = new Set(['candidate_name', 'expenditure_amount', 'expenditure_date']);
    const renderers = committeeRenderers(result);
    const lines: string[] = [...formatHoistedCommittee(result.committee)];

    for (const row of result.results) {
      const candidate = str(row, 'candidate_name') || str(row, 'candidate_id') || 'Unknown';
      const date = str(row, 'expenditure_date').slice(0, 10);
      const header = markRowKinds(
        `**${fmt$(row.expenditure_amount)} for ${candidate}**${date ? ` — ${date}` : ''}`,
        row,
      );
      const fields = renderRecord(row, headerKeys, renderers);
      lines.push(fields ? `${header}\n${fields}` : header);
    }
    lines.push(...formatCommitteeMaps(result));

    const { page, pages, count, per_page, count_is_approximate } = result.pagination;
    lines.push(
      `\n---\nPage ${page} of ${pages} · ${fmtTotal(count, count_is_approximate)} · ${per_page} per page`,
    );

    const criteria = formatSearchCriteria(result.search_criteria);
    if (criteria) lines.push(criteria);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
