/**
 * @fileoverview Tests for the search-committees tool — single lookup, search,
 * validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-committees.tool.test
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

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

const makeCtx = () => createMockContext({ errors: searchCommittees.errors });

describe('searchCommittees', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
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
      const result = await searchCommittees.handler(input, ctx);

      expect(mockService.searchCommittees).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'Biden', page: 1, per_page: 20 }),
        ctx,
      );
      expect(result.committees).toEqual(committees);
      expect(result.pagination.count).toBe(1);
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
      // The echo lands on non-empty responses too, so filters can be verified.
      expect(result.search_criteria).toMatchObject({ query: 'Biden' });
      expect(result.search_criteria).not.toHaveProperty('per_page');
    });

    it('sets enrichment notice when search returns empty results', async () => {
      mockService.searchCommittees.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 0 },
        results: [],
      });

      const input = searchCommittees.input.parse({ query: 'Nonexistent' });
      await searchCommittees.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeDefined();
      expect(getEnrichment(ctx).notice).toContain('No committees matched');
    });

    it('fetches a single committee by ID', async () => {
      const committees = [committeeRecord()];
      mockService.getCommittee.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: committees,
      });

      const input = searchCommittees.input.parse({ committee_id: 'C00703975' });
      const result = await searchCommittees.handler(input, ctx);

      expect(mockService.getCommittee).toHaveBeenCalledWith('C00703975', ctx);
      expect(result.committees).toEqual(committees);
    });

    it('returns only the effective committee-ID criterion on both output paths', async () => {
      mockService.getCommittee.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [committeeRecord()],
      });

      const input = searchCommittees.input.parse({ committee_id: 'C00703975' });
      const result = await searchCommittees.handler(input, ctx);

      expect(result.search_criteria).toEqual({ committee_id: 'C00703975' });
      expect(formatText(searchCommittees.format!(result))).toContain(
        '_Search criteria: committee_id=C00703975_',
      );
    });

    it('rejects every explicit search-only input on the direct-ID path', async () => {
      const input = searchCommittees.input.parse({
        committee_id: 'C00703975',
        query: 'Biden',
        candidate_id: 'P00003392',
        state: 'ZZ',
        party: 'DEM',
        committee_type: 'P',
        designation: 'P',
        cycle: 2024,
        treasurer_name: 'SMITH',
        page: 2,
        per_page: 50,
      });
      const err = (await Promise.resolve(searchCommittees.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({
        reason: 'inputs_not_applicable_to_id_lookup',
        inapplicable_inputs: [
          'query',
          'candidate_id',
          'state',
          'party',
          'committee_type',
          'designation',
          'cycle',
          'treasurer_name',
          'page',
          'per_page',
        ],
        supported_inputs: ['committee_id'],
      });
      expect((err.data as { recovery: { hint: string } }).recovery.hint).toBeTruthy();
      expect(mockService.getCommittee).not.toHaveBeenCalled();
      expect(mockService.searchCommittees).not.toHaveBeenCalled();
    });

    it('throws on invalid committee_id format with a friendly McpError', async () => {
      // .regex() removed from Zod schema — validation now fires in handler via validateCommitteeId
      const input = searchCommittees.input.parse({ committee_id: 'INVALID' });
      const err = await Promise.resolve(searchCommittees.handler(input, ctx)).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_committee_id' });
    });
  });

  describe('format', () => {
    it('renders the criteria echo on a non-empty response', () => {
      const blocks = searchCommittees.format!({
        committees: [committeeRecord()],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { query: 'Biden', state: 'DE' },
      });

      expect(formatText(blocks)).toContain('_Search criteria: query=Biden · state=DE_');
    });

    it('renders committee lines with type, designation, party, and state', () => {
      const blocks = searchCommittees.format!({
        committees: [committeeRecord()],
        pagination: { ...PAGE, count: 1 },
        search_criteria: {},
      });

      const text = formatText(blocks);
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
        search_criteria: { query: 'NOSUCHCOMMITTEE' },
      });

      expect(formatText(blocks)).toContain('No results found');
    });

    it('includes candidate_ids when present', () => {
      const blocks = searchCommittees.format!({
        committees: [committeeRecord({ candidate_ids: ['P00003392', 'P00004455'] })],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { candidate_id: 'P00003392' },
      });

      const text = formatText(blocks);
      expect(text).toContain('candidate_ids: P00003392, P00004455');
    });
  });

  describe('exhausted position', () => {
    it('reports a page past the end as exhausted on both surfaces', async () => {
      mockService.searchCommittees.mockResolvedValueOnce({
        pagination: { page: 50, pages: 1, count: 1, per_page: 20 },
        results: [],
      });

      const input = searchCommittees.input.parse({ query: 'ACTBLUE', page: 50 });
      const result = await searchCommittees.handler(input, ctx);

      expect(result.pagination).toMatchObject({ page: 50, pages: 1, count: 1 });
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toContain('Page 50 is past the last page');
      expect(getEnrichment(ctx).notice).not.toContain('No committees matched');

      const text = formatText(searchCommittees.format!(result));
      expect(text).toContain('No results at this position.');
      expect(text).toContain('1 total');
      expect(text).not.toContain('No results found');
    });

    it('keeps zero-match guidance when nothing matched at all', async () => {
      mockService.searchCommittees.mockResolvedValueOnce({
        pagination: { page: 1, pages: 0, count: 0, per_page: 20 },
        results: [],
      });

      const input = searchCommittees.input.parse({ query: 'NOSUCHCOMMITTEE' });
      const result = await searchCommittees.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('No committees matched');

      const text = formatText(searchCommittees.format!(result));
      expect(text).toContain('No results found.');
      expect(text).not.toContain('No results at this position');
    });
  });
});
