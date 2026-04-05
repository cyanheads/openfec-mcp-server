/**
 * @fileoverview Tests for the search-contributions tool — itemized mode,
 * aggregate modes, cursor pagination, validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-contributions.tool.test
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

import { searchContributions } from '@/mcp-server/tools/definitions/search-contributions.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

const contributionRecord = (overrides: Record<string, unknown> = {}) => ({
  contributor_name: 'DOE, JANE',
  contributor_employer: 'ACME CORP',
  contribution_receipt_amount: 2800,
  contribution_receipt_date: '2024-03-15',
  committee_name: 'BIDEN FOR PRESIDENT',
  committee_id: 'C00703975',
  contributor_city: 'SEATTLE',
  contributor_state: 'WA',
  ...overrides,
});

const aggregateRecord = (overrides: Record<string, unknown> = {}) => ({
  size: 200,
  total: 5_000_000,
  count: 25_000,
  ...overrides,
});

describe('searchContributions', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('returns itemized contributions with committee_id', async () => {
      const contributions = [contributionRecord()];
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: contributions,
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchContributions.handler(input, ctx as unknown as Context);

      expect(mockService.searchContributions).toHaveBeenCalledOnce();
      expect(result.results).toEqual(contributions);
      expect(result.next_cursor).toBeNull();
      expect(result.count).toBe(1);
    });

    it('throws without committee_id in itemized mode', async () => {
      const input = searchContributions.input.parse({ mode: 'itemized' });

      await expect(
        searchContributions.handler(input, ctx as unknown as Context),
      ).rejects.toBeInstanceOf(McpError);
    });

    it('fetches by_size aggregates', async () => {
      const aggregates = [aggregateRecord()];
      mockService.getContributionAggregates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: aggregates,
      });

      const input = searchContributions.input.parse({
        mode: 'by_size',
        committee_id: 'C00703975',
      });
      const result = await searchContributions.handler(input, ctx as unknown as Context);

      expect(mockService.getContributionAggregates).toHaveBeenCalledWith(
        'by_size',
        expect.objectContaining({ committee_id: 'C00703975' }),
        ctx,
      );
      expect(result.results).toEqual(aggregates);
      expect(result.pagination).toBeDefined();
    });

    it('routes to by_size_candidate when candidate_id provided', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [aggregateRecord()],
      });

      const input = searchContributions.input.parse({
        mode: 'by_size',
        candidate_id: 'P00003392',
      });
      await searchContributions.handler(input, ctx as unknown as Context);

      expect(mockService.getContributionAggregates).toHaveBeenCalledWith(
        'by_size_candidate',
        expect.objectContaining({ candidate_id: 'P00003392' }),
        ctx,
      );
    });

    it('requires committee_id for by_employer mode', async () => {
      const input = searchContributions.input.parse({ mode: 'by_employer' });

      await expect(
        searchContributions.handler(input, ctx as unknown as Context),
      ).rejects.toBeInstanceOf(McpError);
    });

    it('passes decoded cursor indexes into params', async () => {
      const lastIndexes = { last_index: '999', last_contribution_receipt_date: '2024-01-01' };
      const cursor = btoa(JSON.stringify(lastIndexes));

      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 50, per_page: 20 },
        results: [contributionRecord()],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        cursor,
      });
      await searchContributions.handler(input, ctx as unknown as Context);

      const callArgs = mockService.searchContributions.mock.calls[0]![0];
      expect(callArgs.last_index).toBe('999');
      expect(callArgs.last_contribution_receipt_date).toBe('2024-01-01');
    });
  });

  describe('format', () => {
    it('renders itemized results with donor info', () => {
      const blocks = searchContributions.format!({
        results: [contributionRecord()],
        next_cursor: null,
        count: 1,
      });

      const text = blocks[0]!.text;
      expect(text).toContain('DOE, JANE');
      expect(text).toContain('contributor_city: SEATTLE');
      expect(text).toContain('contributor_state: WA');
      expect(text).toContain('BIDEN FOR PRESIDENT');
      expect(text).toContain('ACME CORP');
      expect(text).toContain('2024-03-15');
    });

    it('renders aggregate results', () => {
      const blocks = searchContributions.format!({
        results: [aggregateRecord()],
        pagination: { ...PAGE, count: 1 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('size: 200');
      expect(text).toContain('count: 25000');
      expect(text).toContain('1 aggregate rows');
    });

    it('renders empty results message', () => {
      const blocks = searchContributions.format!({
        results: [],
        count: 0,
      });

      expect(blocks[0]!.text).toContain('No contributions found');
    });
  });
});
