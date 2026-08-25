/**
 * @fileoverview Tests for the search-expenditures tool — itemized mode,
 * by_candidate aggregates, support/oppose mapping, cursor pagination,
 * and format rendering.
 * @module tests/mcp-server/tools/definitions/search-expenditures.tool.test
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

import { searchExpenditures } from '@/mcp-server/tools/definitions/search-expenditures.tool.js';
import { cursorQuery, encodeCursor } from '@/services/openfec/openfec-service.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

/**
 * Build the cursor this tool would return for `args`, carrying `lastIndexes`.
 * The itemized branch binds the cursor to the effective values, so the two
 * fields it defaults are resolved the same way here.
 */
const cursorFor = (args: Record<string, unknown>, lastIndexes: Record<string, string>) =>
  encodeCursor(
    lastIndexes,
    cursorQuery('openfec_search_expenditures', {
      ...searchExpenditures.input.parse(args),
      cycle: args.cycle ?? CURRENT_CYCLE,
      most_recent: args.most_recent ?? true,
    }),
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

/** Schedule E rows as OpenFEC actually returns them — nested committee + candidate. */
const nestedCommittee = (id: string) => ({
  committee_id: id,
  name: `PAC ${id}`,
  committee_type_full: 'Super PAC',
  treasurer_name: 'ROE, RICHARD',
  cycles: [2020, 2022, 2024],
});

const nestedExpenditureRecord = (committeeId: string, overrides: Record<string, unknown> = {}) =>
  expenditureRecord({
    committee_id: committeeId,
    committee: nestedCommittee(committeeId),
    candidate: { candidate_id: 'H2OH01234', idx: 1, two_year_period: 2024 },
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

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

const makeCtx = () => createMockContext({ errors: searchExpenditures.errors });

describe('searchExpenditures', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
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
      const result = await searchExpenditures.handler(input, ctx);

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
      await searchExpenditures.handler(input, ctx);

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
      const result = await searchExpenditures.handler(input, ctx);

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
      const result = await searchExpenditures.handler(input, ctx);

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
      await searchExpenditures.handler(input, ctx);

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
      await searchExpenditures.handler(input, ctx);

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
      const result = await searchExpenditures.handler(input, ctx);

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
      const result = await searchExpenditures.handler(input, ctx);

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

      const err = await Promise.resolve(searchExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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

      const err = await Promise.resolve(searchExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'by_candidate_requires_scope' });
      expect(mockService.getExpendituresByCandidate).not.toHaveBeenCalled();
    });

    it('rejects by_candidate with neither a candidate_id nor a race scope', async () => {
      const input = searchExpenditures.input.parse({ mode: 'by_candidate', cycle: 2024 });

      const err = await Promise.resolve(searchExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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

      const err = await Promise.resolve(searchExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({
        reason: 'itemized_only_filters_in_aggregate_mode',
        inapplicable_inputs: ['candidate_party'],
      });
      expect(mockService.getExpendituresByCandidate).not.toHaveBeenCalled();
    });

    it.each([
      ['payee_name', 'NOSUCHPAYEE'],
      ['min_date', '2024-10-01'],
      ['max_date', '2024-10-31'],
      ['min_amount', 1_000_000],
      ['max_amount', 2_000_000],
      ['is_notice', true],
      ['most_recent', false],
      ['sort', '-expenditure_amount'],
      ['cursor', 'abc'],
    ])('rejects itemized-only %s in by_candidate instead of dropping it', async (field, value) => {
      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_id: 'S6FL00123',
        [field]: value,
      });

      const err = await Promise.resolve(searchExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({
        reason: 'itemized_only_filters_in_aggregate_mode',
        inapplicable_inputs: [field],
      });
      expect(mockService.getExpendituresByCandidate).not.toHaveBeenCalled();
    });

    it('names every rejected input and what by_candidate does accept', async () => {
      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_id: 'S6FL00123',
        min_date: '2024-10-01',
        max_date: '2024-10-31',
        payee_name: 'NOSUCHPAYEE',
      });

      const err = (await Promise.resolve(searchExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.message).toContain('payee_name');
      expect(err.message).toContain('min_date');
      expect(err.message).toContain('max_date');
      // The rejection names the mode's supported inputs, not just the bad ones.
      expect(err.message).toContain('candidate_id');
      expect(err.message).toContain('support_oppose');
      const data = err.data as { supported_inputs: string[]; recovery: { hint: string } };
      expect(data.supported_inputs).toContain('cycle');
      expect(data.recovery.hint).toContain('itemized');
    });

    it('accepts the filters by_candidate genuinely supports', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [byCandidateRecord()],
      });

      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_id: 'S6FL00123',
        committee_id: 'C00111111',
        support_oppose: 'S',
        cycle: 2024,
      });
      const result = await searchExpenditures.handler(input, ctx);

      expect(result.mode).toBe('by_candidate');
      expect(mockService.getExpendituresByCandidate).toHaveBeenCalledOnce();
    });

    it('hoists the shared committee out of the rows when scoped to one committee_id', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 2, per_page: 20 },
        results: [nestedExpenditureRecord('C00111111'), nestedExpenditureRecord('C00111111')],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
      });
      const result = await searchExpenditures.handler(input, ctx);

      expect(result.committee).toMatchObject({ committee_id: 'C00111111', name: 'PAC C00111111' });
      for (const row of result.results) expect(row).not.toHaveProperty('committee');
      // The flat identity field stays, so a row is still attributable on its own.
      expect(result.results[0]!.committee_id).toBe('C00111111');
    });

    it('keeps the per-row committee when the query spans committees', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 2, per_page: 20 },
        results: [nestedExpenditureRecord('C00111111'), nestedExpenditureRecord('C00222222')],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        candidate_id: 'H2OH01234',
      });
      const result = await searchExpenditures.handler(input, ctx);

      expect(result.committee).toBeUndefined();
      expect(result.results[0]!.committee).toMatchObject({ committee_id: 'C00111111' });
      expect(result.results[1]!.committee).toMatchObject({ committee_id: 'C00222222' });
    });

    it('drops the duplicated candidate sub-object whether or not the committee is hoisted', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 2, per_page: 20 },
        results: [nestedExpenditureRecord('C00111111'), nestedExpenditureRecord('C00222222')],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        candidate_id: 'H2OH01234',
      });
      const result = await searchExpenditures.handler(input, ctx);

      for (const row of result.results) {
        expect(row).not.toHaveProperty('candidate');
        // The flat candidate_id it duplicated is still there.
        expect(row.candidate_id).toBe('H2OH01234');
      }
    });

    it('echoes the resolved mode and search criteria on a non-empty response', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
        cycle: 2024,
      });
      const result = await searchExpenditures.handler(input, ctx);

      expect(result.mode).toBe('itemized');
      expect(result.search_criteria).toMatchObject({
        mode: 'itemized',
        committee_id: 'C00111111',
        cycle: 2024,
      });
    });

    it('echoes by_candidate as the resolved mode', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [byCandidateRecord()],
      });

      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_id: 'S6FL00123',
      });
      const result = await searchExpenditures.handler(input, ctx);

      expect(result.mode).toBe('by_candidate');
      expect(result.search_criteria).toMatchObject({ candidate_id: 'S6FL00123' });
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
      await searchExpenditures.handler(input, ctx);

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
      await searchExpenditures.handler(input, ctx);

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
      await searchExpenditures.handler(input, ctx);

      const [callArgs, callQuery] = mockService.searchExpenditures.mock.calls[0]!;
      expect(callArgs.last_index).toBe('42');
      expect(callArgs.last_expenditure_date).toBe('2024-09-15');
      expect(callQuery).toEqual({
        scope: 'openfec_search_expenditures',
        args: {
          mode: 'itemized',
          committee_id: 'C00111111',
          cycle: String(CURRENT_CYCLE),
          most_recent: 'true',
        },
      });
    });

    it('rejects a malformed cursor with an invalid_cursor reason and recovery hint', async () => {
      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
        cursor: 'not-a-cursor',
      });

      const err = await Promise.resolve(searchExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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

      const err = await Promise.resolve(searchExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

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
      await searchExpenditures.handler(input, ctx);

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
      await searchExpenditures.handler(input, ctx);

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
      await searchExpenditures.handler(input, ctx);

      expect(mockService.searchExpenditures.mock.calls[0]![0].sort_nulls_last).toBeUndefined();
    });

    it('applies most_recent=true in itemized mode when the caller omits it', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({ mode: 'itemized' });
      expect(input.most_recent).toBeUndefined();
      await searchExpenditures.handler(input, ctx);

      expect(mockService.searchExpenditures.mock.calls[0]![0].most_recent).toBe(true);
    });

    it('forwards an explicit most_recent=false to the itemized endpoint', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({ mode: 'itemized', most_recent: false });
      await searchExpenditures.handler(input, ctx);

      expect(mockService.searchExpenditures.mock.calls[0]![0].most_recent).toBe(false);
    });

    it('echoes an explicitly-supplied most_recent in the search criteria', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({ mode: 'itemized', most_recent: false });
      const result = await searchExpenditures.handler(input, ctx);

      expect(result.search_criteria).toMatchObject({ most_recent: false });
    });

    it('echoes the defaults it applied when the caller omitted most_recent and cycle', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({ mode: 'itemized' });
      const result = await searchExpenditures.handler(input, ctx);

      expect(result.search_criteria).toMatchObject({
        most_recent: true,
        cycle: CURRENT_CYCLE,
      });
      expect(mockService.searchExpenditures.mock.calls[0]![0]).toMatchObject({
        most_recent: true,
        cycle: CURRENT_CYCLE,
      });
    });

    it('scopes an unfiltered itemized call to the current cycle', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({});
      await searchExpenditures.handler(input, ctx);

      expect(mockService.searchExpenditures.mock.calls[0]![0].cycle).toBe(CURRENT_CYCLE);
    });

    it('keeps an explicit itemized cycle instead of the default', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({ mode: 'itemized', cycle: 2020 });
      await searchExpenditures.handler(input, ctx);

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
      await searchExpenditures.handler(input, ctx);

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
        mode: 'itemized',
        next_cursor: null,
        count: 2,
        search_criteria: { mode: 'itemized', committee_id: 'C00111111' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**Mode:** itemized');
      expect(text).toContain('_Search criteria: mode=itemized · committee_id=C00111111_');
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
        mode: 'itemized',
        next_cursor: cursor,
        count: 200,
        search_criteria: {},
      });

      const text = formatText(blocks);
      expect(text).toContain(`next_cursor: \`${cursor}\``);
      expect(text).not.toContain(`${cursor}_`);
    });

    it('renders by_candidate aggregate results', () => {
      const blocks = searchExpenditures.format!({
        results: [byCandidateRecord()],
        mode: 'by_candidate',
        pagination: { ...PAGE, count: 1 },
        search_criteria: { mode: 'by_candidate' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**Mode:** by_candidate');
      expect(text).toContain('[OPPOSE]');
      expect(text).toContain('JONES, ALICE');
      expect(text).toContain('CITIZENS UNITED PAC');
      expect(text).toContain('count: 45');
      expect(text).toContain('Page 1 of 1');
    });

    it('renders empty state with the mode that produced it', () => {
      const blocks = searchExpenditures.format!({
        results: [],
        mode: 'by_candidate',
        count: 0,
        search_criteria: { candidate_id: 'S6FL00123' },
      });

      expect(formatText(blocks)).toContain('No results found');
      expect(formatText(blocks)).toContain('**Mode:** by_candidate');
      expect(formatText(blocks)).toContain('candidate_id: S6FL00123');
    });

    it('renders the hoisted committee once, above the rows', () => {
      const blocks = searchExpenditures.format!({
        results: [expenditureRecord(), expenditureRecord()],
        mode: 'itemized',
        committee: nestedCommittee('C00111111'),
        next_cursor: null,
        count: 2,
        search_criteria: {},
      });

      const text = formatText(blocks);
      expect(text).toContain('**Committee (applies to every row below):** PAC C00111111');
      expect(text.match(/PAC C00111111/g)).toHaveLength(1);
      expect(text).toContain('ROE, RICHARD');
    });
  });
});
