/**
 * @fileoverview Fetch one FEC legal document in full by type and number — the
 * detail counterpart to openfec_search_legal, which replaces each result's
 * related-filing array with a count and cuts every commission vote down to a
 * date and a truncated action.
 * @module mcp-server/tools/definitions/get-legal-document.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import {
  buildSearchCriteria,
  formatSearchCriteria,
  renderRecord,
  SearchCriteriaSchema,
} from './utils/format-helpers.js';

const docTypes = ['advisory_opinions', 'murs', 'adrs', 'admin_fines', 'statutes'] as const;

/**
 * Record arrays rendered as their own blocks. `renderRecord` collapses an array
 * of objects onto one comma-joined line, which is unreadable for the three
 * arrays that are the whole point of this tool.
 */
const ARRAY_SECTIONS = ['documents', 'commission_votes', 'dispositions'] as const;

/**
 * Read the record's identifier, whichever field the document type carries it
 * in. Same precedence `openfec_search_legal` renders its results with, so the
 * same document is headed the same way in both tools.
 */
function documentNumber(doc: Record<string, unknown>): string {
  const value = doc.ao_no ?? doc.case_no ?? doc.no;
  return value == null ? '' : String(value);
}

/** Render one array section as a numbered list of indented field lines. */
function formatSection(key: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const entries = value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return `${index + 1}. ${String(entry)}`;
    const fields = renderRecord(entry as Record<string, unknown>);
    return fields ? `${index + 1}.\n${fields}` : `${index + 1}. (no detail)`;
  });
  return [`### ${key} (${value.length})`, entries.join('\n')];
}

export const getLegalDocument = tool('openfec_get_legal_document', {
  description:
    "Fetch one FEC legal document in full — advisory opinion, MUR, ADR, administrative fine, or statute — by its type and number. openfec_search_legal replaces each result's documents array with a count and category summary and cuts every commission vote down to a date and a 200-character action; this returns the record untouched. doc_type is the plural form of the document_type discriminator on a search result (advisory_opinion becomes advisory_opinions, mur becomes murs, adr becomes adrs, admin_fine becomes admin_fines, statute becomes statutes), and no is that result's no field — every document type carries it, and advisory opinions repeat it as ao_no.",
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'legal_document_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No legal document exists at the requested doc_type and document number',
      recovery:
        "Confirm doc_type is the plural form of the search result document_type and that no is copied from that result's no field; openfec_search_legal returns both.",
    },
  ],

  input: z.object({
    doc_type: z
      .enum(docTypes)
      .describe(
        'Legal document type, always plural. openfec_search_legal reports the singular form in each result document_type — advisory_opinion, mur, adr, admin_fine, statute — so add an "s" to get the value this field wants.',
      ),
    no: z
      .string()
      .min(1)
      .describe(
        'Document number, copied from the no field of the matching openfec_search_legal result. Advisory opinions are year-serial (e.g. "2024-01", also repeated as ao_no); murs, adrs, and admin_fines are digit strings (e.g. "8363"); statutes are U.S. Code section numbers (e.g. "30123").',
      ),
  }),

  output: z.object({
    document: z
      .looseObject({})
      .describe(
        'The complete legal document record. Carries the full documents array that openfec_search_legal replaces with a count and category summary, and the complete commission_votes entries it reduces to a vote date and a truncated action, alongside the dispositions and the scalar and date fields (name, type, url, penalty and determination amounts, case dates). Fields present vary by document type.',
      ),
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    attachedDocumentCount: z
      .number()
      .describe(
        'Number of related filings in the record documents array. Compare against the document_count openfec_search_legal reported for the same record.',
      ),
  },

  enrichmentTrailer: {
    attachedDocumentCount: { label: 'Attached documents' },
  },

  async handler(input, ctx) {
    const fec = getOpenFecService();

    ctx.log.info('Fetching legal document', { doc_type: input.doc_type, no: input.no });
    const document = await fec.getLegalDocument(input.doc_type, input.no, ctx);

    if (!document) {
      throw ctx.fail(
        'legal_document_not_found',
        `No ${input.doc_type} record numbered "${input.no}".`,
        {
          doc_type: input.doc_type,
          no: input.no,
          ...ctx.recoveryFor('legal_document_not_found'),
        },
      );
    }

    const documents = document.documents;
    ctx.enrich({ attachedDocumentCount: Array.isArray(documents) ? documents.length : 0 });

    return { document, search_criteria: buildSearchCriteria(input) };
  },

  format: (result) => {
    const doc = result.document;
    const number = documentNumber(doc);
    const name = typeof doc.name === 'string' ? doc.name : '';
    const heading = [number && `**${number}**`, name].filter(Boolean).join(' — ');

    const sectionKeys = new Set<string>(ARRAY_SECTIONS);
    const lines: string[] = [heading || '**Legal document**'];

    const scalars = renderRecord(doc, sectionKeys);
    if (scalars) lines.push(scalars);

    for (const key of ARRAY_SECTIONS) lines.push(...formatSection(key, doc[key]));

    const criteria = formatSearchCriteria(result.search_criteria);
    if (criteria) lines.push(criteria);

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
