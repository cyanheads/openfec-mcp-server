/**
 * @fileoverview Search itemized committee spending (Schedule B) or get aggregate
 * breakdowns by purpose or recipient. Answers "what is this committee spending money on?"
 * @module mcp-server/tools/definitions/search-disbursements.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  cursorQuery,
  decodeCursor,
  getOpenFecService,
} from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import { currentCycle } from './utils/election-cycle.js';
import {
  buildSearchCriteria,
  formatEmptyResult,
  formatSearchCriteria,
  PaginationSchema,
  renderRecord,
  SearchCriteriaSchema,
} from './utils/format-helpers.js';
import { validateCommitteeId } from './utils/id-validators.js';
import { validateRange } from './utils/range-validators.js';
import {
  formatHoistedCommittee,
  HoistedCommitteeSchema,
  trimScheduleRows,
} from './utils/trim-schedule-row.js';

const modes = ['itemized', 'by_purpose', 'by_recipient', 'by_recipient_id'] as const;

/**
 * Inputs the itemized Schedule B endpoint accepts and the aggregate endpoints
 * do not. Sending one in an aggregate mode used to drop it silently, returning
 * an unnarrowed result set that looks like an answer to the narrowed question.
 */
const ITEMIZED_ONLY_INPUTS = [
  'recipient_name',
  'recipient_state',
  'recipient_city',
  'recipient_committee_id',
  'disbursement_description',
  'disbursement_purpose_category',
  'min_date',
  'max_date',
  'min_amount',
  'max_amount',
  'sort',
  'cursor',
] as const;

/** What the Schedule B aggregate endpoints do accept — quoted in the rejection. */
const AGGREGATE_INPUTS = 'committee_id, cycle, mode, page, per_page';
const ITEMIZED_INPUTS = [
  'mode',
  'committee_id',
  'recipient_name',
  'recipient_state',
  'recipient_city',
  'recipient_committee_id',
  'disbursement_description',
  'disbursement_purpose_category',
  'cycle',
  'min_date',
  'max_date',
  'min_amount',
  'max_amount',
  'sort',
  'per_page',
  'cursor',
] as const;

export const searchDisbursements = tool('openfec_search_disbursements', {
  description:
    'Search itemized committee spending (Schedule B) or get aggregate breakdowns by purpose or recipient. All modes require a committee_id. Use to answer "what is this committee spending money on?" or "who is receiving payments from this committee?"',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'itemized_only_filters_in_aggregate_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An itemized-only filter was supplied alongside an aggregate mode, which cannot apply it',
      recovery: `Re-run with mode "itemized" to filter by recipient, description, date range, or amount, or drop the named inputs to keep the aggregate. Aggregate modes accept only ${AGGREGATE_INPUTS}.`,
    },
    {
      reason: 'inputs_not_applicable_to_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Itemized mode receives an explicit page number that its keyset endpoint cannot apply',
      recovery: 'Remove page and use per_page plus cursor to navigate itemized results.',
    },
  ],

  input: z.object({
    mode: z
      .enum(modes)
      .default('itemized')
      .describe(
        'Query mode. "itemized" returns individual disbursement records (keyset pagination). "by_purpose" aggregates by purpose category. "by_recipient" aggregates by recipient name. "by_recipient_id" aggregates by recipient committee ID (committee-to-committee transfers).',
      ),
    committee_id: z
      .string()
      .min(1)
      .describe(
        'Spending committee ID (e.g., C00703975). Get IDs from openfec_search_committees results. Required for all modes.',
      ),
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
    cycle: z
      .number()
      .optional()
      .describe(
        'Two-year election cycle (e.g., 2024). Even years only. Itemized mode defaults to the current cycle when omitted — Schedule B spans all history, and an all-history scan of an active committee times out upstream. Pass an explicit cycle to search an earlier period.',
      ),
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
      .enum([
        'disbursement_date',
        '-disbursement_date',
        'disbursement_amount',
        '-disbursement_amount',
      ])
      .optional()
      .describe(
        'Sort field. A "-" prefix sorts descending: use "-disbursement_amount" for the biggest payments first, since the ascending form leads with the most negative rows (refunds and voided payments). Itemized only; OpenFEC sorts by "-disbursement_date" when omitted.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Page number (1-indexed) for aggregate modes. Explicit page is rejected in itemized mode, which paginates with cursor. Defaults to 1 for aggregates.',
      ),
    per_page: z.number().int().min(1).max(100).default(20).describe('Results per page.'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque pagination cursor from a previous response of this tool. Itemized mode only (keyset pagination). Valid only for an otherwise-identical call — changing any other argument, including sort, rejects the cursor; omit it to start over.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .looseObject({})
          .describe(
            'Itemized disbursement record (mode=itemized) or aggregate row (mode=by_purpose, by_recipient, by_recipient_id).',
          ),
      )
      .describe(
        'Disbursement result set; itemized records or aggregate buckets depending on mode.',
      ),
    mode: z
      .enum(modes)
      .describe(
        'Query mode as the server resolved it. Row shapes differ by mode — itemized rows are individual payments, aggregate rows are buckets with a total — so read this rather than inferring the shape from the fields present.',
      ),
    committee: HoistedCommitteeSchema,
    next_cursor: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Pagination cursor for the next page of itemized results. Null when no more pages.',
      ),
    count: z.number().optional().describe('Total result count (may be approximate for itemized).'),
    pagination: PaginationSchema.optional().describe(
      'Page-based pagination info (aggregate modes only).',
    ),
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching disbursements or aggregate rows.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no disbursements matched — echoes filters and suggests how to broaden.',
      ),
  },

  async handler(input, ctx) {
    const fec = getOpenFecService();
    const mode = input.mode;

    validateCommitteeId(input.committee_id);

    /* ---------------------------------------------------------------- */
    /*  Itemized disbursements (keyset/SEEK)                            */
    /* ---------------------------------------------------------------- */
    if (mode === 'itemized') {
      if (input.page !== undefined) {
        throw ctx.fail('inputs_not_applicable_to_mode', 'Mode "itemized" cannot apply page.', {
          mode,
          inapplicable_inputs: ['page'],
          supported_inputs: [...ITEMIZED_INPUTS],
          ...ctx.recoveryFor('inputs_not_applicable_to_mode'),
        });
      }

      validateRange({
        minField: 'min_date',
        minValue: input.min_date,
        maxField: 'max_date',
        maxValue: input.max_date,
        valueType: 'date',
      });
      validateRange({
        minField: 'min_amount',
        minValue: input.min_amount,
        maxField: 'max_amount',
        maxValue: input.max_amount,
        valueType: 'number',
      });

      const cycle = input.cycle ?? currentCycle();
      /**
       * The cycle can default, and a default the caller cannot see is the
       * failure the criteria echo exists to close — so the echo and the cursor
       * identity are both built from the effective values, not the raw input.
       */
      const applied = { ...input, cycle };
      const params: FecParams = {
        committee_id: input.committee_id,
        two_year_transaction_period: cycle,
        per_page: input.per_page,
      };

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

      const query = cursorQuery('openfec_search_disbursements', applied);
      if (input.cursor) {
        Object.assign(params, decodeCursor(input.cursor, query));
      }

      const result = await fec.searchDisbursements(params, query, ctx);
      ctx.log.info('Itemized disbursements fetched', {
        committee_id: input.committee_id,
        cycle,
        count: result.pagination.count,
        returned: result.results.length,
      });

      ctx.enrich.total(result.pagination.count);
      if (result.results.length === 0) {
        ctx.enrich.notice(
          'No itemized disbursements matched. Try a different cycle, broaden name/description filters, or look up the committee by name with openfec_search_committees.',
        );
      }

      /** committee_id is required here, so every row carries the same committee. */
      const trimmed = trimScheduleRows(result.results as Record<string, unknown>[], {
        hoistCommittee: true,
      });

      return {
        results: trimmed.results,
        ...(trimmed.committee ? { committee: trimmed.committee } : {}),
        mode: 'itemized' as const,
        next_cursor: result.nextCursor,
        count: result.pagination.count,
        search_criteria: buildSearchCriteria(applied),
      };
    }

    /* ---------------------------------------------------------------- */
    /*  Aggregate modes                                                 */
    /* ---------------------------------------------------------------- */
    const inapplicable = ITEMIZED_ONLY_INPUTS.filter(
      (key) => input[key] !== undefined && input[key] !== '',
    );
    if (inapplicable.length > 0) {
      throw ctx.fail(
        'itemized_only_filters_in_aggregate_mode',
        `Mode "${mode}" cannot apply ${inapplicable.join(', ')} — the Schedule B aggregate endpoints accept only ${AGGREGATE_INPUTS}. Sending them would have returned an unfiltered aggregate.`,
        {
          mode,
          inapplicable_inputs: inapplicable,
          supported_inputs: AGGREGATE_INPUTS.split(', '),
          ...ctx.recoveryFor('itemized_only_filters_in_aggregate_mode'),
        },
      );
    }

    const params: FecParams = {
      committee_id: input.committee_id,
      page: input.page ?? 1,
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

    ctx.enrich.total(result.pagination.count);
    if (result.results.length === 0) {
      ctx.enrich.notice(
        'No disbursement aggregates matched. Verify the committee_id is correct and the cycle is set correctly.',
      );
    }

    return {
      results: result.results,
      mode,
      pagination: result.pagination,
      search_criteria: buildSearchCriteria(input),
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return formatEmptyResult(
        result.search_criteria,
        'Try a different cycle, broaden name/description filters, or look up the committee by name with openfec_search_committees.',
        result.mode,
      );
    }

    const isItemized = 'next_cursor' in result && result.next_cursor !== undefined;
    const lines: string[] = [
      `**Mode:** ${result.mode}`,
      ...formatHoistedCommittee(result.committee),
    ];

    if (isItemized) {
      if (result.count != null) {
        lines.push(`**${result.count} total disbursements**\n`);
      }
      for (const r of result.results) {
        const name = String(r.recipient_name ?? 'Unknown');
        lines.push(`**${name}**\n${renderRecord(r, new Set(['recipient_name']))}`);
      }
      if (result.next_cursor) {
        lines.push('\n_More results available._', `next_cursor: \`${result.next_cursor}\``);
      }
    } else {
      for (const r of result.results) {
        lines.push(renderRecord(r));
      }
    }

    if (result.pagination) {
      const p = result.pagination;
      lines.push(`\n_Page ${p.page} of ${p.pages} · ${p.count} total · ${p.per_page} per page_`);
    }

    const criteria = formatSearchCriteria(result.search_criteria);
    if (criteria) lines.push(criteria);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
