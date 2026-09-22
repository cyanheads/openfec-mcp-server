/**
 * @fileoverview Tests for the search-disbursements tool — itemized mode,
 * aggregate modes, cursor pagination, validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-disbursements.tool.test
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

import { searchDisbursements } from '@/mcp-server/tools/definitions/search-disbursements.tool.js';
import { cursorQuery, encodeCursor } from '@/services/openfec/openfec-service.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

/** The two-year period the itemized branch falls back to when no cycle is given. */
const CURRENT_CYCLE = (() => {
  const year = new Date().getFullYear();
  return year % 2 === 0 ? year : year + 1;
})();

/**
 * Build the cursor this tool would return for `args`, carrying `lastIndexes`.
 * The itemized branch binds the cursor to the effective values, so the cycle it
 * defaults is resolved the same way here.
 */
const cursorFor = (args: Record<string, unknown>, lastIndexes: Record<string, string>) =>
  encodeCursor(
    lastIndexes,
    cursorQuery('openfec_search_disbursements', {
      ...searchDisbursements.input.parse(args),
      cycle: args.cycle ?? CURRENT_CYCLE,
    }),
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

/** Schedule B rows as OpenFEC returns them — a full nested spending committee. */
const nestedCommittee = (id: string) => ({
  committee_id: id,
  name: `COMMITTEE ${id}`,
  committee_type_full: 'Presidential',
  treasurer_name: 'SMITH, ANNA',
  cycles: [2020, 2022, 2024],
});

const nestedDisbursementRecord = (committeeId: string, overrides: Record<string, unknown> = {}) =>
  disbursementRecord({
    committee_id: committeeId,
    committee: nestedCommittee(committeeId),
    ...overrides,
  });

const aggregateRecord = (overrides: Record<string, unknown> = {}) => ({
  purpose: 'ADVERTISING',
  total: 3_500_000,
  count: 120,
  ...overrides,
});

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

const makeCtx = () => createMockContext({ errors: searchDisbursements.errors });

describe('searchDisbursements', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it.each([
      ['date', { min_date: '2024-12-31', max_date: '2024-01-01' }],
      ['amount', { min_amount: 5000, max_amount: 1000 }],
    ] as const)('rejects an inverted itemized %s range before dispatch', async (_kind, range) => {
      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        ...range,
      });
      const err = (await Promise.resolve(searchDisbursements.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_range' });
      expect(mockService.searchDisbursements).not.toHaveBeenCalled();
    });

    it('rejects a malformed itemized date before dispatch', async () => {
      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        max_date: '2024-13-01',
      });
      const err = (await Promise.resolve(searchDisbursements.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_date', field: 'max_date' });
      expect(mockService.searchDisbursements).not.toHaveBeenCalled();
    });

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
      const result = await searchDisbursements.handler(input, ctx);

      expect(mockService.searchDisbursements).toHaveBeenCalledOnce();
      expect(result.results).toEqual(disbursements);
      expect(result.next_cursor).toBeNull();
      expect(result.count).toBe(1);
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('scopes an itemized call with no cycle to the current two-year period', async () => {
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      await searchDisbursements.handler(input, ctx);

      expect(mockService.searchDisbursements.mock.calls[0]![0].two_year_transaction_period).toBe(
        CURRENT_CYCLE,
      );
    });

    it('keeps an explicit itemized cycle instead of the default', async () => {
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        cycle: 2020,
      });
      await searchDisbursements.handler(input, ctx);

      expect(mockService.searchDisbursements.mock.calls[0]![0].two_year_transaction_period).toBe(
        2020,
      );
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
      await searchDisbursements.handler(input, ctx);

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

      await expect(searchDisbursements.handler(rawInput, ctx)).rejects.toBeInstanceOf(McpError);
    });

    it('throws friendly McpError for malformed committee_id (validator now reachable)', async () => {
      // With .regex() removed from the Zod schema, the friendly validator fires instead
      // of a raw -32602 Zod boundary error.
      const input = searchDisbursements.input.parse({ committee_id: 'ABC123' });

      const err = await Promise.resolve(searchDisbursements.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      expect(mcpErr.data).toMatchObject({ committee_id: 'ABC123', reason: 'invalid_committee_id' });
      expect(mcpErr.message).toContain("start with 'C'");
    });

    it('hoists the shared spending committee out of the itemized rows', async () => {
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 2, per_page: 20 },
        results: [
          nestedDisbursementRecord('C00703975'),
          nestedDisbursementRecord('C00703975', { recipient_name: 'PRINT SHOP LLC' }),
        ],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchDisbursements.handler(input, ctx);

      expect(result.committee).toMatchObject({ committee_id: 'C00703975' });
      for (const row of result.results) expect(row).not.toHaveProperty('committee');
      expect(result.results[0]!.committee_id).toBe('C00703975');
    });

    it('echoes the resolved mode and criteria on a non-empty response', async () => {
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [disbursementRecord()],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        cycle: 2024,
      });
      const result = await searchDisbursements.handler(input, ctx);

      expect(result.mode).toBe('itemized');
      expect(result.search_criteria).toMatchObject({ committee_id: 'C00703975', cycle: 2024 });
    });

    it('echoes the cycle it defaulted to when the caller omitted one', async () => {
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [disbursementRecord()],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchDisbursements.handler(input, ctx);

      expect(mockService.searchDisbursements.mock.calls[0]![0]!.two_year_transaction_period).toBe(
        CURRENT_CYCLE,
      );
      expect(result.search_criteria).toMatchObject({ cycle: CURRENT_CYCLE });
    });

    it.each([
      ['recipient_name', 'MEDIA'],
      ['recipient_state', 'DC'],
      ['recipient_city', 'WASHINGTON'],
      ['recipient_committee_id', 'C00999999'],
      ['disbursement_description', 'MEDIA BUY'],
      ['disbursement_purpose_category', 'ADVERTISING'],
      ['min_date', '2024-10-01'],
      ['max_date', '2024-10-31'],
      ['min_amount', 1000],
      ['max_amount', 5000],
      ['sort', '-disbursement_amount'],
      ['cursor', 'abc'],
    ])('rejects itemized-only %s in an aggregate mode instead of dropping it', async (f, v) => {
      const input = searchDisbursements.input.parse({
        mode: 'by_recipient',
        committee_id: 'C00703975',
        [f]: v,
      });

      const err = await Promise.resolve(searchDisbursements.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({
        reason: 'itemized_only_filters_in_aggregate_mode',
        inapplicable_inputs: [f],
      });
      expect(mockService.getDisbursementAggregates).not.toHaveBeenCalled();
    });

    it('names the rejected inputs and the ones the aggregate does accept', async () => {
      const input = searchDisbursements.input.parse({
        mode: 'by_recipient',
        committee_id: 'C00703975',
        recipient_name: 'MEDIA',
        min_date: '2024-10-01',
      });

      const err = (await Promise.resolve(searchDisbursements.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.message).toContain('recipient_name');
      expect(err.message).toContain('min_date');
      expect(err.message).toContain('committee_id, cycle');
      const data = err.data as { supported_inputs: string[]; recovery: { hint: string } };
      expect(data.supported_inputs).toEqual(['committee_id', 'cycle', 'mode', 'page', 'per_page']);
      expect(data.recovery.hint).toContain('itemized');
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
      const result = await searchDisbursements.handler(input, ctx);

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
      const result = await searchDisbursements.handler(input, ctx);

      expect(mockService.getDisbursementAggregates).toHaveBeenCalledWith(
        'by_recipient',
        expect.objectContaining({ page: 4 }),
        ctx,
      );
      expect(result.pagination?.page).toBe(4);
    });

    it('rejects explicit page in itemized mode before the keyset call', async () => {
      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        page: 9,
      });
      const err = (await Promise.resolve(searchDisbursements.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({
        reason: 'inputs_not_applicable_to_mode',
        inapplicable_inputs: ['page'],
        recovery: { hint: expect.any(String) },
      });
      expect((err.data as { supported_inputs: string[] }).supported_inputs).toEqual(
        expect.arrayContaining(['per_page', 'cursor']),
      );
      expect(mockService.searchDisbursements).not.toHaveBeenCalled();
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
      await searchDisbursements.handler(input, ctx);

      const [callArgs, callQuery] = mockService.searchDisbursements.mock.calls[0]!;
      expect(callArgs.last_index).toBe('500');
      expect(callArgs.last_disbursement_date).toBe('2024-06-01');
      expect(callQuery).toEqual({
        scope: 'openfec_search_disbursements',
        args: { mode: 'itemized', committee_id: 'C00703975', cycle: String(CURRENT_CYCLE) },
      });
    });

    it('rejects a malformed cursor with an invalid_cursor reason and recovery hint', async () => {
      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        cursor: 'not-a-cursor',
      });

      const err = await Promise.resolve(searchDisbursements.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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

      const err = await Promise.resolve(searchDisbursements.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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

      const err = await Promise.resolve(searchDisbursements.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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
      await searchDisbursements.handler(input, ctx);

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
        mode: 'itemized',
        next_cursor: null,
        count: 1,
        search_criteria: { mode: 'itemized', committee_id: 'C00703975' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**Mode:** itemized');
      expect(text).toContain('_Search criteria: mode=itemized · committee_id=C00703975_');
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
        mode: 'itemized',
        next_cursor: cursor,
        count: 100,
        search_criteria: {},
      });

      const text = formatText(blocks);
      expect(text).toContain(`next_cursor: \`${cursor}\``);
      expect(text).not.toContain(`${cursor}_`);
    });

    it('renders aggregate disbursements with purpose and count', () => {
      const blocks = searchDisbursements.format!({
        results: [aggregateRecord()],
        mode: 'by_purpose',
        pagination: { ...PAGE, count: 1 },
        search_criteria: { mode: 'by_purpose' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**Mode:** by_purpose');
      expect(text).toContain('purpose: ADVERTISING');
      expect(text).toContain('count: 120');
      expect(text).toContain('Page 1 of 1');
    });

    it('renders empty state with the mode and criteria', () => {
      const blocks = searchDisbursements.format!({
        results: [],
        mode: 'by_recipient',
        count: 0,
        search_criteria: { committee_id: 'C00703975' },
      });

      const text = formatText(blocks);
      expect(text).toContain('No results found');
      expect(text).toContain('**Mode:** by_recipient');
      expect(text).toContain('committee_id: C00703975');
    });

    it('renders the hoisted committee once, above the rows', () => {
      const blocks = searchDisbursements.format!({
        results: [disbursementRecord(), disbursementRecord()],
        mode: 'itemized',
        committee: nestedCommittee('C00703975'),
        next_cursor: null,
        count: 2,
        search_criteria: {},
      });

      const text = formatText(blocks);
      expect(text).toContain('**Committee (applies to every row below):** COMMITTEE C00703975');
      expect(text.match(/COMMITTEE C00703975/g)).toHaveLength(1);
      expect(text).toContain('SMITH, ANNA');
    });
  });

  describe('exhausted cursor', () => {
    it('renders no more-results trailer on a terminal page', () => {
      const blocks = searchDisbursements.format!({
        results: [disbursementRecord()],
        mode: 'itemized',
        next_cursor: null,
        count: 1,
        search_criteria: { mode: 'itemized', committee_id: 'C00703975' },
      });

      const text = formatText(blocks);
      expect(text).not.toContain('More results available');
      expect(text).not.toContain('next_cursor');
    });

    it('reports a spent cursor as exhausted on both surfaces', async () => {
      const query = { mode: 'itemized', committee_id: 'C00703975' };
      const cursor = cursorFor(query, { last_index: '999' });
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 5, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({ ...query, cursor });
      const result = await searchDisbursements.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(5);
      expect(getEnrichment(ctx).notice).toContain('cursor resumed past the last matching row');
      expect(getEnrichment(ctx).notice).not.toContain('No itemized disbursements matched');

      const text = formatText(searchDisbursements.format!(result));
      expect(text).toContain('No results at this position.');
      expect(text).toContain('5 total');
      expect(text).not.toContain('No results found');
      expect(text).not.toContain('broaden');
    });

    it('keeps zero-match guidance when nothing matched at all', async () => {
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchDisbursements.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('No itemized disbursements matched');

      const text = formatText(searchDisbursements.format!(result));
      expect(text).toContain('No results found.');
      expect(text).not.toContain('No results at this position');
    });
  });

  describe('approximate counts', () => {
    it('marks an inexact itemized count as approximate on both surfaces', async () => {
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: { count: 157_672_929, per_page: 1, is_count_exact: false },
        results: [disbursementRecord()],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        per_page: 1,
      });
      const result = await searchDisbursements.handler(input, ctx);

      expect(result.count_is_approximate).toBe(true);
      expect(formatText(searchDisbursements.format!(result))).toContain(
        '≈157672929 total disbursements (approximate)',
      );
      expect(getEnrichment(ctx).notice).toContain('upstream estimate');
    });

    it.each([
      ['an exact count', true],
      ['a count whose exactness upstream never declared', undefined],
    ])('renders %s as a plain total', async (_label, exact) => {
      mockService.searchDisbursements.mockResolvedValueOnce({
        pagination: {
          count: 97_818,
          per_page: 20,
          ...(exact === undefined ? {} : { is_count_exact: exact }),
        },
        results: [disbursementRecord()],
        nextCursor: null,
      });

      const input = searchDisbursements.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchDisbursements.handler(input, ctx);

      expect(result.count_is_approximate).toBeUndefined();

      const text = formatText(searchDisbursements.format!(result));
      expect(text).toContain('**97818 total disbursements**');
      expect(text).not.toContain('approximate');
    });
  });
});
