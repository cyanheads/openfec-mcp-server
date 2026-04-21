/**
 * @fileoverview Tests for the search-committees tool — single lookup, search,
 * validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-committees.tool.test
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

import { searchCommittees } from '@/mcp-server/tools/definitions/search-committees.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

const committeeRecord = (overrides: Record<string, unknown> = {}) => ({
  committee_id: 'C00703975',
  name: 'BIDEN FOR PRESIDENT',
  committee_type_full: 'Presidential',
  committee_type: 'P',
  designation_full: 'Principal campaign committee',
  designation: 'P',
  party_full: 'DEMOCRATIC PARTY',
  party: 'DEM',
  state: 'DE',
  treasurer_name: 'DILLON, JENNIFER OHARA',
  ...overrides,
});

describe('searchCommittees', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('searches committees by query', async () => {
      const committees = [committeeRecord()];
      mockService.searchCommittees.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: committees,
      });

      const input = searchCommittees.input.parse({ query: 'Biden' });
      const result = await searchCommittees.handler(input, ctx as unknown as Context);

      expect(mockService.searchCommittees).toHaveBeenCalledOnce();
      expect(result.committees).toEqual(committees);
      expect(result.pagination.count).toBe(1);
    });

    it('fetches a single committee by ID', async () => {
      const committees = [committeeRecord()];
      mockService.getCommittee.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: committees,
      });

      const input = searchCommittees.input.parse({ committee_id: 'C00703975' });
      const result = await searchCommittees.handler(input, ctx as unknown as Context);

      expect(mockService.getCommittee).toHaveBeenCalledWith('C00703975', ctx);
      expect(result.committees).toEqual(committees);
    });

    it('throws on invalid committee_id format', async () => {
      const input = searchCommittees.input.parse({ committee_id: 'INVALID' });

      await expect(
        searchCommittees.handler(input, ctx as unknown as Context),
      ).rejects.toBeInstanceOf(McpError);
    });
  });

  describe('format', () => {
    it('renders committee lines with type, designation, party, and state', () => {
      const blocks = searchCommittees.format!({
        committees: [committeeRecord()],
        pagination: { ...PAGE, count: 1 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('**BIDEN FOR PRESIDENT** (C00703975)');
      expect(text).toContain('committee_type_full: Presidential');
      expect(text).toContain('designation_full: Principal campaign committee');
      expect(text).toContain('party_full: DEMOCRATIC PARTY');
      expect(text).toContain('state: DE');
      expect(text).toContain('treasurer_name: DILLON, JENNIFER OHARA');
      expect(text).toContain('Page 1 of 1');
      expect(text).toContain('1 total');
      expect(text).toContain('per page');
    });

    it('renders empty state', () => {
      const blocks = searchCommittees.format!({
        committees: [],
        pagination: PAGE,
      });

      expect(blocks[0]!.text).toContain('No results found');
    });

    it('includes candidate_ids when present', () => {
      const blocks = searchCommittees.format!({
        committees: [committeeRecord({ candidate_ids: ['P00003392', 'P00004455'] })],
        pagination: { ...PAGE, count: 1 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('candidate_ids: P00003392, P00004455');
    });
  });
});
