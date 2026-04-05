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
import { fmt$ } from './utils/format-helpers.js';

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
    'Search FEC legal documents: advisory opinions, enforcement cases (MURs), ' +
    'alternative dispute resolutions, and administrative fines.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    query: z.string().optional().describe('Full-text search across legal documents.'),
    type: z
      .enum(['advisory_opinions', 'murs', 'adrs', 'admin_fines', 'statutes'])
      .optional()
      .describe('Document type filter. Omit to search all types.'),
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
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Legal documents with a document_type discriminator (advisory_opinion, mur, adr, admin_fine, statute).',
      ),
    total_count: z.number().describe('Total matching documents across all types.'),
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

    return { results: trimmed, total_count: data.totalCount };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [
        {
          type: 'text',
          text: 'No legal documents found. Try different search terms, remove the type filter to search all document types, or check the ao_number/case_number format.',
        },
      ];
    }

    /** Group results by document_type for readable output. */
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

    const sections: string[] = [];

    for (const [docType, docs] of grouped) {
      const label = typeLabels[docType] ?? docType;
      const lines = docs.map((doc) => {
        const id = doc.ao_no ?? doc.case_no ?? doc.no ?? '';
        const name = doc.name ?? '';
        const summary =
          doc.summary ??
          (Array.isArray(doc.highlights) && doc.highlights.length > 0
            ? (doc.highlights as string[]).join(' ... ')
            : '');
        const date = doc.issue_date ?? doc.open_date ?? doc.close_date ?? doc.date ?? '';
        const penalty = doc.penalty_amount != null ? ` | Penalty: ${fmt$(doc.penalty_amount)}` : '';

        const parts: string[] = [];
        if (id) parts.push(`**${id}**`);
        if (name) parts.push(String(name));
        if (date) parts.push(`(${date})`);
        if (penalty) parts.push(penalty);
        if (summary) parts.push(`\n  ${String(summary).slice(0, 300)}`);

        return parts.join(' ');
      });

      sections.push(`### ${label}\n${lines.join('\n\n')}`);
    }

    sections.push(`\n_${result.total_count} total matching document(s)_`);

    return [{ type: 'text', text: sections.join('\n\n') }];
  },
});
