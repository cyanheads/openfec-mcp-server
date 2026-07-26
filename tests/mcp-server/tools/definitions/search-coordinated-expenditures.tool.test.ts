/**
 * @fileoverview Tests for the search-coordinated-expenditures tool — Schedule F
 * page-based search, committee hoisting, ID validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-coordinated-expenditures.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
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

import { searchCoordinatedExpenditures } from '@/mcp-server/tools/definitions/search-coordinated-expenditures.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

const committee = (id = 'C00003418') => ({
  committee_id: id,
  name: 'REPUBLICAN NATIONAL COMMITTEE',
  committee_type_full: 'Party - Qualified',
  designation_full: 'Unauthorized',
  party_full: 'REPUBLICAN PARTY',
  state: 'DC',
});

const row = (overrides: Record<string, unknown> = {}) => ({
  candidate_id: 'P80001571',
  candidate_name: 'TRUMP, DONALD J',
  candidate_office: 'P',
  committee_id: 'C00003418',
  expenditure_amount: 9_000_000,
  expenditure_date: '2024-08-07T00:00:00',
  expenditure_purpose_full: 'MEDIA BUY',
  expenditure_type_full: 'COORDINATED EXPENDITURE',
  payee_name: 'NATIONAL MEDIA RESEARCH',
  subordinate_committee_id: 'C00003418',
  committee: committee(),
  subordinate_committee: committee(),
  ...overrides,
});

describe('searchCoordinatedExpenditures', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('sends only the filters the caller supplied, under Schedule F parameter names', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [row()],
      });

      const input = searchCoordinatedExpenditures.input.parse({
        candidate_id: 'P80001571',
        cycle: 2024,
        payee_name: 'MEDIA',
        min_amount: 1000,
        max_date: '2024-11-05',
        sort: '-expenditure_amount',
      });
      await searchCoordinatedExpenditures.handler(input, ctx as unknown as Context);

      expect(mockService.searchCoordinatedExpenditures).toHaveBeenCalledOnce();
      const params = mockService.searchCoordinatedExpenditures.mock.calls[0]![0];
      expect(params).toEqual({
        page: 1,
        per_page: 20,
        candidate_id: 'P80001571',
        cycle: 2024,
        payee_name: 'MEDIA',
        min_amount: 1000,
        max_date: '2024-11-05',
        sort: '-expenditure_amount',
      });
    });

    it('echoes the effective criteria minus paging arguments', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [row()],
      });

      const input = searchCoordinatedExpenditures.input.parse({ cycle: 2024, per_page: 5 });
      const result = await searchCoordinatedExpenditures.handler(input, ctx as unknown as Context);

      expect(result.search_criteria).toEqual({ cycle: 2024 });
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('hoists the committee and drops subordinate_committee when scoped to one committee', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 2 },
        results: [row(), row({ expenditure_amount: 73_563 })],
      });

      const input = searchCoordinatedExpenditures.input.parse({ committee_id: 'C00003418' });
      const result = await searchCoordinatedExpenditures.handler(input, ctx as unknown as Context);

      expect(result.committee).toMatchObject({ committee_id: 'C00003418' });
      for (const r of result.results) {
        expect(r).not.toHaveProperty('committee');
        expect(r).not.toHaveProperty('subordinate_committee');
        expect(r).toHaveProperty('subordinate_committee_id', 'C00003418');
      }
    });

    it('keeps the per-row committee when the query spans committees, still dropping subordinate_committee', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 2 },
        results: [row(), row({ committee_id: 'C00010603', committee: committee('C00010603') })],
      });

      const input = searchCoordinatedExpenditures.input.parse({ cycle: 2024 });
      const result = await searchCoordinatedExpenditures.handler(input, ctx as unknown as Context);

      expect(result.committee).toBeUndefined();
      expect(result.results[0]).toHaveProperty('committee');
      expect(result.results[0]).not.toHaveProperty('subordinate_committee');
    });

    it('sets an enrichment notice when nothing matched', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: PAGE,
        results: [],
      });

      const input = searchCoordinatedExpenditures.input.parse({ cycle: 2024 });
      await searchCoordinatedExpenditures.handler(input, ctx as unknown as Context);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toContain('No coordinated party expenditures matched');
    });

    it('rejects a malformed committee_id before calling the API', async () => {
      const input = searchCoordinatedExpenditures.input.parse({ committee_id: 'NOPE' });
      const err = await searchCoordinatedExpenditures
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_committee_id' });
      expect(mockService.searchCoordinatedExpenditures).not.toHaveBeenCalled();
    });

    it('rejects a malformed candidate_id before calling the API', async () => {
      const input = searchCoordinatedExpenditures.input.parse({ candidate_id: 'X123' });
      const err = await searchCoordinatedExpenditures
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_candidate_id' });
      expect(mockService.searchCoordinatedExpenditures).not.toHaveBeenCalled();
    });

    it('rejects a sort field Schedule F does not expose', () => {
      expect(() =>
        searchCoordinatedExpenditures.input.parse({ sort: '-office_total_ytd' }),
      ).toThrow();
    });
  });

  describe('format', () => {
    it('renders the amount, candidate, date, and remaining row fields', () => {
      const blocks = searchCoordinatedExpenditures.format!({
        results: [row()],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { cycle: 2024 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('**$9,000,000 for TRUMP, DONALD J** — 2024-08-07');
      expect(text).toContain('payee_name: NATIONAL MEDIA RESEARCH');
      expect(text).toContain('expenditure_type_full: COORDINATED EXPENDITURE');
      expect(text).toContain('Page 1 of 1 · 1 total · 20 per page');
      expect(text).toContain('_Search criteria: cycle=2024_');
    });

    it('renders the hoisted committee header once', () => {
      const blocks = searchCoordinatedExpenditures.format!({
        results: [row(), row()],
        committee: committee(),
        pagination: { ...PAGE, count: 2 },
        search_criteria: { committee_id: 'C00003418' },
      });

      const text = blocks[0]!.text;
      expect(text.match(/applies to every row below/g)).toHaveLength(1);
      expect(text).toContain('REPUBLICAN NATIONAL COMMITTEE (C00003418)');
    });

    it('renders the empty state with the criteria echo and a recovery hint', () => {
      const blocks = searchCoordinatedExpenditures.format!({
        results: [],
        pagination: PAGE,
        search_criteria: { committee_id: 'C00703975', cycle: 2024 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('No results found.');
      expect(text).toContain('committee_id: C00703975');
      expect(text).toContain('only party committees report Schedule F');
    });
  });
});
