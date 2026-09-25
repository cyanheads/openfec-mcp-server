/**
 * @fileoverview Fetch one FEC legal document by type and number — the detail
 * counterpart to openfec_search_legal, which replaces each result's
 * related-filing and disposition arrays with a count and cuts every commission
 * vote down to a date and a truncated action. A record too large for the
 * response budget comes back as its scalars, the arrays that fit, and a list of
 * the arrays held back, each paged by entry offset.
 * @module mcp-server/tools/definitions/get-legal-document.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService, LEGAL_DOC_TYPES } from '@/services/openfec/openfec-service.js';
import {
  buildSearchCriteria,
  formatSearchCriteria,
  renderRecord,
  SearchCriteriaSchema,
} from './utils/format-helpers.js';
import {
  LEGAL_FIELD_RENDERERS,
  legalDocumentNumber,
  legalDocumentTitle,
} from './utils/legal-field-renderers.js';
import {
  enrichmentTrailerBytes,
  RESPONSE_BUDGET_BYTES,
  utf8Bytes,
} from './utils/trim-schedule-row.js';

type LegalRecord = Record<string, unknown>;

/**
 * Record arrays rendered as their own blocks, every field of every entry — the
 * three arrays that are the whole point of this tool, which a one-line field
 * rendering would compress.
 */
const ARRAY_SECTIONS = ['documents', 'commission_votes', 'dispositions'] as const;
const SECTION_KEYS: ReadonlySet<string> = new Set(ARRAY_SECTIONS);

/**
 * One flat output for the three shapes a response takes — the whole record, a
 * bounded record with its held-back arrays, or the scalars with a slice of one
 * array — each arm rendered on its own presence.
 */
const LegalDocumentOutputSchema = z.object({
  document: z
    .looseObject({})
    .describe(
      "The legal document record, fields as upstream sends them — the full documents array openfec_search_legal summarizes, the complete dispositions and commission_votes entries, and the scalar and date fields (name, type, url, penalty and determination amounts, case dates). Whole when it fits the 100,000-byte response budget; otherwise the scalar fields and the arrays that fit, with the rest in withheld. With array set, the record's non-array fields only — the entries are in slice. Fields present vary by document type.",
    ),
  withheld: z
    .array(
      z
        .object({
          array: z.string().describe('Name of the array field held back — pass it as array.'),
          count: z.number().describe('Entries in the array.'),
          bytes: z.number().describe('Size of the whole array as JSON, in UTF-8 bytes.'),
        })
        .describe('One array held back from document.'),
    )
    .optional()
    .describe(
      'Arrays held back from document because the whole record exceeds the 100,000-byte response budget, smallest first. Page through one by re-calling with array set to its name. Absent when document is the whole record.',
    ),
  slice: z
    .object({
      array: z.string().describe('The array these entries come from.'),
      offset: z.number().describe('Offset (0-indexed) of the first entry here.'),
      total: z.number().describe('Entries in the whole array.'),
      next_offset: z
        .number()
        .optional()
        .describe('Offset that continues the array. Absent once the last entry is here.'),
      entries: z
        .array(z.unknown().describe('One entry, exactly as the record carries it.'))
        .describe(
          'Entries from offset, as many as fit the response budget — at least one while offset is inside the array.',
        ),
    })
    .optional()
    .describe('A run of the requested array. Present only when array was given.'),
  search_criteria: SearchCriteriaSchema,
});

type LegalDocumentOutput = z.infer<typeof LegalDocumentOutputSchema>;

/** One array held back from a record that exceeds the response budget. */
type WithheldArray = NonNullable<LegalDocumentOutput['withheld']>[number];

/** A run of one array's entries, from `offset`, with where the next run starts. */
type ArraySlice = NonNullable<LegalDocumentOutput['slice']>;

/**
 * One array entry as a numbered item. Entries of the three section arrays show
 * every field, as their whole-record sections do; an entry of any other array
 * takes that array's legal field rendering when it has one.
 */
function renderEntry(array: string, entry: unknown, position: number): string {
  if (typeof entry !== 'object' || entry === null) return `${position}. ${String(entry)}`;
  const compact = SECTION_KEYS.has(array) ? null : LEGAL_FIELD_RENDERERS[array]?.([entry]);
  if (compact) return `${position}. ${compact}`;
  const fields = renderRecord(entry as LegalRecord, undefined, LEGAL_FIELD_RENDERERS);
  return fields ? `${position}.\n${fields}` : `${position}. (no detail)`;
}

/** Render one whole array section as a heading and its numbered entries. */
function formatSection(key: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const entries = value.map((entry, index) => renderEntry(key, entry, index + 1));
  return [`### ${key} (${value.length})`, entries.join('\n')];
}

/** The `content[]` text for a result, every arm rendered on its own presence. */
function formatText(result: LegalDocumentOutput): string {
  const doc = result.document;
  const number = legalDocumentNumber(doc);
  const heading = [number && `**${number}**`, legalDocumentTitle(doc)].filter(Boolean).join(' — ');
  const lines: string[] = [heading || '**Legal document**'];

  const scalars = renderRecord(doc, SECTION_KEYS, LEGAL_FIELD_RENDERERS);
  if (scalars) lines.push(scalars);
  for (const key of ARRAY_SECTIONS) lines.push(...formatSection(key, doc[key]));

  if (result.withheld) {
    lines.push(
      [
        '### Arrays held back by the response budget',
        ...result.withheld.map(
          (w) => `- ${w.array} — ${w.count} entries, ${w.bytes.toLocaleString('en-US')} bytes`,
        ),
        'Re-call with array set to one of these names, and offset 0, to page through its entries.',
      ].join('\n'),
    );
  }

  if (result.slice) {
    const { array, offset, total, next_offset, entries } = result.slice;
    const range =
      entries.length > 0
        ? `entries ${offset + 1}–${offset + entries.length} of ${total} (offset ${offset})`
        : `no entries at offset ${offset} of ${total}`;
    lines.push(`### ${array} — ${range}`);
    if (entries.length > 0) {
      lines.push(
        entries.map((entry, index) => renderEntry(array, entry, offset + index + 1)).join('\n'),
      );
    }
    lines.push(
      next_offset === undefined
        ? `_End of ${array}._`
        : `_Continue with array ${array} and offset ${next_offset}._`,
    );
  }

  const criteria = formatSearchCriteria(result.search_criteria);
  if (criteria) lines.push(criteria);
  return lines.join('\n\n');
}

/** What one slice entry costs: the larger of its bytes on each surface, with its separator. */
const entryCharge = (array: string, entry: unknown, position: number): number =>
  Math.max(
    utf8Bytes(JSON.stringify(entry)) + 1,
    utf8Bytes(renderEntry(array, entry, position)) + 1,
  );

/**
 * What inlining one array in `document` costs: the larger of its bytes on each
 * surface — its JSON member, or its section or field line — with its separator.
 */
function arrayCharge(key: string, value: unknown[]): number {
  const text = SECTION_KEYS.has(key)
    ? formatSection(key, value).join('\n\n')
    : renderRecord({ [key]: value }, undefined, LEGAL_FIELD_RENDERERS);
  return Math.max(
    utf8Bytes(`${JSON.stringify(key)}:${JSON.stringify(value)}`) + 1,
    utf8Bytes(text) + 2,
  );
}

/**
 * Bytes a response occupies before any array content: the larger surface for
 * the envelope given, with the enrichment it will carry.
 */
function envelopeBytes(output: LegalDocumentOutput, attached: number, notice: string): number {
  return Math.max(
    utf8Bytes(JSON.stringify({ ...output, attachedDocumentCount: attached, notice })),
    utf8Bytes(formatText(output)) +
      enrichmentTrailerBytes([`**Attached documents:** ${attached}`, `> ${notice}`]),
  );
}

const withheldNotice = (count: number): string =>
  `This record exceeds the 100,000-byte response budget, so ${count} array(s) are held back and listed in withheld. Re-call with array set to one of them to page through its entries by offset.`;

const sliceNotice = (array: string, total: number, next: number): string =>
  `${array} continues past this response: ${total} entries in all. Re-call with array ${array} and offset ${next} to continue.`;

export const getLegalDocument = tool('openfec_get_legal_document', {
  description:
    "Fetch one FEC legal document — advisory opinion, MUR, ADR, administrative fine, or statute — by its type and number. openfec_search_legal replaces each result's documents and dispositions arrays with a count and category summary and cuts every commission vote down to a date and a 200-character action; this returns the record as upstream sends it, whole when it fits the 100,000-byte response budget. A larger record returns its scalar fields and the arrays that fit, with the rest listed in withheld; page through one by re-calling with array and offset. doc_type is the plural form of the document_type discriminator on a search result (advisory_opinion becomes advisory_opinions, mur becomes murs, adr becomes adrs, admin_fine becomes admin_fines, statute becomes statutes), and no is that result's no field — every document type carries it, and advisory opinions repeat it as ao_no.",
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'legal_document_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No legal document exists at the requested doc_type and document number',
      recovery:
        "Confirm doc_type is the plural form of the search result document_type and that no is copied from that result's no field; openfec_search_legal returns both.",
    },
    {
      reason: 'array_not_in_record',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The array input names a field this record does not carry as an array',
      recovery:
        'Set array to one of the array fields this record carries — the error lists them in arrays, and withheld names the ones a bounded response held back — or omit array to fetch the record.',
    },
    {
      reason: 'offset_without_array',
      code: JsonRpcErrorCode.ValidationError,
      when: 'offset was given without array, so there is no array for it to index',
      recovery:
        'Send offset together with array, naming the array to page through, or omit offset to fetch the record.',
    },
  ],

  input: z.object({
    doc_type: z
      .enum(LEGAL_DOC_TYPES)
      .describe(
        'Legal document type, always plural. openfec_search_legal reports the singular form in each result document_type — advisory_opinion, mur, adr, admin_fine, statute — so add an "s" to get the value this field wants.',
      ),
    no: z
      .string()
      .min(1)
      .describe(
        'Document number, copied from the no field of the matching openfec_search_legal result. Advisory opinions are year-serial (e.g. "2024-01", also repeated as ao_no); murs, adrs, and admin_fines are digit strings (e.g. "8363"); statutes are U.S. Code section numbers (e.g. "30123").',
      ),
    array: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Name of one top-level array field of the record to page through by entry — usually one listed in withheld when the record was too large to return whole (e.g. "dispositions", "documents"). Returns that array\'s entries from offset while they fit the response budget, in slice, with the record\'s scalar fields. Omit to fetch the record itself.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Entry offset (0-indexed) into array. Requires array; defaults to 0 when array is given. Pass the next_offset a previous slice returned to continue.',
      ),
  }),

  output: LegalDocumentOutputSchema,

  enrichment: {
    attachedDocumentCount: z
      .number()
      .describe(
        'Number of related filings in the record documents array — the full count, whether this response carries them in document, in a slice, or holds them back. Compare against the document_count openfec_search_legal reported for the same record.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'How to continue: which arrays were held back and how to page them, where a slice continues, or that an offset ran past the end of its array.',
      ),
  },

  enrichmentTrailer: {
    attachedDocumentCount: { label: 'Attached documents' },
  },

  async handler(input, ctx) {
    if (input.offset !== undefined && input.array === undefined) {
      throw ctx.fail('offset_without_array', `offset ${input.offset} was given without array.`, {
        offset: input.offset,
        ...ctx.recoveryFor('offset_without_array'),
      });
    }

    const fec = getOpenFecService();

    ctx.log.info('Fetching legal document', { doc_type: input.doc_type, no: input.no });
    const record = await fec.getLegalDocument(input.doc_type, input.no, ctx);

    if (!record) {
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

    const attached = Array.isArray(record.documents) ? record.documents.length : 0;
    ctx.enrich({ attachedDocumentCount: attached });

    const search_criteria = buildSearchCriteria(input);
    const arrays = Object.entries(record).filter((entry): entry is [string, unknown[]] =>
      Array.isArray(entry[1]),
    );
    const scalars = Object.fromEntries(
      Object.entries(record).filter(([, value]) => !Array.isArray(value)),
    );

    if (input.array !== undefined) {
      const { array } = input;
      const values = record[array];
      if (!Array.isArray(values)) {
        throw ctx.fail(
          'array_not_in_record',
          `The ${input.doc_type} record numbered "${input.no}" has no array field named "${array}".`,
          { array, arrays: arrays.map(([key]) => key), ...ctx.recoveryFor('array_not_in_record') },
        );
      }
      const offset = input.offset ?? 0;
      const total = values.length;
      const slice: ArraySlice = { array, offset, total, entries: [] };

      if (offset >= total) {
        ctx.enrich.notice(
          total > 0
            ? `offset ${offset} is past the end of ${array}, which holds ${total} entries (offsets 0–${total - 1}). Request a lower offset.`
            : `${array} holds no entries on this record.`,
        );
        return { document: scalars, slice, search_criteria };
      }

      /** The envelope renders an empty slice; a filled one's heading names its range and opens an entry block. */
      const filledHeading =
        utf8Bytes(`entries ${total}–${total} of ${total} (offset ${total})`) + 2;
      let remaining =
        RESPONSE_BUDGET_BYTES -
        filledHeading -
        envelopeBytes(
          { document: scalars, slice: { ...slice, next_offset: total }, search_criteria },
          attached,
          sliceNotice(array, total, total),
        );
      let end = offset;
      while (end < total) {
        const cost = entryCharge(array, values[end], end + 1);
        if (cost > remaining && end > offset) break;
        remaining -= cost;
        end++;
      }
      slice.entries = values.slice(offset, end);
      if (end < total) {
        slice.next_offset = end;
        ctx.enrich.notice(sliceNotice(array, total, end));
      }
      return { document: scalars, slice, search_criteria };
    }

    /**
     * Inline arrays smallest-first while they fit the budget left after the
     * envelope, reserved at its largest: the scalars, every array listed as
     * held back, and the notice naming them all.
     */
    const costed = arrays
      .map(([key, value]) => ({ key, value, cost: arrayCharge(key, value) }))
      .sort((a, b) => a.cost - b.cost);
    const describe = ({ key, value }: { key: string; value: unknown[] }): WithheldArray => ({
      array: key,
      count: value.length,
      bytes: utf8Bytes(JSON.stringify(value)),
    });
    let remaining =
      RESPONSE_BUDGET_BYTES -
      envelopeBytes(
        { document: scalars, withheld: costed.map(describe), search_criteria },
        attached,
        withheldNotice(costed.length),
      );
    let fits = true;
    const heldBack = costed.filter(({ cost }) => {
      fits &&= cost <= remaining;
      if (fits) remaining -= cost;
      return !fits;
    });
    if (heldBack.length === 0) return { document: record, search_criteria };

    const heldKeys = new Set(heldBack.map(({ key }) => key));
    const document = Object.fromEntries(
      Object.entries(record).filter(([key]) => !heldKeys.has(key)),
    );
    ctx.enrich.notice(withheldNotice(heldBack.length));
    return { document, withheld: heldBack.map(describe), search_criteria };
  },

  format: (result) => [{ type: 'text', text: formatText(result) }],
});
