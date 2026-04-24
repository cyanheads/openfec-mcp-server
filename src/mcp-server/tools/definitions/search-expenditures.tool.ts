/**
 * @fileoverview Search independent expenditures (Schedule E) — outside spending
 * by Super PACs, party committees, and other groups supporting or opposing
 * federal candidates. Key dataset for tracking outside money in elections.
 * @module mcp-server/tools/definitions/search-expenditures.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import {
  buildSearchCriteria,
  formatEmptyResult,
  renderRecord,
  SearchCriteriaSchema,
} from './utils/format-helpers.js';
import { validateCandidateId, validateCommitteeId } from './utils/id-validators.js';

/** Expand S/O indicator to a readable label. */
const supportOpposeLabel = (code: unknown) =>
  code === 'S' ? 'SUPPORT' : code === 'O' ? 'OPPOSE' : String(code ?? '');

const modes = ['itemized', 'by_candidate'] as const;

export const searchExpenditures = tool('openfec_search_expenditures', {
  description:
    'Search independent expenditures (Schedule E) — outside spending supporting or opposing federal candidates. Covers Super PACs, party committees, and other groups. Use itemized mode for individual expenditure records, or by_candidate for aggregated totals per candidate.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    mode: z
      .enum(modes)
      .default('itemized')
      .describe(
        'Query mode. "itemized" returns individual expenditure records (keyset pagination). "by_candidate" returns aggregated totals per candidate by committee (page-based).',
      ),
    committee_id: z.string().optional().describe('Spending committee ID (e.g., C00703975).'),
    candidate_id: z.string().optional().describe('Targeted candidate ID (e.g., P00003392).'),
    support_oppose: z
      .enum(['S', 'O'])
      .optional()
      .describe(
        'S = support, O = oppose. Filter by whether the expenditure supports or opposes the candidate.',
      ),
    payee_name: z.string().optional().describe('Full-text payee name search. Itemized only.'),
    candidate_office: z
      .enum(['H', 'S', 'P'])
      .optional()
      .describe('Office of the targeted candidate: H=House, S=Senate, P=President.'),
    candidate_office_state: z
      .string()
      .optional()
      .describe('Two-letter state code of the targeted race.'),
    candidate_party: z
      .string()
      .optional()
      .describe('Three-letter party code of the targeted candidate (e.g., DEM, REP).'),
    cycle: z.number().optional().describe('Two-year election cycle (e.g., 2024). Even years only.'),
    min_date: z
      .string()
      .optional()
      .describe('Earliest expenditure date (YYYY-MM-DD). Itemized only.'),
    max_date: z
      .string()
      .optional()
      .describe('Latest expenditure date (YYYY-MM-DD). Itemized only.'),
    min_amount: z
      .number()
      .optional()
      .describe('Minimum expenditure amount in dollars. Itemized only.'),
    max_amount: z
      .number()
      .optional()
      .describe('Maximum expenditure amount in dollars. Itemized only.'),
    is_notice: z
      .boolean()
      .optional()
      .describe('Only 24/48-hour notice filings (near-election spending). Itemized only.'),
    most_recent: z
      .boolean()
      .default(true)
      .describe('Only the most recent version of amended filings. Itemized only.'),
    sort: z
      .enum(['expenditure_date', 'expenditure_amount', 'office_total_ytd'])
      .optional()
      .describe('Sort field. Itemized only.'),
    per_page: z.number().default(20).describe('Results per page (max 100).'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque pagination cursor from a previous response. Itemized mode only (keyset pagination).',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .looseObject({})
          .describe('An expenditure record (itemized entry) or a per-candidate aggregate row.'),
      )
      .describe('Expenditure records (itemized) or per-candidate aggregate rows.'),
    next_cursor: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Pagination cursor for the next page of itemized results. Null when no more pages.',
      ),
    count: z.number().optional().describe('Total result count (may be approximate for itemized).'),
    pagination: z
      .object({
        page: z.number().describe('Current page number.'),
        pages: z.number().describe('Total pages.'),
        count: z.number().describe('Total results.'),
        per_page: z.number().describe('Results per page.'),
      })
      .optional()
      .describe('Page-based pagination info (by_candidate mode only).'),
    search_criteria: SearchCriteriaSchema,
  }),

  async handler(input, ctx) {
    const fec = getOpenFecService();
    const mode = input.mode;

    if (input.candidate_id) validateCandidateId(input.candidate_id);
    if (input.committee_id) validateCommitteeId(input.committee_id);

    /* ---------------------------------------------------------------- */
    /*  Itemized expenditures (keyset/SEEK)                             */
    /* ---------------------------------------------------------------- */
    if (mode === 'itemized') {
      const params: FecParams = {
        per_page: input.per_page,
        most_recent: input.most_recent,
      };

      if (input.committee_id) params.committee_id = input.committee_id;
      if (input.candidate_id) params.candidate_id = input.candidate_id;
      if (input.support_oppose) params.support_oppose_indicator = input.support_oppose;
      if (input.payee_name) params.payee_name = input.payee_name;
      if (input.candidate_office) params.candidate_office = input.candidate_office;
      if (input.candidate_office_state)
        params.candidate_office_state = input.candidate_office_state;
      if (input.candidate_party) params.candidate_party = input.candidate_party;
      if (input.cycle) params.cycle = input.cycle;
      if (input.min_date) params.min_date = input.min_date;
      if (input.max_date) params.max_date = input.max_date;
      if (input.min_amount !== undefined) params.min_amount = input.min_amount;
      if (input.max_amount !== undefined) params.max_amount = input.max_amount;
      if (input.is_notice !== undefined) params.is_notice = input.is_notice;
      if (input.sort) params.sort = input.sort;

      if (input.cursor) {
        const lastIndexes = decodeCursor(input.cursor);
        Object.assign(params, lastIndexes);
      }

      const result = await fec.searchExpenditures(params, ctx);
      ctx.log.info('Itemized expenditures fetched', {
        committee_id: input.committee_id,
        candidate_id: input.candidate_id,
        count: result.pagination.count,
        returned: result.results.length,
      });

      return {
        results: result.results,
        next_cursor: result.nextCursor,
        count: result.pagination.count,
        search_criteria: result.results.length === 0 ? buildSearchCriteria(input) : undefined,
      };
    }

    /* ---------------------------------------------------------------- */
    /*  By candidate (page-based)                                       */
    /* ---------------------------------------------------------------- */
    if (!input.candidate_id) {
      throw invalidParams(
        'by_candidate mode requires a candidate_id. Use openfec_search_candidates to find the ID, then pass it here to see independent expenditures supporting or opposing that candidate.',
        { mode: input.mode },
      );
    }

    const params: FecParams = { per_page: input.per_page };

    if (input.committee_id) params.committee_id = input.committee_id;
    if (input.candidate_id) params.candidate_id = input.candidate_id;
    if (input.support_oppose) params.support_oppose_indicator = input.support_oppose;
    if (input.candidate_office) params.candidate_office = input.candidate_office;
    if (input.candidate_office_state) params.candidate_office_state = input.candidate_office_state;
    if (input.candidate_party) params.candidate_party = input.candidate_party;
    if (input.cycle) params.cycle = input.cycle;

    const result = await fec.getExpendituresByCandidate(params, ctx);
    ctx.log.info('Expenditures by candidate fetched', {
      count: result.pagination.count,
      returned: result.results.length,
    });

    return {
      results: result.results,
      pagination: result.pagination,
      search_criteria: result.results.length === 0 ? buildSearchCriteria(input) : undefined,
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return formatEmptyResult(
        result.search_criteria,
        'Try a different cycle, broaden filters, or verify the candidate_id/committee_id. Not all races attract significant outside spending.',
      );
    }

    const isItemized = 'next_cursor' in result && result.next_cursor !== undefined;
    const lines: string[] = [];

    if (isItemized) {
      if (result.count != null) {
        lines.push(`**${result.count} total independent expenditures**\n`);
      }
    }
    for (const r of result.results) {
      const indicator = supportOpposeLabel(r.support_oppose_indicator);
      const candidate = String(r.candidate_name ?? r.candidate_id ?? 'Unknown');
      lines.push(
        `**[${indicator}] ${candidate}**\n${renderRecord(r, new Set(['candidate_name', 'support_oppose_indicator']))}`,
      );
    }
    if (isItemized && result.next_cursor) {
      lines.push(`\n_More results available — next_cursor: ${result.next_cursor}_`);
    }

    if (result.pagination) {
      const p = result.pagination;
      lines.push(`\n_Page ${p.page} of ${p.pages} · ${p.count} total · ${p.per_page} per page_`);
    }

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
