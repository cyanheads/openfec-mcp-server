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
  APPROXIMATE_COUNT_NOTICE,
  approximateCount,
  buildSearchCriteria,
  describeExhaustedPosition,
  exhaustedPage,
  exhaustedSchedule,
  fmtTotal,
  formatEmptyResult,
  formatExhaustedResult,
  formatSearchCriteria,
  PaginationSchema,
  renderRecord,
  SearchCriteriaSchema,
  toPagination,
} from './utils/format-helpers.js';
import { validateCandidateId, validateCommitteeId } from './utils/id-validators.js';
import { validateRange } from './utils/range-validators.js';
import {
  disclosePageBound,
  formatHoistedCommittee,
  formatRowCommittee,
  HoistedCommitteeSchema,
  PageBoundEnrichment,
  PageBoundTrailer,
  PER_PAGE_CAPS,
  trimScheduleRows,
} from './utils/trim-schedule-row.js';

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

/** Applied when the caller leaves `most_recent` unset in itemized mode. */
const MOST_RECENT_DEFAULT = true;

/**
 * Applied when the caller leaves `election_full` unset in by_candidate mode —
 * OpenFEC's own default, and the one `openfec_lookup_elections` applies to the
 * same flag.
 */
const ELECTION_FULL_DEFAULT = true;

/**
 * Inputs the itemized Schedule E endpoint accepts and `/by_candidate/` does
 * not. Sending one in by_candidate mode used to drop it silently, returning an
 * unnarrowed result set that looks like an answer to the narrowed question.
 */
const ITEMIZED_ONLY_INPUTS = [
  'payee_name',
  'candidate_party',
  'min_date',
  'max_date',
  'min_amount',
  'max_amount',
  'is_notice',
  'most_recent',
  'sort',
  'cursor',
] as const;

/** What `/by_candidate/` does accept — quoted in the rejection. */
const BY_CANDIDATE_INPUTS =
  'committee_id, candidate_id, support_oppose, candidate_office, candidate_office_state, candidate_office_district, cycle, election_full, mode, page, per_page';
const ITEMIZED_INPUTS = [
  'mode',
  'committee_id',
  'candidate_id',
  'support_oppose',
  'payee_name',
  'candidate_office',
  'candidate_office_state',
  'candidate_office_district',
  'candidate_party',
  'cycle',
  'min_date',
  'max_date',
  'min_amount',
  'max_amount',
  'is_notice',
  'most_recent',
  'sort',
  'per_page',
  'cursor',
] as const;

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
      reason: 'itemized_only_filters_in_aggregate_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An itemized-only filter (payee_name, candidate_party, a date or amount bound, is_notice, most_recent, sort, cursor) was supplied alongside mode by_candidate, which cannot apply it',
      recovery: `Re-run with mode "itemized" to filter by payee, party, date range, amount, or notice status, or drop the named inputs to keep the per-candidate aggregate. by_candidate accepts only ${BY_CANDIDATE_INPUTS}.`,
    },
    {
      reason: 'inputs_not_applicable_to_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Itemized mode receives an explicit page number or election_full, neither of which its keyset endpoint can apply',
      recovery:
        'Remove page and election_full. Navigate itemized results with per_page plus cursor, and use mode "by_candidate" for totals over a full election period.',
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
        'Two-year election cycle (e.g., 2024). Even years only. Itemized mode defaults to the current cycle when omitted — Schedule E spans all history and an unscoped scan times out upstream. Pass an explicit cycle to search an earlier period. In by_candidate mode the cycle names the election, and election_full decides whether the totals cover the full election period ending in it (4yr president, 6yr senate, 2yr house) or only this two-year cycle.',
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
      .optional()
      .describe(
        'Only the most recent version of amended filings. Itemized only — by_candidate rejects it. Defaults to true in itemized mode when omitted; pass false to see superseded versions of amended filings.',
      ),
    election_full: z
      .boolean()
      .optional()
      .describe(
        'by_candidate only: expand cycle to the full election period (4yr president, 6yr senate, 2yr house) instead of the two-year cycle alone. Defaults to true when omitted; itemized mode rejects it, since that endpoint has no such parameter. Carries no schema default, so an explicit value is distinguishable from an omission.',
      ),
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
      .optional()
      .describe(
        'Page number (1-indexed) for by_candidate mode. Explicit page is rejected in itemized mode, which paginates with cursor. Defaults to 1 for by_candidate.',
      ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        `Results per page. Itemized mode sends at most ${PER_PAGE_CAPS.expenditures.committeeScoped} upstream when scoped by committee_id and ${PER_PAGE_CAPS.expenditures.perRowCommittee} otherwise, keeping the response under a 100,000-byte budget; a page bounded below your request reports truncated and cap, and next_cursor continues it.`,
      ),
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
    mode: z
      .enum(modes)
      .describe(
        'Query mode as the server resolved it. Row shapes differ by mode — itemized rows are individual expenditures, by_candidate rows are per-candidate totals — so read this rather than inferring the shape from the fields present.',
      ),
    committee: HoistedCommitteeSchema,
    next_cursor: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Pagination cursor for the next page of itemized results. Null when no more pages.',
      ),
    count: z
      .number()
      .optional()
      .describe(
        'Total matching independent expenditures (itemized mode). Check count_is_approximate before quoting it as a figure.',
      ),
    count_is_approximate: z
      .boolean()
      .optional()
      .describe(
        'True when OpenFEC reports count as an estimate rather than a tally, which it does on its highest-volume queries. Absent means the count is a tally.',
      ),
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
        'Guidance when the response needs context: how to broaden a search that matched nothing, which requested position ran out when expenditures did match, that the total is an estimate, or that the page was bounded below the per_page requested and how to continue.',
      ),
    ...PageBoundEnrichment,
  },
  enrichmentTrailer: PageBoundTrailer,

  async handler(input, ctx) {
    const fec = getOpenFecService();
    const mode = input.mode;

    if (input.candidate_id) validateCandidateId(input.candidate_id);
    if (input.committee_id) validateCommitteeId(input.committee_id);

    /* ---------------------------------------------------------------- */
    /*  Itemized expenditures (keyset/SEEK)                             */
    /* ---------------------------------------------------------------- */
    if (mode === 'itemized') {
      const inapplicableInputs = [
        ...(input.page !== undefined ? ['page'] : []),
        ...(input.election_full !== undefined ? ['election_full'] : []),
      ];
      if (inapplicableInputs.length > 0) {
        throw ctx.fail(
          'inputs_not_applicable_to_mode',
          `Mode "itemized" cannot apply ${inapplicableInputs.join(', ')} — /schedules/schedule_e/ paginates by cursor and has no election_full parameter.`,
          {
            mode,
            inapplicable_inputs: inapplicableInputs,
            supported_inputs: [...ITEMIZED_INPUTS],
            ...ctx.recoveryFor('inputs_not_applicable_to_mode'),
          },
        );
      }

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

      /**
       * Schedule E is large enough that an unscoped scan times out upstream, and
       * the timeout is retried — so scope the query the way itemized
       * contributions already do rather than sending an unbounded request.
       */
      const cycle = input.cycle ?? currentCycle();
      const mostRecent = input.most_recent ?? MOST_RECENT_DEFAULT;
      /**
       * Both `cycle` and `most_recent` can default, and a default the caller
       * cannot see is the failure the criteria echo exists to close — so the
       * echo and the cursor identity are both built from the effective values,
       * not the raw input. Binding the cursor to the effective values also
       * keeps an omitted `most_recent` and an explicit `true` on one identity.
       */
      const applied = { ...input, cycle, most_recent: mostRecent };
      /**
       * A committee-scoped page hoists the committee record out of its rows; a
       * page spanning committees keeps one per row, roughly doubling its weight.
       * The cap lowers the upstream request itself, so the keyset cursor is
       * minted from the last row actually returned and stays exact.
       */
      const perPage = Math.min(
        input.per_page,
        input.committee_id
          ? PER_PAGE_CAPS.expenditures.committeeScoped
          : PER_PAGE_CAPS.expenditures.perRowCommittee,
      );
      const params: FecParams = {
        per_page: perPage,
        most_recent: mostRecent,
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

      const query = cursorQuery('openfec_search_expenditures', applied);
      const resume = input.cursor ? decodeCursor(input.cursor, query) : undefined;
      if (resume) Object.assign(params, resume.indexes);

      const result = await fec.searchExpenditures(params, query, ctx, resume?.delivered);
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
          result.pagination.count > 0
            ? describeExhaustedPosition({ kind: 'cursor', count: result.pagination.count })
            : 'No independent expenditures matched. Try a different cycle, broaden filters, or verify the candidate_id/committee_id. Not all races attract significant outside spending.',
        );
      } else if (result.pagination.is_count_exact === false) {
        ctx.enrich.notice(APPROXIMATE_COUNT_NOTICE);
      }
      disclosePageBound(ctx, {
        requested: input.per_page,
        applied: perPage,
        shown: result.results.length,
        continuation: { kind: 'cursor', nextCursor: result.nextCursor },
        approximate: result.pagination.is_count_exact === false,
      });

      /**
       * Schedule E does not require a committee_id, so a candidate- or
       * race-scoped page spans several spending committees. Hoist only when the
       * caller pinned one; the embedded `candidate` sub-object carries nothing
       * the row and the echoed cycle do not already state.
       */
      const trimmed = trimScheduleRows(result.results as Record<string, unknown>[], {
        hoistCommittee: Boolean(input.committee_id),
        drop: ['candidate'],
      });

      return {
        results: trimmed.results,
        ...(trimmed.committee ? { committee: trimmed.committee } : {}),
        mode: 'itemized' as const,
        next_cursor: result.nextCursor,
        count: result.pagination.count,
        ...approximateCount(result.pagination),
        search_criteria: buildSearchCriteria(applied),
      };
    }

    /* ---------------------------------------------------------------- */
    /*  By candidate (page-based)                                       */
    /* ---------------------------------------------------------------- */
    const inapplicable = ITEMIZED_ONLY_INPUTS.filter(
      (key) => input[key] !== undefined && input[key] !== '',
    );
    if (inapplicable.length > 0) {
      throw ctx.fail(
        'itemized_only_filters_in_aggregate_mode',
        `Mode "by_candidate" cannot apply ${inapplicable.join(', ')} — /schedules/schedule_e/by_candidate/ accepts only ${BY_CANDIDATE_INPUTS}. Sending them would have returned an unfiltered per-candidate aggregate.`,
        {
          mode: input.mode,
          inapplicable_inputs: inapplicable,
          supported_inputs: BY_CANDIDATE_INPUTS.split(', '),
          ...ctx.recoveryFor('itemized_only_filters_in_aggregate_mode'),
        },
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

    /**
     * `election_full` carries no schema default, so the effective value is
     * resolved here and both sent and echoed — upstream would apply the same
     * default silently, reporting a full election period under a criteria echo
     * that named only the two-year cycle.
     */
    const electionFull = input.election_full ?? ELECTION_FULL_DEFAULT;
    const params: FecParams = {
      page: input.page ?? 1,
      per_page: input.per_page,
      election_full: electionFull,
    };

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
    const exhausted = exhaustedPage(result.pagination, result.results.length);
    if (exhausted) {
      ctx.enrich.notice(describeExhaustedPosition(exhausted));
    } else if (result.results.length === 0) {
      ctx.enrich.notice(
        'No expenditures by candidate matched. Verify the candidate_id (or the office/state/district race scope) and the cycle are correct.',
      );
    }

    return {
      results: result.results,
      mode: 'by_candidate' as const,
      pagination: toPagination(result.pagination),
      search_criteria: buildSearchCriteria({ ...input, election_full: electionFull }),
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      const exhausted = exhaustedSchedule(result);
      if (exhausted) {
        return formatExhaustedResult(result.search_criteria, exhausted, result.mode);
      }
      return formatEmptyResult(
        result.search_criteria,
        'Try a different cycle, broaden filters, or verify the candidate_id/committee_id. Not all races attract significant outside spending.',
        result.mode,
      );
    }

    const isItemized = 'next_cursor' in result && result.next_cursor !== undefined;
    const lines: string[] = [
      `**Mode:** ${result.mode}`,
      ...formatHoistedCommittee(result.committee),
    ];

    if (isItemized) {
      if (result.count != null) {
        lines.push(
          `**${fmtTotal(result.count, result.count_is_approximate, 'total independent expenditures')}**\n`,
        );
      }
    }
    for (const r of result.results) {
      const indicator = supportOpposeLabel(r.support_oppose_indicator);
      const candidate = String(r.candidate_name ?? r.candidate_id ?? 'Unknown');
      lines.push(
        `**[${indicator}] ${candidate}**\n${renderRecord(r, new Set(['candidate_name', 'support_oppose_indicator']), { committee: formatRowCommittee })}`,
      );
    }
    if (isItemized && result.next_cursor) {
      lines.push('\n_More results available._', `next_cursor: \`${result.next_cursor}\``);
    }

    if (result.pagination) {
      const p = result.pagination;
      lines.push(
        `\n_Page ${p.page} of ${p.pages} · ${fmtTotal(p.count, p.count_is_approximate)} · ${p.per_page} per page_`,
      );
    }

    const criteria = formatSearchCriteria(result.search_criteria);
    if (criteria) lines.push(criteria);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
