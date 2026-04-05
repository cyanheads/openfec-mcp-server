/**
 * @fileoverview Tests for the lookup-elections tool — validation guards,
 * search/summary mode routing, and format rendering.
 * @module tests/mcp-server/tools/definitions/lookup-elections.tool.test
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

import { lookupElectionsTool } from '@/mcp-server/tools/definitions/lookup-elections.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

describe('lookupElectionsTool', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('search mode returns election data', async () => {
      const elections = [
        {
          candidate_name: 'BIDEN, JOSEPH R JR',
          candidate_id: 'P00003392',
          party: 'DEM',
          total_receipts: 150_000_000,
          total_disbursements: 120_000_000,
        },
      ];
      mockService.searchElections.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: elections,
      });

      const input = lookupElectionsTool.input.parse({
        office: 'president',
        cycle: 2024,
      });
      const result = await lookupElectionsTool.handler(input, ctx as unknown as Context);

      expect(result.results).toEqual(elections);
      expect(mockService.searchElections).toHaveBeenCalledOnce();
    });

    it('summary mode calls getElectionSummary', async () => {
      const summary = [{ total_receipts: 500_000_000, total_disbursements: 400_000_000 }];
      mockService.getElectionSummary.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: summary,
      });

      const input = lookupElectionsTool.input.parse({
        mode: 'summary',
        office: 'president',
        cycle: 2024,
      });
      const result = await lookupElectionsTool.handler(input, ctx as unknown as Context);

      expect(result.results).toEqual(summary);
      expect(mockService.getElectionSummary).toHaveBeenCalledOnce();
      expect(mockService.searchElections).not.toHaveBeenCalled();
    });

    it('throws on odd cycle year', async () => {
      const input = lookupElectionsTool.input.parse({
        office: 'president',
        cycle: 2025,
      });

      await expect(
        lookupElectionsTool.handler(input, ctx as unknown as Context),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
      });
    });

    it('throws when senate lookup missing state', async () => {
      const input = lookupElectionsTool.input.parse({
        office: 'senate',
        cycle: 2024,
      });

      await expect(
        lookupElectionsTool.handler(input, ctx as unknown as Context),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
      });
    });

    it('throws when house lookup missing district', async () => {
      const input = lookupElectionsTool.input.parse({
        office: 'house',
        cycle: 2024,
        state: 'CA',
      });

      await expect(
        lookupElectionsTool.handler(input, ctx as unknown as Context),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
      });
    });

    it('president lookup does not require state or district', async () => {
      mockService.searchElections.mockResolvedValueOnce({
        pagination: PAGE,
        results: [],
      });

      const input = lookupElectionsTool.input.parse({
        office: 'president',
        cycle: 2024,
      });

      await expect(
        lookupElectionsTool.handler(input, ctx as unknown as Context),
      ).resolves.toBeDefined();
    });
  });

  describe('format', () => {
    it('renders candidate financial info', () => {
      const blocks = lookupElectionsTool.format!({
        results: [
          {
            candidate_name: 'SMITH, JANE',
            party_full: 'Democratic Party',
            incumbent_challenge_full: 'Incumbent',
            total_receipts: 5_000_000,
            total_disbursements: 4_000_000,
            cash_on_hand_end_period: 1_000_000,
            coverage_end_date: '2024-06-30',
          },
        ],
        pagination: { ...PAGE, count: 1 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('**SMITH, JANE**');
      expect(text).toContain('Democratic Party');
      expect(text).toContain('Incumbent');
      expect(text).toContain('Raised:');
      expect(text).toContain('Spent:');
      expect(text).toContain('Cash on hand:');
      expect(text).toContain('Through: 2024-06-30');
    });

    it('renders empty state', () => {
      const blocks = lookupElectionsTool.format!({
        results: [],
        pagination: PAGE,
      });

      expect(blocks[0]!.text).toBe('No election results found for the given criteria.');
    });
  });
});
