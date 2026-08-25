/**
 * @fileoverview Tests for the search-candidates tool — single lookup, search,
 * totals merging, validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-candidates.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

vi.mock('@/services/openfec/openfec-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/openfec/openfec-service.js')>()),
  getOpenFecService: () => mockService,
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

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

const makeCtx = () => createMockContext({ errors: searchCandidates.errors });

describe('searchCandidates', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
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
      const result = await searchCandidates.handler(input, ctx);

      expect(mockService.searchCandidates).toHaveBeenCalledOnce();
      expect(result.candidates).toEqual(candidates);
      expect(result.pagination.count).toBe(1);
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
      // The echo lands on non-empty responses too, so filters can be verified.
      expect(result.search_criteria).toMatchObject({ query: 'Biden' });
      expect(result.search_criteria).not.toHaveProperty('per_page');
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
      const result = await searchCandidates.handler(input, ctx);

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
      const result = await searchCandidates.handler(input, ctx);

      expect(mockService.getCandidateTotals).toHaveBeenCalledOnce();
      expect(result.totals).toEqual([totalsRecord()]);
    });

    it('throws on invalid candidate_id format with a friendly McpError', async () => {
      // .regex() removed from Zod schema — validation now fires in handler via validateCandidateId
      const input = searchCandidates.input.parse({ candidate_id: 'INVALID' });
      const err = await Promise.resolve(searchCandidates.handler(input, ctx)).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_candidate_id' });
    });

    it('pages the totals sub-fetch on its own terms instead of the candidate search page', async () => {
      const candidates = [
        candidateRecord({ candidate_id: 'S2CA01110', name: 'SMITH, A' }),
        candidateRecord({ candidate_id: 'S8MO00301', name: 'SMITH, B' }),
      ];
      mockService.searchCandidates.mockResolvedValueOnce({
        pagination: { page: 2, pages: 5, count: 90, per_page: 10 },
        results: candidates,
      });
      mockService.getCandidateTotals
        .mockResolvedValueOnce({
          pagination: { page: 1, pages: 2, count: 13, per_page: 100 },
          results: [totalsRecord({ candidate_id: 'S2CA01110', cycle: 2024 })],
        })
        .mockResolvedValueOnce({
          pagination: { page: 2, pages: 2, count: 13, per_page: 100 },
          results: [totalsRecord({ candidate_id: 'S8MO00301', cycle: 2020 })],
        });

      const input = searchCandidates.input.parse({
        query: 'smith',
        office: 'S',
        per_page: 10,
        page: 2,
        include_totals: true,
      });
      const result = await searchCandidates.handler(input, ctx);

      expect(mockService.getCandidateTotals).toHaveBeenCalledTimes(2);
      const [first, second] = mockService.getCandidateTotals.mock.calls.map((c) => c[0]);
      expect(first).toMatchObject({
        candidate_id: ['S2CA01110', 'S8MO00301'],
        page: 1,
        per_page: 100,
      });
      expect(second).toMatchObject({ page: 2, per_page: 100 });
      expect(result.totals).toHaveLength(2);
      expect(result.missing_totals).toBeUndefined();
    });

    it('reports candidates left uncovered when the totals fetch hits its page cap', async () => {
      mockService.searchCandidates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 2 },
        results: [
          candidateRecord({ candidate_id: 'S2CA01110' }),
          candidateRecord({ candidate_id: 'S8MO00301' }),
        ],
      });
      mockService.getCandidateTotals.mockResolvedValue({
        pagination: { page: 1, pages: 40, count: 4_000, per_page: 100 },
        results: [totalsRecord({ candidate_id: 'S2CA01110', cycle: 2024 })],
      });

      const input = searchCandidates.input.parse({ query: 'smith', include_totals: true });
      const result = await searchCandidates.handler(input, ctx);

      // Capped at 5 pages rather than walking all 40
      expect(mockService.getCandidateTotals).toHaveBeenCalledTimes(5);
      expect(result.missing_totals).toEqual(['S8MO00301']);
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
      const result = await searchCandidates.handler(input, ctx);

      expect(mockService.getCandidateTotals).not.toHaveBeenCalled();
      expect(result.totals).toBeUndefined();
    });

    it('sets enrichment notice when search returns empty results', async () => {
      mockService.searchCandidates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 0 },
        results: [],
      });

      const input = searchCandidates.input.parse({ query: 'Nonexistent Candidate' });
      await searchCandidates.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeDefined();
      expect(getEnrichment(ctx).notice).toContain('No candidates matched');
    });
  });

  describe('format', () => {
    it('renders the criteria echo on a non-empty response', () => {
      const blocks = searchCandidates.format!({
        candidates: [candidateRecord()],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { query: 'Biden', office: 'P' },
      });

      expect(formatText(blocks)).toContain('_Search criteria: query=Biden · office=P_');
    });

    it('renders candidate lines with pagination', () => {
      const blocks = searchCandidates.format!({
        candidates: [candidateRecord()],
        pagination: { ...PAGE, count: 1 },
        search_criteria: {},
      });

      const text = formatText(blocks);
      expect(text).toContain('**BIDEN, JOSEPH R JR** (P00003392)');
      expect(text).toContain('DEMOCRATIC PARTY');
      expect(text).toContain('President');
      expect(text).toContain('DE');
      expect(text).toContain('Page 1 of 1');
      expect(text).toContain('1 total');
      expect(text).toContain('per page');
    });

    it('renders "No candidates found" for empty results', () => {
      const blocks = searchCandidates.format!({
        candidates: [],
        pagination: PAGE,
        search_criteria: { query: 'NOSUCHCANDIDATE' },
      });

      expect(formatText(blocks)).toContain('No results found');
    });

    it('merges financial totals into candidate lines', () => {
      const blocks = searchCandidates.format!({
        candidates: [candidateRecord()],
        totals: [totalsRecord()],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { candidate_id: 'P00003392' },
      });

      const text = formatText(blocks);
      expect(text).toContain('receipts:');
      expect(text).toContain('disbursements:');
      expect(text).toContain('cash_on_hand_end_period:');
      expect(text).toContain('debts_owed_by_committee:');
      expect(text).toContain('coverage_end_date: 2024-06-30');
    });

    it('renders every totals row for a candidate, one per cycle', () => {
      const blocks = searchCandidates.format!({
        candidates: [candidateRecord()],
        totals: [
          totalsRecord({ cycle: 2016, receipts: 1_000_000 }),
          totalsRecord({ cycle: 2008, receipts: 2_000_000 }),
        ],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { candidate_id: 'P00003392' },
      });

      const text = formatText(blocks);
      expect(text).toContain('— Financial Totals (cycle 2016) —');
      expect(text).toContain('— Financial Totals (cycle 2008) —');
      expect(text).toContain('receipts: 1000000');
      expect(text).toContain('receipts: 2000000');
    });

    it('renders the uncovered candidates when totals are incomplete', () => {
      const blocks = searchCandidates.format!({
        candidates: [candidateRecord()],
        totals: [],
        missing_totals: ['S8MO00301', 'S0IL00402'],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { query: 'Biden' },
      });

      const text = formatText(blocks);
      expect(text).toContain('S8MO00301, S0IL00402');
      expect(text).toContain('candidate_id');
    });
  });
});
