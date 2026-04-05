/**
 * @fileoverview Search independent expenditures (Schedule E) — outside spending
 * by Super PACs, party committees, and other groups supporting or opposing
 * federal candidates. Key dataset for tracking outside money in elections.
 * @module mcp-server/tools/definitions/search-expenditures.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';

const CANDIDATE_ID_RE = /^[HSP][0-9A-Z]+$/i;
const COMMITTEE_ID_RE = /^C\d+$/i;

/** Format a number as USD or 'N/A' for non-numeric values. */
const fmt$ = (n: unknown) => (typeof n === 'number' ? `$${n.toLocaleString()}` : 'N/A');

/** Expand S/O indicator to a readable label. */
const supportOpposeLabel = (code: unknown) =>
  code === 'S' ? 'SUPPORT' : code === 'O' ? 'OPPOSE' : String(code ?? '');

const modes = ['itemized', 'by_candidate'] as const;

export const searchExpenditures = tool('openfec_search_expenditures', {
  description:
    'Search independent expenditures (Schedule E) — outside spending supporting or opposing ' +
    'federal candidates. Covers Super PACs, party committees, and other groups. Use itemized ' +
    'mode for individual expenditure records, or by_candidate for aggregated totals per candidate.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    mode: z
      .enum(modes)
      .default('itemized')
      .describe(
        'Query mode. "itemized" returns individual expenditure records (keyset pagination). ' +
          '"by_candidate" returns aggregated totals per candidate by committee (page-based).',
      ),
    committee_id: z.string().optional().describe('Spending committee ID (e.g., C00703975).'),
    candidate_id: z.string().optional().describe('Targeted candidate ID (e.g., P00003392).'),
    support_oppose: z
      .enum(['S', 'O'])
      .optional()
      .describe(
        'S = support, O = oppose. Filter by whether the expenditure supports or opposes the candidate.',
      ),
    payee_name: z.string().optional().describe('Full-text payee name search. Itemized only.'),
    candidate_office: z
      .enum(['H', 'S', 'P'])
      .optional()
      .describe('Office of the targeted candidate: H=House, S=Senate, P=President.'),
    candidate_office_state: z
      .string()
      .optional()
      .describe('Two-letter state code of the targeted race.'),
    candidate_party: z
      .string()
      .optional()
      .describe('Three-letter party code of the targeted candidate (e.g., DEM, REP).'),
    cycle: z.number().optional().describe('Two-year election cycle (e.g., 2024). Even years only.'),
    min_date: z
      .string()
      .optional()
      .describe('Earliest expenditure date (YYYY-MM-DD). Itemized only.'),
    max_date: z
      .string()
      .optional()
      .describe('Latest expenditure date (YYYY-MM-DD). Itemized only.'),
    min_amount: z
      .number()
      .optional()
      .describe('Minimum expenditure amount in dollars. Itemized only.'),
    max_amount: z
      .number()
      .optional()
      .describe('Maximum expenditure amount in dollars. Itemized only.'),
    is_notice: z
      .boolean()
      .optional()
      .describe('Only 24/48-hour notice filings (near-election spending). Itemized only.'),
    most_recent: z
      .boolean()
      .default(true)
      .describe('Only the most recent version of amended filings. Itemized only.'),
    sort: z
      .enum(['expenditure_date', 'expenditure_amount', 'office_total_ytd'])
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
      .describe('Expenditure records (itemized) or per-candidate aggregate rows.'),
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
      .describe('Page-based pagination info (by_candidate mode only).'),
  }),

  async handler(input, ctx) {
    const fec = getOpenFecService();
    const mode = input.mode;

    if (input.candidate_id && !CANDIDATE_ID_RE.test(input.candidate_id)) {
      throw invalidParams(
        "Invalid candidate ID format. FEC candidate IDs start with H (House), S (Senate), or P (President) followed by digits (e.g., 'P00003392').",
        { candidate_id: input.candidate_id },
      );
    }
    if (input.committee_id && !COMMITTEE_ID_RE.test(input.committee_id)) {
      throw invalidParams(
        "Invalid committee ID format. FEC committee IDs start with 'C' followed by digits (e.g., 'C00703975').",
        { committee_id: input.committee_id },
      );
    }

    /* ---------------------------------------------------------------- */
    /*  Itemized expenditures (keyset/SEEK)                             */
    /* ---------------------------------------------------------------- */
    if (mode === 'itemized') {
      const params: FecParams = {
        per_page: input.per_page,
        most_recent: input.most_recent,
      };

      if (input.committee_id) params.committee_id = input.committee_id;
      if (input.candidate_id) params.candidate_id = input.candidate_id;
      if (input.support_oppose) params.support_oppose_indicator = input.support_oppose;
      if (input.payee_name) params.payee_name = input.payee_name;
      if (input.candidate_office) params.candidate_office = input.candidate_office;
      if (input.candidate_office_state)
        params.candidate_office_state = input.candidate_office_state;
      if (input.candidate_party) params.candidate_party = input.candidate_party;
      if (input.cycle) params.cycle = input.cycle;
      if (input.min_date) params.min_date = input.min_date;
      if (input.max_date) params.max_date = input.max_date;
      if (input.min_amount !== undefined) params.min_amount = input.min_amount;
      if (input.max_amount !== undefined) params.max_amount = input.max_amount;
      if (input.is_notice !== undefined) params.is_notice = input.is_notice;
      if (input.sort) params.sort = input.sort;

      if (input.cursor) {
        const lastIndexes = decodeCursor(input.cursor);
        Object.assign(params, lastIndexes);
      }

      const result = await fec.searchExpenditures(params, ctx);
      ctx.log.info('Itemized expenditures fetched', {
        committee_id: input.committee_id,
        candidate_id: input.candidate_id,
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
    /*  By candidate (page-based)                                       */
    /* ---------------------------------------------------------------- */
    if (!input.candidate_id) {
      throw invalidParams(
        'by_candidate mode requires a candidate_id. Use openfec_search_candidates to find the ID, then pass it here to see independent expenditures supporting or opposing that candidate.',
        { mode: input.mode },
      );
    }

    const params: FecParams = { per_page: input.per_page };

    if (input.committee_id) params.committee_id = input.committee_id;
    if (input.candidate_id) params.candidate_id = input.candidate_id;
    if (input.support_oppose) params.support_oppose_indicator = input.support_oppose;
    if (input.candidate_office) params.candidate_office = input.candidate_office;
    if (input.candidate_office_state) params.candidate_office_state = input.candidate_office_state;
    if (input.candidate_party) params.candidate_party = input.candidate_party;
    if (input.cycle) params.cycle = input.cycle;

    const result = await fec.getExpendituresByCandidate(params, ctx);
    ctx.log.info('Expenditures by candidate fetched', {
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
      return [
        {
          type: 'text',
          text: 'No independent expenditures found. Try a different cycle, broaden filters, or verify the candidate_id/committee_id. Not all races attract significant outside spending.',
        },
      ];
    }

    const isItemized = 'next_cursor' in result && result.next_cursor !== undefined;

    if (isItemized) {
      const lines: string[] = [
        `**${result.count?.toLocaleString() ?? '?'} total independent expenditures**\n`,
      ];
      for (const r of result.results) {
        const indicator = supportOpposeLabel(r.support_oppose_indicator);
        const amount = fmt$(r.expenditure_amount);
        const date = r.expenditure_date ?? '';
        const committee = r.committee_name ?? r.committee_id ?? '';
        const candidate = r.candidate_name ?? r.candidate_id ?? '';
        const office = r.candidate_office ?? '';
        const state = r.candidate_office_state ?? '';
        const payee = r.payee_name ?? '';
        const desc = r.expenditure_description ?? '';
        const notice = r.is_notice ? ' [24/48h NOTICE]' : '';

        lines.push(
          `- **[${indicator}]** ${amount} — ${candidate} (${office}${state ? `-${state}` : ''})${notice}`,
        );
        lines.push(`  By: ${committee} on ${date}`);
        if (payee) lines.push(`  Payee: ${payee}`);
        if (desc) lines.push(`  ${desc}`);
      }
      if (result.next_cursor) {
        lines.push(`\n_More results available — pass cursor to continue._`);
      }
      return [{ type: 'text', text: lines.join('\n') }];
    }

    // By candidate aggregate
    const lines: string[] = [
      `**${result.pagination?.count?.toLocaleString() ?? '?'} candidate-committee pairs**\n`,
    ];
    for (const r of result.results) {
      const indicator = supportOpposeLabel(r.support_oppose_indicator);
      const candidate = r.candidate_name ?? r.candidate_id ?? 'Unknown';
      const committee = r.committee_name ?? r.committee_id ?? 'Unknown';
      const total = fmt$(r.total);
      const count =
        typeof r.count === 'number' ? ` (${r.count.toLocaleString()} expenditures)` : '';

      lines.push(`- **[${indicator}]** ${candidate}`);
      lines.push(`  ${total}${count} from ${committee}`);
    }
    if (result.pagination && result.pagination.page < result.pagination.pages) {
      lines.push(`\n_Page ${result.pagination.page} of ${result.pagination.pages}_`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
