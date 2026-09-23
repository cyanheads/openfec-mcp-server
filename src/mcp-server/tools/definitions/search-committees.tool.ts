/**
 * @fileoverview Tool for searching and retrieving FEC committee records.
 * Supports full-text search, single-committee lookup by ID, and filtering
 * by candidate affiliation, type, designation, state, and party.
 * @module mcp-server/tools/definitions/search-committees.tool
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
import { validateCandidateId, validateCommitteeId } from './utils/id-validators.js';

const DIRECT_ID_INPUTS = ['committee_id'] as const;
const SEARCH_ONLY_INPUTS = [
  'query',
  'candidate_id',
  'state',
  'party',
  'committee_type',
  'designation',
  'cycle',
  'treasurer_name',
  'page',
  'per_page',
] as const;

export const searchCommittees = tool('openfec_search_committees', {
  description:
    'Find political committees (campaign, PAC, Super PAC, party) by name, type, candidate affiliation, or state. Retrieve a specific committee by FEC ID. Committee IDs start with C followed by exactly eight digits (e.g., C00358796).',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'committee_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Single-committee lookup by committee_id returned no record',
      recovery:
        'Verify the committee_id format (C + eight digits) or drop it and search by name, candidate_id, or type.',
    },
    {
      reason: 'inputs_not_applicable_to_id_lookup',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A direct committee_id lookup includes inputs that only the committee search endpoint supports',
      recovery:
        'Remove the named search-only inputs, or drop committee_id and use them on the search path.',
    },
  ],

  input: z.object({
    query: z.string().optional().describe('Full-text committee name search.'),
    committee_id: z
      .string()
      .optional()
      .describe(
        "FEC committee ID: 'C' followed by exactly eight digits (e.g., C00358796). Get IDs from openfec_search_committees results. Returns a single committee with full detail.",
      ),
    candidate_id: z
      .string()
      .optional()
      .describe(
        'Find committees linked to this candidate (authorized, leadership, joint fundraising). Get IDs from openfec_search_candidates results.',
      ),
    state: z.string().optional().describe('Two-letter state code.'),
    party: z.string().optional().describe('Three-letter party code (e.g., DEM, REP).'),
    committee_type: z
      .string()
      .optional()
      .describe(
        'Committee type code. Common: H (House), S (Senate), P (Presidential), O (Super PAC), N (PAC nonqualified), Q (PAC qualified), X (Party nonqualified), Y (Party qualified).',
      ),
    designation: z
      .string()
      .optional()
      .describe(
        "Committee designation. A (authorized), B (lobbyist PAC), D (leadership PAC), J (joint fundraiser), P (principal campaign), U (unauthorized). Matches each committee's current designation only, even with cycle set — a past principal committee since redesignated drops out of P. For a candidate's principal committee in a given cycle, use openfec_lookup_elections (mode: search) and read candidate_pcc_id.",
      ),
    cycle: z.number().optional().describe('Two-year election cycle (even year).'),
    treasurer_name: z.string().optional().describe('Full-text treasurer name search.'),
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
      .describe('Search results per page. Defaults to 20 on the search path.'),
  }),

  output: z.object({
    committees: z
      .array(
        z
          .looseObject({})
          .describe(
            'Committee record; common keys include committee_id, name, type, designation, party, and state.',
          ),
      )
      .describe('Committee result set; one record per match.'),
    pagination: PaginationSchema,
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching committees before pagination.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the response carries no committees: how to broaden a search that matched nothing, or which requested position ran out when committees did match.',
      ),
  },

  async handler(input, ctx) {
    const fec = getOpenFecService();

    if (input.committee_id) validateCommitteeId(input.committee_id);
    if (input.candidate_id) validateCandidateId(input.candidate_id);

    let result: Awaited<ReturnType<typeof fec.getCommittee>>;
    let effectiveCriteria: Record<string, unknown>;

    if (input.committee_id) {
      const inapplicableInputs = SEARCH_ONLY_INPUTS.filter((field) => input[field] !== undefined);
      if (inapplicableInputs.length > 0) {
        throw ctx.fail(
          'inputs_not_applicable_to_id_lookup',
          'A direct committee_id lookup cannot apply search-only inputs.',
          {
            inapplicable_inputs: inapplicableInputs,
            supported_inputs: [...DIRECT_ID_INPUTS],
            ...ctx.recoveryFor('inputs_not_applicable_to_id_lookup'),
          },
        );
      }

      ctx.log.info('Fetching committee by ID', { committee_id: input.committee_id });
      result = await fec.getCommittee(input.committee_id, ctx);
      effectiveCriteria = buildSearchCriteria({ committee_id: input.committee_id });
    } else {
      const page = input.page ?? 1;
      const perPage = input.per_page ?? 20;
      const params: FecParams = {
        q: input.query,
        candidate_id: input.candidate_id,
        state: input.state,
        party: input.party,
        committee_type: input.committee_type,
        designation: input.designation,
        cycle: input.cycle,
        treasurer_name: input.treasurer_name,
        page,
        per_page: perPage,
      };
      ctx.log.info('Searching committees', { query: input.query, state: input.state });
      result = await fec.searchCommittees(params, ctx);
      effectiveCriteria = buildSearchCriteria({ ...input, page, per_page: perPage });
    }

    if (input.committee_id && result.results.length === 0) {
      throw ctx.fail('committee_not_found', `Committee ${input.committee_id} not found.`, {
        committee_id: input.committee_id,
        ...ctx.recoveryFor('committee_not_found'),
      });
    }

    ctx.enrich.total(result.pagination.count);
    const exhausted = exhaustedPage(result.pagination, result.results.length);
    if (exhausted) {
      ctx.enrich.notice(describeExhaustedPosition(exhausted));
    } else if (result.results.length === 0) {
      ctx.enrich.notice(
        'No committees matched. Try a partial name, remove type/designation filters, or search by candidate_id to find linked committees.',
      );
    }

    return {
      committees: result.results,
      pagination: toPagination(result.pagination),
      search_criteria: effectiveCriteria,
    };
  },

  format(result) {
    if (result.committees.length === 0) {
      const exhausted = exhaustedPage(result.pagination, 0);
      if (exhausted) return formatExhaustedResult(result.search_criteria, exhausted);
      return formatEmptyResult(
        result.search_criteria,
        'Try a partial name, remove type/designation filters, or search by candidate_id to find linked committees.',
      );
    }

    const headerKeys = new Set(['committee_id', 'name']);

    const lines = result.committees.map((c) => {
      const id = str(c, 'committee_id');
      const name = str(c, 'name');
      const header = `**${name || id}**${name && id ? ` (${id})` : ''}`;
      const fields = renderRecord(c, headerKeys);
      return fields ? `${header}\n${fields}` : header;
    });

    const { page, pages, count, per_page, count_is_approximate } = result.pagination;
    lines.push(
      `\n---\nPage ${page} of ${pages} · ${fmtTotal(count, count_is_approximate)} · ${per_page} per page`,
    );

    const criteria = formatSearchCriteria(result.search_criteria);
    if (criteria) lines.push(criteria);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
