/**
 * @fileoverview Legal document search tool — search FEC advisory opinions,
 * enforcement cases (MURs), alternative dispute resolutions, administrative
 * fines, and statutes.
 * @module mcp-server/tools/definitions/search-legal.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';
import {
  buildSearchCriteria,
  formatEmptyResult,
  renderRecord,
  SearchCriteriaSchema,
} from './utils/format-helpers.js';

/**
 * Date parameters `/legal/search/` accepts, keyed by document type and then by
 * date kind. There is no generic date bound and no kind shared by every type:
 * advisory opinions, cases (MURs and ADRs), and administrative fines each carry
 * their own prefix and their own set of dates. `statutes` has none at all.
 */
const DATE_PARAMS = {
  advisory_opinions: {
    issue_date: ['ao_min_issue_date', 'ao_max_issue_date'],
    request_date: ['ao_min_request_date', 'ao_max_request_date'],
    document_date: ['ao_min_document_date', 'ao_max_document_date'],
  },
  murs: {
    open_date: ['case_min_open_date', 'case_max_open_date'],
    close_date: ['case_min_close_date', 'case_max_close_date'],
    document_date: ['case_min_document_date', 'case_max_document_date'],
  },
  adrs: {
    open_date: ['case_min_open_date', 'case_max_open_date'],
    close_date: ['case_min_close_date', 'case_max_close_date'],
    document_date: ['case_min_document_date', 'case_max_document_date'],
  },
  admin_fines: {
    rtb_date: ['af_min_rtb_date', 'af_max_rtb_date'],
    fd_date: ['af_min_fd_date', 'af_max_fd_date'],
  },
  statutes: {},
} as const satisfies Record<string, Record<string, readonly [string, string]>>;

/** Every date kind any document type supports — the `date_kind` input's domain. */
const dateKinds = [
  'issue_date',
  'request_date',
  'open_date',
  'close_date',
  'document_date',
  'rtb_date',
  'fd_date',
] as const;

type LegalType = keyof typeof DATE_PARAMS;

/** Date kinds valid for one document type, in the order the schema lists them. */
const kindsFor = (type: LegalType): string[] => Object.keys(DATE_PARAMS[type]);

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

  errors: [
    {
      reason: 'missing_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Called without any scoping filter at all',
      recovery:
        'Provide at least one of: query, type, ao_number, case_number, respondent, regulatory_citation, statutory_citation, a penalty bound (min_penalty_amount / max_penalty_amount), or a date bound with its type and date_kind.',
    },
    {
      reason: 'date_filter_incomplete',
      code: JsonRpcErrorCode.ValidationError,
      when: 'min_date or max_date given without both a type and a date_kind, or a date_kind given with neither bound',
      recovery:
        'Send min_date and/or max_date together with type and date_kind — upstream date parameters are named per document type and per date kind, so both are needed to pick one.',
    },
    {
      reason: 'date_kind_not_valid_for_type',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested date_kind is not a date this document type records',
      recovery:
        'Pick a date_kind the type records: advisory_opinions has issue_date, request_date, document_date; murs and adrs have open_date, close_date, document_date; admin_fines has rtb_date and fd_date; statutes are not date-filterable.',
    },
  ],

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
      .describe(
        'Minimum penalty amount in dollars. Filters enforcement cases (murs, adrs) only — other document types are returned unfiltered by it.',
      ),
    max_penalty_amount: z
      .number()
      .optional()
      .describe(
        'Maximum penalty amount in dollars. Filters enforcement cases (murs, adrs) only — other document types are returned unfiltered by it.',
      ),
    date_kind: z
      .enum(dateKinds)
      .optional()
      .describe(
        'Which date min_date/max_date bound. Each document type records its own dates, so this must be one the chosen type has: type=advisory_opinions → issue_date (opinion issued), request_date (request received), document_date; type=murs or adrs → open_date (case opened), close_date (case closed), document_date; type=admin_fines → rtb_date (reason-to-believe finding), fd_date (final determination). type=statutes cannot be date-filtered. Required whenever min_date or max_date is given, together with type.',
      ),
    min_date: z
      .string()
      .optional()
      .describe(
        'Earliest date (YYYY-MM-DD) for the date_kind selected. Requires type and date_kind.',
      ),
    max_date: z
      .string()
      .optional()
      .describe(
        'Latest date (YYYY-MM-DD) for the date_kind selected. Requires type and date_kind.',
      ),
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
            'Legal document record. The document_type field discriminates among advisory_opinion, mur, adr, admin_fine, and statute. Common fields include ao_no/case_no/no (identifier), name, document_type, document_count, and document_categories summarizing the related filings.',
          ),
      )
      .describe(
        'Legal document result set spanning advisory opinions, MURs, ADRs, admin fines, and statutes.',
      ),
    total_count: z.number().describe('Total matching documents across all types.'),
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching legal documents across all types.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no legal documents matched — echoes filters and suggests how to broaden.',
      ),
  },

  async handler(input, ctx) {
    const hasDateBound = Boolean(input.min_date || input.max_date);
    const hasFilter =
      input.query ||
      input.type ||
      input.ao_number ||
      input.case_number ||
      input.respondent ||
      input.regulatory_citation ||
      input.statutory_citation ||
      input.min_penalty_amount !== undefined ||
      input.max_penalty_amount !== undefined ||
      hasDateBound;
    if (!hasFilter) {
      throw ctx.fail('missing_filter', undefined, { ...ctx.recoveryFor('missing_filter') });
    }

    /**
     * A date bound only becomes a real upstream parameter once the type and the
     * date kind together name one — so reject the incomplete forms rather than
     * guessing a kind and dropping the rest.
     */
    if (hasDateBound !== Boolean(input.date_kind) || (hasDateBound && !input.type)) {
      throw ctx.fail(
        'date_filter_incomplete',
        'A date filter needs min_date and/or max_date, plus type and date_kind.',
        {
          given: {
            type: input.type,
            date_kind: input.date_kind,
            min_date: input.min_date,
            max_date: input.max_date,
          },
          ...ctx.recoveryFor('date_filter_incomplete'),
        },
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
      params.case_min_penalty_amount = input.min_penalty_amount;
    if (input.max_penalty_amount !== undefined)
      params.case_max_penalty_amount = input.max_penalty_amount;

    if (input.type && input.date_kind) {
      const forType: Record<string, readonly [string, string]> = DATE_PARAMS[input.type];
      const bounds = forType[input.date_kind];
      if (!bounds) {
        const valid = kindsFor(input.type);
        throw ctx.fail(
          'date_kind_not_valid_for_type',
          valid.length > 0
            ? `Document type "${input.type}" has no ${input.date_kind}; it records ${valid.join(', ')}.`
            : `Document type "${input.type}" carries no date the API can filter on.`,
          {
            type: input.type,
            date_kind: input.date_kind,
            valid_date_kinds: valid,
            ...ctx.recoveryFor('date_kind_not_valid_for_type'),
          },
        );
      }
      const [minParam, maxParam] = bounds;
      if (input.min_date) params[minParam] = input.min_date;
      if (input.max_date) params[maxParam] = input.max_date;
    }

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

    ctx.enrich.total(data.totalCount);
    if (trimmed.length === 0) {
      ctx.enrich.notice(
        'No legal documents matched. Try different search terms, remove the type filter to search all document types, or check the ao_number/case_number format.',
      );
    }

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
