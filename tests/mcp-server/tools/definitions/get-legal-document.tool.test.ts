/**
 * @fileoverview Tests for the get-legal-document tool — full-record retrieval,
 * the not-found contract, enrichment, and format rendering of the arrays
 * openfec_search_legal trims away.
 * @module tests/mcp-server/tools/definitions/get-legal-document.tool.test
 */

import { readFileSync } from 'node:fs';
import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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

import { getLegalDocument } from '@/mcp-server/tools/definitions/get-legal-document.tool.js';

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
  'mur_8343' | 'mur_1704' | 'adr_172' | 'ao_2003_37' | 'af_4229',
  Record<string, unknown>
>;

const LIVE_CASES = [
  ['murs', '8343', 'mur_8343'],
  ['murs', '1704', 'mur_1704'],
  ['adrs', '172', 'adr_172'],
  ['advisory_opinions', '2003-37', 'ao_2003_37'],
  ['admin_fines', '4229', 'af_4229'],
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

      const input = getLegalDocument.input.parse({ doc_type: 'murs', no: '99999999' });
      const err = await Promise.resolve(getLegalDocument.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
      expect((err as McpError).data).toMatchObject({
        reason: 'legal_document_not_found',
        doc_type: 'murs',
        no: '99999999',
      });
      expect((err as McpError).data).toHaveProperty('recovery.hint');
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

    it.each(LIVE_CASES)(
      'returns the %s %s record byte-identical on structuredContent',
      async (docType, no, key) => {
        mockService.getLegalDocument.mockResolvedValueOnce(structuredClone(LIVE[key]));

        const result = await runToolContract(getLegalDocument, { doc_type: docType, no });

        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as { document: unknown };
        expect(JSON.stringify(structured.document)).toBe(JSON.stringify(LIVE[key]));
      },
    );
  });

  describe('format', () => {
    it('renders the identifier header, scalar fields, and the documents section', () => {
      const blocks = getLegalDocument.format!({
        document: advisoryOpinion(),
        search_criteria: { doc_type: 'advisory_opinions', no: '2024-01' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**2024-01** — Sample Requestor LLC');
      expect(text).toContain('status: Final');
      expect(text).toContain('### documents (2)');
      expect(text).toContain('category: Final Opinion');
      expect(text).toContain('url: /files/final.pdf');
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
        'citations: 52 U.S.C. 30104(g) (https://www.govinfo.gov/link/uscode/52/30104); 52 U.S.C. 30118(a) (https://www.govinfo.gov/link/uscode/52/30118); 11 CFR 100.73 (/regulations/100-73/CURRENT)',
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
        'citations: 11 C.F.R. 100.5(g) (/regulations/100-5/CURRENT); 11 C.F.R. 110.3 (/regulations/110-3/CURRENT); 52 U.S.C. 30103(b)(2) (https://www.govinfo.gov/link/uscode/52/30103)',
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

      expect(text).toContain('### documents — entries 11–12 of 154 (offset 10)');
      expect(text).toContain('11.\n  category: Complaint');
      expect(text).toContain('12.\n  category: GCR');
      expect(text).toContain('_Continue with array documents and offset 12._');
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
});
