/**
 * @fileoverview Search independent expenditures (Schedule E) — outside spending
 * by Super PACs, party committees, and other groups supporting or opposing
 * federal candidates. Key dataset for tracking outside money in elections.
 * @module mcp-server/tools/definitions/search-expenditures.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  cursorQuery,
  decodeCursor,
  getOpenFecService,
} from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import { currentCycle } from './utils/election-cycle.js';
import {
  buildSearchCriteria,
  formatEmptyResult,
  PaginationSchema,
  renderRecord,
  SearchCriteriaSchema,
} from './utils/format-helpers.js';
import { validateCandidateId, validateCommitteeId } from './utils/id-validators.js';

/** Expand S/O indicator to a readable label. */
const supportOpposeLabel = (code: unknown) =>
  code === 'S' ? 'SUPPORT' : code === 'O' ? 'OPPOSE' : String(code ?? '');

const modes = ['itemized', 'by_candidate'] as const;

/**
 * `/schedules/schedule_e/by_candidate/` spells the office out where the itemized
 * endpoint uses a single letter, and rejects the letter form with a 422.
 */
const BY_CANDIDATE_OFFICE: Record<'H' | 'S' | 'P', string> = {
  H: 'house',
  S: 'senate',
  P: 'president',
};

export const searchExpenditures = tool('openfec_search_expenditures', {
  description:
    'Search independent expenditures (Schedule E) — outside spending supporting or opposing federal candidates. Covers Super PACs, party committees, and other groups. Use itemized mode for individual expenditure records, or by_candidate for aggregated totals per candidate; by_candidate needs either a candidate_id or a full race scope (candidate_office alone for President, plus candidate_office_state for Senate, plus candidate_office_district as well for House).',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'by_candidate_requires_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'by_candidate mode invoked without a candidate_id and without a full race scope',
      recovery:
        'Pass a candidate_id (find one with openfec_search_candidates), or scope a whole race: candidate_office=P on its own, candidate_office=S with candidate_office_state, or candidate_office=H with both candidate_office_state and candidate_office_district.',
    },
    {
      reason: 'candidate_party_not_supported_by_candidate',
      code: JsonRpcErrorCode.ValidationError,
      when: 'candidate_party passed in by_candidate mode, which the aggregate endpoint cannot filter on',
      recovery:
        'Drop candidate_party and scope by candidate_id or by a race (candidate_office, with candidate_office_state for S and both the state and candidate_office_district for H), or switch to mode itemized where party filtering is supported.',
    },
  ],

  input: z.object({
    mode: z
      .enum(modes)
      .default('itemized')
      .describe(
        'Query mode. "itemized" returns individual expenditure records (keyset pagination). "by_candidate" returns aggregated totals per candidate by committee (page-based).',
      ),
    committee_id: z
      .string()
      .optional()
      .describe(
        'Spending committee ID (e.g., C00703975). Get IDs from openfec_search_committees results.',
      ),
    candidate_id: z
      .string()
      .optional()
      .describe(
        'Targeted candidate ID (e.g., P00003392). Get IDs from openfec_search_candidates results.',
      ),
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
      .describe(
        'Office of the targeted candidate: H=House, S=Senate, P=President. In by_candidate mode this scopes a whole race: P stands alone, S also needs candidate_office_state, H also needs candidate_office_state and candidate_office_district.',
      ),
    candidate_office_state: z
      .string()
      .optional()
      .describe(
        'Two-letter state code of the targeted race. Required alongside candidate_office=H or candidate_office=S in by_candidate mode; leave it off for candidate_office=P, whose aggregate rows carry no state and match nothing when one is supplied.',
      ),
    candidate_office_district: z
      .string()
      .optional()
      .describe(
        'Two-digit House district of the targeted race (e.g., "09"). Required alongside candidate_office=H and candidate_office_state in by_candidate mode; Senate and presidential rows carry no district and match nothing when one is supplied.',
      ),
    candidate_party: z
      .string()
      .optional()
      .describe(
        'Three-letter party code of the targeted candidate (e.g., DEM, REP). Itemized only — by_candidate rejects it, since the aggregate endpoint has no party filter.',
      ),
    cycle: z
      .number()
      .optional()
      .describe(
        'Two-year election cycle (e.g., 2024). Even years only. Itemized mode defaults to the current cycle when omitted — Schedule E spans all history and an unscoped scan times out upstream. Pass an explicit cycle to search an earlier period.',
      ),
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
      .enum([
        'expenditure_date',
        '-expenditure_date',
        'expenditure_amount',
        '-expenditure_amount',
        'office_total_ytd',
        '-office_total_ytd',
      ])
      .optional()
      .describe(
        'Sort field. A "-" prefix sorts descending: use "-expenditure_amount" for the largest outside spending first, since the ascending form leads with the most negative rows (corrections and voided entries). Itemized only; OpenFEC sorts by "-expenditure_date" when omitted.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Page number (1-indexed) for by_candidate mode. Ignored in itemized mode, which paginates with cursor. Read pagination.pages in the response to see how many pages exist.',
      ),
    per_page: z.number().int().min(1).max(100).default(20).describe('Results per page.'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque pagination cursor from a previous response of this tool. Itemized mode only (keyset pagination). Valid only for an otherwise-identical call — changing any other argument, including sort, rejects the cursor; omit it to start over.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .looseObject({})
          .describe(
            'Itemized independent expenditure record (mode=itemized) or per-candidate aggregate row (mode=by_candidate).',
          ),
      )
      .describe(
        'Expenditure result set; itemized records or per-candidate aggregates depending on mode.',
      ),
    next_cursor: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Pagination cursor for the next page of itemized results. Null when no more pages.',
      ),
    count: z.number().optional().describe('Total result count (may be approximate for itemized).'),
    pagination: PaginationSchema.optional().describe(
      'Page-based pagination info (by_candidate mode only).',
    ),
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching expenditures or per-candidate aggregates.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no expenditures matched — echoes filters and suggests how to broaden.',
      ),
  },

  async handler(input, ctx) {
    const fec = getOpenFecService();
    const mode = input.mode;

    if (input.candidate_id) validateCandidateId(input.candidate_id);
    if (input.committee_id) validateCommitteeId(input.committee_id);

    /* ---------------------------------------------------------------- */
    /*  Itemized expenditures (keyset/SEEK)                             */
    /* ---------------------------------------------------------------- */
    if (mode === 'itemized') {
      /**
       * Schedule E is large enough that an unscoped scan times out upstream, and
       * the timeout is retried — so scope the query the way itemized
       * contributions already do rather than sending an unbounded request.
       */
      const cycle = input.cycle ?? currentCycle();
      const params: FecParams = {
        per_page: input.per_page,
        most_recent: input.most_recent,
        cycle,
      };

      if (input.committee_id) params.committee_id = input.committee_id;
      if (input.candidate_id) params.candidate_id = input.candidate_id;
      if (input.support_oppose) params.support_oppose_indicator = input.support_oppose;
      if (input.payee_name) params.payee_name = input.payee_name;
      if (input.candidate_office) params.candidate_office = input.candidate_office;
      if (input.candidate_office_state)
        params.candidate_office_state = input.candidate_office_state;
      if (input.candidate_office_district)
        params.candidate_office_district = input.candidate_office_district;
      if (input.candidate_party) params.candidate_party = input.candidate_party;
      if (input.min_date) params.min_date = input.min_date;
      if (input.max_date) params.max_date = input.max_date;
      if (input.min_amount !== undefined) params.min_amount = input.min_amount;
      if (input.max_amount !== undefined) params.max_amount = input.max_amount;
      if (input.is_notice !== undefined) params.is_notice = input.is_notice;
      if (input.sort) {
        params.sort = input.sort;
        /**
         * Many Schedule E rows carry a null `office_total_ytd`, and a descending
         * sort orders nulls first — so `-office_total_ytd` would lead with empty
         * rows instead of the highest totals. Ascending already places nulls
         * last, making this a no-op there.
         */
        params.sort_nulls_last = true;
      }

      const query = cursorQuery('openfec_search_expenditures', input);
      if (input.cursor) {
        Object.assign(params, decodeCursor(input.cursor, query));
      }

      const result = await fec.searchExpenditures(params, query, ctx);
      ctx.log.info('Itemized expenditures fetched', {
        committee_id: input.committee_id,
        candidate_id: input.candidate_id,
        cycle,
        count: result.pagination.count,
        returned: result.results.length,
      });

      ctx.enrich.total(result.pagination.count);
      if (result.results.length === 0) {
        ctx.enrich.notice(
          'No independent expenditures matched. Try a different cycle, broaden filters, or verify the candidate_id/committee_id. Not all races attract significant outside spending.',
        );
      }

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
    if (input.candidate_party) {
      throw ctx.fail(
        'candidate_party_not_supported_by_candidate',
        'The by_candidate aggregate endpoint has no party filter, so candidate_party would be ignored.',
        { mode: input.mode, ...ctx.recoveryFor('candidate_party_not_supported_by_candidate') },
      );
    }

    /**
     * A whole race is a valid scope here, but a district race has to be named in
     * full: the endpoint answers 422 for `house` or `senate` without a state, and
     * for `house` without a district. The presidency is a national race — `office`
     * alone is a complete scope, and pairing it with a state matches nothing.
     */
    const raceScoped =
      input.candidate_office === 'P' ||
      (Boolean(input.candidate_office) &&
        Boolean(input.candidate_office_state) &&
        (input.candidate_office !== 'H' || Boolean(input.candidate_office_district)));

    if (!input.candidate_id && !raceScoped) {
      throw ctx.fail('by_candidate_requires_scope', undefined, {
        mode: input.mode,
        ...ctx.recoveryFor('by_candidate_requires_scope'),
      });
    }

    const params: FecParams = { page: input.page, per_page: input.per_page };

    if (input.committee_id) params.committee_id = input.committee_id;
    if (input.candidate_id) params.candidate_id = input.candidate_id;
    if (input.support_oppose) params.support_oppose = input.support_oppose;
    if (input.candidate_office) params.office = BY_CANDIDATE_OFFICE[input.candidate_office];
    if (input.candidate_office_state) params.state = input.candidate_office_state;
    if (input.candidate_office_district) params.district = input.candidate_office_district;
    if (input.cycle) params.cycle = input.cycle;

    const result = await fec.getExpendituresByCandidate(params, ctx);
    ctx.log.info('Expenditures by candidate fetched', {
      count: result.pagination.count,
      returned: result.results.length,
    });

    ctx.enrich.total(result.pagination.count);
    if (result.results.length === 0) {
      ctx.enrich.notice(
        'No expenditures by candidate matched. Verify the candidate_id (or the office/state/district race scope) and the cycle are correct.',
      );
    }

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
      lines.push('\n_More results available._', `next_cursor: \`${result.next_cursor}\``);
    }

    if (result.pagination) {
      const p = result.pagination;
      lines.push(`\n_Page ${p.page} of ${p.pages} · ${p.count} total · ${p.per_page} per page_`);
    }

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
