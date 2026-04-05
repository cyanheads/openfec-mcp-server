/**
 * @fileoverview Tests for the search-expenditures tool — itemized mode,
 * by_candidate aggregates, support/oppose mapping, cursor pagination,
 * and format rendering.
 * @module tests/mcp-server/tools/definitions/search-expenditures.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
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

import { searchExpenditures } from '@/mcp-server/tools/definitions/search-expenditures.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

const expenditureRecord = (overrides: Record<string, unknown> = {}) => ({
  support_oppose_indicator: 'S',
  expenditure_amount: 500_000,
  expenditure_date: '2024-10-01',
  committee_name: 'AMERICANS FOR PROGRESS',
  committee_id: 'C00111111',
  candidate_name: 'SMITH, JOHN',
  candidate_id: 'H2OH01234',
  candidate_office: 'H',
  candidate_office_state: 'OH',
  payee_name: 'MEDIA PARTNERS LLC',
  expenditure_description: 'TV advertising buy',
  is_notice: false,
  ...overrides,
});

const byCandidateRecord = (overrides: Record<string, unknown> = {}) => ({
  support_oppose_indicator: 'O',
  candidate_name: 'JONES, ALICE',
  candidate_id: 'S6FL00123',
  committee_name: 'CITIZENS UNITED PAC',
  committee_id: 'C00222222',
  total: 1_200_000,
  count: 45,
  ...overrides,
});

describe('searchExpenditures', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('returns itemized expenditures', async () => {
      const expenditures = [expenditureRecord()];
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: expenditures,
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
      });
      const result = await searchExpenditures.handler(input, ctx as unknown as Context);

      expect(mockService.searchExpenditures).toHaveBeenCalledOnce();
      expect(result.results).toEqual(expenditures);
      expect(result.next_cursor).toBeNull();
      expect(result.count).toBe(1);
    });

    it('fetches by_candidate aggregates', async () => {
      const aggregates = [byCandidateRecord()];
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: aggregates,
      });

      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_id: 'S6FL00123',
      });
      const result = await searchExpenditures.handler(input, ctx as unknown as Context);

      expect(mockService.getExpendituresByCandidate).toHaveBeenCalledOnce();
      expect(result.results).toEqual(aggregates);
      expect(result.pagination).toBeDefined();
    });

    it('maps support_oppose to support_oppose_indicator in params', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        support_oppose: 'O',
      });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      const callArgs = mockService.searchExpenditures.mock.calls[0]![0];
      expect(callArgs.support_oppose_indicator).toBe('O');
      expect(callArgs).not.toHaveProperty('support_oppose');
    });

    it('passes decoded cursor indexes into itemized params', async () => {
      const lastIndexes = { last_index: '42', last_expenditure_date: '2024-09-15' };
      const cursor = btoa(JSON.stringify(lastIndexes));

      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 200, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
        cursor,
      });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      const callArgs = mockService.searchExpenditures.mock.calls[0]![0];
      expect(callArgs.last_index).toBe('42');
      expect(callArgs.last_expenditure_date).toBe('2024-09-15');
    });
  });

  describe('format', () => {
    it('renders itemized expenditures with SUPPORT/OPPOSE labels', () => {
      const blocks = searchExpenditures.format!({
        results: [
          expenditureRecord({ support_oppose_indicator: 'S' }),
          expenditureRecord({
            support_oppose_indicator: 'O',
            candidate_name: 'RIVAL, BOB',
            expenditure_amount: 250_000,
          }),
        ],
        next_cursor: null,
        count: 2,
      });

      const text = blocks[0]!.text;
      expect(text).toContain('[SUPPORT]');
      expect(text).toContain('[OPPOSE]');
      expect(text).toContain('SMITH, JOHN');
      expect(text).toContain('RIVAL, BOB');
      expect(text).toContain('AMERICANS FOR PROGRESS');
      expect(text).toContain('MEDIA PARTNERS LLC');
    });

    it('renders by_candidate aggregate results', () => {
      const blocks = searchExpenditures.format!({
        results: [byCandidateRecord()],
        pagination: { ...PAGE, count: 1 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('[OPPOSE]');
      expect(text).toContain('JONES, ALICE');
      expect(text).toContain('CITIZENS UNITED PAC');
      expect(text).toContain('count: 45');
      expect(text).toContain('1 candidate-committee pairs');
    });

    it('renders empty state', () => {
      const blocks = searchExpenditures.format!({
        results: [],
        count: 0,
      });

      expect(blocks[0]!.text).toContain('No results found');
    });
  });
});
