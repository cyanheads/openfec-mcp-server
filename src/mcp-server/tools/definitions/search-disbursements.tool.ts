/**
 * @fileoverview Search itemized committee spending (Schedule B) or get aggregate
 * breakdowns by purpose or recipient. Answers "what is this committee spending money on?"
 * @module mcp-server/tools/definitions/search-disbursements.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { decodeCursor, getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import { renderRecord } from './utils/format-helpers.js';
import { validateCommitteeId } from './utils/id-validators.js';

const modes = ['itemized', 'by_purpose', 'by_recipient', 'by_recipient_id'] as const;

export const searchDisbursements = tool('openfec_search_disbursements', {
  description:
    'Search itemized committee spending (Schedule B) or get aggregate breakdowns by purpose ' +
    'or recipient. All modes require a committee_id. Use to answer "what is this committee ' +
    'spending money on?" or "who is receiving payments from this committee?"',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    mode: z
      .enum(modes)
      .default('itemized')
      .describe(
        'Query mode. "itemized" returns individual disbursement records (keyset pagination). ' +
          '"by_purpose" aggregates by purpose category. "by_recipient" aggregates by recipient name. ' +
          '"by_recipient_id" aggregates by recipient committee ID (committee-to-committee transfers).',
      ),
    committee_id: z
      .string()
      .min(1)
      .describe('Spending committee ID (e.g., C00703975). Required for all modes.'),
    recipient_name: z.string().optional().describe('Full-text payee name search. Itemized only.'),
    recipient_state: z.string().optional().describe('Recipient state. Itemized only.'),
    recipient_city: z.string().optional().describe('Recipient city. Itemized only.'),
    recipient_committee_id: z
      .string()
      .optional()
      .describe('Recipient committee ID (for committee-to-committee transfers). Itemized only.'),
    disbursement_description: z
      .string()
      .optional()
      .describe('Full-text description search (e.g., "media buy", "consulting"). Itemized only.'),
    disbursement_purpose_category: z
      .string()
      .optional()
      .describe('Purpose category code. Itemized only.'),
    cycle: z.number().optional().describe('Two-year election cycle (e.g., 2024). Even years only.'),
    min_date: z
      .string()
      .optional()
      .describe('Earliest disbursement date (YYYY-MM-DD). Itemized only.'),
    max_date: z
      .string()
      .optional()
      .describe('Latest disbursement date (YYYY-MM-DD). Itemized only.'),
    min_amount: z.number().optional().describe('Minimum amount in dollars. Itemized only.'),
    max_amount: z.number().optional().describe('Maximum amount in dollars. Itemized only.'),
    sort: z
      .enum(['disbursement_date', 'disbursement_amount'])
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
      .describe('Disbursement records (itemized) or aggregate rows.'),
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

    validateCommitteeId(input.committee_id);

    /* ---------------------------------------------------------------- */
    /*  Itemized disbursements (keyset/SEEK)                            */
    /* ---------------------------------------------------------------- */
    if (mode === 'itemized') {
      const params: FecParams = {
        committee_id: input.committee_id,
        per_page: input.per_page,
      };

      if (input.cycle) params.two_year_transaction_period = input.cycle;
      if (input.recipient_name) params.recipient_name = input.recipient_name;
      if (input.recipient_state) params.recipient_state = input.recipient_state;
      if (input.recipient_city) params.recipient_city = input.recipient_city;
      if (input.recipient_committee_id)
        params.recipient_committee_id = input.recipient_committee_id;
      if (input.disbursement_description)
        params.disbursement_description = input.disbursement_description;
      if (input.disbursement_purpose_category) {
        params.disbursement_purpose_category = input.disbursement_purpose_category;
      }
      if (input.min_date) params.min_date = input.min_date;
      if (input.max_date) params.max_date = input.max_date;
      if (input.min_amount !== undefined) params.min_amount = input.min_amount;
      if (input.max_amount !== undefined) params.max_amount = input.max_amount;
      if (input.sort) params.sort = input.sort;

      if (input.cursor) {
        const lastIndexes = decodeCursor(input.cursor);
        Object.assign(params, lastIndexes);
      }

      const result = await fec.searchDisbursements(params, ctx);
      ctx.log.info('Itemized disbursements fetched', {
        committee_id: input.committee_id,
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
    const params: FecParams = {
      committee_id: input.committee_id,
      per_page: input.per_page,
      sort: '-total',
      sort_hide_null: true,
    };
    if (input.cycle) params.cycle = input.cycle;

    const result = await fec.getDisbursementAggregates(mode, params, ctx);
    ctx.log.info('Disbursement aggregates fetched', {
      mode,
      committee_id: input.committee_id,
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
          text: 'No disbursements found. Try a different cycle, broaden name/description filters, or verify the committee_id is correct.',
        },
      ];
    }

    const isItemized = 'next_cursor' in result && result.next_cursor !== undefined;
    const lines: string[] = [];

    if (isItemized) {
      if (result.count != null) {
        lines.push(`**${result.count.toLocaleString()} total disbursements**\n`);
      }
      for (const r of result.results) {
        const name = String(r.recipient_name ?? 'Unknown');
        lines.push(`**${name}**\n${renderRecord(r, new Set(['recipient_name']))}`);
      }
      if (result.next_cursor) {
        lines.push('\n_More results available — pass cursor to continue._');
      }
    } else {
      if (result.pagination?.count != null) {
        lines.push(`**${result.pagination.count.toLocaleString()} aggregate rows**\n`);
      }
      for (const r of result.results) {
        lines.push(renderRecord(r));
      }
      if (result.pagination && result.pagination.page < result.pagination.pages) {
        lines.push(`\n_Page ${result.pagination.page} of ${result.pagination.pages}_`);
      }
    }

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
