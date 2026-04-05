/**
 * @fileoverview Calendar lookup tool — FEC calendar events, filing deadlines,
 * and election dates.
 * @module mcp-server/tools/definitions/lookup-calendar.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import { renderRecord } from './utils/format-helpers.js';

export const lookupCalendar = tool('openfec_lookup_calendar', {
  description: 'Look up FEC calendar events, filing deadlines, and election dates.',
  annotations: { readOnlyHint: true, idempotentHint: true },

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
      .string()
      .optional()
      .describe(
        'Calendar category ID for events mode. Common values: "32" (reporting deadlines), "33" (election dates), "34" (quarterly filings). Events mode only.',
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
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Calendar records — events, filing deadlines, or election dates depending on mode.',
      ),
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
    const fec = getOpenFecService();

    const params: FecParams = {
      page: input.page,
      per_page: input.per_page,
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
      return { results: data.results, pagination: data.pagination };
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
      return { results: data.results, pagination: data.pagination };
    }

    /* Default: events mode — /calendar-dates/ uses min_start_date / max_start_date */
    if (input.min_date) params.min_start_date = input.min_date;
    if (input.max_date) params.max_start_date = input.max_date;
    if (input.description) params.description = input.description;
    if (input.category) params.calendar_category_id = input.category;

    ctx.log.info('Fetching calendar events', { description: input.description });
    const data = await fec.getCalendarDates(params, ctx);
    return { results: data.results, pagination: data.pagination };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [
        {
          type: 'text',
          text: 'No calendar entries found. Try widening the date range, removing filters, or checking a different mode (events, filing_deadlines, election_dates).',
        },
      ];
    }

    const lines = result.results.map((r) => {
      const summary = String(r.summary ?? r.report_type ?? r.election_type_full ?? 'Event');
      const header = `**${summary}**`;
      const fields = renderRecord(r, new Set(['summary']));
      return fields ? `${header}\n${fields}` : header;
    });

    const { page, pages, count } = result.pagination;
    lines.push(`\n_${count} result(s) — page ${page}/${pages}_`);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
