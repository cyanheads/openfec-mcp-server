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
  fmt$,
  formatEmptyResult,
  formatSearchCriteria,
  PaginationSchema,
  renderRecord,
  SearchCriteriaSchema,
  str,
} from './utils/format-helpers.js';
import { validateCandidateId, validateCommitteeId } from './utils/id-validators.js';
import { validateRange } from './utils/range-validators.js';
import {
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
            'Coordinated expenditure record; common keys include expenditure_date, expenditure_amount, payee_name, candidate_id, candidate_name, candidate_office, expenditure_type_full, pdf_url, and subordinate_committee_id — the committee the expenditure was attributed to, which is usually the spender but can be another committee; look it up with openfec_search_committees.',
          ),
      )
      .describe('Coordinated expenditure result set; one record per itemized transaction.'),
    committee: HoistedCommitteeSchema,
    pagination: PaginationSchema,
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching coordinated expenditures before pagination.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no coordinated expenditures matched — echoes filters and suggests how to broaden.',
      ),
  },

  async handler(input, ctx) {
    if (input.committee_id) validateCommitteeId(input.committee_id);
    if (input.candidate_id) validateCandidateId(input.candidate_id);

    validateRange({
      minField: 'min_date',
      minValue: input.min_date,
      maxField: 'max_date',
      maxValue: input.max_date,
      valueType: 'date',
    });
    validateRange({
      minField: 'min_amount',
      minValue: input.min_amount,
      maxField: 'max_amount',
      maxValue: input.max_amount,
      valueType: 'number',
    });

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

    ctx.enrich.total(result.pagination.count);
    if (result.results.length === 0) {
      ctx.enrich.notice(
        'No coordinated party expenditures matched. Try a different cycle, drop the committee_id or candidate_id filter, or confirm the committee is a party committee — only party committees report Schedule F.',
      );
    }

    /**
     * Rows carry the spending committee as `committee`, hoisted when the caller
     * pinned one. `subordinate_committee` is a second embedded committee object:
     * null on most rows, the spender again on most of the rest, occasionally a
     * different committee. It is dropped because the row's own
     * `subordinate_committee_id` always matches it, and that ID resolves through
     * openfec_search_committees.
     */
    const trimmed = trimScheduleRows(result.results as Record<string, unknown>[], {
      hoistCommittee: Boolean(input.committee_id),
      drop: ['subordinate_committee'],
    });

    return {
      results: trimmed.results,
      ...(trimmed.committee ? { committee: trimmed.committee } : {}),
      pagination: result.pagination,
      search_criteria: buildSearchCriteria(input),
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return formatEmptyResult(
        result.search_criteria,
        'Try a different cycle, drop the committee_id or candidate_id filter, or confirm the committee is a party committee — only party committees report Schedule F.',
      );
    }

    const headerKeys = new Set(['candidate_name', 'expenditure_amount', 'expenditure_date']);
    const lines: string[] = [...formatHoistedCommittee(result.committee)];

    for (const row of result.results) {
      const candidate = str(row, 'candidate_name') || str(row, 'candidate_id') || 'Unknown';
      const date = str(row, 'expenditure_date').slice(0, 10);
      const header = `**${fmt$(row.expenditure_amount)} for ${candidate}**${date ? ` — ${date}` : ''}`;
      const fields = renderRecord(row, headerKeys);
      lines.push(fields ? `${header}\n${fields}` : header);
    }

    const { page, pages, count, per_page } = result.pagination;
    lines.push(`\n---\nPage ${page} of ${pages} · ${count} total · ${per_page} per page`);

    const criteria = formatSearchCriteria(result.search_criteria);
    if (criteria) lines.push(criteria);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
