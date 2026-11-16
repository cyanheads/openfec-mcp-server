/**
 * @fileoverview Tests for the get-legal-document tool — full-record retrieval,
 * the not-found contract, enrichment, and format rendering of the arrays
 * openfec_search_legal trims away.
 * @module tests/mcp-server/tools/definitions/get-legal-document.tool.test
 */

import { readFileSync } from 'node:fs';
import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = {
  searchCandidates: vi.fn(),
  getCandidate: vi.fn(),
  getCandidateTotals: vi.fn(),
  getCandidateCommittees: vi.fn(),
  searchCommittees: vi.fn(),
  getCommittee: vi.fn(),
  getCommitteeTotals: vi.fn(),
  getCommitteeTotalsByEntityType: vi.fn(),
  searchContributions: vi.fn(),
  getContributionAggregates: vi.fn(),
  searchDisbursements: vi.fn(),
  getDisbursementAggregates: vi.fn(),
  searchExpenditures: vi.fn(),
  getExpendituresByCandidate: vi.fn(),
  searchCoordinatedExpenditures: vi.fn(),
  searchFilings: vi.fn(),
  searchElections: vi.fn(),
  searchElectionsByZip: vi.fn(),
  getElectionSummary: vi.fn(),
  searchLegal: vi.fn(),
  getLegalDocument: vi.fn(),
  getCalendarDates: vi.fn(),
  getReportingDates: vi.fn(),
  getElectionDates: vi.fn(),
};

vi.mock('@/services/openfec/openfec-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/openfec/openfec-service.js')>()),
  getOpenFecService: () => mockService,
}));

import {
  enrichmentTrailerBytes,
  getLegalDocument,
  RESPONSE_BUDGET_BYTES,
  utf8Bytes,
} from '@/mcp-server/tools/definitions/get-legal-document.tool.js';
import { contractFailure, declaredRecovery } from './contract-failure.js';

const advisoryOpinion = (overrides: Record<string, unknown> = {}) => ({
  ao_no: '2024-01',
  ao_year: 2024,
  name: 'Sample Requestor LLC',
  status: 'Final',
  issue_date: '2024-03-14T00:00:00',
  documents: [
    { category: 'Final Opinion', date: '2024-03-14', document_id: 1, url: '/files/final.pdf' },
    { category: 'Comment', date: '2024-02-01', document_id: 2, url: '/files/comment.pdf' },
  ],
  ...overrides,
});

const mur = () => ({
  no: 7226,
  name: 'Example Committee',
  commission_votes: [{ vote_date: '2019-05-01', action: 'Failed to find reason to believe.' }],
  dispositions: [
    { disposition_date: '2019-06-02', disposition_description: 'Dismissed', penalty: 0 },
  ],
  documents: [],
});

/** Live `/legal/docs/` records (arrays shortened), one per nested shape family. */
const LIVE = JSON.parse(
  readFileSync(new URL('../../../fixtures/legal-records.json', import.meta.url), 'utf8'),
) as Record<
  'mur_8343' | 'mur_1704' | 'adr_172' | 'ao_2003_37' | 'af_4229' | 'mur_8309',
  Record<string, unknown>
>;

const LIVE_CASES = [
  ['murs', '8343', 'mur_8343'],
  ['murs', '1704', 'mur_1704'],
  ['adrs', '172', 'adr_172'],
  ['advisory_opinions', '2003-37', 'ao_2003_37'],
  ['admin_fines', '4229', 'af_4229'],
  ['murs', '8309', 'mur_8309'],
] as const;

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

const makeCtx = () => createMockContext({ errors: getLegalDocument.errors });

describe('getLegalDocument', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('passes the plural doc_type and the number straight through to the service', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce(advisoryOpinion());

      const input = getLegalDocument.input.parse({
        doc_type: 'advisory_opinions',
        no: '2024-01',
      });
      const result = await getLegalDocument.handler(input, ctx);

      expect(mockService.getLegalDocument).toHaveBeenCalledWith(
        'advisory_opinions',
        '2024-01',
        ctx,
      );
      expect(result.document).toMatchObject({ ao_no: '2024-01' });
      expect(result.search_criteria).toEqual({ doc_type: 'advisory_opinions', no: '2024-01' });
    });

    it('returns the documents array openfec_search_legal replaces with a count', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce(advisoryOpinion());

      const input = getLegalDocument.input.parse({
        doc_type: 'advisory_opinions',
        no: '2024-01',
      });
      const result = await getLegalDocument.handler(input, ctx);

      expect(result.document.documents).toHaveLength(2);
      expect(getEnrichment(ctx).attachedDocumentCount).toBe(2);
    });

    it('reports zero attached documents when the record carries none', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce(mur());

      const input = getLegalDocument.input.parse({ doc_type: 'murs', no: '7226' });
      await getLegalDocument.handler(input, ctx);

      expect(getEnrichment(ctx).attachedDocumentCount).toBe(0);
    });

    it('counts zero when the record omits the documents field entirely', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce({ no: 1, name: 'Statute' });

      const input = getLegalDocument.input.parse({ doc_type: 'statutes', no: '1' });
      const result = await getLegalDocument.handler(input, ctx);

      expect(getEnrichment(ctx).attachedDocumentCount).toBe(0);
      expect(result.document).toEqual({ no: 1, name: 'Statute' });
    });

    it('throws legal_document_not_found with a recovery hint when no record exists', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce(null);

      const err = await contractFailure(getLegalDocument, { doc_type: 'murs', no: '99999999' });

      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data).toMatchObject({
        reason: 'legal_document_not_found',
        doc_type: 'murs',
        no: '99999999',
        recovery: { hint: declaredRecovery(getLegalDocument, 'legal_document_not_found') },
      });
    });

    it('rejects the singular document_type form that search results carry', () => {
      expect(() => getLegalDocument.input.parse({ doc_type: 'mur', no: '7226' })).toThrow();
    });

    it('rejects an empty document number', () => {
      expect(() =>
        getLegalDocument.input.parse({ doc_type: 'advisory_opinions', no: '' }),
      ).toThrow();
    });

    it('declares a contract entry for an array the record lacks and an offset with no array', () => {
      const reasons = getLegalDocument.errors?.map((entry) => entry.reason);
      expect(reasons).toEqual(
        expect.arrayContaining(['array_not_in_record', 'offset_without_array']),
      );
    });

    it('rejects a negative offset and an empty array name at the schema', () => {
      expect(() =>
        getLegalDocument.input.parse({ doc_type: 'murs', no: '1', array: 'documents', offset: -1 }),
      ).toThrow();
      expect(() =>
        getLegalDocument.input.parse({ doc_type: 'murs', no: '1', array: '' }),
      ).toThrow();
    });

    it('pages a non-section array through its legal rendering, scalars alongside', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce(structuredClone(LIVE.mur_8343));

      const result = await runToolContract(getLegalDocument, {
        doc_type: 'murs',
        no: '8343',
        array: 'participants',
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        document: Record<string, unknown>;
        slice: { entries: unknown[]; offset: number; total: number };
        attachedDocumentCount: number;
      };
      expect(structured.slice.offset).toBe(0);
      expect(structured.slice.entries).toEqual(LIVE.mur_8343.participants);
      expect(structured.document).not.toHaveProperty('participants');
      expect(structured.document).not.toHaveProperty('documents');
      expect(structured.document.name).toBe('The Washington Post');
      expect(structured.attachedDocumentCount).toBe((LIVE.mur_8343.documents as unknown[]).length);
      const text = formatText(result.content as ContentBlock[]);
      expect(text).toContain('1. Washington Post, The (Primary Respondent)');
      expect(text).toContain('_End of participants._');
    });

    it('reports an empty array as holding no entries, not as an error', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce({ no: '1', name: 'X', documents: [] });

      const result = await runToolContract(getLegalDocument, {
        doc_type: 'murs',
        no: '1',
        array: 'documents',
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.slice).toEqual({ array: 'documents', offset: 0, total: 0, entries: [] });
      expect(structured.notice).toBe('documents holds no entries on this record.');
    });

    /**
     * The record as upstream sent it with only its site-relative links made
     * absolute: record pages under fec.gov/data, every other path under the
     * site root. An advisory opinion's constructed page is checked separately.
     */
    const withAbsoluteLinks = (record: Record<string, unknown>): string =>
      JSON.stringify(record)
        .replaceAll('"url":"/legal/', '"url":"https://www.fec.gov/data/legal/')
        .replaceAll('"url":"/', '"url":"https://www.fec.gov/');

    it.each(LIVE_CASES.filter(([docType]) => docType !== 'advisory_opinions'))(
      'returns the %s %s record byte-identical on structuredContent but for its absolute links',
      async (docType, no, key) => {
        mockService.getLegalDocument.mockResolvedValueOnce(structuredClone(LIVE[key]));

        const result = await runToolContract(getLegalDocument, { doc_type: docType, no });

        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as { document: unknown };
        expect(JSON.stringify(structured.document)).toBe(withAbsoluteLinks(LIVE[key]));
        expect(JSON.stringify(structured.document)).not.toContain('"url":"/');
      },
    );

    it('returns the advisory opinion record whole, its links absolute and its page added', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce(structuredClone(LIVE.ao_2003_37));

      const result = await runToolContract(getLegalDocument, {
        doc_type: 'advisory_opinions',
        no: '2003-37',
      });

      const { document } = result.structuredContent as { document: Record<string, unknown> };
      expect(document.url).toBe('https://www.fec.gov/data/legal/advisory-opinions/2003-37/');
      const { url: _added, ...rest } = document;
      expect(JSON.stringify(rest)).toBe(withAbsoluteLinks(LIVE.ao_2003_37));
    });
  });

  describe('links', () => {
    const run = async (
      key: keyof typeof LIVE,
      args: { doc_type: 'murs' | 'advisory_opinions'; no: string; array?: string; offset?: number },
    ) => {
      mockService.getLegalDocument.mockResolvedValueOnce(structuredClone(LIVE[key]));
      const result = await runToolContract(getLegalDocument, args);
      expect(result.isError).toBeFalsy();
      return {
        structured: result.structuredContent as {
          document: Record<string, unknown>;
          slice?: { entries: Array<Record<string, unknown>> };
        },
        text: formatText(result.content as ContentBlock[]),
      };
    };

    it('makes the record page, every document, and every disposition citation absolute', async () => {
      const { structured, text } = await run('mur_8343', { doc_type: 'murs', no: '8343' });
      const { document } = structured;

      expect(document.url).toBe('https://www.fec.gov/data/legal/matter-under-review/8343/');
      expect((document.documents as Array<{ url: string }>).map((d) => d.url)).toEqual([
        'https://www.fec.gov/files/legal/murs/8343/8343_07.pdf',
        'https://www.fec.gov/files/legal/murs/8343/8343_06.pdf',
      ]);
      const citations = (document.dispositions as Array<{ citations: Array<{ url: string }> }>)
        .flatMap((d) => d.citations)
        .map((c) => c.url);
      expect(new Set(citations)).toEqual(
        new Set([
          'https://www.govinfo.gov/link/uscode/52/30104',
          'https://www.govinfo.gov/link/uscode/52/30118',
          'https://www.fec.gov/regulations/100-73/CURRENT',
          'https://www.fec.gov/regulations/100-132/CURRENT',
          'https://www.fec.gov/regulations/114-2/CURRENT',
        ]),
      );

      expect(text).toContain(
        'url: [8343](<https://www.fec.gov/data/legal/matter-under-review/8343/>)',
      );
      expect(text).toContain(
        'url: [8343_06.pdf](<https://www.fec.gov/files/legal/murs/8343/8343_06.pdf>)',
      );
      expect(text).toContain('[11 CFR 100.73](<https://www.fec.gov/regulations/100-73/CURRENT>)');
      expect(text).toContain(
        '[52 U.S.C. 30104(g)](<https://www.govinfo.gov/link/uscode/52/30104>)',
      );
    });

    it('resolves the archived citation groups and fabricates no page for an archived MUR', async () => {
      const { structured, text } = await run('mur_1704', { doc_type: 'murs', no: '1704' });
      const citations = structured.document.citations as Record<string, Array<{ url: string }>>;

      expect(structured.document).not.toHaveProperty('url');
      expect(citations.regulations!.map((c) => c.url)).toEqual([
        'https://www.fec.gov/regulations/100-5/CURRENT',
        'https://www.fec.gov/regulations/110-3/CURRENT',
      ]);
      expect(citations.us_code!.map((c) => c.url)).toEqual([
        'https://www.govinfo.gov/link/uscode/52/30103',
        'https://www.govinfo.gov/link/uscode/52/30103',
      ]);
      expect(text).toContain('[11 C.F.R. 110.3](<https://www.fec.gov/regulations/110-3/CURRENT>)');
      expect(text).toContain(
        'url: [1704_A.pdf](<https://www.fec.gov/files/legal/murs/1704_A.pdf>)',
      );
    });

    it('carries the advisory opinion page on both surfaces', async () => {
      const { structured, text } = await run('ao_2003_37', {
        doc_type: 'advisory_opinions',
        no: '2003-37',
      });

      const page = 'https://www.fec.gov/data/legal/advisory-opinions/2003-37/';
      expect(structured.document.url).toBe(page);
      expect(text).toContain(`url: [2003-37](<${page}>)`);
    });

    it('resolves links inside a slice: documents, and the citations nested in dispositions', async () => {
      const docs = await run('mur_8343', {
        doc_type: 'murs',
        no: '8343',
        array: 'documents',
        offset: 1,
      });
      expect(docs.structured.slice!.entries.map((d) => d.url)).toEqual([
        'https://www.fec.gov/files/legal/murs/8343/8343_06.pdf',
      ]);
      expect(docs.structured.document.url).toBe(
        'https://www.fec.gov/data/legal/matter-under-review/8343/',
      );
      expect(docs.text).toContain(
        'url: [8343_06.pdf](<https://www.fec.gov/files/legal/murs/8343/8343_06.pdf>)',
      );

      const dispositions = await run('mur_8343', {
        doc_type: 'murs',
        no: '8343',
        array: 'dispositions',
      });
      const nested = dispositions.structured.slice!.entries.flatMap((d) =>
        (d.citations as Array<{ url: string }>).map((c) => c.url),
      );
      expect(nested).toHaveLength(10);
      expect(nested.every((url) => url.startsWith('https://'))).toBe(true);
      expect(nested).toContain('https://www.fec.gov/regulations/114-2/CURRENT');
      expect(dispositions.text).toContain(
        '[11 CFR 100.132](<https://www.fec.gov/regulations/100-132/CURRENT>)',
      );
    });
  });

  describe('format', () => {
    /** The record as the handler hands it to format(): every link already absolute. */
    it('renders the identifier header, scalar fields, and the documents section', () => {
      const page = 'https://www.fec.gov/data/legal/advisory-opinions/2024-01/';
      const file = 'https://www.fec.gov/files/final.pdf';
      const blocks = getLegalDocument.format!({
        document: advisoryOpinion({
          url: page,
          documents: [
            { category: 'Final Opinion', date: '2024-03-14', document_id: 1, url: file },
            {
              category: 'Comment',
              date: '2024-02-01',
              document_id: 2,
              url: 'https://www.fec.gov/files/comment.pdf',
            },
          ],
        }),
        search_criteria: { doc_type: 'advisory_opinions', no: '2024-01' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**2024-01** — Sample Requestor LLC');
      expect(text).toContain('status: Final');
      expect(text).toContain(`  url: [2024-01](<${page}>)`);
      expect(text).toContain('### documents (2)');
      expect(text).toContain('category: Final Opinion');
      expect(text).toContain(`url: [final.pdf](<${file}>)`);
      expect(text).toContain('_Search criteria: doc_type=advisory_opinions · no=2024-01_');
    });

    it('renders commission_votes and dispositions as their own sections', () => {
      const blocks = getLegalDocument.format!({
        document: mur(),
        search_criteria: { doc_type: 'murs', no: '7226' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**7226** — Example Committee');
      expect(text).toContain('### commission_votes (1)');
      expect(text).toContain('action: Failed to find reason to believe.');
      expect(text).toContain('### dispositions (1)');
      expect(text).toContain('disposition_description: Dismissed');
      expect(text).not.toContain('### documents');
    });

    it.each(LIVE_CASES)(
      'renders no JSON object literal for any nested field of %s %s',
      async (docType, no, key) => {
        mockService.getLegalDocument.mockResolvedValueOnce(structuredClone(LIVE[key]));

        const result = await runToolContract(getLegalDocument, { doc_type: docType, no });

        const text = formatText(result.content as ContentBlock[]);
        expect(text).not.toContain('{"');
      },
    );

    it('renders a current MUR: participants, subjects, and citations inside each disposition', () => {
      const text = formatText(
        getLegalDocument.format!({
          document: structuredClone(LIVE.mur_8343),
          search_criteria: { doc_type: 'murs', no: '8343' },
        }),
      );

      expect(text).toContain('**8343** — The Washington Post');
      expect(text).toContain(
        'participants: Washington Post, The (Primary Respondent); Crate, Bradley T. (Complainant)',
      );
      expect(text).toContain('subjects: Contributions-Prohibited; Reporting');
      expect(text).toContain('### dispositions (2)');
      expect(text).toContain('respondent: Harris for President');
      expect(text).toContain(
        'citations: [52 U.S.C. 30104(g)](<https://www.govinfo.gov/link/uscode/52/30104>); [52 U.S.C. 30118(a)](<https://www.govinfo.gov/link/uscode/52/30118>); 11 CFR 100.73 (/regulations/100-73/CURRENT)',
      );
    });

    it('heads an archived MUR by mur_name and renders its citations and subject tree', () => {
      const text = formatText(
        getLegalDocument.format!({
          document: structuredClone(LIVE.mur_1704),
          search_criteria: { doc_type: 'murs', no: '1704' },
        }),
      );

      expect(text).toContain('**1704** — MONDALE DELEGATE COMMITTEES');
      expect(text).toContain(
        'citations: 11 C.F.R. 100.5(g) (/regulations/100-5/CURRENT); 11 C.F.R. 110.3 (/regulations/110-3/CURRENT); [52 U.S.C. 30103(b)(2)](<https://www.govinfo.gov/link/uscode/52/30103>)',
      );
      expect(text).toContain(
        'subject: Affiliation; Contributions > Acceptance > of prohibited contribution; Contributions > Limitations > annual limit for individuals',
      );
    });

    it('renders an advisory opinion: entities, AO references, and citation lists', () => {
      const text = formatText(
        getLegalDocument.format!({
          document: structuredClone(LIVE.ao_2003_37),
          search_criteria: { doc_type: 'advisory_opinions', no: '2003-37' },
        }),
      );

      expect(text).toContain('entities: Mr. Charles Spies Esq. (Commenter, Individual)');
      expect(text).toContain(
        'ao_citations: AO 2000-25 (Minnesota House DFL Caucus); AO 2003-03 (Cantor)',
      );
      expect(text).toContain('regulatory_citations: 11 CFR 100.4; 11 CFR 100.16; 11 CFR 100.22');
      expect(text).toContain(
        'statutory_citations: 26 U.S.C. 527; 52 U.S.C. 30101; 52 U.S.C. 30104',
      );
    });

    it('keeps an unknown nested shape on the generic JSON rendering', () => {
      const text = formatText(
        getLegalDocument.format!({
          document: { no: '1', name: 'X', unknown_nested: [{ a: 1 }], participants: [{ id: 7 }] },
          search_criteria: { doc_type: 'murs', no: '1' },
        }),
      );

      expect(text).toContain('unknown_nested: {"a":1}');
      expect(text).toContain('participants: {"id":7}');
    });

    it('renders the held-back arrays with their entry counts, sizes, and the re-call', () => {
      const text = formatText(
        getLegalDocument.format!({
          document: { no: '8123', name: 'Example' },
          withheld: [{ array: 'dispositions', count: 53, bytes: 72797 }],
          search_criteria: { doc_type: 'murs', no: '8123' },
        }),
      );

      expect(text).toContain('### Arrays held back by the response budget');
      expect(text).toContain('- dispositions — 53 entries, 72,797 bytes');
      expect(text).toContain('Re-call with array set to one of these names');
    });

    it('renders a slice numbered from its offset, with where it continues', () => {
      const text = formatText(
        getLegalDocument.format!({
          document: { no: '8123', name: 'Example' },
          slice: {
            array: 'documents',
            offset: 10,
            total: 154,
            next_offset: 12,
            entries: [
              { category: 'Complaint', url: '/a.pdf' },
              { category: 'GCR', url: '/b.pdf' },
            ],
          },
          search_criteria: { doc_type: 'murs', no: '8123' },
        }),
      );

      expect(text).toContain(
        '### documents — entries 11–12 of 154 (offset 10)\n\n11. category: Complaint\n    url: /a.pdf\n12. category: GCR\n    url: /b.pdf\n\n_Continue with array documents and offset 12._',
      );
    });

    it('marks the end of an array and an offset with no entries', () => {
      const last = formatText(
        getLegalDocument.format!({
          document: { no: '1' },
          slice: { array: 'respondents', offset: 2, total: 3, entries: ['Roe, Richard'] },
          search_criteria: { doc_type: 'murs', no: '1' },
        }),
      );
      expect(last).toContain('3. Roe, Richard');
      expect(last).toContain('_End of respondents._');

      const past = formatText(
        getLegalDocument.format!({
          document: { no: '1' },
          slice: { array: 'respondents', offset: 5, total: 3, entries: [] },
          search_criteria: { doc_type: 'murs', no: '1' },
        }),
      );
      expect(past).toContain('### respondents — no entries at offset 5 of 3');
    });

    it('falls back to a generic heading when the record carries no identifier or name', () => {
      const blocks = getLegalDocument.format!({
        document: { type: 'statute' },
        search_criteria: { doc_type: 'statutes', no: '1' },
      });

      expect(formatText(blocks)).toContain('**Legal document**');
    });
  });

  /**
   * Each array entry is one CommonMark list item: its number, then its fields
   * at the item's content column (the marker's width). A field whose string
   * spans lines is a list item of its own under the key, its further lines at
   * that item's content column and its blank lines blank, so an upstream line
   * that reads as a list marker ("1. Accept…") or follows a blank line stays
   * inside its entry.
   */
  describe('array entries as list items', () => {
    it('renders a section of several entries one item each, fields at the content column', () => {
      const text = formatText(
        getLegalDocument.format!({
          document: {
            no: '7226',
            name: 'Example Committee',
            commission_votes: [
              { vote_date: '2019-05-01', action: 'Failed to find reason to believe.' },
              {
                vote_date: '2019-06-11',
                action: 'Closed the file.',
                commissioner_name: 'Weintraub, Ellen L.',
                vote_type: 'Affirmed',
              },
            ],
          },
          search_criteria: { doc_type: 'murs', no: '7226' },
        }),
      );

      expect(text).toBe(
        '**7226** — Example Committee\n\n  no: 7226\n  name: Example Committee\n\n### commission_votes (2)\n\n1. vote_date: 2019-05-01\n   action: Failed to find reason to believe.\n2. vote_date: 2019-06-11\n   action: Closed the file.\n   commissioner_name: Weintraub, Ellen L.\n   vote_type: Affirmed\n\n_Search criteria: doc_type=murs · no=7226_',
      );
    });

    /** MUR 8309's latest vote, live: its action numbers its own steps 1–3 and ends in blank lines. */
    it('keeps an action that spans lines, numbered steps and all, inside its own entry', () => {
      const [vote] = LIVE.mur_8309.commission_votes as Record<string, unknown>[];
      const text = formatText(
        getLegalDocument.format!({
          document: { no: '8309', name: 'Oklahoma Leadership Council', commission_votes: [vote] },
          search_criteria: { doc_type: 'murs', no: '8309' },
        }),
      );

      expect(text).toBe(
        '**8309** — Oklahoma Leadership Council\n\n  no: 8309\n  name: Oklahoma Leadership Council\n\n### commission_votes (1)\n\n1. action:\n   - The Commission decided by a vote of 4-0 to take the following actions in MUR 8309:\n\n     1. Accept the signed Conciliation Agreement, as recommended in the Memorandum to the Commission dated April 3, 2025.\n\n     2. Approve the appropriate letter.\n\n     3. Close the file effective 30 days from the date the certification of this vote is signed (or on the next business day after the 30th day, if the 30th day falls on a weekend or holiday).\n\n\n\n   vote_date: 2025-04-29T00:00:00\n\n_Search criteria: doc_type=murs · no=8309_',
      );
    });

    /** The opening of MUR 8309's 3-3 vote: blank lines between steps, and a break inside one with no blank line. */
    it('keeps blank lines and a bare line break inside the entry, and the next entry and section after it', () => {
      const text = formatText(
        getLegalDocument.format!({
          document: {
            no: '8309',
            name: 'Oklahoma Leadership Council',
            commission_votes: [
              {
                vote_date: '2024-08-27T00:00:00',
                action:
                  'The Commission failed by a vote of 3-3 to:\n\na. Open a MUR.\n\nb. Find reason to believe that Oklahoma Leadership Council and John Elliott in his official capacity as treasurer violated 52 U.S.C. § 30104(b)(1), (2), (3), (4), (5), and 11 C.F.R. \n§ 104.3(a), (b) by failing to accurately report both receipts and disbursements.',
              },
              { vote_date: '2024-08-27T00:00:00', action: 'l. Approve the appropriate letter.' },
            ],
            dispositions: [{ disposition: 'Conciliation: Pre Probable Cause', penalty: 174000 }],
          },
          search_criteria: { doc_type: 'murs', no: '8309' },
        }),
      );

      expect(text).toBe(
        '**8309** — Oklahoma Leadership Council\n\n  no: 8309\n  name: Oklahoma Leadership Council\n\n### commission_votes (2)\n\n1. vote_date: 2024-08-27T00:00:00\n   action:\n   - The Commission failed by a vote of 3-3 to:\n\n     a. Open a MUR.\n\n     b. Find reason to believe that Oklahoma Leadership Council and John Elliott in his official capacity as treasurer violated 52 U.S.C. § 30104(b)(1), (2), (3), (4), (5), and 11 C.F.R. \n     § 104.3(a), (b) by failing to accurately report both receipts and disbursements.\n\n2. vote_date: 2024-08-27T00:00:00\n   action: l. Approve the appropriate letter.\n\n### dispositions (1)\n\n1. disposition: Conciliation: Pre Probable Cause\n   penalty: 174000\n\n_Search criteria: doc_type=murs · no=8309_',
      );
    });

    it('numbers a slice from its offset, each item indented to its own marker width', () => {
      const text = formatText(
        getLegalDocument.format!({
          document: { no: '8309', name: 'Oklahoma Leadership Council' },
          slice: {
            array: 'commission_votes',
            offset: 8,
            total: 10,
            entries: [
              { vote_date: '2020-01-02', action: 'Line one\nLine two' },
              { vote_date: '2020-03-04', action: 'Closed.' },
            ],
          },
          search_criteria: {
            doc_type: 'murs',
            no: '8309',
            array: 'commission_votes',
            offset: 8,
          },
        }),
      );

      expect(text).toBe(
        '**8309** — Oklahoma Leadership Council\n\n  no: 8309\n  name: Oklahoma Leadership Council\n\n### commission_votes — entries 9–10 of 10 (offset 8)\n\n9. vote_date: 2020-01-02\n   action:\n   - Line one\n     Line two\n\n10. vote_date: 2020-03-04\n    action: Closed.\n\n_End of commission_votes._\n\n_Search criteria: doc_type=murs · no=8309 · array=commission_votes · offset=8_',
      );
    });

    it('renders a one-line entry on its marker line, and a bare string entry that spans lines inside its item', () => {
      const one = formatText(
        getLegalDocument.format!({
          document: { no: '1', documents: [{ category: 'Complaint' }] },
          search_criteria: { doc_type: 'murs', no: '1' },
        }),
      );
      expect(one).toBe(
        '**1**\n\n  no: 1\n\n### documents (1)\n\n1. category: Complaint\n\n_Search criteria: doc_type=murs · no=1_',
      );

      const spanning = formatText(
        getLegalDocument.format!({
          document: { no: '1' },
          slice: { array: 'respondents', offset: 2, total: 3, entries: ['Roe,\nRichard'] },
          search_criteria: { doc_type: 'murs', no: '1' },
        }),
      );
      expect(spanning).toContain(
        '### respondents — entries 3–3 of 3 (offset 2)\n\n3. Roe,\n   Richard\n\n_End of respondents._',
      );
    });

    it('renders live MUR 8309 whole: every vote line inside its own item, documents and dispositions one item each', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce(structuredClone(LIVE.mur_8309));

      const result = await runToolContract(getLegalDocument, { doc_type: 'murs', no: '8309' });

      const text = formatText(result.content as ContentBlock[]);
      expect(text).toContain(
        '### documents (2)\n\n1. category: Conciliation and Settlement Agreements\n   description: Oklahoma Leadership Council\n   doc_order_id: 1\n   document_date: 2025-06-02T00:00:00\n   document_id: 100515248\n   filename: 8309_12\n   length: 1496352\n   url: [8309_12.pdf](<https://www.fec.gov/files/legal/murs/8309/8309_12.pdf>)\n2. category: Complaint, Responses, Designation of Counsel and Extensions of Time\n   description: Second Consent to Extend the Time to Commence a Civil Law Enforcement Action, Suit, or Proceeding\n   doc_order_id: 2\n   document_date: 2025-03-04T00:00:00\n   document_id: 100515247\n   filename: 8309_09\n   length: 644003\n   url: [8309_09.pdf](<https://www.fec.gov/files/legal/murs/8309/8309_09.pdf>)\n\n### commission_votes (3)\n\n1. action:\n',
      );
      expect(text).toContain(
        '\n\n### dispositions (1)\n\n1. citations: [52 U.S.C. 30102(d)](<https://www.govinfo.gov/link/uscode/52/30102>); [52 U.S.C. 30104(b)](<https://www.govinfo.gov/link/uscode/52/30104>)\n   disposition: Conciliation: Pre Probable Cause\n   mur_disposition_category_id: 1\n   penalty: 174000\n   respondent: Oklahoma Leadership Council\n\n',
      );

      const votes = LIVE.mur_8309.commission_votes as Array<{ action: string; vote_date: string }>;
      const section = text.slice(
        text.indexOf('### commission_votes (3)\n\n') + '### commission_votes (3)\n\n'.length,
        text.indexOf('\n\n### dispositions'),
      );
      /** Only an entry's own marker line starts at column 0. */
      expect(section.split('\n').filter((line) => /^\S/.test(line))).toEqual([
        '1. action:',
        '2. action:',
        '3. action:',
      ]);
      const items = section.split(/\n(?=\d+\. )/);
      expect(items).toHaveLength(votes.length);
      votes.forEach(({ action, vote_date }, i) => {
        const item = items[i]!;
        expect(item.startsWith(`${i + 1}. action:\n`)).toBe(true);
        expect(item).toContain(`\n   vote_date: ${vote_date}`);
        const [first, ...rest] = action.split('\n');
        expect(item).toContain(`\n   - ${first}\n`);
        for (const line of rest.filter((l) => l.trim() !== '')) {
          expect(item).toContain(`\n     ${line}`);
        }
      });
    });
  });

  describe('response budget measure', () => {
    it('pins the budget at 100,000 bytes per surface', () => {
      expect(RESPONSE_BUDGET_BYTES).toBe(100_000);
    });

    it('counts UTF-8 bytes, not UTF-16 code units', () => {
      expect(utf8Bytes('abc')).toBe(3);
      expect(utf8Bytes('§')).toBe(2);
      expect(utf8Bytes('—')).toBe(3);
      expect(utf8Bytes('😀')).toBe(4);
      expect('😀'.length).toBe(2);
    });

    it('bounds the trailer a framework join could produce for the given lines', () => {
      expect(enrichmentTrailerBytes([])).toBe(3);
      expect(enrichmentTrailerBytes(['**5 total**', '> note'])).toBe(3 + 13 + 8);
    });
  });
});
