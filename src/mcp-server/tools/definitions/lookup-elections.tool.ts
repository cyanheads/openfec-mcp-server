/**
 * @fileoverview Election lookup tool — find federal election races and candidate
 * financial summaries by office, cycle, state, and district.
 * @module mcp-server/tools/definitions/lookup-elections.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import {
  buildSearchCriteria,
  formatEmptyResult,
  renderRecord,
  SearchCriteriaSchema,
} from './utils/format-helpers.js';

export const lookupElections = tool('openfec_lookup_elections', {
  description:
    "Look up federal election races and candidate financial summaries. Find who's running in a race with fundraising totals, or get an aggregate race summary.",
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
      .describe(
        'Two-letter US state code (e.g., AZ, CA). Required for senate/house unless zip is provided.',
      ),
    district: z
      .string()
      .optional()
      .describe(
        'Two-digit district number (e.g. "07"). Required for house unless zip is provided.',
      ),
    zip: z
      .string()
      .optional()
      .describe('ZIP code — finds races covering this ZIP. Search mode only.'),
    election_full: z
      .boolean()
      .default(true)
      .describe(
        'Expand to full election period (4yr president, 6yr senate, 2yr house). Default true. Ignored for ZIP-based searches.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .looseObject({})
          .describe('An election race record (candidate financial row or aggregate summary).'),
      )
      .describe('Election race records — candidates with financial data, or aggregate summary.'),
    pagination: z
      .object({
        page: z.number().describe('Current page number.'),
        pages: z.number().describe('Total pages available.'),
        count: z.number().describe('Total result count.'),
        per_page: z.number().describe('Results per page.'),
      })
      .describe('Page-based pagination metadata.'),
    search_criteria: SearchCriteriaSchema,
  }),

  async handler(input, ctx) {
    if (input.cycle % 2 !== 0) {
      throw invalidParams('Election cycles are even years (e.g., 2024, 2026).');
    }
    // ZIP resolves geography on its own — only require state/district when no zip
    if (!input.zip) {
      if ((input.office === 'senate' || input.office === 'house') && !input.state) {
        throw invalidParams(
          'Senate and House election lookups require a state (or provide a zip).',
        );
      }
      if (input.office === 'house' && !input.district) {
        throw invalidParams('House election lookups require a district number (or provide a zip).');
      }
    }

    const fec = getOpenFecService();

    const params: FecParams = {
      office: input.office,
      cycle: input.cycle,
    };
    if (input.state) params.state = input.state;
    if (input.district) params.district = input.district;
    if (input.zip) params.zip = input.zip;

    if (input.mode === 'summary') {
      if (input.zip) {
        throw invalidParams('Summary mode does not support ZIP lookups. Use search mode with zip.');
      }
      params.election_full = input.election_full;
      ctx.log.info('Fetching election summary', { office: input.office, cycle: input.cycle });
      const summary = await fec.getElectionSummary(params, ctx);
      return {
        results: [summary as unknown as Record<string, unknown>],
        pagination: { page: 1, pages: 1, count: 1, per_page: 1 },
      };
    }

    // /elections/search/ supports zip but not election_full; /elections/ supports election_full
    ctx.log.info('Searching elections', {
      office: input.office,
      cycle: input.cycle,
      zip: input.zip,
    });
    if (input.zip) {
      const data = await fec.searchElectionsByZip(params, ctx);
      return {
        results: data.results,
        pagination: data.pagination,
        search_criteria: data.results.length === 0 ? buildSearchCriteria(input) : undefined,
      };
    }
    params.election_full = input.election_full;
    const data = await fec.searchElections(params, ctx);
    return {
      results: data.results,
      pagination: data.pagination,
      search_criteria: data.results.length === 0 ? buildSearchCriteria(input) : undefined,
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return formatEmptyResult(
        result.search_criteria,
        'Verify the cycle is an even year, the state code is correct for senate/house races, and the district exists for the given state.',
      );
    }

    // Summary mode returns a single flat object with aggregate totals
    const first = result.results[0];
    if (
      first &&
      'receipts' in first &&
      'disbursements' in first &&
      'independent_expenditures' in first
    ) {
      return [{ type: 'text', text: `**Election Summary**\n${renderRecord(first)}` }];
    }

    const headerKeys = new Set(['candidate_name', 'candidate_id']);

    const lines = result.results.map((r) => {
      const name = String(r.candidate_name ?? 'Unknown');
      const id = r.candidate_id ? String(r.candidate_id) : '';
      const header = id ? `**${name}** (${id})` : `**${name}**`;
      const fields = renderRecord(r, headerKeys);
      return fields ? `${header}\n${fields}` : header;
    });

    const { page, pages, count, per_page } = result.pagination;
    lines.push(`\n_${count} result(s) · page ${page}/${pages} · ${per_page} per page_`);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
