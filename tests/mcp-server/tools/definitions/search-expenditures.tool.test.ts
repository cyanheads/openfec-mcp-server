/**
 * @fileoverview Tests for the search-expenditures tool — itemized mode,
 * by_candidate aggregates, support/oppose mapping, cursor pagination,
 * and format rendering.
 * @module tests/mcp-server/tools/definitions/search-expenditures.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
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

import { searchExpenditures } from '@/mcp-server/tools/definitions/search-expenditures.tool.js';
import { cursorQuery, encodeCursor } from '@/services/openfec/openfec-service.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

/** Build the cursor this tool would return for `args`, carrying `lastIndexes`. */
const cursorFor = (args: Record<string, unknown>, lastIndexes: Record<string, string>) =>
  encodeCursor(
    lastIndexes,
    cursorQuery('openfec_search_expenditures', searchExpenditures.input.parse(args)),
  );

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

/** The cycle the itemized branch falls back to when the caller omits one. */
const CURRENT_CYCLE = (() => {
  const year = new Date().getFullYear();
  return year % 2 === 0 ? year : year + 1;
})();

describe('searchExpenditures', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext({ errors: searchExpenditures.errors });
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
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('sets enrichment notice for empty itemized expenditures', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({ mode: 'itemized' });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeDefined();
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

    it('forwards page to the by_candidate endpoint', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { page: 2, pages: 17, count: 329, per_page: 20 },
        results: [byCandidateRecord()],
      });

      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_id: 'S6FL00123',
        page: 2,
      });
      const result = await searchExpenditures.handler(input, ctx as unknown as Context);

      expect(mockService.getExpendituresByCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2 }),
        ctx,
      );
      expect(result.pagination?.page).toBe(2);
    });

    it('sends the by_candidate endpoint its own parameter names, not the itemized ones', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [byCandidateRecord()],
      });

      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_id: 'H2OH09999',
        support_oppose: 'S',
        candidate_office: 'H',
        candidate_office_state: 'OH',
        candidate_office_district: '09',
        cycle: 2024,
      });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      const callArgs = mockService.getExpendituresByCandidate.mock.calls[0]![0];
      expect(callArgs).toMatchObject({
        support_oppose: 'S',
        office: 'house',
        state: 'OH',
        district: '09',
        cycle: 2024,
      });
      for (const dropped of [
        'support_oppose_indicator',
        'candidate_office',
        'candidate_office_state',
        'candidate_office_district',
        'candidate_party',
      ]) {
        expect(callArgs).not.toHaveProperty(dropped);
      }
    });

    it.each([
      ['S', 'senate'],
      ['P', 'president'],
    ])('translates candidate_office %s to office %s for by_candidate', async (letter, office) => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [byCandidateRecord()],
      });

      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_office: letter,
        candidate_office_state: 'OH',
      });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      expect(mockService.getExpendituresByCandidate.mock.calls[0]![0].office).toBe(office);
    });

    it('accepts office plus state as a by_candidate scope without a candidate_id', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 125 },
        results: [byCandidateRecord()],
      });

      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_office: 'S',
        candidate_office_state: 'OH',
        cycle: 2024,
      });
      const result = await searchExpenditures.handler(input, ctx as unknown as Context);

      expect(mockService.getExpendituresByCandidate).toHaveBeenCalledOnce();
      expect(result.pagination?.count).toBe(125);
    });

    it('accepts a presidential by_candidate scope from the office alone', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 943 },
        results: [byCandidateRecord()],
      });

      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_office: 'P',
        cycle: 2024,
      });
      const result = await searchExpenditures.handler(input, ctx as unknown as Context);

      const callArgs = mockService.getExpendituresByCandidate.mock.calls[0]![0];
      expect(callArgs).toMatchObject({ office: 'president', cycle: 2024 });
      expect(callArgs).not.toHaveProperty('state');
      expect(result.pagination?.count).toBe(943);
    });

    it('rejects a by_candidate Senate scope with no state, which the endpoint would 422', async () => {
      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_office: 'S',
      });

      const err = await searchExpenditures
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'by_candidate_requires_scope' });
      expect(mockService.getExpendituresByCandidate).not.toHaveBeenCalled();
    });

    it('rejects a by_candidate House scope with no district, which the endpoint would 422', async () => {
      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_office: 'H',
        candidate_office_state: 'OH',
      });

      const err = await searchExpenditures
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'by_candidate_requires_scope' });
      expect(mockService.getExpendituresByCandidate).not.toHaveBeenCalled();
    });

    it('rejects by_candidate with neither a candidate_id nor a race scope', async () => {
      const input = searchExpenditures.input.parse({ mode: 'by_candidate', cycle: 2024 });

      const err = await searchExpenditures
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      const data = (err as McpError).data as { reason: string; recovery: { hint: string } };
      expect(data.reason).toBe('by_candidate_requires_scope');
      expect(data.recovery.hint).toContain('candidate_office');
      expect(mockService.getExpendituresByCandidate).not.toHaveBeenCalled();
    });

    it('rejects candidate_party in by_candidate rather than dropping it silently', async () => {
      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_id: 'S6FL00123',
        candidate_party: 'DEM',
      });

      const err = await searchExpenditures
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({
        reason: 'candidate_party_not_supported_by_candidate',
      });
      expect(mockService.getExpendituresByCandidate).not.toHaveBeenCalled();
    });

    it('does not send page on the itemized keyset call, and keeps the cursor valid across pages', async () => {
      const cursor = cursorFor(
        { mode: 'itemized', committee_id: 'C00111111', page: 1 },
        { last_index: '42' },
      );

      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 200, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
        page: 5,
        cursor,
      });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      const [callArgs] = mockService.searchExpenditures.mock.calls[0]!;
      expect(callArgs.page).toBeUndefined();
      expect(callArgs.last_index).toBe('42');
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
      const query = { mode: 'itemized', committee_id: 'C00111111' };
      const cursor = cursorFor(query, {
        last_index: '42',
        last_expenditure_date: '2024-09-15',
      });

      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 200, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({ ...query, cursor });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      const [callArgs, callQuery] = mockService.searchExpenditures.mock.calls[0]!;
      expect(callArgs.last_index).toBe('42');
      expect(callArgs.last_expenditure_date).toBe('2024-09-15');
      expect(callQuery).toEqual({
        scope: 'openfec_search_expenditures',
        args: { mode: 'itemized', committee_id: 'C00111111', most_recent: 'true' },
      });
    });

    it('rejects a malformed cursor with an invalid_cursor reason and recovery hint', async () => {
      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
        cursor: 'not-a-cursor',
      });

      const err = await searchExpenditures
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      const data = (err as McpError).data as { reason: string; recovery: { hint: string } };
      expect(data.reason).toBe('invalid_cursor');
      expect(data.recovery.hint).toContain('Omit cursor');
      expect(mockService.searchExpenditures).not.toHaveBeenCalled();
    });

    it('rejects a cursor replayed under a changed sort', async () => {
      const cursor = cursorFor(
        { mode: 'itemized', committee_id: 'C00111111', sort: 'expenditure_amount' },
        { last_index: '42' },
      );

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
        sort: '-expenditure_amount',
        cursor,
      });

      const err = await searchExpenditures
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      const data = (err as McpError).data as { reason: string; changed_arguments: string[] };
      expect(data.reason).toBe('cursor_query_mismatch');
      expect(data.changed_arguments).toEqual([
        'sort (cursor: "expenditure_amount", call: "-expenditure_amount")',
      ]);
      expect(mockService.searchExpenditures).not.toHaveBeenCalled();
    });

    it('passes a descending sort through to the FEC params', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
        sort: '-expenditure_amount',
      });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      expect(mockService.searchExpenditures.mock.calls[0]![0].sort).toBe('-expenditure_amount');
    });

    it('sorts nulls last so -office_total_ytd leads with real totals, not empty rows', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
        sort: '-office_total_ytd',
      });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      expect(mockService.searchExpenditures.mock.calls[0]![0].sort_nulls_last).toBe(true);
    });

    it('omits sort_nulls_last when no sort is requested', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
      });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      expect(mockService.searchExpenditures.mock.calls[0]![0].sort_nulls_last).toBeUndefined();
    });

    it('scopes an unfiltered itemized call to the current cycle', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({});
      await searchExpenditures.handler(input, ctx as unknown as Context);

      expect(mockService.searchExpenditures.mock.calls[0]![0].cycle).toBe(CURRENT_CYCLE);
    });

    it('keeps an explicit itemized cycle instead of the default', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({ mode: 'itemized', cycle: 2020 });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      expect(mockService.searchExpenditures.mock.calls[0]![0].cycle).toBe(2020);
    });

    it('sends the itemized endpoint its own office/state/district parameter names', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        candidate_office: 'H',
        candidate_office_state: 'OH',
        candidate_office_district: '09',
        candidate_party: 'DEM',
      });
      await searchExpenditures.handler(input, ctx as unknown as Context);

      const callArgs = mockService.searchExpenditures.mock.calls[0]![0];
      expect(callArgs).toMatchObject({
        candidate_office: 'H',
        candidate_office_state: 'OH',
        candidate_office_district: '09',
        candidate_party: 'DEM',
      });
      expect(callArgs).not.toHaveProperty('office');
      expect(callArgs).not.toHaveProperty('state');
      expect(callArgs).not.toHaveProperty('district');
    });

    it('accepts every ascending and descending sort value the schema advertises', () => {
      for (const sort of [
        'expenditure_date',
        '-expenditure_date',
        'expenditure_amount',
        '-expenditure_amount',
        'office_total_ytd',
        '-office_total_ytd',
      ]) {
        expect(
          searchExpenditures.input.parse({ mode: 'itemized', committee_id: 'C00111111', sort })
            .sort,
        ).toBe(sort);
      }
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

    it('delimits next_cursor so its end is unambiguous', () => {
      const cursor = 'eyJxIjp7InNjb3BlIjoib3BlbmZlY19zZWFyY2hfZXhwZW5kaXR1cmVzIn19=';
      const blocks = searchExpenditures.format!({
        results: [expenditureRecord()],
        next_cursor: cursor,
        count: 200,
      });

      const text = blocks[0]!.text;
      expect(text).toContain(`next_cursor: \`${cursor}\``);
      expect(text).not.toContain(`${cursor}_`);
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
      expect(text).toContain('Page 1 of 1');
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
