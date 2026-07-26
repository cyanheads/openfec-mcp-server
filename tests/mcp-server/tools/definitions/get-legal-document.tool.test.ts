/**
 * @fileoverview Tests for the get-legal-document tool — full-record retrieval,
 * the not-found contract, enrichment, and format rendering of the arrays
 * openfec_search_legal trims away.
 * @module tests/mcp-server/tools/definitions/get-legal-document.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

describe('getLegalDocument', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext({ errors: getLegalDocument.errors });
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('passes the plural doc_type and the number straight through to the service', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce(advisoryOpinion());

      const input = getLegalDocument.input.parse({
        doc_type: 'advisory_opinions',
        no: '2024-01',
      });
      const result = await getLegalDocument.handler(input, ctx as unknown as Context);

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
      const result = await getLegalDocument.handler(input, ctx as unknown as Context);

      expect(result.document.documents).toHaveLength(2);
      expect(getEnrichment(ctx).attachedDocumentCount).toBe(2);
    });

    it('reports zero attached documents when the record carries none', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce(mur());

      const input = getLegalDocument.input.parse({ doc_type: 'murs', no: '7226' });
      await getLegalDocument.handler(input, ctx as unknown as Context);

      expect(getEnrichment(ctx).attachedDocumentCount).toBe(0);
    });

    it('counts zero when the record omits the documents field entirely', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce({ no: 1, name: 'Statute' });

      const input = getLegalDocument.input.parse({ doc_type: 'statutes', no: '1' });
      const result = await getLegalDocument.handler(input, ctx as unknown as Context);

      expect(getEnrichment(ctx).attachedDocumentCount).toBe(0);
      expect(result.document).toEqual({ no: 1, name: 'Statute' });
    });

    it('throws legal_document_not_found with a recovery hint when no record exists', async () => {
      mockService.getLegalDocument.mockResolvedValueOnce(null);

      const input = getLegalDocument.input.parse({ doc_type: 'murs', no: '99999999' });
      const err = await getLegalDocument
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

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
  });

  describe('format', () => {
    it('renders the identifier header, scalar fields, and the documents section', () => {
      const blocks = getLegalDocument.format!({
        document: advisoryOpinion(),
        search_criteria: { doc_type: 'advisory_opinions', no: '2024-01' },
      });

      const text = blocks[0]!.text;
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

      const text = blocks[0]!.text;
      expect(text).toContain('**7226** — Example Committee');
      expect(text).toContain('### commission_votes (1)');
      expect(text).toContain('action: Failed to find reason to believe.');
      expect(text).toContain('### dispositions (1)');
      expect(text).toContain('disposition_description: Dismissed');
      expect(text).not.toContain('### documents');
    });

    it('falls back to a generic heading when the record carries no identifier or name', () => {
      const blocks = getLegalDocument.format!({
        document: { type: 'statute' },
        search_criteria: { doc_type: 'statutes', no: '1' },
      });

      expect(blocks[0]!.text).toContain('**Legal document**');
    });
  });
});
