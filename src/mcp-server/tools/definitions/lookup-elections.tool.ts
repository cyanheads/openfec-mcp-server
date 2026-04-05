/**
 * @fileoverview Election lookup tool — find federal election races and candidate
 * financial summaries by office, cycle, state, and district.
 * @module mcp-server/tools/definitions/lookup-elections.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';

const fmt$ = (n: unknown) => (typeof n === 'number' ? `$${n.toLocaleString()}` : 'N/A');

export const lookupElectionsTool = tool('openfec_lookup_elections', {
  description:
    'Look up federal election races and candidate financial summaries. ' +
    "Find who's running in a race with fundraising totals, or get an aggregate race summary.",
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    mode: z
      .enum(['search', 'summary'])
      .default('search')
      .describe(
        'search = candidates in a race with financial totals. summary = aggregate race financial summary.',
      ),
    office: z
      .enum(['president', 'senate', 'house'])
      .describe('Office sought: president, senate, or house.'),
    cycle: z.number().int().describe('Election cycle year (even years only, e.g. 2024).'),
    state: z
      .string()
      .optional()
      .describe('Two-letter US state code (e.g., AZ, CA). Required for senate and house races.'),
    district: z
      .string()
      .optional()
      .describe('Two-digit district number (e.g. "07"). Required for house races.'),
    zip: z
      .string()
      .optional()
      .describe('ZIP code — finds races covering this ZIP. Search mode only.'),
    election_full: z
      .boolean()
      .default(true)
      .describe(
        'Expand to full election period (4yr president, 6yr senate, 2yr house). Default true.',
      ),
  }),

  output: z.object({
    results: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Election race records — candidates with financial data, or aggregate summary.'),
    pagination: z
      .object({
        page: z.number().describe('Current page number.'),
        pages: z.number().describe('Total pages available.'),
        count: z.number().describe('Total result count.'),
        per_page: z.number().describe('Results per page.'),
      })
      .describe('Page-based pagination metadata.'),
  }),

  async handler(input, ctx) {
    if (input.cycle % 2 !== 0) {
      throw invalidParams('Election cycles are even years (e.g., 2024, 2026).');
    }
    if ((input.office === 'senate' || input.office === 'house') && !input.state) {
      throw invalidParams('Senate and House election lookups require a state.');
    }
    if (input.office === 'house' && !input.district) {
      throw invalidParams('House election lookups require a district number.');
    }

    const fec = getOpenFecService();

    const params: FecParams = {
      office: input.office,
      cycle: input.cycle,
      election_full: input.election_full,
    };
    if (input.state) params.state = input.state;
    if (input.district) params.district = input.district;
    if (input.zip) params.zip = input.zip;

    if (input.mode === 'summary') {
      ctx.log.info('Fetching election summary', { office: input.office, cycle: input.cycle });
      const data = await fec.getElectionSummary(params, ctx);
      return { results: data.results, pagination: data.pagination };
    }

    ctx.log.info('Searching elections', { office: input.office, cycle: input.cycle });
    const data = await fec.searchElections(params, ctx);
    return { results: data.results, pagination: data.pagination };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No election results found for the given criteria.' }];
    }

    const lines = result.results.map((r) => {
      const name = r.candidate_name ?? r.candidate_id ?? 'Unknown';
      const party = r.party_full ?? r.party ?? '';
      const status = r.incumbent_challenge_full ?? '';
      const receipts = fmt$(r.total_receipts);
      const disbursements = fmt$(r.total_disbursements);
      const cash = fmt$(r.cash_on_hand_end_period);

      const parts = [`**${name}**`];
      if (party) parts.push(`(${party})`);
      if (status) parts.push(`— ${status}`);
      parts.push(`\n  Raised: ${receipts} | Spent: ${disbursements} | Cash on hand: ${cash}`);

      const coverage = r.coverage_end_date;
      if (coverage) parts.push(`| Through: ${coverage}`);

      return parts.join(' ');
    });

    const { page, pages, count } = result.pagination;
    lines.push(`\n_${count} result(s) — page ${page}/${pages}_`);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
