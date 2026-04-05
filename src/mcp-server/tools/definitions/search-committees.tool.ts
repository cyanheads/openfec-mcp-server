/**
 * @fileoverview Tool for searching and retrieving FEC committee records.
 * Supports full-text search, single-committee lookup by ID, and filtering
 * by candidate affiliation, type, designation, state, and party.
 * @module mcp-server/tools/definitions/search-committees.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams, notFound } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';

const COMMITTEE_ID_RE = /^C\d+$/i;

/** Safely read a string field from a record. */
const str = (rec: Record<string, unknown>, key: string): string =>
  typeof rec[key] === 'string' ? (rec[key] as string) : '';

const PaginationSchema = z.object({
  page: z.number().describe('Current page number (1-indexed).'),
  pages: z.number().describe('Total number of pages.'),
  count: z.number().describe('Total result count.'),
  per_page: z.number().describe('Results per page.'),
});

export const searchCommittees = tool('openfec_search_committees', {
  description:
    'Find political committees (campaign, PAC, Super PAC, party) by name, type, ' +
    'candidate affiliation, or state. Retrieve a specific committee by FEC ID. ' +
    'Committee IDs start with C followed by digits (e.g., C00358796).',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    query: z.string().optional().describe('Full-text committee name search.'),
    committee_id: z
      .string()
      .optional()
      .describe(
        "FEC committee ID (e.g., C00358796). Starts with 'C' followed by digits. Returns a single committee with full detail.",
      ),
    candidate_id: z
      .string()
      .optional()
      .describe(
        'Find committees linked to this candidate (authorized, leadership, joint fundraising).',
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
    page: z.number().optional().describe('Page number (1-indexed). Default 1.'),
    per_page: z.number().optional().describe('Results per page. Default 20, max 100.'),
  }),

  output: z.object({
    committees: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Committee records with committee_id, name, type, designation, party, state, etc.'),
    pagination: PaginationSchema.describe('Page-based pagination metadata.'),
  }),

  async handler(input, ctx) {
    const fec = getOpenFecService();

    if (input.committee_id && !COMMITTEE_ID_RE.test(input.committee_id)) {
      throw invalidParams(
        "Invalid committee ID format. FEC committee IDs start with 'C' followed by digits (e.g., 'C00358796').",
        { committee_id: input.committee_id },
      );
    }

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
      throw notFound(`Committee ${input.committee_id} not found.`, {
        committee_id: input.committee_id,
      });
    }

    return {
      committees: result.results,
      pagination: result.pagination,
    };
  },

  format(result) {
    if (result.committees.length === 0) {
      return [
        {
          type: 'text',
          text: 'No committees found. Try a partial name, remove type/designation filters, or search by candidate_id to find linked committees.',
        },
      ];
    }

    const lines = result.committees.map((c) => {
      const id = str(c, 'committee_id');
      const name = str(c, 'name');
      const type = str(c, 'committee_type_full') || str(c, 'committee_type');
      const designation = str(c, 'designation_full') || str(c, 'designation');
      const party = str(c, 'party_full') || str(c, 'party');
      const state = str(c, 'state');
      const treasurer = str(c, 'treasurer_name');

      let line = `**${name}** (${id})\n  Type: ${type} | Designation: ${designation}`;
      if (party) line += ` | ${party}`;
      if (state) line += ` | ${state}`;
      if (treasurer) line += `\n  Treasurer: ${treasurer}`;

      const candidateIds = c.candidate_ids;
      if (Array.isArray(candidateIds) && candidateIds.length > 0) {
        line += `\n  Candidates: ${candidateIds.join(', ')}`;
      }

      return line;
    });

    const { page, pages, count } = result.pagination;
    lines.push(`\n---\nPage ${page} of ${pages} (${count} total)`);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
