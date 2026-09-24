/**
 * @fileoverview Tool for searching and retrieving FEC candidate records.
 * Supports full-text search, single-candidate lookup by ID, and optional
 * financial totals merging from the /candidates/totals/ endpoint.
 * @module mcp-server/tools/definitions/search-candidates.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import {
  buildSearchCriteria,
  describeExhaustedPosition,
  exhaustedPage,
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
import { validateCandidateId } from './utils/id-validators.js';
import {
  disclosePageBound,
  dropEmptyFields,
  PageBoundEnrichment,
  PageBoundTrailer,
  PER_PAGE_CAPS,
} from './utils/trim-schedule-row.js';

/**
 * `/candidates/totals/` is its own paged endpoint, not a view onto the candidate
 * search: one candidate yields one row per cycle, so N candidates routinely
 * produce more than N rows. The sub-fetch walks that endpoint's own pages at the
 * API's maximum page size, capped so a single tool call cannot fan out without
 * bound. 100 candidates × 5 pages covers every realistic candidate page.
 */
const TOTALS_PER_PAGE = 100;
const TOTALS_MAX_PAGES = 5;
const DIRECT_ID_INPUTS = ['candidate_id', 'include_totals', 'cycle', 'election_year'] as const;
const DIRECT_ID_INPUTS_WITHOUT_TOTALS = ['candidate_id', 'include_totals'] as const;
const TOTALS_ONLY_INPUTS = ['cycle', 'election_year'] as const;
const SEARCH_ONLY_INPUTS = [
  'query',
  'state',
  'district',
  'office',
  'party',
  'incumbent_challenge',
  'candidate_status',
  'has_raised_funds',
  'page',
  'per_page',
] as const;

export const searchCandidates = tool('openfec_search_candidates', {
  description:
    'Find federal candidates by name, state, office, party, or cycle. Retrieve a specific candidate by FEC ID with financial totals. Candidate IDs start with H (House), S (Senate), or P (President) followed by exactly eight letters or digits.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'candidate_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Single-candidate lookup by candidate_id returned no record',
      recovery:
        'Verify the candidate_id format (H/S/P + eight letters or digits) or drop it and search by name, state, or cycle.',
    },
    {
      reason: 'inputs_not_applicable_to_id_lookup',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A direct candidate_id lookup includes search-only inputs, or totals-only scope while include_totals is false',
      recovery:
        'Remove the named inputs. To use cycle or election_year on a direct lookup, set include_totals to true; otherwise drop candidate_id and use search filters.',
    },
  ],

  input: z.object({
    query: z.string().optional().describe('Full-text candidate name search.'),
    candidate_id: z
      .string()
      .optional()
      .describe(
        'FEC candidate ID: H, S, or P followed by exactly eight letters or digits (e.g., P00003392, H2CO07170). Get IDs from openfec_search_candidates results. When provided, returns a single candidate with full detail.',
      ),
    state: z.string().optional().describe('Two-letter US state code (e.g., AZ, CA).'),
    district: z.string().optional().describe('Two-digit district number for House candidates.'),
    office: z
      .enum(['H', 'S', 'P'])
      .optional()
      .describe('Filter by office: H=House, S=Senate, P=President.'),
    party: z.string().optional().describe('Three-letter party code (e.g., DEM, REP, LIB).'),
    cycle: z.number().optional().describe('Two-year election cycle (even year, e.g., 2024).'),
    election_year: z.number().optional().describe('Specific election year the candidate ran in.'),
    incumbent_challenge: z
      .enum(['I', 'C', 'O'])
      .optional()
      .describe('Incumbent status: I=incumbent, C=challenger, O=open seat.'),
    candidate_status: z
      .enum(['C', 'F', 'N', 'P'])
      .optional()
      .describe('Candidate status: C=present, F=future, N=not yet, P=prior.'),
    has_raised_funds: z
      .boolean()
      .optional()
      .describe('Only candidates whose committee has received receipts.'),
    include_totals: z
      .boolean()
      .optional()
      .describe(
        'Include financial totals (receipts, disbursements, cash on hand). Defaults to true when fetching by candidate_id.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Search-results page number (1-indexed). Defaults to 1 on the search path.'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        `Search results per page. Defaults to 20 on the search path. With include_totals, at most ${PER_PAGE_CAPS.candidatesWithTotals.oneCycle} candidates are requested when cycle or election_year scopes the totals and ${PER_PAGE_CAPS.candidatesWithTotals.allCycles} when the totals span every cycle, keeping the response under a 100,000-byte budget. A page bounded below your request reports truncated and cap, and pagination.per_page echoes the size applied — page numbers count at that size, so continue with the next page number.`,
      ),
  }),

  output: z.object({
    candidates: z
      .array(
        z
          .looseObject({})
          .describe(
            'Candidate record; common keys include candidate_id, name, party, state, office, and cycles.',
          ),
      )
      .describe('Candidate result set; one record per match.'),
    totals: z
      .array(
        z.looseObject({}).describe('Per-cycle financial totals row for a candidate committee.'),
      )
      .optional()
      .describe(
        'Financial totals (receipts, disbursements, cash_on_hand) when include_totals is true. One row per candidate per cycle.',
      ),
    missing_totals: z
      .array(z.string().describe('FEC candidate ID with no totals row in this response.'))
      .optional()
      .describe(
        'Candidates whose financial totals were not retrieved because the totals fetch hit its page cap. Re-query each one on its own with candidate_id to get its totals.',
      ),
    pagination: PaginationSchema,
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching candidates before pagination.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the response needs context: how to broaden a search that matched nothing, which requested position ran out when candidates did match, or that the page was bounded below the per_page requested and how to continue.',
      ),
    ...PageBoundEnrichment,
  },
  enrichmentTrailer: PageBoundTrailer,

  async handler(input, ctx) {
    const fec = getOpenFecService();

    if (input.candidate_id) validateCandidateId(input.candidate_id);

    const shouldIncludeTotals = input.include_totals ?? !!input.candidate_id;

    let candidateResult: Awaited<ReturnType<typeof fec.getCandidate>>;
    let effectiveCriteria: Record<string, unknown>;
    /** The per_page asked for and the one sent — search path only. */
    let pageBound: { requested: number; applied: number } | undefined;

    if (input.candidate_id) {
      const inapplicableInputs = [
        ...SEARCH_ONLY_INPUTS.filter((field) => input[field] !== undefined),
        ...(shouldIncludeTotals
          ? []
          : TOTALS_ONLY_INPUTS.filter((field) => input[field] !== undefined)),
      ];
      if (inapplicableInputs.length > 0) {
        throw ctx.fail(
          'inputs_not_applicable_to_id_lookup',
          'A direct candidate_id lookup cannot apply the named inputs.',
          {
            inapplicable_inputs: inapplicableInputs,
            supported_inputs: [
              ...(shouldIncludeTotals ? DIRECT_ID_INPUTS : DIRECT_ID_INPUTS_WITHOUT_TOTALS),
            ],
            ...ctx.recoveryFor('inputs_not_applicable_to_id_lookup'),
          },
        );
      }

      // Single candidate lookup
      ctx.log.info('Fetching candidate by ID', { candidate_id: input.candidate_id });
      candidateResult = await fec.getCandidate(input.candidate_id, ctx);
      effectiveCriteria = buildSearchCriteria({
        candidate_id: input.candidate_id,
        include_totals: shouldIncludeTotals,
        ...(shouldIncludeTotals ? { cycle: input.cycle, election_year: input.election_year } : {}),
      });
    } else {
      // Search with filters
      const page = input.page ?? 1;
      const requested = input.per_page ?? 20;
      /**
       * Totals bring one row per cycle each candidate filed in, so a page with
       * totals is capped — harder when the totals span every cycle. Upstream
       * paginates at the size sent, so page numbers count at the capped size.
       */
      const perPage = shouldIncludeTotals
        ? Math.min(
            requested,
            input.cycle !== undefined || input.election_year !== undefined
              ? PER_PAGE_CAPS.candidatesWithTotals.oneCycle
              : PER_PAGE_CAPS.candidatesWithTotals.allCycles,
          )
        : requested;
      pageBound = { requested, applied: perPage };
      const params: FecParams = {
        q: input.query,
        state: input.state,
        district: input.district,
        office: input.office,
        party: input.party,
        cycle: input.cycle,
        election_year: input.election_year,
        incumbent_challenge: input.incumbent_challenge,
        candidate_status: input.candidate_status,
        has_raised_funds: input.has_raised_funds,
        page,
        per_page: perPage,
      };
      ctx.log.info('Searching candidates', { query: input.query, state: input.state });
      candidateResult = await fec.searchCandidates(params, ctx);
      effectiveCriteria = buildSearchCriteria({
        ...input,
        include_totals: shouldIncludeTotals,
        page,
        per_page: perPage,
      });
    }

    const candidates = (candidateResult.results as Record<string, unknown>[]).map(dropEmptyFields);

    if (input.candidate_id && candidates.length === 0) {
      throw ctx.fail('candidate_not_found', `Candidate ${input.candidate_id} not found.`, {
        candidate_id: input.candidate_id,
        ...ctx.recoveryFor('candidate_not_found'),
      });
    }

    // Fetch financial totals if requested
    let totals: Record<string, unknown>[] | undefined;
    let missingTotals: string[] | undefined;
    if (shouldIncludeTotals && candidates.length > 0) {
      const requestedIds = input.candidate_id
        ? [input.candidate_id]
        : candidates.map((c) => str(c, 'candidate_id')).filter(Boolean);

      const totalsParams: FecParams = {
        // The API accepts repeated candidate_id params (?candidate_id=X&candidate_id=Y)
        candidate_id: requestedIds,
        cycle: input.cycle,
        election_year: input.election_year,
        per_page: TOTALS_PER_PAGE,
      };

      ctx.log.info('Fetching candidate totals', { candidate_ids: requestedIds.length });

      const rows: Record<string, unknown>[] = [];
      let totalsPages = 1;
      let page = 1;
      do {
        const totalsResult = await fec.getCandidateTotals({ ...totalsParams, page }, ctx);
        rows.push(...(totalsResult.results as Record<string, unknown>[]).map(dropEmptyFields));
        totalsPages = totalsResult.pagination.pages;
        page += 1;
      } while (page <= totalsPages && page <= TOTALS_MAX_PAGES);

      totals = rows;

      if (totalsPages > TOTALS_MAX_PAGES) {
        const covered = new Set(rows.map((r) => str(r, 'candidate_id')));
        const uncovered = requestedIds.filter((id) => !covered.has(id));
        if (uncovered.length > 0) missingTotals = uncovered;
        ctx.log.warning('Candidate totals fetch capped before covering every candidate', {
          fetched_pages: TOTALS_MAX_PAGES,
          total_pages: totalsPages,
          missing: uncovered.length,
        });
      }
    }

    ctx.enrich.total(candidateResult.pagination.count);
    const exhausted = exhaustedPage(candidateResult.pagination, candidates.length);
    if (exhausted) {
      ctx.enrich.notice(describeExhaustedPosition(exhausted));
    } else if (candidates.length === 0) {
      ctx.enrich.notice(
        'No candidates matched. Try a partial name, remove filters like state or office, or check a different election cycle.',
      );
    }
    if (pageBound) {
      disclosePageBound(ctx, {
        ...pageBound,
        shown: candidates.length,
        continuation: { kind: 'page', pagination: candidateResult.pagination },
      });
    }

    return {
      candidates,
      totals,
      missing_totals: missingTotals,
      pagination: toPagination(candidateResult.pagination),
      search_criteria: effectiveCriteria,
    };
  },

  format(result) {
    if (result.candidates.length === 0) {
      const exhausted = exhaustedPage(result.pagination, 0);
      if (exhausted) return formatExhaustedResult(result.search_criteria, exhausted);
      return formatEmptyResult(
        result.search_criteria,
        'Try broadening your search — use a partial name, remove filters like state or office, or check a different election cycle.',
      );
    }

    /** One candidate has one totals row per cycle — group, never overwrite. */
    const totalsMap = new Map<string, Record<string, unknown>[]>();
    for (const t of result.totals ?? []) {
      const id = str(t, 'candidate_id');
      if (!id) continue;
      const rows = totalsMap.get(id);
      if (rows) rows.push(t);
      else totalsMap.set(id, [t]);
    }

    const headerKeys = new Set(['candidate_id', 'name']);

    const lines = result.candidates.map((c) => {
      const id = str(c, 'candidate_id');
      const name = str(c, 'name');
      let block = `**${name || id}**${name && id ? ` (${id})` : ''}`;
      const fields = renderRecord(c, headerKeys);
      if (fields) block += `\n${fields}`;

      for (const t of totalsMap.get(id) ?? []) {
        const cycle = t.cycle;
        const label =
          typeof cycle === 'number' || typeof cycle === 'string' ? ` (cycle ${cycle})` : '';
        block += `\n  — Financial Totals${label} —`;
        const totalsFields = renderRecord(t, new Set(['candidate_id']));
        if (totalsFields) block += `\n${totalsFields}`;
      }

      return block;
    });

    if (result.missing_totals?.length) {
      lines.push(
        `\n_Financial totals were not retrieved for ${result.missing_totals.length} candidate(s): ${result.missing_totals.join(', ')}. Query each one on its own with candidate_id to get its totals._`,
      );
    }

    const { page, pages, count, per_page, count_is_approximate } = result.pagination;
    lines.push(
      `\n---\nPage ${page} of ${pages} · ${fmtTotal(count, count_is_approximate)} · ${per_page} per page`,
    );

    const criteria = formatSearchCriteria(result.search_criteria);
    if (criteria) lines.push(criteria);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
