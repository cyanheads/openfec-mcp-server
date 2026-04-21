/**
 * @fileoverview Tests for the search-disbursements tool — itemized mode,
 * aggregate modes, cursor pagination, validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-disbursements.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
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

import { searchDisbursements } from '@/mcp-server/tools/definitions/search-disbursements.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

const disbursementRecord = (overrides: Record<string, unknown> = {}) => ({
  recipient_name: 'MEDIA STRATEGIES INC',
  disbursement_amount: 150_000,
  disbursement_date: '2024-05-10',
  disbursement_description: 'MEDIA BUY - TV',
  disbursement_purpose_category: 'ADVERTISING',
  committee_name: 'BIDEN FOR PRESIDENT',
  committee_id: 'C00703975',
  recipient_city: 'WASHINGTON',
  recipient_state: 'DC',
  ...overrides,
});

const aggregateRecord = (overrides: Record<string, unknown> = {}) => ({
  purpose: 'ADVERTISING',
  total: 3_500_000,
  count: 120,
  ...overrides,
});

describe('searchDisbursements', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('returns itemized disbursements with seek pagination', async () => {
      const disbursements = [disbursementRecord()];
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: disbursements,
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchDisbursements.handler(input, ctx as unknown as Context);

      expect(mockService.searchDisbursements).toHaveBeenCalledOnce();
      expect(result.results).toEqual(disbursements);
      expect(result.next_cursor).toBeNull();
      expect(result.count).toBe(1);
    });

    it('throws without committee_id', async () => {
      const input = searchDisbursements.input.parse({ committee_id: 'C00703975' });
      /**
       * committee_id is required in the schema, so we test the handler guard
       * by constructing an input that bypasses the schema default.
       */
      const rawInput = { ...input, committee_id: undefined } as unknown as typeof input;

      await expect(
        searchDisbursements.handler(rawInput, ctx as unknown as Context),
      ).rejects.toBeInstanceOf(McpError);
    });

    it('fetches by_purpose aggregates', async () => {
      const aggregates = [aggregateRecord()];
      mockService.getDisbursementAggregates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: aggregates,
      });

      const input = searchDisbursements.input.parse({
        mode: 'by_purpose',
        committee_id: 'C00703975',
      });
      const result = await searchDisbursements.handler(input, ctx as unknown as Context);

      expect(mockService.getDisbursementAggregates).toHaveBeenCalledWith(
        'by_purpose',
        expect.objectContaining({ committee_id: 'C00703975' }),
        ctx,
      );
      expect(result.results).toEqual(aggregates);
      expect(result.pagination).toBeDefined();
    });

    it('passes decoded cursor indexes into itemized params', async () => {
      const lastIndexes = { last_index: '500', last_disbursement_date: '2024-06-01' };
      const cursor = btoa(JSON.stringify(lastIndexes));

      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 100, per_page: 20 },
        results: [disbursementRecord()],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        cursor,
      });
      await searchDisbursements.handler(input, ctx as unknown as Context);

      const callArgs = mockService.searchDisbursements.mock.calls[0]![0];
      expect(callArgs.last_index).toBe('500');
      expect(callArgs.last_disbursement_date).toBe('2024-06-01');
    });
  });

  describe('format', () => {
    it('renders itemized disbursements with recipient and description', () => {
      const blocks = searchDisbursements.format!({
        results: [disbursementRecord()],
        next_cursor: null,
        count: 1,
      });

      const text = blocks[0]!.text;
      expect(text).toContain('MEDIA STRATEGIES INC');
      expect(text).toContain('recipient_city: WASHINGTON');
      expect(text).toContain('recipient_state: DC');
      expect(text).toContain('BIDEN FOR PRESIDENT');
      expect(text).toContain('MEDIA BUY - TV');
      expect(text).toContain('2024-05-10');
    });

    it('renders aggregate disbursements with purpose and count', () => {
      const blocks = searchDisbursements.format!({
        results: [aggregateRecord()],
        pagination: { ...PAGE, count: 1 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('purpose: ADVERTISING');
      expect(text).toContain('count: 120');
      expect(text).toContain('Page 1 of 1');
    });

    it('renders empty state', () => {
      const blocks = searchDisbursements.format!({
        results: [],
        count: 0,
      });

      expect(blocks[0]!.text).toContain('No results found');
    });
  });
});
