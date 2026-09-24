/**
 * @fileoverview Search itemized individual contributions (Schedule A) or get
 * aggregate breakdowns by size, state, employer, or occupation. Central tool
 * for answering "who's funding this candidate/committee?"
 * @module mcp-server/tools/definitions/search-contributions.tool
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

const modes = ['itemized', 'by_size', 'by_state', 'by_employer', 'by_occupation'] as const;

/**
 * Modes as the handler resolves them. `by_size` and `by_state` split into a
 * `_candidate` variant when the query is scoped by candidate_id rather than
 * committee_id, and that variant hits a different upstream endpoint.
 */
const resolvedModes = [...modes, 'by_size_candidate', 'by_state_candidate'] as const;
type ResolvedMode = (typeof resolvedModes)[number];

/**
 * Inputs the itemized Schedule A endpoint accepts and the aggregate endpoints
 * do not. Sending one in an aggregate mode used to drop it silently, returning
 * an unnarrowed result set that looks like an answer to the narrowed question.
 */
const ITEMIZED_ONLY_INPUTS = [
  'contributor_name',
  'contributor_employer',
  'contributor_occupation',
  'contributor_city',
  'contributor_state',
  'contributor_zip',
  'min_date',
  'max_date',
  'min_amount',
  'max_amount',
  'is_individual',
  'sort',
  'cursor',
] as const;

/** What the Schedule A aggregate endpoints do accept — quoted in the rejection. */
const AGGREGATE_INPUTS = 'committee_id, candidate_id, cycle, mode, page, per_page';
const ITEMIZED_INPUTS = [
  'mode',
  'committee_id',
  'contributor_name',
  'contributor_employer',
  'contributor_occupation',
  'contributor_city',
  'contributor_state',
  'contributor_zip',
  'cycle',
  'min_date',
  'max_date',
  'min_amount',
  'max_amount',
  'is_individual',
  'sort',
  'per_page',
  'cursor',
] as const;

export const searchContributions = tool('openfec_search_contributions', {
  description:
    'Search itemized individual contributions (Schedule A) or get aggregate breakdowns by size, state, employer, or occupation. Use to answer "who is funding this committee?" Itemized mode requires a committee_id. Aggregate by_size/by_state can use candidate_id instead.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'itemized_requires_committee_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Itemized mode invoked without a committee_id',
      recovery:
        "Provide a committee_id, switch to a by_size or by_state aggregate mode with candidate_id, or look up the candidate's committee with openfec_search_committees.",
    },
    {
      reason: 'aggregate_requires_committee_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'by_employer or by_occupation aggregate without a committee_id',
      recovery:
        'These aggregates roll up to a single committee — provide a committee_id for the spending committee.',
    },
    {
      reason: 'itemized_only_filters_in_aggregate_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An itemized-only filter was supplied alongside an aggregate mode, which cannot apply it',
      recovery: `Re-run with mode "itemized" (requires committee_id) to filter by contributor, date range, or amount, or drop the named inputs to keep the aggregate. Aggregate modes accept only ${AGGREGATE_INPUTS}.`,
    },
    {
      reason: 'inputs_not_applicable_to_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The resolved Schedule A endpoint does not accept one or more explicitly supplied inputs',
      recovery:
        'Remove the named inputs or choose a mode and identifier combination whose concrete endpoint supports them.',
    },
  ],

  input: z.object({
    mode: z
      .enum(modes)
      .default('itemized')
      .describe(
        'Query mode. "itemized" returns individual contribution records (keyset pagination). "by_size" aggregates by contribution size bucket. "by_state" aggregates by contributor state. "by_employer" aggregates by employer. "by_occupation" aggregates by occupation.',
      ),
    committee_id: z
      .string()
      .optional()
      .describe(
        'Receiving committee ID (e.g., C00703975). Get IDs from openfec_search_committees results.',
      ),
    candidate_id: z
      .string()
      .optional()
      .describe(
        'Candidate ID (e.g., P00003392). Get IDs from openfec_search_candidates results. Enables by_size and by_state aggregates without a committee_id.',
      ),
    contributor_name: z.string().optional().describe('Full-text donor name search. Itemized only.'),
    contributor_employer: z
      .string()
      .optional()
      .describe('Full-text employer search. Itemized only.'),
    contributor_occupation: z
      .string()
      .optional()
      .describe('Full-text occupation search. Itemized only.'),
    contributor_city: z.string().optional().describe('Contributor city. Itemized only.'),
    contributor_state: z
      .string()
      .optional()
      .describe('Two-letter state code (e.g., CA). Itemized only.'),
    contributor_zip: z
      .string()
      .optional()
      .describe('ZIP code prefix (starts-with match). Itemized only.'),
    cycle: z
      .number()
      .optional()
      .describe(
        'Two-year election cycle (e.g., 2024). Even years only. Defaults to current cycle for itemized mode.',
      ),
    min_date: z
      .string()
      .optional()
      .describe('Earliest contribution date (YYYY-MM-DD). Itemized only.'),
    max_date: z
      .string()
      .optional()
      .describe('Latest contribution date (YYYY-MM-DD). Itemized only.'),
    min_amount: z
      .number()
      .optional()
      .describe('Minimum contribution amount in dollars. Itemized only.'),
    max_amount: z
      .number()
      .optional()
      .describe('Maximum contribution amount in dollars. Itemized only.'),
    is_individual: z
      .boolean()
      .optional()
      .describe(
        'Only individual contributions (excludes committee-to-committee transfers). Itemized only.',
      ),
    sort: z
      .enum([
        'contribution_receipt_date',
        '-contribution_receipt_date',
        'contribution_receipt_amount',
        '-contribution_receipt_amount',
      ])
      .optional()
      .describe(
        'Sort field. A "-" prefix sorts descending: use "-contribution_receipt_amount" for the largest receipts first, since the ascending form leads with the most negative rows (refunds, reattributions, redesignations). Itemized only; OpenFEC sorts by "-contribution_receipt_date" when omitted.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Page number (1-indexed) for aggregate modes. Explicit page is rejected in itemized mode, which paginates with cursor. Defaults to 1 for aggregates.',
      ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        `Results per page. Itemized mode sends at most ${PER_PAGE_CAPS.contributions} upstream, keeping the response under a 100,000-byte budget; a page bounded below your request reports truncated and cap, and next_cursor continues it.`,
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
            'Itemized contribution record (mode=itemized) or aggregate row (mode=by_size, by_state, by_employer, by_occupation).',
          ),
      )
      .describe(
        'Contribution result set; itemized records or aggregate buckets depending on mode.',
      ),
    mode: z
      .enum(resolvedModes)
      .describe(
        'Query mode as the server resolved it. "by_size" and "by_state" resolve to "by_size_candidate" / "by_state_candidate" when scoped by candidate_id — a different endpoint with different row shapes — so read this rather than assuming the mode you sent.',
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
        'Total matching contributions (itemized mode). Check count_is_approximate before quoting it as a figure.',
      ),
    count_is_approximate: z
      .boolean()
      .optional()
      .describe(
        'True when OpenFEC reports count as an estimate rather than a tally, which it does on its highest-volume queries. Absent means the count is a tally.',
      ),
    pagination: PaginationSchema.optional().describe(
      'Page-based pagination info (aggregate modes only).',
    ),
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching contributions or aggregate rows.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the response needs context: how to broaden a search that matched nothing, which requested position ran out when contributions did match, that the total is an estimate, or that the page was bounded below the per_page requested and how to continue.',
      ),
    ...PageBoundEnrichment,
  },
  enrichmentTrailer: PageBoundTrailer,

  async handler(input, ctx) {
    const fec = getOpenFecService();
    const mode = input.mode;

    if (input.committee_id) validateCommitteeId(input.committee_id);
    if (input.candidate_id) validateCandidateId(input.candidate_id);

    /* ---------------------------------------------------------------- */
    /*  Itemized contributions (keyset/SEEK)                            */
    /* ---------------------------------------------------------------- */
    if (mode === 'itemized') {
      if (!input.committee_id) {
        throw ctx.fail('itemized_requires_committee_id', undefined, {
          ...ctx.recoveryFor('itemized_requires_committee_id'),
        });
      }

      const inapplicableInputs = [
        ...(input.candidate_id !== undefined ? ['candidate_id'] : []),
        ...(input.page !== undefined ? ['page'] : []),
      ];
      if (inapplicableInputs.length > 0) {
        throw ctx.fail(
          'inputs_not_applicable_to_mode',
          `Mode "itemized" cannot apply ${inapplicableInputs.join(', ')}.`,
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

      const cycle = input.cycle ?? currentCycle();
      /**
       * The cycle can default, and a default the caller cannot see is the
       * failure the criteria echo exists to close — so the echo and the cursor
       * identity are both built from the effective values, not the raw input.
       */
      const applied = { ...input, cycle };
      /** Lowered upstream, never trimmed after the fetch, so the keyset cursor stays exact. */
      const perPage = Math.min(input.per_page, PER_PAGE_CAPS.contributions);
      const params: FecParams = {
        committee_id: input.committee_id,
        two_year_transaction_period: cycle,
        per_page: perPage,
      };

      if (input.contributor_name) params.contributor_name = input.contributor_name;
      if (input.contributor_employer) params.contributor_employer = input.contributor_employer;
      if (input.contributor_occupation)
        params.contributor_occupation = input.contributor_occupation;
      if (input.contributor_city) params.contributor_city = input.contributor_city;
      if (input.contributor_state) params.contributor_state = input.contributor_state;
      if (input.contributor_zip) params.contributor_zip = input.contributor_zip;
      if (input.min_date) params.min_date = input.min_date;
      if (input.max_date) params.max_date = input.max_date;
      if (input.min_amount !== undefined) params.min_amount = input.min_amount;
      if (input.max_amount !== undefined) params.max_amount = input.max_amount;
      if (input.is_individual !== undefined) params.is_individual = input.is_individual;
      if (input.sort) params.sort = input.sort;

      const query = cursorQuery('openfec_search_contributions', applied);
      if (input.cursor) {
        Object.assign(params, decodeCursor(input.cursor, query));
      }

      const result = await fec.searchContributions(params, query, ctx);
      ctx.log.info('Itemized contributions fetched', {
        committee_id: input.committee_id,
        cycle,
        count: result.pagination.count,
        returned: result.results.length,
      });

      ctx.enrich.total(result.pagination.count);
      if (result.results.length === 0) {
        ctx.enrich.notice(
          result.pagination.count > 0
            ? describeExhaustedPosition({ kind: 'cursor', count: result.pagination.count })
            : 'No itemized contributions matched. Try a different cycle or broaden name/employer filters.',
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

      /** committee_id is required here, so every row carries the same committee. */
      const trimmed = trimScheduleRows(result.results as Record<string, unknown>[], {
        hoistCommittee: true,
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
    /*  Aggregate modes                                                 */
    /* ---------------------------------------------------------------- */
    if (mode === 'by_employer' || mode === 'by_occupation') {
      if (!input.committee_id) {
        throw ctx.fail(
          'aggregate_requires_committee_id',
          `Aggregate by ${mode.replace('by_', '')} requires a committee_id.`,
          { mode, ...ctx.recoveryFor('aggregate_requires_committee_id') },
        );
      }
      if (input.candidate_id) {
        throw ctx.fail(
          'inputs_not_applicable_to_mode',
          `Mode "${mode}" cannot apply candidate_id.`,
          {
            mode,
            inapplicable_inputs: ['candidate_id'],
            supported_inputs: ['mode', 'committee_id', 'cycle', 'page', 'per_page'],
            ...ctx.recoveryFor('inputs_not_applicable_to_mode'),
          },
        );
      }
    }

    const inapplicable = ITEMIZED_ONLY_INPUTS.filter(
      (key) => input[key] !== undefined && input[key] !== '',
    );
    if (inapplicable.length > 0) {
      throw ctx.fail(
        'itemized_only_filters_in_aggregate_mode',
        `Mode "${mode}" cannot apply ${inapplicable.join(', ')} — the Schedule A aggregate endpoints accept only ${AGGREGATE_INPUTS}. Sending them would have returned an unfiltered aggregate.`,
        {
          mode,
          inapplicable_inputs: inapplicable,
          supported_inputs: AGGREGATE_INPUTS.split(', '),
          ...ctx.recoveryFor('itemized_only_filters_in_aggregate_mode'),
        },
      );
    }

    // /by_candidate variants require cycle — default to current if not provided
    const useByCandidate =
      (mode === 'by_size' || mode === 'by_state') && Boolean(input.candidate_id);
    if (useByCandidate && input.committee_id) {
      throw ctx.fail(
        'inputs_not_applicable_to_mode',
        `Mode "${mode}" with candidate_id cannot apply committee_id.`,
        {
          mode,
          inapplicable_inputs: ['committee_id'],
          supported_inputs: ['mode', 'candidate_id', 'cycle', 'page', 'per_page'],
          ...ctx.recoveryFor('inputs_not_applicable_to_mode'),
        },
      );
    }
    const cycle = input.cycle ?? (useByCandidate ? currentCycle() : undefined);

    const params: FecParams = {
      page: input.page ?? 1,
      per_page: input.per_page,
      sort: '-total',
      sort_hide_null: true,
    };
    if (useByCandidate) params.candidate_id = input.candidate_id;
    else if (input.committee_id) params.committee_id = input.committee_id;
    if (cycle) params.cycle = cycle;

    const aggregateMode: ResolvedMode = useByCandidate
      ? mode === 'by_size'
        ? 'by_size_candidate'
        : 'by_state_candidate'
      : mode;

    const result = await fec.getContributionAggregates(aggregateMode, params, ctx);
    ctx.log.info('Contribution aggregates fetched', {
      mode: aggregateMode,
      count: result.pagination.count,
      returned: result.results.length,
    });

    ctx.enrich.total(result.pagination.count);
    const exhausted = exhaustedPage(result.pagination, result.results.length);
    if (exhausted) {
      ctx.enrich.notice(describeExhaustedPosition(exhausted));
    } else if (result.results.length === 0) {
      ctx.enrich.notice(
        'No contribution aggregates matched. Verify the committee_id or candidate_id is correct.',
      );
    }

    return {
      results: result.results,
      mode: aggregateMode,
      pagination: toPagination(result.pagination),
      search_criteria: buildSearchCriteria({ ...input, cycle }),
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
        'For itemized mode, try a different cycle or broaden name/employer filters. For aggregates, verify the committee_id or candidate_id is correct.',
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
          `**${fmtTotal(result.count, result.count_is_approximate, 'total contributions')}**\n`,
        );
      }
      for (const r of result.results) {
        const name = String(r.contributor_name ?? 'Unknown');
        lines.push(
          `**${name}**\n${renderRecord(r, new Set(['contributor_name']), { contributor: formatRowCommittee })}`,
        );
      }
      if (result.next_cursor) {
        lines.push('\n_More results available._', `next_cursor: \`${result.next_cursor}\``);
      }
    } else {
      for (const r of result.results) {
        lines.push(renderRecord(r));
      }
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
