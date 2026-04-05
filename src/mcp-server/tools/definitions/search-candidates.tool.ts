/**
 * @fileoverview Tool for searching and retrieving FEC candidate records.
 * Supports full-text search, single-candidate lookup by ID, and optional
 * financial totals merging from the /candidates/totals/ endpoint.
 * @module mcp-server/tools/definitions/search-candidates.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams, notFound } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';

const CANDIDATE_ID_RE = /^[HSP][0-9A-Z]+$/i;

/** Format a number as USD or return 'N/A'. */
const fmt$ = (n: unknown): string => (typeof n === 'number' ? `$${n.toLocaleString()}` : 'N/A');

/** Safely read a string field from a record. */
const str = (rec: Record<string, unknown>, key: string): string =>
  typeof rec[key] === 'string' ? (rec[key] as string) : '';

const PaginationSchema = z.object({
  page: z.number().describe('Current page number (1-indexed).'),
  pages: z.number().describe('Total number of pages.'),
  count: z.number().describe('Total result count.'),
  per_page: z.number().describe('Results per page.'),
});

export const searchCandidates = tool('openfec_search_candidates', {
  description:
    'Find federal candidates by name, state, office, party, or cycle. ' +
    'Retrieve a specific candidate by FEC ID with financial totals. ' +
    'Candidate IDs start with H (House), S (Senate), or P (President) followed by digits.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    query: z.string().optional().describe('Full-text candidate name search.'),
    candidate_id: z
      .string()
      .optional()
      .describe(
        'FEC candidate ID (e.g., P00003392, H2CO07170). When provided, returns a single candidate with full detail.',
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
        'Include financial totals (receipts, disbursements, cash on hand). Defaults to true when fetching by candidate_id. Adds a second API call.',
      ),
    page: z.number().optional().describe('Page number (1-indexed). Default 1.'),
    per_page: z.number().optional().describe('Results per page. Default 20, max 100.'),
  }),

  output: z.object({
    candidates: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Candidate records with candidate_id, name, party, state, office, cycles, etc.'),
    totals: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Financial totals (receipts, disbursements, cash_on_hand) when include_totals is true.',
      ),
    pagination: PaginationSchema.describe('Page-based pagination metadata.'),
  }),

  async handler(input, ctx) {
    const fec = getOpenFecService();

    // Validate candidate_id format when provided
    if (input.candidate_id && !CANDIDATE_ID_RE.test(input.candidate_id)) {
      throw invalidParams(
        "Invalid candidate ID format. FEC candidate IDs start with H (House), S (Senate), or P (President) followed by digits (e.g., 'P00003392').",
        { candidate_id: input.candidate_id },
      );
    }

    const shouldIncludeTotals = input.include_totals ?? !!input.candidate_id;

    let candidateResult: Awaited<ReturnType<typeof fec.getCandidate>>;

    if (input.candidate_id) {
      // Single candidate lookup
      ctx.log.info('Fetching candidate by ID', { candidate_id: input.candidate_id });
      candidateResult = await fec.getCandidate(input.candidate_id, ctx);
    } else {
      // Search with filters
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
        page: input.page,
        per_page: input.per_page,
      };
      ctx.log.info('Searching candidates', { query: input.query, state: input.state });
      candidateResult = await fec.searchCandidates(params, ctx);
    }

    const candidates = candidateResult.results as Record<string, unknown>[];

    if (input.candidate_id && candidates.length === 0) {
      throw notFound(`Candidate ${input.candidate_id} not found.`, {
        candidate_id: input.candidate_id,
      });
    }

    // Fetch financial totals if requested
    let totals: Record<string, unknown>[] | undefined;
    if (shouldIncludeTotals && candidates.length > 0) {
      const totalsParams: FecParams = {
        candidate_id: input.candidate_id,
        cycle: input.cycle,
        election_year: input.election_year,
        page: input.page,
        per_page: input.per_page,
      };

      // For search results, collect all candidate IDs for the totals call
      if (!input.candidate_id) {
        const ids = candidates.map((c) => str(c, 'candidate_id')).filter(Boolean);
        if (ids.length > 0) {
          // The API accepts multiple candidate_id values — pass the first page's IDs
          totalsParams.candidate_id = ids.join(',');
        }
      }

      ctx.log.info('Fetching candidate totals', { candidate_id: totalsParams.candidate_id });
      const totalsResult = await fec.getCandidateTotals(totalsParams, ctx);
      totals = totalsResult.results as Record<string, unknown>[];
    }

    return {
      candidates,
      totals,
      pagination: candidateResult.pagination,
    };
  },

  format(result) {
    if (result.candidates.length === 0) {
      return [
        {
          type: 'text',
          text: 'No candidates found. Try broadening your search — use a partial name, remove filters like state or office, or check a different election cycle.',
        },
      ];
    }

    // Build a lookup of totals by candidate_id for merging
    const totalsMap = new Map<string, Record<string, unknown>>();
    if (result.totals) {
      for (const t of result.totals) {
        const id = str(t, 'candidate_id');
        if (id) totalsMap.set(id, t);
      }
    }

    const lines = result.candidates.map((c) => {
      const id = str(c, 'candidate_id');
      const name = str(c, 'name');
      const party = str(c, 'party_full') || str(c, 'party');
      const state = str(c, 'state');
      const office = str(c, 'office_full') || str(c, 'office');
      const status = str(c, 'incumbent_challenge_full') || str(c, 'incumbent_challenge');
      const district =
        typeof c.district_number === 'number'
          ? `-${String(c.district_number).padStart(2, '0')}`
          : '';

      let line = `**${name}** (${id})\n  ${party} | ${office}${district ? ` ${district}` : ''} | ${state} | ${status}`;

      const t = totalsMap.get(id);
      if (t) {
        line +=
          `\n  Receipts: ${fmt$(t.receipts)} | Disbursements: ${fmt$(t.disbursements)}` +
          `\n  Cash on Hand: ${fmt$(t.cash_on_hand_end_period)} | Debt: ${fmt$(t.debts_owed_by_committee)}`;
        const coverageEnd = str(t, 'coverage_end_date');
        if (coverageEnd) line += ` | Through: ${coverageEnd}`;
      }

      return line;
    });

    const { page, pages, count } = result.pagination;
    lines.push(`\n---\nPage ${page} of ${pages} (${count} total)`);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
