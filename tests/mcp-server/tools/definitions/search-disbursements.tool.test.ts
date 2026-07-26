/**
 * @fileoverview Tests for the search-disbursements tool — itemized mode,
 * aggregate modes, cursor pagination, validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-disbursements.tool.test
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

import { searchDisbursements } from '@/mcp-server/tools/definitions/search-disbursements.tool.js';
import { cursorQuery, encodeCursor } from '@/services/openfec/openfec-service.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

/** Build the cursor this tool would return for `args`, carrying `lastIndexes`. */
const cursorFor = (args: Record<string, unknown>, lastIndexes: Record<string, string>) =>
  encodeCursor(
    lastIndexes,
    cursorQuery('openfec_search_disbursements', searchDisbursements.input.parse(args)),
  );

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
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('sets enrichment notice for empty itemized disbursements', async () => {
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      await searchDisbursements.handler(input, ctx as unknown as Context);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeDefined();
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

    it('throws friendly McpError for malformed committee_id (validator now reachable)', async () => {
      // With .regex() removed from the Zod schema, the friendly validator fires instead
      // of a raw -32602 Zod boundary error.
      const input = searchDisbursements.input.parse({ committee_id: 'ABC123' });

      const err = await searchDisbursements
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      expect(mcpErr.data).toMatchObject({ committee_id: 'ABC123', reason: 'invalid_committee_id' });
      expect(mcpErr.message).toContain("start with 'C'");
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

    it('forwards page to the aggregate endpoint', async () => {
      mockService.getDisbursementAggregates.mockResolvedValueOnce({
        pagination: { page: 4, pages: 684, count: 13_675, per_page: 20 },
        results: [aggregateRecord()],
      });

      const input = searchDisbursements.input.parse({
        mode: 'by_recipient',
        committee_id: 'C00703975',
        page: 4,
      });
      const result = await searchDisbursements.handler(input, ctx as unknown as Context);

      expect(mockService.getDisbursementAggregates).toHaveBeenCalledWith(
        'by_recipient',
        expect.objectContaining({ page: 4 }),
        ctx,
      );
      expect(result.pagination?.page).toBe(4);
    });

    it('does not send page on the itemized keyset call, and keeps the cursor valid across pages', async () => {
      const cursor = cursorFor(
        { mode: 'itemized', committee_id: 'C00703975', page: 1 },
        { last_index: '500' },
      );

      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 100, per_page: 20 },
        results: [disbursementRecord()],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        page: 9,
        cursor,
      });
      await searchDisbursements.handler(input, ctx as unknown as Context);

      const [callArgs] = mockService.searchDisbursements.mock.calls[0]!;
      expect(callArgs.page).toBeUndefined();
      expect(callArgs.last_index).toBe('500');
    });

    it('passes decoded cursor indexes into itemized params', async () => {
      const query = { mode: 'itemized', committee_id: 'C00703975' };
      const cursor = cursorFor(query, {
        last_index: '500',
        last_disbursement_date: '2024-06-01',
      });

      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 100, per_page: 20 },
        results: [disbursementRecord()],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({ ...query, cursor });
      await searchDisbursements.handler(input, ctx as unknown as Context);

      const [callArgs, callQuery] = mockService.searchDisbursements.mock.calls[0]!;
      expect(callArgs.last_index).toBe('500');
      expect(callArgs.last_disbursement_date).toBe('2024-06-01');
      expect(callQuery).toEqual({
        scope: 'openfec_search_disbursements',
        args: { mode: 'itemized', committee_id: 'C00703975' },
      });
    });

    it('rejects a malformed cursor with an invalid_cursor reason and recovery hint', async () => {
      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        cursor: 'not-a-cursor',
      });

      const err = await searchDisbursements
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      const data = (err as McpError).data as { reason: string; recovery: { hint: string } };
      expect(data.reason).toBe('invalid_cursor');
      expect(data.recovery.hint).toContain('Omit cursor');
      expect(mockService.searchDisbursements).not.toHaveBeenCalled();
    });

    it('rejects a cursor replayed under a changed filter', async () => {
      const cursor = cursorFor(
        { mode: 'itemized', committee_id: 'C00703975', recipient_state: 'DC' },
        { last_index: '500' },
      );

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        recipient_state: 'VA',
        cursor,
      });

      const err = await searchDisbursements
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      const data = (err as McpError).data as { reason: string; changed_arguments: string[] };
      expect(data.reason).toBe('cursor_query_mismatch');
      expect(data.changed_arguments).toEqual(['recipient_state (cursor: "DC", call: "VA")']);
      expect(mockService.searchDisbursements).not.toHaveBeenCalled();
    });

    it('rejects a cursor issued by a different tool', async () => {
      const cursor = encodeCursor(
        { last_index: '500' },
        cursorQuery('openfec_search_contributions', {
          mode: 'itemized',
          committee_id: 'C00703975',
        }),
      );

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        cursor,
      });

      const err = await searchDisbursements
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect(((err as McpError).data as { reason: string }).reason).toBe('cursor_query_mismatch');
      expect((err as McpError).message).toContain('openfec_search_contributions');
    });

    it('passes a descending sort through to the FEC params', async () => {
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [disbursementRecord()],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        sort: '-disbursement_amount',
      });
      await searchDisbursements.handler(input, ctx as unknown as Context);

      expect(mockService.searchDisbursements.mock.calls[0]![0].sort).toBe('-disbursement_amount');
    });

    it('accepts every ascending and descending sort value the schema advertises', () => {
      for (const sort of [
        'disbursement_date',
        '-disbursement_date',
        'disbursement_amount',
        '-disbursement_amount',
      ]) {
        expect(
          searchDisbursements.input.parse({ mode: 'itemized', committee_id: 'C00703975', sort })
            .sort,
        ).toBe(sort);
      }
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

    it('delimits next_cursor so its end is unambiguous', () => {
      const cursor = 'eyJxIjp7InNjb3BlIjoib3BlbmZlY19zZWFyY2hfZGlzYnVyc2VtZW50cyJ9fQ=';
      const blocks = searchDisbursements.format!({
        results: [disbursementRecord()],
        next_cursor: cursor,
        count: 100,
      });

      const text = blocks[0]!.text;
      expect(text).toContain(`next_cursor: \`${cursor}\``);
      expect(text).not.toContain(`${cursor}_`);
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
