/**
 * @fileoverview Tool for searching FEC filings and reports. Covers all
 * disclosure documents: financial reports (F3/F3P/F3X), statements of
 * candidacy, organizational filings, and amendments.
 * @module mcp-server/tools/definitions/search-filings.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import {
  buildSearchCriteria,
  formatEmptyResult,
  PaginationSchema,
  renderRecord,
  SearchCriteriaSchema,
  str,
} from './utils/format-helpers.js';

export const searchFilings = tool('openfec_search_filings', {
  description:
    'Search FEC filings and reports by committee, candidate, form type, or date range. ' +
    'Covers financial reports (F3/F3P/F3X), statements of candidacy (F2), ' +
    'organizational filings (F1), 24-hour IE notices (F24), and amendments.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    committee_id: z.string().optional().describe('Filing committee ID.'),
    candidate_id: z.string().optional().describe('Associated candidate ID.'),
    filer_name: z.string().optional().describe('Full-text filer name search.'),
    form_type: z
      .string()
      .optional()
      .describe(
        'FEC form type. Common: F3 (House/Senate quarterly), F3P (Presidential), F3X (PAC/party), F24 (24-hour IE notice), F1 (statement of organization), F2 (statement of candidacy), F5 (IE by persons).',
      ),
    report_type: z
      .string()
      .optional()
      .describe(
        'Report type code. Common: Q1/Q2/Q3 (quarterly), YE (year-end), M3-M12 (monthly), 12G/12P/30G (pre/post election).',
      ),
    report_year: z.number().optional().describe('Filing year.'),
    cycle: z.number().optional().describe('Two-year election cycle (even year).'),
    is_amended: z.boolean().optional().describe('Filter to original or amended filings only.'),
    most_recent: z
      .boolean()
      .optional()
      .describe('Only the most recent version (filters out superseded amendments). Default true.'),
    min_receipt_date: z
      .string()
      .optional()
      .describe('Earliest date FEC received the filing (YYYY-MM-DD).'),
    max_receipt_date: z.string().optional().describe('Latest FEC receipt date (YYYY-MM-DD).'),
    page: z.number().optional().describe('Page number (1-indexed). Default 1.'),
    per_page: z.number().optional().describe('Results per page. Default 20, max 100.'),
  }),

  output: z.object({
    filings: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Filing records with form_type, committee, report_type, financial totals, pdf_url, etc.',
      ),
    pagination: PaginationSchema.describe('Page-based pagination metadata.'),
    search_criteria: SearchCriteriaSchema,
  }),

  async handler(input, ctx) {
    const fec = getOpenFecService();

    const params: FecParams = {
      committee_id: input.committee_id,
      candidate_id: input.candidate_id,
      q_filer: input.filer_name,
      form_type: input.form_type,
      report_type: input.report_type,
      report_year: input.report_year,
      cycle: input.cycle,
      is_amended: input.is_amended,
      most_recent: input.most_recent ?? true,
      min_receipt_date: input.min_receipt_date,
      max_receipt_date: input.max_receipt_date,
      page: input.page,
      per_page: input.per_page,
    };

    ctx.log.info('Searching filings', {
      committee_id: input.committee_id,
      form_type: input.form_type,
    });

    const result = await fec.searchFilings(params, ctx);

    return {
      filings: result.results,
      pagination: result.pagination,
      search_criteria: result.results.length === 0 ? buildSearchCriteria(input) : undefined,
    };
  },

  format(result) {
    if (result.filings.length === 0) {
      return formatEmptyResult(
        result.search_criteria,
        'Try removing the form_type or report_type filter, broadening the date range, or verifying the committee_id.',
      );
    }

    const headerKeys = new Set(['form_type', 'committee_name', 'committee_id']);

    const lines = result.filings.map((f) => {
      const formType = str(f, 'form_type');
      const committeeName = str(f, 'committee_name');
      const committeeId = str(f, 'committee_id');
      const header = `**${formType}** — ${committeeName} (${committeeId})`;
      const fields = renderRecord(f, headerKeys);
      return fields ? `${header}\n${fields}` : header;
    });

    const { page, pages, count } = result.pagination;
    lines.push(`\n---\nPage ${page} of ${pages} (${count} total)`);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
