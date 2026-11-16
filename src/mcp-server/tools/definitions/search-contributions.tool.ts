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
import { validateStateCode } from './utils/code-validators.js';
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
  itemizedPageNotice,
  PaginationSchema,
  renderRecord,
  SearchCriteriaSchema,
  toPagination,
} from './utils/format-helpers.js';
import { validateCandidateId, validateCommitteeId } from './utils/id-validators.js';
import { validateScheduleRanges } from './utils/range-validators.js';
import { markRowKinds } from './utils/row-kinds.js';
import {
  COMMITTEES,
  CONTRIBUTOR_COMMITTEES,
  CommitteeMapSchema,
  committeeRenderers,
  formatCommitteeMaps,
  formatHoistedCommittee,
  HoistedCommitteeSchema,
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
  'contributor_id',
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
  'contributor_id',
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

/**
 * Inputs that each scope an itemized search on their own: the recipient, or
 * the donor by ID, name, or employer. Occupation, place, date, and amount
 * filters describe a population rather than a giver, so they only narrow.
 */
const ITEMIZED_SCOPES = [
  'committee_id',
  'contributor_id',
  'contributor_name',
  'contributor_employer',
] as const;

/**
 * Sent on the `_candidate` aggregate variants, whose upstream default is the
 * same value: the full election period ending in `cycle`. Sending and echoing
 * it keeps the criteria echo from naming only the two-year cycle.
 */
const CANDIDATE_AGGREGATE_ELECTION_FULL = true;

const UNSCOPED_AGGREGATE_NOTICE =
  "Without committee_id or candidate_id, each row is one committee's bucket for one cycle, across every committee on file, not a combined breakdown. Pass committee_id or candidate_id to break down one committee or candidate.";

/**
 * Dollar range of each Schedule A size bucket, keyed by the floor OpenFEC
 * returns as `size`. Bucket 0 folds in unitemized individual contributions on
 * both the committee and the candidate endpoints, which is why its count is null.
 */
const SIZE_RANGES = new Map<number, string>([
  [0, '$200 and under (includes unitemized)'],
  [200, '$200.01 to $499.99'],
  [500, '$500 to $999.99'],
  [1000, '$1,000 to $1,999.99'],
  [2000, '$2,000 and over'],
]);

/** Insert `size_range` right after `size`; a floor outside the five buckets stays unlabeled. */
function labelSizeBucket(row: Record<string, unknown>): Record<string, unknown> {
  const range = typeof row.size === 'number' ? SIZE_RANGES.get(row.size) : undefined;
  if (range === undefined) return row;
  const labeled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    labeled[key] = value;
    if (key === 'size') labeled.size_range = range;
  }
  return labeled;
}

export const searchContributions = tool('openfec_search_contributions', {
  description:
    'Search itemized contributions (Schedule A) or get aggregate breakdowns by size, state, employer, or occupation. Use to answer "who is funding this committee?" or "where has this donor given?" Itemized mode needs a recipient committee_id or a donor: contributor_id, contributor_name, or contributor_employer. Aggregate by_size/by_state can use candidate_id instead of committee_id.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'itemized_requires_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Itemized mode invoked without committee_id, contributor_id, contributor_name, or contributor_employer',
      recovery:
        'Provide the recipient committee_id or a donor scope (contributor_id, contributor_name, or contributor_employer). Occupation, city, state, ZIP, date, and amount filters narrow a scoped search but cannot scope one; for a breakdown across contributors use a by_size or by_state aggregate mode.',
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
      recovery: `Re-run with mode "itemized" (scoped by committee_id or a donor) to filter by contributor, date range, or amount, or drop the named inputs to keep the aggregate. Aggregate modes accept only ${AGGREGATE_INPUTS}.`,
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
        'Query mode. "itemized" returns individual contribution records (keyset pagination). "by_size" aggregates by contribution size bucket. "by_state" aggregates by contributor state. "by_employer" aggregates by employer. "by_occupation" aggregates by occupation. Without committee_id or candidate_id, by_size and by_state return one row per committee and cycle across every committee on file, not a combined breakdown.',
      ),
    committee_id: z
      .string()
      .optional()
      .describe(
        'Receiving committee ID (e.g., C00703975). Get IDs from openfec_search_committees results. In itemized mode it scopes the search on its own or narrows a donor scope to gifts to this committee.',
      ),
    candidate_id: z
      .string()
      .optional()
      .describe(
        'Candidate ID (e.g., P00003392). Get IDs from openfec_search_candidates results. Enables by_size and by_state aggregates without a committee_id; those cover the full election period ending in cycle (4yr president, 6yr senate, 2yr house).',
      ),
    contributor_id: z
      .string()
      .optional()
      .describe(
        'FEC committee ID of a registered donor (C + eight digits): the receipts recipients reported from it. Earmarked contributions carry the conduit ID here (e.g. ActBlue, C00401224) with the individual in contributor_name. Itemized only.',
      ),
    contributor_name: z
      .string()
      .optional()
      .describe(
        'Full-text donor name search. Itemized only; scopes the search on its own. Without committee_id, a common name can time out upstream — add committee_id or a more specific name.',
      ),
    contributor_employer: z
      .string()
      .optional()
      .describe(
        'Full-text employer search. Itemized only; scopes the search on its own. Without committee_id, an employer scan can time out upstream — add committee_id to narrow it.',
      ),
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
        'Two-year election cycle (e.g., 2024). Even years only. Defaults to current cycle for itemized mode and for candidate-scoped by_size/by_state, where it names the election: those totals cover the full election period ending in it (4yr president, 6yr senate, 2yr house), not this two-year cycle alone.',
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
            'Itemized contribution record (mode=itemized) or aggregate row (mode=by_size, by_state, by_employer, by_occupation). An itemized row with memo_code "X" (memoed_subtotal true) is a memo entry: it itemizes or restates another row and FEC leaves it out of report totals, so never add it to the other rows. by_size rows carry size_range, the dollar range of the size bucket; the $200-and-under bucket includes unitemized contributions, so its count is null.',
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
    committees: CommitteeMapSchema.describe(
      "Recipient committee records on an itemized page scoped by donor without committee_id, keyed by each row's committee_id: every distinct recipient once, in full. The rows' flat committee_name is null, so this is where each recipient's name lives. Absent when committee_id scoped the page (see committee) or no row carries a record.",
    ),
    contributor_committees: CommitteeMapSchema.describe(
      "Donor records for donors that are themselves registered committees, keyed by each row's contributor_id: every distinct donor committee once, in full. A row whose record differs from its ID's entry keeps its own. Absent when no row carries one.",
    ),
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
        'Guidance when the response needs context: how to broaden a search that matched nothing, which requested position ran out when contributions did match, that an unscoped by_size or by_state page lists per-committee buckets, that the total is an estimate, or how many rows on the page are memo entries not to sum with the rest.',
      ),
  },

  async handler(input, ctx) {
    const fec = getOpenFecService();
    const mode = input.mode;

    if (input.committee_id) validateCommitteeId(input.committee_id);
    if (input.contributor_id) validateCommitteeId(input.contributor_id, 'contributor_id');
    if (input.candidate_id) validateCandidateId(input.candidate_id);

    /* ---------------------------------------------------------------- */
    /*  Itemized contributions (keyset/SEEK)                            */
    /* ---------------------------------------------------------------- */
    if (mode === 'itemized') {
      if (!ITEMIZED_SCOPES.some((key) => input[key]?.trim())) {
        throw ctx.fail('itemized_requires_scope');
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
          },
        );
      }

      validateScheduleRanges(input);
      /** `/schedules/schedule_a/` reads a leading `-` as exclude, and `other` as foreign, invalid, or missing states. */
      if (input.contributor_state) {
        validateStateCode('contributor_state', input.contributor_state, {
          exclusion: true,
          other: true,
        });
      }

      const cycle = input.cycle ?? currentCycle();
      /**
       * The cycle can default, and a default the caller cannot see is the
       * failure the criteria echo exists to close — so the echo and the cursor
       * identity are both built from the effective values, not the raw input.
       */
      const applied = { ...input, cycle };
      const params: FecParams = {
        two_year_transaction_period: cycle,
        per_page: input.per_page,
      };

      if (input.committee_id) params.committee_id = input.committee_id;
      if (input.contributor_id) params.contributor_id = input.contributor_id;
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
      const resume = input.cursor ? decodeCursor(input.cursor, query) : undefined;
      if (resume) Object.assign(params, resume.indexes);

      const result = await fec.searchContributions(params, query, ctx, resume?.delivered);
      ctx.log.info('Itemized contributions fetched', {
        committee_id: input.committee_id,
        contributor_id: input.contributor_id,
        cycle,
        count: result.pagination.count,
        returned: result.results.length,
      });

      /**
       * Only a committee_id scope pins every row to one recipient, which is
       * hoisted; a donor scope spans recipients, which go to the `committees` map.
       */
      const trimmed = trimScheduleRows(result.results as Record<string, unknown>[], {
        hoistCommittee: Boolean(input.committee_id),
        collect: [CONTRIBUTOR_COMMITTEES, COMMITTEES],
      });

      ctx.enrich.total(result.pagination.count);
      const notice = itemizedPageNotice(
        result.pagination,
        trimmed.results,
        'No itemized contributions matched. Try a different cycle or broaden name/employer filters.',
      );
      if (notice) ctx.enrich.notice(notice);

      return {
        results: trimmed.results,
        ...(trimmed.committee ? { committee: trimmed.committee } : {}),
        ...(trimmed.committees ? { committees: trimmed.committees } : {}),
        ...(trimmed.contributor_committees
          ? { contributor_committees: trimmed.contributor_committees }
          : {}),
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
          { mode },
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
    if (useByCandidate) {
      params.candidate_id = input.candidate_id;
      params.election_full = CANDIDATE_AGGREGATE_ELECTION_FULL;
    } else if (input.committee_id) params.committee_id = input.committee_id;
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
    } else {
      /** `notice` is last-wins, so every sentence this page earns goes out in one call. */
      const notices: string[] = [];
      if (
        (mode === 'by_size' || mode === 'by_state') &&
        !input.committee_id &&
        !input.candidate_id
      ) {
        notices.push(UNSCOPED_AGGREGATE_NOTICE);
      }
      if (result.pagination.is_count_exact === false) notices.push(APPROXIMATE_COUNT_NOTICE);
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    }

    return {
      results: mode === 'by_size' ? result.results.map(labelSizeBucket) : result.results,
      mode: aggregateMode,
      pagination: toPagination(result.pagination),
      search_criteria: buildSearchCriteria({
        ...input,
        cycle,
        ...(useByCandidate ? { election_full: CANDIDATE_AGGREGATE_ELECTION_FULL } : {}),
      }),
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
      const renderers = committeeRenderers(result);
      for (const r of result.results) {
        const header = markRowKinds(`**${String(r.contributor_name ?? 'Unknown')}**`, r);
        lines.push(`${header}\n${renderRecord(r, new Set(['contributor_name']), renderers)}`);
      }
      lines.push(...formatCommitteeMaps(result));
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
