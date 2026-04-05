/**
 * @fileoverview Tests for the search-candidates tool — single lookup, search,
 * totals merging, validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-candidates.tool.test
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

import { searchCandidates } from '@/mcp-server/tools/definitions/search-candidates.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

const candidateRecord = (overrides: Record<string, unknown> = {}) => ({
  candidate_id: 'P00003392',
  name: 'BIDEN, JOSEPH R JR',
  party_full: 'DEMOCRATIC PARTY',
  party: 'DEM',
  state: 'DE',
  office_full: 'President',
  office: 'P',
  incumbent_challenge_full: 'Incumbent',
  incumbent_challenge: 'I',
  district_number: 0,
  ...overrides,
});

const totalsRecord = (overrides: Record<string, unknown> = {}) => ({
  candidate_id: 'P00003392',
  receipts: 250_000_000,
  disbursements: 200_000_000,
  cash_on_hand_end_period: 50_000_000,
  debts_owed_by_committee: 1_000_000,
  coverage_end_date: '2024-06-30',
  ...overrides,
});

describe('searchCandidates', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('searches candidates by query', async () => {
      const candidates = [candidateRecord()];
      mockService.searchCandidates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: candidates,
      });

      const input = searchCandidates.input.parse({ query: 'Biden' });
      const result = await searchCandidates.handler(input, ctx as unknown as Context);

      expect(mockService.searchCandidates).toHaveBeenCalledOnce();
      expect(result.candidates).toEqual(candidates);
      expect(result.pagination.count).toBe(1);
    });

    it('fetches a single candidate by ID', async () => {
      const candidates = [candidateRecord()];
      mockService.getCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: candidates,
      });
      mockService.getCandidateTotals.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [totalsRecord()],
      });

      const input = searchCandidates.input.parse({ candidate_id: 'P00003392' });
      const result = await searchCandidates.handler(input, ctx as unknown as Context);

      expect(mockService.getCandidate).toHaveBeenCalledWith('P00003392', ctx);
      expect(result.candidates).toEqual(candidates);
    });

    it('auto-includes totals when fetching by candidate_id', async () => {
      mockService.getCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [candidateRecord()],
      });
      mockService.getCandidateTotals.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [totalsRecord()],
      });

      const input = searchCandidates.input.parse({ candidate_id: 'P00003392' });
      const result = await searchCandidates.handler(input, ctx as unknown as Context);

      expect(mockService.getCandidateTotals).toHaveBeenCalledOnce();
      expect(result.totals).toEqual([totalsRecord()]);
    });

    it('throws on invalid candidate_id format', async () => {
      const input = searchCandidates.input.parse({ candidate_id: 'INVALID' });

      await expect(
        searchCandidates.handler(input, ctx as unknown as Context),
      ).rejects.toBeInstanceOf(McpError);
    });

    it('skips totals when include_totals=false', async () => {
      mockService.getCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [candidateRecord()],
      });

      const input = searchCandidates.input.parse({
        candidate_id: 'P00003392',
        include_totals: false,
      });
      const result = await searchCandidates.handler(input, ctx as unknown as Context);

      expect(mockService.getCandidateTotals).not.toHaveBeenCalled();
      expect(result.totals).toBeUndefined();
    });
  });

  describe('format', () => {
    it('renders candidate lines with pagination', () => {
      const blocks = searchCandidates.format!({
        candidates: [candidateRecord()],
        pagination: { ...PAGE, count: 1 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('**BIDEN, JOSEPH R JR** (P00003392)');
      expect(text).toContain('DEMOCRATIC PARTY');
      expect(text).toContain('President');
      expect(text).toContain('DE');
      expect(text).toContain('Page 1 of 1 (1 total)');
    });

    it('renders "No candidates found" for empty results', () => {
      const blocks = searchCandidates.format!({
        candidates: [],
        pagination: PAGE,
      });

      expect(blocks[0]!.text).toContain('No candidates found');
    });

    it('merges financial totals into candidate lines', () => {
      const blocks = searchCandidates.format!({
        candidates: [candidateRecord()],
        totals: [totalsRecord()],
        pagination: { ...PAGE, count: 1 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('Receipts:');
      expect(text).toContain('Disbursements:');
      expect(text).toContain('Cash on Hand:');
      expect(text).toContain('Debt:');
      expect(text).toContain('Through: 2024-06-30');
    });
  });
});
