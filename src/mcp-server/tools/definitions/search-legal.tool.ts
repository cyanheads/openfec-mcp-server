/**
 * @fileoverview Legal document search tool — search FEC advisory opinions,
 * enforcement cases (MURs), alternative dispute resolutions, administrative
 * fines, and statutes.
 * @module mcp-server/tools/definitions/search-legal.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import {
  buildSearchCriteria,
  formatEmptyResult,
  renderRecord,
  SearchCriteriaSchema,
} from './utils/format-helpers.js';

/** Human-readable labels for document type discriminators. */
const typeLabels: Record<string, string> = {
  advisory_opinion: 'Advisory Opinion',
  mur: 'Matter Under Review (MUR)',
  adr: 'Alternative Dispute Resolution',
  admin_fine: 'Administrative Fine',
  statute: 'Statute',
};

export const searchLegal = tool('openfec_search_legal', {
  description:
    'Search FEC legal documents: advisory opinions, enforcement cases (MURs), alternative dispute resolutions, and administrative fines.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    query: z.string().optional().describe('Full-text search across legal documents.'),
    type: z
      .enum(['advisory_opinions', 'murs', 'adrs', 'admin_fines', 'statutes'])
      .optional()
      .describe(
        'Document type filter. Omit to search all types. admin_fines is slow without a query or respondent filter.',
      ),
    ao_number: z.string().optional().describe('Specific advisory opinion number (e.g. "2024-01").'),
    case_number: z.string().optional().describe('Specific MUR or ADR case number.'),
    respondent: z.string().optional().describe('Respondent name (enforcement cases).'),
    regulatory_citation: z.string().optional().describe('CFR citation (e.g. "11 CFR 112.4").'),
    statutory_citation: z.string().optional().describe('U.S.C. citation (e.g. "52 U.S.C. 30106").'),
    min_penalty_amount: z
      .number()
      .optional()
      .describe('Minimum penalty amount (enforcement cases).'),
    max_penalty_amount: z.number().optional().describe('Maximum penalty amount.'),
    min_date: z.string().optional().describe('Earliest document date (YYYY-MM-DD).'),
    max_date: z.string().optional().describe('Latest document date (YYYY-MM-DD).'),
    from_hit: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Offset for pagination (0-indexed). Default 0.'),
    hits_returned: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe('Results per page. Default 20, max 200.'),
  }),

  output: z.object({
    results: z
      .array(
        z
          .looseObject({})
          .describe(
            'A legal document record with a document_type discriminator (advisory_opinion, mur, adr, admin_fine, statute).',
          ),
      )
      .describe(
        'Legal documents with a document_type discriminator (advisory_opinion, mur, adr, admin_fine, statute).',
      ),
    total_count: z.number().describe('Total matching documents across all types.'),
    search_criteria: SearchCriteriaSchema,
  }),

  async handler(input, ctx) {
    const hasFilter = input.query || input.type || input.ao_number || input.case_number;
    if (!hasFilter) {
      throw invalidParams(
        'Provide at least a search query, document type, or specific identifier (ao_number, case_number).',
      );
    }

    const fec = getOpenFecService();

    const params: FecParams = {
      from_hit: input.from_hit,
      hits_returned: input.hits_returned,
    };
    if (input.query) params.q = input.query;
    if (input.type) params.type = input.type;
    if (input.ao_number) params.ao_no = input.ao_number;
    if (input.case_number) params.case_no = input.case_number;
    if (input.respondent) params.case_respondents = input.respondent;
    if (input.regulatory_citation) params.ao_regulatory_citation = input.regulatory_citation;
    if (input.statutory_citation) params.ao_statutory_citation = input.statutory_citation;
    if (input.min_penalty_amount !== undefined)
      params.min_penalty_amount = input.min_penalty_amount;
    if (input.max_penalty_amount !== undefined)
      params.max_penalty_amount = input.max_penalty_amount;
    if (input.min_date) params.min_date = input.min_date;
    if (input.max_date) params.max_date = input.max_date;

    ctx.log.info('Searching legal documents', {
      query: input.query,
      type: input.type,
      resultCount: input.hits_returned,
    });

    const data = await fec.searchLegal(params, ctx);

    // Trim bulky fields to keep payloads manageable for LLM context windows.
    // Full document lists and verbose highlights can easily exceed 100KB per result.
    const trimmed = data.results.map((doc) => {
      const d = { ...doc };

      // Keep only the first 3 highlights and drop per-document highlight maps
      if (Array.isArray(d.highlights) && d.highlights.length > 3) {
        d.highlights = d.highlights.slice(0, 3);
      }
      delete d.document_highlights;

      // Summarize documents as a count + categories instead of full arrays
      if (Array.isArray(d.documents) && d.documents.length > 0) {
        const docs = d.documents as Array<Record<string, unknown>>;
        const categories = [...new Set(docs.map((dd) => dd.category).filter(Boolean))];
        d.document_count = docs.length;
        d.document_categories = categories;
        delete d.documents;
      }

      // Trim verbose commission_votes to just the vote dates
      if (Array.isArray(d.commission_votes) && d.commission_votes.length > 0) {
        const votes = d.commission_votes as Array<Record<string, unknown>>;
        d.commission_votes = votes.map((v) => ({
          vote_date: v.vote_date,
          action: typeof v.action === 'string' ? v.action.slice(0, 200) : v.action,
        }));
      }

      return d;
    });

    return {
      results: trimmed,
      total_count: data.totalCount,
      search_criteria: trimmed.length === 0 ? buildSearchCriteria(input) : undefined,
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return formatEmptyResult(
        result.search_criteria,
        'Try different search terms, remove the type filter to search all document types, or check the ao_number/case_number format.',
      );
    }

    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const doc of result.results) {
      const docType = String(doc.document_type ?? 'unknown');
      let group = grouped.get(docType);
      if (!group) {
        group = [];
        grouped.set(docType, group);
      }
      group.push(doc);
    }

    const headerKeys = new Set(['ao_no', 'case_no', 'no', 'name', 'document_type']);
    const sections: string[] = [];

    for (const [docType, docs] of grouped) {
      const label = typeLabels[docType] ?? docType;
      const items = docs.map((doc) => {
        const id = String(doc.ao_no ?? doc.case_no ?? doc.no ?? '');
        const name = doc.name ? String(doc.name) : '';
        const header = id
          ? name
            ? `**${id}** — ${name}`
            : `**${id}**`
          : name
            ? `**${name}**`
            : '**Document**';
        const fields = renderRecord(doc, headerKeys);
        return fields ? `${header}\n${fields}` : header;
      });

      sections.push(`### ${label}\n${items.join('\n\n')}`);
    }

    sections.push(`\n_${result.total_count} total matching document(s)_`);

    return [{ type: 'text', text: sections.join('\n\n') }];
  },
});
