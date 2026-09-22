/**
 * @fileoverview Calendar lookup tool — FEC calendar events, filing deadlines,
 * and election dates.
 * @module mcp-server/tools/definitions/lookup-calendar.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams, PageResult } from '@/services/openfec/types.js';
import {
  buildSearchCriteria,
  describeExhaustedPosition,
  exhaustedPage,
  fmtTotal,
  formatEmptyResult,
  formatExhaustedResult,
  formatSearchCriteria,
  PaginationSchema,
  renderRecord,
  SearchCriteriaSchema,
  toPagination,
} from './utils/format-helpers.js';
import { validateRange } from './utils/range-validators.js';

/**
 * Inputs each mode forwards upstream. A mode reads its own FEC dataset, so an
 * input outside its list cannot be applied — it is rejected rather than dropped,
 * since a dropped filter returns an unnarrowed result set that looks like an
 * answer to the narrowed question.
 */
const MODE_INPUTS = {
  events: ['mode', 'min_date', 'max_date', 'description', 'category'],
  filing_deadlines: ['mode', 'min_date', 'max_date', 'report_type', 'report_year'],
  election_dates: ['mode', 'min_date', 'max_date', 'state', 'office', 'election_year'],
} as const satisfies Record<string, readonly string[]>;

export const lookupCalendar = tool('openfec_lookup_calendar', {
  description:
    'Look up FEC calendar events, filing deadlines, and election dates. Use to find upcoming filing windows for a committee, locate when a federal election occurred, or scope FEC events by date range and category.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'inputs_not_applicable_to_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A filter belonging to a different calendar mode was supplied, which the chosen mode cannot apply',
      recovery:
        'Switch to the mode that owns the named inputs, or drop them: description and category belong to events, report_type and report_year to filing_deadlines, state, office and election_year to election_dates. min_date and max_date work in every mode.',
    },
  ],

  input: z.object({
    mode: z
      .enum(['events', 'filing_deadlines', 'election_dates'])
      .default('events')
      .describe(
        'events = FEC calendar events. filing_deadlines = report due dates. election_dates = upcoming/past elections.',
      ),
    state: z
      .string()
      .optional()
      .describe('Two-letter state code (e.g., AZ, CA). Primarily for election_dates mode.'),
    office: z
      .enum(['H', 'S', 'P'])
      .optional()
      .describe('Office sought (H=House, S=Senate, P=President). Election dates mode.'),
    report_type: z
      .string()
      .optional()
      .describe('Report type code (e.g. "Q1", "Q2"). Filing deadlines mode only.'),
    report_year: z.number().int().optional().describe('Report year. Filing deadlines mode.'),
    category: z
      .enum([
        '20',
        '21',
        '22',
        '23',
        '24',
        '25',
        '26',
        '27',
        '28',
        '29',
        '32',
        '33',
        '34',
        '36',
        '37',
        '38',
        '39',
        '40',
      ])
      .optional()
      .describe(
        'Calendar category ID. 20=Commission Meetings, 21=Reporting Deadlines, 22=Conferences and Outreach, 23=AOs and Rules, 24=Other, 25=Quarterly, 26=Monthly, 27=Pre and Post-Elections, 28=EC Periods, 29=IE Periods, 32=Open Meetings, 33=Conferences, 34=Roundtables, 36=Election Dates, 37=Federal Holidays, 38=FEA Periods, 39=Executive Sessions, 40=Public Hearings. Events mode only.',
      ),
    election_year: z.number().int().optional().describe('Election year. Election dates mode.'),
    description: z.string().optional().describe('Full-text event description search. Events mode.'),
    min_date: z.string().optional().describe('Earliest date (YYYY-MM-DD).'),
    max_date: z.string().optional().describe('Latest date (YYYY-MM-DD).'),
    page: z.number().int().min(1).default(1).describe('Page number (1-indexed). Default 1.'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Results per page. Default 20, max 100.'),
  }),

  output: z.object({
    results: z
      .array(
        z
          .looseObject({})
          .describe(
            'Event record (mode=events), filing deadline record (mode=filing_deadlines), or election date record (mode=election_dates).',
          ),
      )
      .describe(
        'Calendar result set; events, filing deadlines, or election dates depending on mode.',
      ),
    mode: z
      .enum(['events', 'filing_deadlines', 'election_dates'])
      .describe(
        'Query mode as the server resolved it. Each mode reads a different FEC dataset with its own row shape — calendar events, report due dates, or election dates — so read this rather than inferring the dataset from the fields present.',
      ),
    pagination: PaginationSchema,
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching calendar entries before pagination.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the response carries no calendar entries: how to broaden a search that matched nothing, or which requested position ran out when entries did match.',
      ),
  },

  async handler(input, ctx) {
    const fec = getOpenFecService();

    const params: FecParams = {
      page: input.page,
      per_page: input.per_page,
    };

    const applied: readonly string[] = MODE_INPUTS[input.mode];
    const criteria = buildSearchCriteria(input);
    const inapplicable = Object.keys(criteria).filter((key) => !applied.includes(key));
    if (inapplicable.length > 0) {
      throw ctx.fail(
        'inputs_not_applicable_to_mode',
        `Mode "${input.mode}" cannot apply ${inapplicable.join(', ')} — it accepts only ${applied.join(', ')}. Sending them would have returned an unnarrowed ${input.mode} result set.`,
        {
          mode: input.mode,
          inapplicable_inputs: inapplicable,
          supported_inputs: applied,
          ...ctx.recoveryFor('inputs_not_applicable_to_mode'),
        },
      );
    }

    validateRange({
      minField: 'min_date',
      minValue: input.min_date,
      maxField: 'max_date',
      maxValue: input.max_date,
      valueType: 'date',
    });

    /**
     * Shape one mode's response: the total, then either the exhausted-position
     * statement or the mode's own zero-match guidance — a page past the end of
     * a nonzero result set is a position to correct, not a search to broaden.
     */
    const respond = (data: PageResult, mode: keyof typeof MODE_INPUTS, zeroMatchNotice: string) => {
      ctx.enrich.total(data.pagination.count);
      const exhausted = exhaustedPage(data.pagination, data.results.length);
      if (exhausted) {
        ctx.enrich.notice(describeExhaustedPosition(exhausted));
      } else if (data.results.length === 0) {
        ctx.enrich.notice(zeroMatchNotice);
      }
      return {
        results: data.results,
        mode,
        pagination: toPagination(data.pagination),
        search_criteria: criteria,
      };
    };

    if (input.mode === 'filing_deadlines') {
      // /reporting-dates/ uses min_due_date / max_due_date
      if (input.min_date) params.min_due_date = input.min_date;
      if (input.max_date) params.max_due_date = input.max_date;
      if (input.report_type) params.report_type = input.report_type;
      if (input.report_year) params.report_year = input.report_year;

      ctx.log.info('Fetching filing deadlines', {
        report_type: input.report_type,
        report_year: input.report_year,
      });
      const data = await fec.getReportingDates(params, ctx);
      return respond(
        data,
        'filing_deadlines',
        'No filing deadlines matched. Try widening the date range or removing the report_type filter.',
      );
    }

    if (input.mode === 'election_dates') {
      // /election-dates/ uses min_election_date / max_election_date
      if (input.min_date) params.min_election_date = input.min_date;
      if (input.max_date) params.max_election_date = input.max_date;
      if (input.state) params.election_state = input.state;
      if (input.office) params.office_sought = input.office;
      if (input.election_year) params.election_year = input.election_year;

      ctx.log.info('Fetching election dates', {
        state: input.state,
        election_year: input.election_year,
      });
      const data = await fec.getElectionDates(params, ctx);
      return respond(
        data,
        'election_dates',
        'No election dates matched. Try widening the date range, removing the state or office filter, or checking a different election year.',
      );
    }

    /* Default: events mode — /calendar-dates/ uses min_start_date / max_start_date */
    if (input.min_date) params.min_start_date = input.min_date;
    if (input.max_date) params.max_start_date = input.max_date;
    if (input.description) params.description = input.description;
    if (input.category) params.calendar_category_id = input.category;

    ctx.log.info('Fetching calendar events', { description: input.description });
    const data = await fec.getCalendarDates(params, ctx);
    return respond(
      data,
      'events',
      'No calendar events matched. Try widening the date range, removing filters, or checking a different mode (events, filing_deadlines, election_dates).',
    );
  },

  format: (result) => {
    if (result.results.length === 0) {
      const exhausted = exhaustedPage(result.pagination, 0);
      if (exhausted) {
        return formatExhaustedResult(result.search_criteria, exhausted, result.mode);
      }
      return formatEmptyResult(
        result.search_criteria,
        'Try widening the date range, removing filters, or checking a different mode (events, filing_deadlines, election_dates).',
        result.mode,
      );
    }

    const lines = [
      `**Mode:** ${result.mode}`,
      ...result.results.map((r) => {
        const summary = String(r.summary ?? r.report_type ?? r.election_type_full ?? 'Event');
        const header = `**${summary}**`;
        const fields = renderRecord(r, new Set(['summary']));
        return fields ? `${header}\n${fields}` : header;
      }),
    ];

    const { page, pages, count, per_page, count_is_approximate } = result.pagination;
    lines.push(
      `\n_${fmtTotal(count, count_is_approximate, 'result(s)')} · page ${page}/${pages} · ${per_page} per page_`,
    );

    const criteriaLine = formatSearchCriteria(result.search_criteria);
    if (criteriaLine) lines.push(criteriaLine);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
