/**
 * @fileoverview Legal document search tool — search FEC advisory opinions,
 * enforcement cases (MURs), alternative dispute resolutions, administrative
 * fines, and statutes.
 * @module mcp-server/tools/definitions/search-legal.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  getOpenFecService,
  LEGAL_DOC_TYPES,
  LEGAL_DOCUMENT_TYPE,
} from '@/services/openfec/openfec-service.js';
import type { FecParams, LegalDocType } from '@/services/openfec/types.js';
import {
  buildSearchCriteria,
  describeExhaustedPosition,
  formatEmptyResult,
  formatExhaustedResult,
  formatSearchCriteria,
  renderRecord,
  SearchCriteriaSchema,
} from './utils/format-helpers.js';
import {
  LEGAL_FIELD_RENDERERS,
  legalDocumentNumber,
  legalDocumentTitle,
} from './utils/legal-field-renderers.js';
import { validateRange } from './utils/range-validators.js';
import {
  enrichmentTrailerBytes,
  RESPONSE_BUDGET_BYTES,
  utf8Bytes,
} from './utils/trim-schedule-row.js';

/**
 * `/legal/search/` runs on OpenSearch, whose result window serves a request
 * only while `from_hit + hits_returned <= 10000`, inclusive. Past it upstream
 * answers 400 with a message naming OpenSearch rather than the window, so the
 * sum is checked here instead.
 */
const RESULT_WINDOW = 10_000;

/** The highest `from_hit` the window serves for a given page size. */
const maxFromHit = (hitsReturned: number) => RESULT_WINDOW - hitsReturned;

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

/** Date kinds valid for one document type, in the order the schema lists them. */
const kindsFor = (type: LegalDocType): string[] => Object.keys(DATE_PARAMS[type]);

/** Inputs that filter only some document types, each sent under a type-specific upstream name. */
type TypeSpecificFilter =
  | 'regulatory_citation'
  | 'statutory_citation'
  | 'min_penalty_amount'
  | 'max_penalty_amount'
  | 'respondent'
  | 'ao_number'
  | 'case_number';

/**
 * The upstream parameter each type-specific filter is sent as, for every
 * document type that honours it. A type absent from a filter's row either
 * ignores that parameter — returning its documents unfiltered while the
 * filter still looks applied — or matches none of its documents on it
 * (a `case_*` citation or respondent against administrative fines), so the
 * filter is rejected for that type rather than sent.
 */
const FILTER_PARAMS: Record<TypeSpecificFilter, Partial<Record<LegalDocType, string>>> = {
  regulatory_citation: {
    advisory_opinions: 'ao_regulatory_citation',
    murs: 'case_regulatory_citation',
    adrs: 'case_regulatory_citation',
  },
  statutory_citation: {
    advisory_opinions: 'ao_statutory_citation',
    murs: 'case_statutory_citation',
    adrs: 'case_statutory_citation',
  },
  min_penalty_amount: {
    murs: 'case_min_penalty_amount',
    adrs: 'case_min_penalty_amount',
    admin_fines: 'case_min_penalty_amount',
  },
  max_penalty_amount: {
    murs: 'case_max_penalty_amount',
    adrs: 'case_max_penalty_amount',
    admin_fines: 'case_max_penalty_amount',
  },
  respondent: { murs: 'case_respondents', adrs: 'case_respondents' },
  ao_number: { advisory_opinions: 'ao_no' },
  case_number: { murs: 'case_no', adrs: 'case_no', admin_fines: 'case_no' },
};

const TYPE_SPECIFIC_FILTERS = Object.keys(FILTER_PARAMS) as TypeSpecificFilter[];

/**
 * Filters MUR and ADR search drops whenever a citation is sent with them:
 * upstream answers with the citation clause in place of its case number,
 * respondent, penalty, and open- and close-date clauses, keeping only the
 * query and a document_date bound. Measured live, `case_regulatory_citation=
 * 11 CFR 110.1` returns the same 95 MURs alone and with any one of them.
 */
const DROPPED_WITH_CASE_CITATION: ReadonlySet<TypeSpecificFilter> = new Set([
  'case_number',
  'respondent',
  'min_penalty_amount',
  'max_penalty_amount',
]);
const DATE_KINDS_DROPPED_WITH_CASE_CITATION: ReadonlySet<string> = new Set([
  'open_date',
  'close_date',
]);
const CASE_TYPES: ReadonlySet<LegalDocType> = new Set(['murs', 'adrs']);

/**
 * The citation prefixes `/legal/search/` parses, through the section number:
 * matched from the start of the value with the rest ignored, as upstream does,
 * and confirmed live against the unfiltered total. Upstream drops a value that
 * does not match and answers with the type unfiltered, so one is rejected here
 * instead. Upstream writes `\s+§*\s*`; `\s+(?:§+\s*)?` accepts the same strings
 * without two adjacent whitespace quantifiers, which backtrack quadratically on
 * a long run of spaces.
 */
const CITATION_FORMS = {
  statutory_citation: /^\d+\s+U\.?S\.?C\.?\s+(?:§+\s*)?\d+/i,
  regulatory_citation: /^\d+\s+C\.?F\.?R\.?\s+(?:§+\s*)?\d+\.\d+/i,
} as const;

type CitationField = keyof typeof CITATION_FORMS;

/** Parenthesized subsections — `(g)`, `(b)(3)` — which never begin another citation. */
const SUBSECTIONS = /\([^()]*\)/g;

/**
 * What follows a citation's section number when it holds a second citation:
 * another U.S.C. or CFR code anywhere, or another section number introduced by
 * a list separator, a range dash, a joining word, or bare whitespace. Upstream
 * applies only the first citation in a value and ignores the rest. A letter
 * suffix (`441b`, `441a-1`), a dotted continuation (`110.1.2`), and trailing
 * words carry no second section and stay accepted.
 */
const SECOND_CITATION =
  /\bU\.?S\.?C\b|\bC\.?F\.?R\b|(?:[,;&/]|\b(?:and|or|through|to)\b|^\s*[-–—]|^\s)\s*(?:§+\s*)?\d/i;

/**
 * Why a citation would not filter as sent — upstream cannot parse it, or would
 * apply only the first of several — or null when it would.
 */
function citationProblem(field: CitationField, value: string): string | null {
  const prefix = CITATION_FORMS[field].exec(value);
  if (!prefix) {
    return `${field} "${value}" is not a citation the search index parses, so it would be ignored and the results left unfiltered`;
  }
  const rest = value.slice(prefix[0].length).replace(SUBSECTIONS, '');
  return SECOND_CITATION.test(rest)
    ? `${field} "${value}" holds more than one citation, and the search index applies only the first`
    : null;
}

/** Document types a type-specific filter applies to, in `LEGAL_DOC_TYPES` order. */
const typesFor = (filter: TypeSpecificFilter): LegalDocType[] =>
  LEGAL_DOC_TYPES.filter((type) => FILTER_PARAMS[filter][type] !== undefined);

/**
 * OpenFEC wraps each matched term in a highlight with `<em>` and `</em>`, and
 * that pair is the only markup it adds. The surrounding prose carries literal
 * `<`, `>`, and `&` of its own (e-mail addresses in angle brackets, `AT&T`),
 * so exactly those two tokens are removed and nothing is decoded or escaped.
 */
const stripEmphasis = (text: string): string => text.replaceAll('<em>', '').replaceAll('</em>', '');

/** Human-readable labels for document type discriminators. */
const typeLabels: Record<string, string> = {
  advisory_opinion: 'Advisory Opinion',
  mur: 'Matter Under Review (MUR)',
  adr: 'Alternative Dispute Resolution',
  admin_fine: 'Administrative Fine',
  statute: 'Statute',
};

type LegalRecord = Record<string, unknown>;

/** The plural `type` value for a singular `document_type` discriminator. */
const typeOfDocument = (docType: string): LegalDocType =>
  LEGAL_DOC_TYPES.find((type) => LEGAL_DOCUMENT_TYPE[type] === docType) as LegalDocType;

const RETRIEVAL_HINT =
  "Every result above is trimmed: the documents array is replaced by document_count and document_categories, the dispositions array by disposition_count and disposition_categories, per-document highlights are dropped and the highlights list is capped at three, and each commission_vote is cut to its vote_date and a 200-character action. Retrieve the untrimmed documents, dispositions, and commission_votes with openfec_get_legal_document, passing doc_type as the result document_type made plural (advisory_opinion to advisory_opinions, mur to murs) and no as the result's no field.";

/** `murs from_hit 34, adrs from_hit 12` — the continuation of each bounded type. */
const describeNextFromHit = (next: Readonly<Record<string, number>>): string =>
  Object.entries(next)
    .map(([type, fromHit]) => `${type} from_hit ${fromHit}`)
    .join(', ');

/** The notice a bounded page carries: what was held back and how each type continues. */
const boundNotice = (shown: number, next: Readonly<Record<string, number>>): string =>
  `Response bounded to ${shown} result(s): the rest of this page would exceed the 100,000-byte response budget. Continue a type by re-calling with the same filters, type set to it, and from_hit set to its nextFromHit value (${describeNextFromHit(next)}). Nothing is skipped.`;

const HEADER_KEYS = new Set(['ao_no', 'case_no', 'no', 'name', 'document_type']);
/** An archived MUR is headed by its mur_name, so that line is not repeated below the header. */
const ARCHIVED_HEADER_KEYS = new Set([...HEADER_KEYS, 'mur_name']);

/** One result's `content[]` rendering: its header line, then its field lines. */
function renderResult(doc: LegalRecord): string {
  const id = legalDocumentNumber(doc);
  const name = legalDocumentTitle(doc);
  const header = id
    ? name
      ? `**${id}** — ${name}`
      : `**${id}**`
    : name
      ? `**${name}**`
      : '**Document**';
  const fields = renderRecord(
    doc,
    doc.name ? HEADER_KEYS : ARCHIVED_HEADER_KEYS,
    LEGAL_FIELD_RENDERERS,
  );
  return fields ? `${header}\n${fields}` : header;
}

/** Results grouped by `document_type`, in the order each type first appears. */
function groupByType<T>(
  docs: readonly LegalRecord[],
  map: (doc: LegalRecord) => T,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const doc of docs) {
    const docType = String(doc.document_type ?? 'unknown');
    let group = grouped.get(docType);
    if (!group) {
      group = [];
      grouped.set(docType, group);
    }
    group.push(map(doc));
  }
  return grouped;
}

/** Rendered results under their type headings, then the total and the criteria echo. */
function assembleText(
  groups: ReadonlyMap<string, readonly string[]>,
  totalCount: number,
  criteria: Record<string, unknown>,
): string {
  const sections: string[] = [];
  for (const [docType, items] of groups) {
    sections.push(`### ${typeLabels[docType] ?? docType}\n${items.join('\n\n')}`);
  }
  sections.push(`\n_${totalCount} total matching document(s)_`);
  const echo = formatSearchCriteria(criteria);
  if (echo) sections.push(echo);
  return sections.join('\n\n');
}

/**
 * What one result costs against the budget: the larger of its bytes on each
 * surface, with the separator that joins it to its neighbours.
 */
const resultCharge = (doc: LegalRecord): number =>
  Math.max(utf8Bytes(JSON.stringify(doc)) + 1, utf8Bytes(renderResult(doc)) + 2);

/**
 * Admit whole results within `available` bytes, one per document type per
 * round so every type that matched is represented. A type whose next result
 * does not fit is closed and the others continue, so each type's admitted
 * results are a prefix of its own list and `from_hit` plus that count resumes
 * it exactly. The first result is admitted whatever its size, so a walk always
 * advances. Returns the admitted results in their original order and, for each
 * type with results held back, how many of its results were admitted. Each
 * result is measured at most once.
 */
function admitRoundRobin(
  results: readonly LegalRecord[],
  available: number,
): { admitted: LegalRecord[]; heldBack: Map<string, number> } {
  const groups = groupByType(results, (doc) => doc);
  const perType = new Map<string, number>([...groups.keys()].map((type) => [type, 0]));
  let open = [...groups.keys()];
  let remaining = available;
  let first = true;
  while (open.length > 0) {
    open = open.filter((type) => {
      const group = groups.get(type) as LegalRecord[];
      const count = perType.get(type) as number;
      if (count === group.length) return false;
      const charge = resultCharge(group[count] as LegalRecord);
      if (charge > remaining && !first) return false;
      first = false;
      remaining -= charge;
      perType.set(type, count + 1);
      return true;
    });
  }
  const taken = new Map<string, number>();
  const admitted = results.filter((doc) => {
    const docType = String(doc.document_type ?? 'unknown');
    const index = taken.get(docType) ?? 0;
    taken.set(docType, index + 1);
    return index < (perType.get(docType) as number);
  });
  const heldBack = new Map(
    [...perType].filter(([type, count]) => count < (groups.get(type) as LegalRecord[]).length),
  );
  return { admitted, heldBack };
}

export const searchLegal = tool('openfec_search_legal', {
  description:
    'Search FEC legal documents: advisory opinions, enforcement cases (MURs), alternative dispute resolutions, administrative fines, and statutes. The citation, penalty, respondent, ao_number, and case_number filters each apply to only some document types; with type omitted, the search returns only the types every one of them applies to. Each response is held to 100,000 bytes: when a page would exceed it, whole results are held back and nextFromHit gives the from_hit that continues each document type.',
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
    {
      reason: 'filter_not_valid_for_type',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A type-specific filter was sent with a type it does not filter, or type-specific filters that no single document type accepts together — including a citation with case_number, respondent, a penalty bound, or an open_date or close_date bound on murs or adrs',
      recovery:
        'Set type to one the filter applies to, or drop the filter: citations filter advisory_opinions, murs, adrs; penalty bounds filter murs, adrs, admin_fines; respondent filters murs, adrs; ao_number filters advisory_opinions; case_number filters murs, adrs, admin_fines. Run filters that share no type as separate searches. On murs and adrs the search index ignores case_number, respondent, penalty bounds, and open_date or close_date bounds sent with a citation, so search the citation on its own (query and a document_date bound still apply) and the other filters separately.',
    },
    {
      reason: 'invalid_citation',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A citation is not in a form the search index parses, so upstream would ignore it and return the type unfiltered, or a value holds a second citation upstream would ignore',
      recovery:
        'Start the citation with its title number: statutory_citation as "<title> U.S.C. <section>" (e.g. "52 U.S.C. 30104"; USC and § are accepted), regulatory_citation as "<title> CFR <part>.<section>" (e.g. "11 CFR 110.1"; C.F.R. and § are accepted). A subsection suffix such as "30104(g)" may follow; a bare section number such as "30106" or "110.1" is not accepted. Send one citation per field: a value such as "52 U.S.C. 30104, 52 U.S.C. 30118" is rejected because only its first citation would be applied, so run a separate search for each citation.',
    },
    {
      reason: 'legal_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'from_hit plus hits_returned exceeds the 10,000-result window the search index serves',
      recovery:
        'Lower from_hit or hits_returned so their sum is 10,000 or less. No document type holds enough records to reach that depth, so narrow the query with a type, a date bound, or search terms rather than paging further.',
    },
  ],

  input: z.object({
    query: z.string().optional().describe('Full-text search across legal documents.'),
    type: z
      .enum(LEGAL_DOC_TYPES)
      .optional()
      .describe(
        'Document type filter. Omit to search every type the other filters apply to — all five when only query is given. admin_fines can be slow without a query.',
      ),
    ao_number: z
      .string()
      .optional()
      .describe(
        'Specific advisory opinion number (e.g. "2024-01"). Applies to advisory_opinions only: rejected with any other type, and with type omitted only advisory opinions are returned.',
      ),
    case_number: z
      .string()
      .optional()
      .describe(
        'Specific MUR, ADR, or administrative fine case number (e.g. "8343"). Applies to murs, adrs, and admin_fines: rejected with advisory_opinions or statutes, and with type omitted only those three types are returned.',
      ),
    respondent: z
      .string()
      .optional()
      .describe(
        'Respondent name. Applies to enforcement cases (murs, adrs) only: rejected with any other type, and with type omitted only MURs and ADRs are returned.',
      ),
    regulatory_citation: z
      .string()
      .optional()
      .describe(
        'CFR citation in the form "<title> CFR <part>.<section>" (e.g. "11 CFR 110.1"; "C.F.R.", "§", and a suffix such as "110.1(b)" are accepted — a bare "110.1" is rejected as invalid_citation). One citation per value: "11 CFR 110.1; 11 CFR 110.2" is rejected, since only the first would be applied. Given with statutory_citation, matches a document that cites either one. On murs and adrs it cannot be combined with case_number, respondent, a penalty bound, or an open_date or close_date bound, which the search index would ignore. Applies to advisory_opinions, murs, and adrs: rejected with admin_fines or statutes, and with type omitted only those three types are returned.',
      ),
    statutory_citation: z
      .string()
      .optional()
      .describe(
        'U.S.C. citation in the form "<title> U.S.C. <section>" (e.g. "52 U.S.C. 30104"; "USC", "§", and a suffix such as "30104(g)" are accepted — a bare "30104" is rejected as invalid_citation). One citation per value: "52 U.S.C. 30104, 52 U.S.C. 30118" is rejected, since only the first would be applied. Given with regulatory_citation, matches a document that cites either one. On murs and adrs it cannot be combined with case_number, respondent, a penalty bound, or an open_date or close_date bound, which the search index would ignore. Applies to advisory_opinions, murs, and adrs: rejected with admin_fines or statutes, and with type omitted only those three types are returned.',
      ),
    min_penalty_amount: z
      .number()
      .optional()
      .describe(
        'Minimum penalty amount in dollars. Applies to murs, adrs, and admin_fines (an administrative fine matches on its reason-to-believe or final-determination amount): rejected with advisory_opinions or statutes, and with type omitted only those three types are returned.',
      ),
    max_penalty_amount: z
      .number()
      .optional()
      .describe(
        'Maximum penalty amount in dollars. Applies to murs, adrs, and admin_fines (an administrative fine matches on its reason-to-believe or final-determination amount): rejected with advisory_opinions or statutes, and with type omitted only those three types are returned.',
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
      .max(RESULT_WINDOW - 1)
      .default(0)
      .describe(
        'Offset for pagination (0-indexed), counted within each document type rather than across them. Default 0. When a response is bounded, nextFromHit gives the value that continues each type. The search index serves a 10,000-result window, so from_hit plus hits_returned must be 10,000 or less — the ceiling here assumes hits_returned of 1.',
      ),
    hits_returned: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe(
        'Results per page, applied per document type. Default 20, max 200. A response is held to 100,000 bytes, so a page of large records can carry fewer, with nextFromHit naming where each type continues. Bounded together with from_hit by the 10,000-result window.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .looseObject({})
          .describe(
            'Legal document record. The document_type field discriminates among advisory_opinion, mur, adr, admin_fine, and statute. Common fields include no (the identifier every type carries, and the one openfec_get_legal_document takes; advisory opinions repeat it as ao_no), name, document_type, document_count and document_categories summarizing the related filings, and disposition_count and disposition_categories summarizing the dispositions.',
          ),
      )
      .describe(
        'Legal document result set spanning advisory opinions, MURs, ADRs, admin fines, and statutes — only the types searched. Grouped by type in upstream order; when truncated is set, each type holds its first results up to the response budget.',
      ),
    total_count: z
      .number()
      .describe(
        'Total matching documents across the types searched: the requested type, or with type omitted, every type the supplied filters apply to.',
      ),
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Total matching legal documents across the document types searched.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on the page returned: how to broaden a search that matched nothing, that from_hit ran past the end when documents did match, or — when truncated is set — how each document type continues.',
      ),
    retrievalHint: z
      .string()
      .optional()
      .describe(
        'How to recover the material trimmed out of these results. Present whenever any result was returned, because every result is trimmed.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when results upstream returned for this page were held back because the next one would take the response past its 100,000-byte budget. Absent when the page is complete, including a naturally short page and an offset past the end.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Results in this response. Present only when truncated is true.'),
    nextFromHit: z
      .record(z.string(), z.number())
      .optional()
      .describe(
        'The from_hit that continues each document type with results held back, keyed by the value to pass as type (advisory_opinions, murs, adrs, admin_fines, statutes). Re-call with the same filters, that type, and this from_hit. Present only when truncated is true.',
      ),
  },

  enrichmentTrailer: {
    retrievalHint: { label: 'Full records' },
    truncated: { label: 'Bounded by the response budget' },
    shown: { label: 'Results in this response' },
    nextFromHit: {
      render: (next) => `**Next from_hit per type:** ${describeNextFromHit(next ?? {})}`,
    },
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

    let resolvedDateParams: readonly [string, string] | undefined;
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
      resolvedDateParams = bounds;
    }

    const suppliedFilters = TYPE_SPECIFIC_FILTERS.filter(
      (filter) => input[filter] !== undefined && input[filter] !== '',
    );
    const acceptedBy = (filters: TypeSpecificFilter[]) =>
      Object.fromEntries(filters.map((filter) => [filter, typesFor(filter)]));

    /**
     * The document types this search covers. A type-specific filter must
     * apply to the requested type; with type omitted, only the types every
     * supplied filter applies to are kept, since upstream returns the rest
     * unfiltered.
     */
    let searchedTypes: readonly LegalDocType[] = LEGAL_DOC_TYPES;
    if (input.type) {
      const { type } = input;
      const ignored = suppliedFilters.filter((filter) => !FILTER_PARAMS[filter][type]);
      if (ignored.length > 0) {
        throw ctx.fail(
          'filter_not_valid_for_type',
          `Document type "${type}" is not filtered by ${ignored
            .map((filter) => `${filter} (it applies to ${typesFor(filter).join(', ')})`)
            .join('; ')}.`,
          {
            type,
            accepted_by: acceptedBy(ignored),
            ...ctx.recoveryFor('filter_not_valid_for_type'),
          },
        );
      }
      searchedTypes = [type];
    } else if (suppliedFilters.length > 0) {
      searchedTypes = LEGAL_DOC_TYPES.filter((type) =>
        suppliedFilters.every((filter) => FILTER_PARAMS[filter][type]),
      );
      if (searchedTypes.length === 0) {
        throw ctx.fail(
          'filter_not_valid_for_type',
          `No document type is filtered by ${suppliedFilters.join(', ')} together: ${suppliedFilters
            .map((filter) => `${filter} applies to ${typesFor(filter).join(', ')}`)
            .join('; ')}.`,
          {
            accepted_by: acceptedBy(suppliedFilters),
            ...ctx.recoveryFor('filter_not_valid_for_type'),
          },
        );
      }
    }

    const citations = suppliedFilters.filter((filter) => filter in CITATION_FORMS);
    if (citations.length > 0 && searchedTypes.some((type) => CASE_TYPES.has(type))) {
      const datesDropped =
        input.date_kind && DATE_KINDS_DROPPED_WITH_CASE_CITATION.has(input.date_kind);
      const ignored = [
        ...suppliedFilters.filter((filter) => DROPPED_WITH_CASE_CITATION.has(filter)),
        ...(datesDropped
          ? (['min_date', 'max_date'] as const).filter((bound) => input[bound])
          : []),
      ];
      if (ignored.length > 0) {
        throw ctx.fail(
          'filter_not_valid_for_type',
          `MURs and ADRs apply a citation on its own: the search index ignores ${ignored.join(', ')} sent with ${citations.join(' and ')}.`,
          {
            ...(input.type ? { type: input.type } : {}),
            ignored_with_citation: ignored,
            ...ctx.recoveryFor('filter_not_valid_for_type'),
          },
        );
      }
    }

    const citationProblems = (Object.keys(CITATION_FORMS) as CitationField[]).flatMap((field) => {
      const value = input[field];
      const problem = value ? citationProblem(field, value) : null;
      return problem ? [{ field, value, problem }] : [];
    });
    if (citationProblems.length > 0) {
      throw ctx.fail(
        'invalid_citation',
        citationProblems.map(({ problem }) => `${problem}.`).join(' '),
        {
          invalid_citations: Object.fromEntries(
            citationProblems.map(({ field, value }) => [field, value]),
          ),
          ...ctx.recoveryFor('invalid_citation'),
        },
      );
    }

    validateRange({
      minField: 'min_penalty_amount',
      minValue: input.min_penalty_amount,
      maxField: 'max_penalty_amount',
      maxValue: input.max_penalty_amount,
      valueType: 'number',
    });
    validateRange({
      minField: 'min_date',
      minValue: input.min_date,
      maxField: 'max_date',
      maxValue: input.max_date,
      valueType: 'date',
    });

    if (input.from_hit + input.hits_returned > RESULT_WINDOW) {
      throw ctx.fail(
        'legal_window_exceeded',
        `from_hit ${input.from_hit} with hits_returned ${input.hits_returned} reaches past the 10,000-result window this search serves.`,
        {
          from_hit: input.from_hit,
          hits_returned: input.hits_returned,
          max_from_hit: maxFromHit(input.hits_returned),
          recovery: {
            hint: `With hits_returned ${input.hits_returned}, from_hit can go no higher than ${maxFromHit(input.hits_returned)}. No document type holds enough records to reach that depth, so narrow the query with a type, a date bound, or search terms rather than paging further.`,
          },
        },
      );
    }

    const fec = getOpenFecService();

    const params: FecParams = {
      from_hit: input.from_hit,
      hits_returned: input.hits_returned,
    };
    /**
     * Filters that leave one document type scope the upstream call to it, so
     * the other types' pages are never fetched only to be discarded.
     */
    const upstreamType = searchedTypes.length === 1 ? searchedTypes[0] : undefined;
    if (input.query) params.q = input.query;
    if (upstreamType) params.type = upstreamType;
    for (const filter of suppliedFilters) {
      for (const type of searchedTypes) {
        const name = FILTER_PARAMS[filter][type];
        if (name) params[name] = input[filter];
      }
    }

    if (resolvedDateParams) {
      const [minParam, maxParam] = resolvedDateParams;
      if (input.min_date) params[minParam] = input.min_date;
      if (input.max_date) params[maxParam] = input.max_date;
    }

    ctx.log.info('Searching legal documents', {
      query: input.query,
      type: upstreamType,
      resultCount: input.hits_returned,
    });

    const data = await fec.searchLegal(params, ctx);

    /**
     * An untyped search that filters narrow to several types keeps only those
     * types, and totals over them from the per-type counts — `total_all` would
     * count the other types unfiltered. A search scoped to one type upstream,
     * and one with no type-specific filter, keep everything upstream returned.
     */
    const narrowed = !upstreamType && suppliedFilters.length > 0;
    const keptTypes = new Set(searchedTypes.map((type) => LEGAL_DOCUMENT_TYPE[type]));
    const results = narrowed
      ? data.results.filter((doc) => keptTypes.has(doc.document_type))
      : data.results;
    /** Upstream computes and sends every type's total on an untyped search, so a missing one is a broken response. */
    const typeTotal = (type: LegalDocType): number => {
      const total = data.typeTotals[type];
      if (total === undefined) {
        throw serviceUnavailable(
          `OpenFEC legal search omitted total_${type} from an untyped search response.`,
        );
      }
      return total;
    };
    const totalCount = narrowed
      ? searchedTypes.reduce((sum, type) => sum + typeTotal(type), 0)
      : data.totalCount;

    /**
     * Every result is trimmed: its related-filing and disposition arrays become
     * a count and category summary, highlights lose their match markup and stop
     * at three, and commission votes are cut to a date and a short action.
     * openfec_get_legal_document returns what is trimmed here.
     */
    const trimmed = results.map((doc) => {
      const d = { ...doc };

      if (Array.isArray(d.highlights)) {
        d.highlights = d.highlights
          .slice(0, 3)
          .map((highlight) =>
            typeof highlight === 'string' ? stripEmphasis(highlight) : highlight,
          );
      }
      delete d.document_highlights;

      if (Array.isArray(d.documents) && d.documents.length > 0) {
        const docs = d.documents as Array<Record<string, unknown>>;
        const categories = [...new Set(docs.map((dd) => dd.category).filter(Boolean))];
        d.document_count = docs.length;
        d.document_categories = categories;
        delete d.documents;
      }

      /** A case disposition names its outcome in `disposition`; an administrative fine's in `disposition_description`. */
      if (Array.isArray(d.dispositions) && d.dispositions.length > 0) {
        const dispositions = d.dispositions as Array<Record<string, unknown>>;
        d.disposition_count = dispositions.length;
        d.disposition_categories = [
          ...new Set(
            dispositions.map((x) => x.disposition ?? x.disposition_description).filter(Boolean),
          ),
        ];
        delete d.dispositions;
      }

      if (Array.isArray(d.commission_votes) && d.commission_votes.length > 0) {
        const votes = d.commission_votes as Array<Record<string, unknown>>;
        d.commission_votes = votes.map((v) => ({
          vote_date: v.vote_date,
          action: typeof v.action === 'string' ? v.action.slice(0, 200) : v.action,
        }));
      }

      return d;
    });

    const searchCriteria = buildSearchCriteria(input);

    /**
     * Hold the response to the budget on both surfaces. The envelope — every
     * byte that is not a result — is reserved at its largest: headings for
     * every type fetched, the total and criteria lines, and the enrichment a
     * bounded page carries with each type's continuation at its highest.
     */
    const deepestNext = Object.fromEntries(
      [...new Set(trimmed.map((doc) => doc.document_type))].map((docType) => [
        typeOfDocument(docType),
        input.from_hit + input.hits_returned,
      ]),
    );
    const deepestNotice = boundNotice(trimmed.length, deepestNext);
    const envelope = Math.max(
      utf8Bytes(
        JSON.stringify({
          results: [],
          total_count: totalCount,
          search_criteria: searchCriteria,
          totalCount,
          retrievalHint: RETRIEVAL_HINT,
          truncated: true,
          shown: trimmed.length,
          nextFromHit: deepestNext,
          notice: deepestNotice,
        }),
      ),
      utf8Bytes(
        assembleText(
          groupByType(trimmed, () => ''),
          totalCount,
          searchCriteria,
        ),
      ) +
        enrichmentTrailerBytes([
          `**${totalCount} total**`,
          `**Full records:** ${RETRIEVAL_HINT}`,
          '**Bounded by the response budget:** true',
          `**Results in this response:** ${trimmed.length}`,
          `**Next from_hit per type:** ${describeNextFromHit(deepestNext)}`,
          `> ${deepestNotice}`,
        ]),
    );
    const { admitted, heldBack } = admitRoundRobin(trimmed, RESPONSE_BUDGET_BYTES - envelope);

    ctx.enrich.total(totalCount);
    const notices: string[] = [];
    if (admitted.length === 0) {
      notices.push(
        totalCount > 0
          ? describeExhaustedPosition({ kind: 'offset', total_count: totalCount })
          : 'No legal documents matched. Try different search terms, remove the type filter to search all document types, or check the ao_number/case_number format.',
      );
    } else {
      ctx.enrich({ retrievalHint: RETRIEVAL_HINT });
    }
    if (heldBack.size > 0) {
      const nextFromHit = Object.fromEntries(
        [...heldBack].map(([docType, count]) => [typeOfDocument(docType), input.from_hit + count]),
      );
      ctx.enrich({ truncated: true, shown: admitted.length, nextFromHit });
      notices.push(boundNotice(admitted.length, nextFromHit));
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      results: admitted,
      total_count: totalCount,
      search_criteria: searchCriteria,
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      if (result.total_count > 0) {
        return formatExhaustedResult(result.search_criteria, {
          kind: 'offset',
          total_count: result.total_count,
        });
      }
      return formatEmptyResult(
        result.search_criteria,
        'Try different search terms, remove the type filter to search all document types, or check the ao_number/case_number format.',
      );
    }
    const text = assembleText(
      groupByType(result.results, renderResult),
      result.total_count,
      result.search_criteria,
    );
    return [{ type: 'text', text }];
  },
});
