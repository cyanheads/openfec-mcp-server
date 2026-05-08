/**
 * @fileoverview Election lookup tool — find federal election races and candidate
 * financial summaries by office, cycle, state, and district.
 * @module mcp-server/tools/definitions/lookup-elections.tool
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
} from './utils/format-helpers.js';

const OFFICE_API_FORM = { H: 'house', S: 'senate', P: 'president' } as const;

export const lookupElections = tool('openfec_lookup_elections', {
  description:
    "Look up federal election races and candidate financial summaries. Find who's running in a race with fundraising totals, or get an aggregate race summary.",
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'cycle_must_be_even',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Cycle is an odd year',
      recovery:
        'Federal election cycles are two-year periods ending in even years (e.g., 2024, 2026).',
    },
    {
      reason: 'missing_state_for_office',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Senate or House office without a state and without a zip',
      recovery:
        'Provide a two-letter state code (e.g., AZ) or a zip code to scope the senate or house race.',
    },
    {
      reason: 'missing_district_for_house',
      code: JsonRpcErrorCode.ValidationError,
      when: 'House office without a district number and without a zip',
      recovery:
        'Provide a two-digit district number (e.g., "07") or a zip code to identify the House race.',
    },
    {
      reason: 'summary_does_not_support_zip',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Summary mode invoked with a zip parameter',
      recovery:
        'Use mode "search" for ZIP-based lookups, or remove zip and use state and district for summary mode.',
    },
  ],

  input: z.object({
    mode: z
      .enum(['search', 'summary'])
      .default('search')
      .describe(
        'search = candidates in a race with financial totals. summary = aggregate race financial summary.',
      ),
    office: z.enum(['H', 'S', 'P']).describe('Office sought: H=House, S=Senate, P=President.'),
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
          .describe(
            'Candidate financial row (search mode) or aggregate race summary (summary mode).',
          ),
      )
      .describe(
        'Election race result set; candidate financial rows in search mode, a single aggregate summary row in summary mode.',
      ),
    pagination: PaginationSchema,
    search_criteria: SearchCriteriaSchema,
  }),

  async handler(input, ctx) {
    if (input.cycle % 2 !== 0) {
      throw ctx.fail('cycle_must_be_even', undefined, {
        cycle: input.cycle,
        ...ctx.recoveryFor('cycle_must_be_even'),
      });
    }
    // ZIP resolves geography on its own — only require state/district when no zip
    if (!input.zip) {
      if ((input.office === 'S' || input.office === 'H') && !input.state) {
        throw ctx.fail('missing_state_for_office', undefined, {
          office: input.office,
          ...ctx.recoveryFor('missing_state_for_office'),
        });
      }
      if (input.office === 'H' && !input.district) {
        throw ctx.fail('missing_district_for_house', undefined, {
          office: input.office,
          state: input.state,
          ...ctx.recoveryFor('missing_district_for_house'),
        });
      }
    }

    const fec = getOpenFecService();

    const params: FecParams = {
      office: OFFICE_API_FORM[input.office],
      cycle: input.cycle,
    };
    if (input.state) params.state = input.state;
    if (input.district) params.district = input.district;
    if (input.zip) params.zip = input.zip;

    if (input.mode === 'summary') {
      if (input.zip) {
        throw ctx.fail('summary_does_not_support_zip', undefined, {
          ...ctx.recoveryFor('summary_does_not_support_zip'),
        });
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
