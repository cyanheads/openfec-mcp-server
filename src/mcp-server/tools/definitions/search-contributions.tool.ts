/**
 * @fileoverview Search itemized individual contributions (Schedule A) or get
 * aggregate breakdowns by size, state, employer, or occupation. Central tool
 * for answering "who's funding this candidate/committee?"
 * @module mcp-server/tools/definitions/search-contributions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';

/** Format a number as USD or 'N/A' for non-numeric values. */
const fmt$ = (n: unknown) => (typeof n === 'number' ? `$${n.toLocaleString()}` : 'N/A');

/** Derive the current two-year election cycle (always even). */
const currentCycle = () => {
  const year = new Date().getFullYear();
  return year % 2 === 0 ? year : year + 1;
};

const modes = ['itemized', 'by_size', 'by_state', 'by_employer', 'by_occupation'] as const;

export const searchContributions = tool('openfec_search_contributions', {
  description:
    'Search itemized individual contributions (Schedule A) or get aggregate breakdowns ' +
    'by size, state, employer, or occupation. Use to answer "who is funding this committee?" ' +
    'Itemized mode requires a committee_id. Aggregate by_size/by_state can use candidate_id instead.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    mode: z
      .enum(modes)
      .default('itemized')
      .describe(
        'Query mode. "itemized" returns individual contribution records (keyset pagination). ' +
          '"by_size" aggregates by contribution size bucket. "by_state" aggregates by contributor state. ' +
          '"by_employer" aggregates by employer. "by_occupation" aggregates by occupation.',
      ),
    committee_id: z.string().optional().describe('Receiving committee ID (e.g., C00703975).'),
    candidate_id: z
      .string()
      .optional()
      .describe(
        'Candidate ID. Used with by_size/by_state aggregates to route to the /by_candidate variant.',
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
        'Two-year election cycle (e.g., 2024). Even years only. ' +
          'Defaults to current cycle for itemized mode (API requires two_year_transaction_period).',
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
      .enum(['contribution_receipt_date', 'contribution_receipt_amount'])
      .optional()
      .describe('Sort field. Itemized only.'),
    per_page: z.number().default(20).describe('Results per page (max 100).'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque pagination cursor from a previous response. Itemized mode only (keyset pagination).',
      ),
  }),

  output: z.object({
    results: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Contribution records (itemized) or aggregate rows.'),
    next_cursor: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Pagination cursor for the next page of itemized results. Null when no more pages.',
      ),
    count: z.number().optional().describe('Total result count (may be approximate for itemized).'),
    pagination: z
      .object({
        page: z.number().describe('Current page number.'),
        pages: z.number().describe('Total pages.'),
        count: z.number().describe('Total results.'),
        per_page: z.number().describe('Results per page.'),
      })
      .optional()
      .describe('Page-based pagination info (aggregate modes only).'),
  }),

  async handler(input, ctx) {
    const fec = getOpenFecService();
    const mode = input.mode;

    /* ---------------------------------------------------------------- */
    /*  Itemized contributions (keyset/SEEK)                            */
    /* ---------------------------------------------------------------- */
    if (mode === 'itemized') {
      if (!input.committee_id) {
        throw invalidParams(
          'Itemized contribution search requires a committee_id. To search contributions ' +
            'by candidate, use a "by_size" or "by_state" aggregate mode with candidate_id, ' +
            "or first look up the candidate's committee with openfec_search_committees.",
        );
      }

      const cycle = input.cycle ?? currentCycle();
      const params: FecParams = {
        committee_id: input.committee_id,
        two_year_transaction_period: cycle,
        per_page: input.per_page,
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

      if (input.cursor) {
        const lastIndexes = decodeCursor(input.cursor);
        Object.assign(params, lastIndexes);
      }

      const result = await fec.searchContributions(params, ctx);
      ctx.log.info('Itemized contributions fetched', {
        committee_id: input.committee_id,
        cycle,
        count: result.pagination.count,
        returned: result.results.length,
      });

      return {
        results: result.results,
        next_cursor: result.nextCursor,
        count: result.pagination.count,
      };
    }

    /* ---------------------------------------------------------------- */
    /*  Aggregate modes                                                 */
    /* ---------------------------------------------------------------- */
    if (mode === 'by_employer' || mode === 'by_occupation') {
      if (!input.committee_id) {
        throw invalidParams(`Aggregate by ${mode.replace('by_', '')} requires a committee_id.`);
      }
    }

    const params: FecParams = { per_page: input.per_page };
    if (input.committee_id) params.committee_id = input.committee_id;
    if (input.candidate_id) params.candidate_id = input.candidate_id;
    if (input.cycle) params.cycle = input.cycle;

    // For by_size and by_state, route to /by_candidate variant when candidate_id is provided
    let aggregateMode: string = mode;
    if ((mode === 'by_size' || mode === 'by_state') && input.candidate_id) {
      aggregateMode = `${mode}_candidate`;
    }

    const result = await fec.getContributionAggregates(aggregateMode, params, ctx);
    ctx.log.info('Contribution aggregates fetched', {
      mode: aggregateMode,
      count: result.pagination.count,
      returned: result.results.length,
    });

    return {
      results: result.results,
      pagination: result.pagination,
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No contributions found matching the given criteria.' }];
    }

    // Detect itemized vs aggregate by presence of next_cursor key
    const isItemized = 'next_cursor' in result && result.next_cursor !== undefined;

    if (isItemized) {
      const lines: string[] = [
        `**${result.count?.toLocaleString() ?? '?'} total contributions**\n`,
      ];
      for (const r of result.results) {
        const name = r.contributor_name ?? 'Unknown';
        const employer = r.contributor_employer ?? '';
        const amount = fmt$(r.contribution_receipt_amount);
        const date = r.contribution_receipt_date ?? '';
        const committee = r.committee_name ?? r.committee_id ?? '';
        const city = r.contributor_city ?? '';
        const state = r.contributor_state ?? '';
        const location = [city, state].filter(Boolean).join(', ');

        lines.push(`- **${name}** ${location ? `(${location})` : ''}`);
        lines.push(`  ${amount} on ${date} → ${committee}`);
        if (employer) lines.push(`  Employer: ${employer}`);
      }
      if (result.next_cursor) {
        lines.push(`\n_More results available — pass cursor to continue._`);
      }
      return [{ type: 'text', text: lines.join('\n') }];
    }

    // Aggregate
    const lines: string[] = [
      `**${result.pagination?.count?.toLocaleString() ?? '?'} aggregate rows**\n`,
    ];
    for (const r of result.results) {
      const dimension =
        r.size ?? r.state ?? r.employer ?? r.occupation ?? r.state_full ?? 'Unknown';
      const total = fmt$(r.total);
      const count =
        typeof r.count === 'number' ? ` (${r.count.toLocaleString()} contributions)` : '';
      lines.push(`- **${dimension}**: ${total}${count}`);
    }
    if (result.pagination && result.pagination.page < result.pagination.pages) {
      lines.push(`\n_Page ${result.pagination.page} of ${result.pagination.pages}_`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
