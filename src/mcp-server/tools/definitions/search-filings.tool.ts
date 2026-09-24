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
  APPROXIMATE_COUNT_NOTICE,
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
  str,
  toPagination,
} from './utils/format-helpers.js';
import { validateCandidateId, validateCommitteeId } from './utils/id-validators.js';
import { validateRange } from './utils/range-validators.js';
import {
  disclosePageBound,
  dropEmptyFields,
  PageBoundEnrichment,
  PageBoundTrailer,
  PER_PAGE_CAPS,
} from './utils/trim-schedule-row.js';

export const searchFilings = tool('openfec_search_filings', {
  description:
    'Search FEC filings and reports by committee, candidate, form type, or date range. Covers financial reports (F3/F3P/F3X), statements of candidacy (F2), organizational filings (F1), 24-hour IE notices (F24), and amendments.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    committee_id: z
      .string()
      .optional()
      .describe(
        'Filing committee ID (e.g., C00358796). Get IDs from openfec_search_committees results.',
      ),
    candidate_id: z
      .string()
      .optional()
      .describe(
        'Associated candidate ID (e.g., P00003392). Get IDs from openfec_search_candidates results.',
      ),
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
      .default(true)
      .describe('Only the most recent version (filters out superseded amendments).'),
    min_receipt_date: z
      .string()
      .optional()
      .describe('Earliest date FEC received the filing (YYYY-MM-DD).'),
    max_receipt_date: z.string().optional().describe('Latest FEC receipt date (YYYY-MM-DD).'),
    page: z.number().int().min(1).default(1).describe('Page number (1-indexed).'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        `Results per page. At most ${PER_PAGE_CAPS.filings} are requested upstream, keeping the response under a 100,000-byte budget. A page bounded below your request reports truncated and cap, and pagination.per_page echoes the size applied — page numbers count at that size, so continue with the next page number.`,
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .looseObject({})
          .describe(
            'Filing record; common keys include form_type, committee_id, committee_name, report_type, financial totals, and pdf_url.',
          ),
      )
      .describe('Filing result set; one record per match.'),
    pagination: PaginationSchema,
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching filings before pagination.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the response needs context: how to broaden a search that matched nothing, which requested position ran out when filings did match, that the total is an estimate, or that the page was bounded below the per_page requested and how to continue.',
      ),
    ...PageBoundEnrichment,
  },
  enrichmentTrailer: PageBoundTrailer,

  async handler(input, ctx) {
    if (input.committee_id) validateCommitteeId(input.committee_id);
    if (input.candidate_id) validateCandidateId(input.candidate_id);

    validateRange({
      minField: 'min_receipt_date',
      minValue: input.min_receipt_date,
      maxField: 'max_receipt_date',
      maxValue: input.max_receipt_date,
      valueType: 'date',
    });

    const fec = getOpenFecService();

    /** Upstream paginates at the size sent, so page numbers count at the capped size. */
    const perPage = Math.min(input.per_page, PER_PAGE_CAPS.filings);
    const params: FecParams = {
      committee_id: input.committee_id,
      candidate_id: input.candidate_id,
      q_filer: input.filer_name,
      form_type: input.form_type,
      report_type: input.report_type,
      report_year: input.report_year,
      cycle: input.cycle,
      is_amended: input.is_amended,
      most_recent: input.most_recent,
      min_receipt_date: input.min_receipt_date,
      max_receipt_date: input.max_receipt_date,
      page: input.page,
      per_page: perPage,
    };

    ctx.log.info('Searching filings', {
      committee_id: input.committee_id,
      form_type: input.form_type,
    });

    const result = await fec.searchFilings(params, ctx);

    ctx.enrich.total(result.pagination.count);
    const exhausted = exhaustedPage(result.pagination, result.results.length);
    if (exhausted) {
      ctx.enrich.notice(describeExhaustedPosition(exhausted));
    } else if (result.results.length === 0) {
      ctx.enrich.notice(
        'No filings matched. Try removing the form_type or report_type filter, broadening the date range, or looking up the committee by name with openfec_search_committees.',
      );
    } else if (result.pagination.is_count_exact === false) {
      ctx.enrich.notice(APPROXIMATE_COUNT_NOTICE);
    }
    disclosePageBound(ctx, {
      requested: input.per_page,
      applied: perPage,
      shown: result.results.length,
      continuation: { kind: 'page', pagination: result.pagination },
      approximate: result.pagination.is_count_exact === false,
    });

    return {
      results: result.results.map(dropEmptyFields),
      pagination: toPagination(result.pagination),
      search_criteria: buildSearchCriteria(input),
    };
  },

  format(result) {
    if (result.results.length === 0) {
      const exhausted = exhaustedPage(result.pagination, 0);
      if (exhausted) return formatExhaustedResult(result.search_criteria, exhausted);
      return formatEmptyResult(
        result.search_criteria,
        'Try removing the form_type or report_type filter, broadening the date range, or looking up the committee by name with openfec_search_committees.',
      );
    }

    const headerKeys = new Set(['form_type', 'committee_name', 'committee_id']);

    const lines = result.results.map((f) => {
      const formType = str(f, 'form_type');
      const committeeName = str(f, 'committee_name');
      const committeeId = str(f, 'committee_id');
      const header = `**${formType}** — ${committeeName} (${committeeId})`;
      const fields = renderRecord(f, headerKeys);
      return fields ? `${header}\n${fields}` : header;
    });

    const { page, pages, count, per_page, count_is_approximate } = result.pagination;
    lines.push(
      `\n---\nPage ${page} of ${pages} · ${fmtTotal(count, count_is_approximate)} · ${per_page} per page`,
    );

    const criteria = formatSearchCriteria(result.search_criteria);
    if (criteria) lines.push(criteria);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
