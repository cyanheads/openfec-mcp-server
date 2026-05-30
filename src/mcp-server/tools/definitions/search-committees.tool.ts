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
  formatEmptyResult,
  PaginationSchema,
  renderRecord,
  SearchCriteriaSchema,
  str,
} from './utils/format-helpers.js';
import { validateCandidateId, validateCommitteeId } from './utils/id-validators.js';

export const searchCommittees = tool('openfec_search_committees', {
  description:
    'Find political committees (campaign, PAC, Super PAC, party) by name, type, candidate affiliation, or state. Retrieve a specific committee by FEC ID. Committee IDs start with C followed by digits (e.g., C00358796).',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'committee_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Single-committee lookup by committee_id returned no record',
      recovery:
        'Verify the committee_id format (C + digits) or drop it and search by name, candidate_id, or type.',
    },
  ],

  input: z.object({
    query: z.string().optional().describe('Full-text committee name search.'),
    committee_id: z
      .string()
      .regex(/^C\d+$/i)
      .optional()
      .describe(
        "FEC committee ID (e.g., C00358796). Get IDs from openfec_search_committees results. Starts with 'C' followed by digits. Returns a single committee with full detail.",
      ),
    candidate_id: z
      .string()
      .regex(/^[HSP][0-9A-Z]+$/i)
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
        'Committee designation. A (authorized), B (lobbyist PAC), D (leadership PAC), J (joint fundraiser), P (principal campaign), U (unauthorized).',
      ),
    cycle: z.number().optional().describe('Two-year election cycle (even year).'),
    treasurer_name: z.string().optional().describe('Full-text treasurer name search.'),
    page: z.number().int().min(1).default(1).describe('Page number (1-indexed).'),
    per_page: z.number().int().min(1).max(100).default(20).describe('Results per page.'),
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
        'Guidance when no committees matched — echoes filters and suggests how to broaden.',
      ),
  },

  async handler(input, ctx) {
    const fec = getOpenFecService();

    if (input.committee_id) validateCommitteeId(input.committee_id);
    if (input.candidate_id) validateCandidateId(input.candidate_id);

    let result: Awaited<ReturnType<typeof fec.getCommittee>>;

    if (input.committee_id) {
      ctx.log.info('Fetching committee by ID', { committee_id: input.committee_id });
      result = await fec.getCommittee(input.committee_id, ctx);
    } else {
      const params: FecParams = {
        q: input.query,
        candidate_id: input.candidate_id,
        state: input.state,
        party: input.party,
        committee_type: input.committee_type,
        designation: input.designation,
        cycle: input.cycle,
        treasurer_name: input.treasurer_name,
        page: input.page,
        per_page: input.per_page,
      };
      ctx.log.info('Searching committees', { query: input.query, state: input.state });
      result = await fec.searchCommittees(params, ctx);
    }

    if (input.committee_id && result.results.length === 0) {
      throw ctx.fail('committee_not_found', `Committee ${input.committee_id} not found.`, {
        committee_id: input.committee_id,
        ...ctx.recoveryFor('committee_not_found'),
      });
    }

    ctx.enrich.total(result.pagination.count);
    if (result.results.length === 0) {
      ctx.enrich.notice(
        'No committees matched. Try a partial name, remove type/designation filters, or search by candidate_id to find linked committees.',
      );
    }

    return {
      committees: result.results,
      pagination: result.pagination,
      search_criteria: result.results.length === 0 ? buildSearchCriteria(input) : undefined,
    };
  },

  format(result) {
    if (result.committees.length === 0) {
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

    const { page, pages, count, per_page } = result.pagination;
    lines.push(`\n---\nPage ${page} of ${pages} · ${count} total · ${per_page} per page`);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
