/**
 * @fileoverview Tests for the search-legal tool — validation, param mapping,
 * grouped format rendering, and penalty display.
 * @module tests/mcp-server/tools/definitions/search-legal.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = {
  searchCandidates: vi.fn(),
  getCandidate: vi.fn(),
  getCandidateTotals: vi.fn(),
  searchCommittees: vi.fn(),
  getCommittee: vi.fn(),
  searchContributions: vi.fn(),
  getContributionAggregates: vi.fn(),
  searchDisbursements: vi.fn(),
  getDisbursementAggregates: vi.fn(),
  searchExpenditures: vi.fn(),
  getExpendituresByCandidate: vi.fn(),
  searchFilings: vi.fn(),
  searchElections: vi.fn(),
  getElectionSummary: vi.fn(),
  searchLegal: vi.fn(),
  getCalendarDates: vi.fn(),
  getReportingDates: vi.fn(),
  getElectionDates: vi.fn(),
};

vi.mock('@/services/openfec/openfec-service.js', () => ({
  getOpenFecService: () => mockService,
  encodeCursor: vi.fn((indexes: Record<string, string>) => btoa(JSON.stringify(indexes))),
  decodeCursor: vi.fn((cursor: string) => JSON.parse(atob(cursor))),
}));

import { searchLegalTool } from '@/mcp-server/tools/definitions/search-legal.tool.js';

describe('searchLegalTool', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('searches legal docs by query', async () => {
      const results = [{ document_type: 'advisory_opinion', ao_no: '2024-01', name: 'Test AO' }];
      mockService.searchLegal.mockResolvedValueOnce({
        results,
        totalCount: 1,
      });

      const input = searchLegalTool.input.parse({ query: 'contribution limits' });
      const result = await searchLegalTool.handler(input, ctx as unknown as Context);

      expect(result.results).toEqual(results);
      expect(result.total_count).toBe(1);
      expect(mockService.searchLegal).toHaveBeenCalledOnce();
    });

    it('throws when no filter provided', async () => {
      const input = searchLegalTool.input.parse({});

      await expect(searchLegalTool.handler(input, ctx as unknown as Context)).rejects.toMatchObject(
        {
          code: JsonRpcErrorCode.InvalidParams,
        },
      );
    });

    it('passes ao_number as ao_no', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [],
        totalCount: 0,
      });

      const input = searchLegalTool.input.parse({ ao_number: '2024-01' });
      await searchLegalTool.handler(input, ctx as unknown as Context);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.ao_no).toBe('2024-01');
      expect(callArgs).not.toHaveProperty('ao_number');
    });

    it('passes case_number as case_no', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [],
        totalCount: 0,
      });

      const input = searchLegalTool.input.parse({ case_number: 'MUR-7890' });
      await searchLegalTool.handler(input, ctx as unknown as Context);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.case_no).toBe('MUR-7890');
      expect(callArgs).not.toHaveProperty('case_number');
    });
  });

  describe('format', () => {
    it('groups by document_type with labels', () => {
      const blocks = searchLegalTool.format!({
        results: [
          { document_type: 'advisory_opinion', ao_no: '2024-01', name: 'Test AO' },
          { document_type: 'mur', case_no: 'MUR-7890', name: 'MUR Case' },
          { document_type: 'advisory_opinion', ao_no: '2024-02', name: 'Another AO' },
        ],
        total_count: 3,
      });

      const text = blocks[0]!.text;
      expect(text).toContain('### Advisory Opinion');
      expect(text).toContain('### Matter Under Review (MUR)');
      expect(text).toContain('**2024-01**');
      expect(text).toContain('**2024-02**');
      expect(text).toContain('**MUR-7890**');
      expect(text).toContain('3 total matching document(s)');
    });

    it('renders penalty amounts', () => {
      const blocks = searchLegalTool.format!({
        results: [
          {
            document_type: 'admin_fine',
            no: 'AF-1234',
            name: 'Fine Case',
            penalty_amount: 25_000,
          },
        ],
        total_count: 1,
      });

      const text = blocks[0]!.text;
      expect(text).toContain('### Administrative Fine');
      expect(text).toContain('Penalty: $25,000');
    });

    it('renders empty state', () => {
      const blocks = searchLegalTool.format!({
        results: [],
        total_count: 0,
      });

      expect(blocks[0]!.text).toContain('No legal documents found');
    });
  });
});
