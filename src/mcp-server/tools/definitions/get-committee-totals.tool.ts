/**
 * @fileoverview Pre-aggregated committee financial totals — one committee's
 * per-cycle summary, or a ranked search across every committee of one entity
 * type. Answers "how much has this committee raised?" in a single call instead
 * of paginating Schedule A.
 * @module mcp-server/tools/definitions/get-committee-totals.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import {
  buildSearchCriteria,
  fmt$,
  formatEmptyResult,
  formatSearchCriteria,
  PaginationSchema,
  renderRecord,
  SearchCriteriaSchema,
  str,
} from './utils/format-helpers.js';
import { validateCommitteeId } from './utils/id-validators.js';

const modes = ['single', 'by_entity_type'] as const;

const entityTypes = [
  'presidential',
  'pac',
  'party',
  'pac-party',
  'house-senate',
  'ie-only',
] as const;

/**
 * Inputs only the grouped `/totals/{entity_type}/` search accepts.
 * `/committee/{committee_id}/totals/` takes nothing but paging, cycle, and
 * sort, so sending one of these in single mode would drop it silently and
 * return totals that look filtered but are not.
 */
const BY_ENTITY_TYPE_ONLY_INPUTS = [
  'entity_type',
  'committee_state',
  'committee_type',
  'committee_designation',
  'organization_type',
  'min_receipts',
  'max_receipts',
  'min_disbursements',
  'max_disbursements',
] as const;

/** What the single-committee endpoint does accept — quoted in the rejection. */
const SINGLE_INPUTS = 'committee_id, cycle, sort, mode, page, per_page';

export const getCommitteeTotals = tool('openfec_get_committee_totals', {
  description:
    'Get pre-aggregated committee financial totals — receipts, disbursements, cash on hand, debts, and the itemized/unitemized breakdown — without paginating Schedule A. Use mode "single" (the default) with a committee_id for one committee\'s totals, one row per two-year cycle it has filed. Use mode "by_entity_type" to rank or screen every committee of one type (presidential, pac, party, pac-party, house-senate, ie-only) by state, designation, or a receipts/disbursements threshold.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'committee_id_required_for_single_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mode single invoked without a committee_id',
      recovery:
        'Pass the committee_id whose totals you want (find one with openfec_search_committees), or switch to mode by_entity_type with an entity_type to search across committees.',
    },
    {
      reason: 'entity_type_required_for_group_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mode by_entity_type invoked without an entity_type',
      recovery:
        'Pass an entity_type of presidential, pac, party, pac-party, house-senate, or ie-only, or switch to mode single with a committee_id.',
    },
    {
      reason: 'inputs_not_applicable_to_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A grouped-search filter (entity_type, committee_state, committee_type, committee_designation, organization_type, or a receipts/disbursements bound) was supplied alongside mode single, which cannot apply it',
      recovery: `Re-run with mode "by_entity_type" to filter across committees by state, type, designation, or a financial threshold, or drop the named inputs to keep the single-committee lookup. Mode single accepts only ${SINGLE_INPUTS}.`,
    },
    {
      reason: 'committee_totals_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Single-committee lookup matched no totals row — the committee_id does not exist, it filed nothing in the requested cycle, or it has never filed a financial report at all',
      recovery:
        'Drop the cycle filter to see every cycle the committee has on record, and verify the committee_id with openfec_search_committees; a committee that files no financial report has no totals at any cycle, so read its filings with openfec_search_filings instead.',
    },
  ],

  input: z.object({
    mode: z
      .enum(modes)
      .default('single')
      .describe(
        'Query mode. "single" returns one committee\'s totals, one row per cycle. "by_entity_type" returns a page of committees of one entity type, filterable and sortable across committees.',
      ),
    committee_id: z
      .string()
      .optional()
      .describe(
        'Committee ID (e.g., C00703975). Get IDs from openfec_search_committees results. Required in single mode; in by_entity_type mode it narrows the grouped search to that one committee.',
      ),
    entity_type: z
      .enum(entityTypes)
      .optional()
      .describe(
        'Committee entity type for the grouped search. Required in by_entity_type mode. house-senate covers both chambers as one group; ie-only is committees that report only independent expenditures.',
      ),
    cycle: z
      .number()
      .optional()
      .describe(
        'Two-year election cycle (e.g., 2024). Even years only. Omit in single mode to get every cycle the committee has filed.',
      ),
    committee_state: z
      .string()
      .optional()
      .describe('Two-letter state code of the committee. by_entity_type mode only.'),
    committee_type: z
      .string()
      .optional()
      .describe(
        'Committee type code — H (House), S (Senate), P (Presidential), O (Super PAC), N/Q (PAC), X/Y (party). by_entity_type mode only.',
      ),
    committee_designation: z
      .string()
      .optional()
      .describe(
        'Committee designation — A (authorized), B (lobbyist PAC), D (leadership PAC), J (joint fundraiser), P (principal campaign), U (unauthorized). by_entity_type mode only.',
      ),
    organization_type: z
      .string()
      .optional()
      .describe(
        'Sponsoring organization type — C (corporation), L (labor), M (membership), T (trade), V (cooperative), W (corporation without capital stock). by_entity_type mode only.',
      ),
    min_receipts: z
      .number()
      .optional()
      .describe('Minimum total receipts in dollars. by_entity_type mode only.'),
    max_receipts: z
      .number()
      .optional()
      .describe('Maximum total receipts in dollars. by_entity_type mode only.'),
    min_disbursements: z
      .number()
      .optional()
      .describe('Minimum total disbursements in dollars. by_entity_type mode only.'),
    max_disbursements: z
      .number()
      .optional()
      .describe('Maximum total disbursements in dollars. by_entity_type mode only.'),
    sort: z
      .enum([
        'cycle',
        '-cycle',
        'receipts',
        '-receipts',
        'disbursements',
        '-disbursements',
        'last_cash_on_hand_end_period',
        '-last_cash_on_hand_end_period',
      ])
      .optional()
      .describe(
        'Sort field. A "-" prefix sorts descending: "-receipts" ranks the biggest fundraisers first in by_entity_type mode, "-cycle" puts a committee\'s most recent cycle first in single mode.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Page number (1-indexed). Read pagination.pages in the response to see how many pages exist — a long-running committee can have more cycles than one page holds.',
      ),
    per_page: z.number().int().min(1).max(100).default(20).describe('Results per page.'),
  }),

  output: z.object({
    results: z
      .array(
        z
          .looseObject({})
          .describe(
            'Committee totals row for one committee and cycle; common keys include committee_id, committee_name, cycle, receipts, disbursements, last_cash_on_hand_end_period, last_debts_owed_by_committee, individual_contributions, and coverage_end_date.',
          ),
      )
      .describe(
        'Committee totals result set; one row per cycle in single mode, one row per committee in by_entity_type mode.',
      ),
    mode: z
      .enum(modes)
      .describe(
        'Query mode as the server resolved it. Rows mean different things by mode — single rows are cycles of one committee, by_entity_type rows are different committees — so read this rather than inferring from the fields present.',
      ),
    pagination: PaginationSchema,
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching totals rows before pagination.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no totals matched — echoes filters and suggests how to broaden.'),
  },

  async handler(input, ctx) {
    const fec = getOpenFecService();
    const mode = input.mode;

    if (input.committee_id) validateCommitteeId(input.committee_id);

    /* ---------------------------------------------------------------- */
    /*  Single committee                                                */
    /* ---------------------------------------------------------------- */
    if (mode === 'single') {
      const inapplicable = BY_ENTITY_TYPE_ONLY_INPUTS.filter(
        (key) => input[key] !== undefined && input[key] !== '',
      );
      if (inapplicable.length > 0) {
        throw ctx.fail(
          'inputs_not_applicable_to_mode',
          `Mode "single" cannot apply ${inapplicable.join(', ')} — /committee/{committee_id}/totals/ accepts only ${SINGLE_INPUTS}. Sending them would have returned the committee's unfiltered totals.`,
          {
            mode,
            inapplicable_inputs: inapplicable,
            supported_inputs: SINGLE_INPUTS.split(', '),
            ...ctx.recoveryFor('inputs_not_applicable_to_mode'),
          },
        );
      }

      if (!input.committee_id) {
        throw ctx.fail('committee_id_required_for_single_mode', undefined, {
          mode,
          ...ctx.recoveryFor('committee_id_required_for_single_mode'),
        });
      }

      const params: FecParams = { page: input.page, per_page: input.per_page };
      if (input.cycle !== undefined) params.cycle = input.cycle;
      if (input.sort) params.sort = input.sort;

      ctx.log.info('Fetching committee totals', {
        committee_id: input.committee_id,
        cycle: input.cycle,
      });
      const result = await fec.getCommitteeTotals(input.committee_id, params, ctx);

      /**
       * The endpoint answers 404 for every empty case — unknown committee_id,
       * a cycle the committee did not file, a committee that files no
       * financial report — and the service normalizes that to a zero-row page.
       */
      if (result.results.length === 0) {
        throw ctx.fail(
          'committee_totals_not_found',
          input.cycle === undefined
            ? `Committee ${input.committee_id} has no financial totals on file.`
            : `Committee ${input.committee_id} has no financial totals for cycle ${input.cycle}.`,
          {
            committee_id: input.committee_id,
            ...(input.cycle === undefined ? {} : { cycle: input.cycle }),
            ...ctx.recoveryFor('committee_totals_not_found'),
          },
        );
      }

      ctx.enrich.total(result.pagination.count);

      return {
        results: result.results,
        mode,
        pagination: result.pagination,
        search_criteria: buildSearchCriteria(input),
      };
    }

    /* ---------------------------------------------------------------- */
    /*  Grouped by entity type                                          */
    /* ---------------------------------------------------------------- */
    if (!input.entity_type) {
      throw ctx.fail('entity_type_required_for_group_mode', undefined, {
        mode,
        valid_entity_types: [...entityTypes],
        ...ctx.recoveryFor('entity_type_required_for_group_mode'),
      });
    }

    const params: FecParams = { page: input.page, per_page: input.per_page };
    if (input.committee_id) params.committee_id = input.committee_id;
    if (input.cycle !== undefined) params.cycle = input.cycle;
    if (input.committee_state) params.committee_state = input.committee_state;
    if (input.committee_type) params.committee_type = input.committee_type;
    if (input.committee_designation) params.committee_designation = input.committee_designation;
    if (input.organization_type) params.organization_type = input.organization_type;
    if (input.min_receipts !== undefined) params.min_receipts = input.min_receipts;
    if (input.max_receipts !== undefined) params.max_receipts = input.max_receipts;
    if (input.min_disbursements !== undefined) params.min_disbursements = input.min_disbursements;
    if (input.max_disbursements !== undefined) params.max_disbursements = input.max_disbursements;
    if (input.sort) params.sort = input.sort;

    ctx.log.info('Searching committee totals by entity type', {
      entity_type: input.entity_type,
      cycle: input.cycle,
    });
    const result = await fec.getCommitteeTotalsByEntityType(input.entity_type, params, ctx);

    ctx.enrich.total(result.pagination.count);
    if (result.results.length === 0) {
      ctx.enrich.notice(
        'No committee totals matched. Try a different cycle, lower the receipts or disbursements threshold, or widen the entity_type — house-senate holds both chambers, and party is separate from pac-party.',
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
        'Try a different cycle, lower the receipts or disbursements threshold, or widen the entity_type.',
        result.mode,
      );
    }

    const headerKeys = new Set(['committee_name', 'committee_id', 'cycle', 'receipts']);
    const lines: string[] = [`**Mode:** ${result.mode}`];

    for (const row of result.results) {
      const id = str(row, 'committee_id');
      const name = str(row, 'committee_name') || id || 'Unknown committee';
      const idSuffix = id && name !== id ? ` (${id})` : '';
      const cycle = row.cycle == null ? '' : ` · cycle ${String(row.cycle)}`;
      const header = `**${name}**${idSuffix}${cycle} — ${fmt$(row.receipts)} raised`;
      const fields = renderRecord(row, headerKeys);
      lines.push(fields ? `${header}\n${fields}` : header);
    }

    const { page, pages, count, per_page } = result.pagination;
    lines.push(`\n---\nPage ${page} of ${pages} · ${count} total · ${per_page} per page`);

    const criteria = formatSearchCriteria(result.search_criteria);
    if (criteria) lines.push(criteria);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
