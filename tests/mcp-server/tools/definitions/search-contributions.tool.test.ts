/**
 * @fileoverview Tests for the search-contributions tool — itemized mode,
 * aggregate modes, cursor pagination, validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-contributions.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

import { searchContributions } from '@/mcp-server/tools/definitions/search-contributions.tool.js';
import { cursorQuery, encodeCursor } from '@/services/openfec/openfec-service.js';
import { contractFailure, declaredRecovery } from './contract-failure.js';

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
    cursorQuery('openfec_search_contributions', {
      ...searchContributions.input.parse(args),
      cycle: args.cycle ?? CURRENT_CYCLE,
    }),
  );

const contributionRecord = (overrides: Record<string, unknown> = {}) => ({
  contributor_name: 'DOE, JANE',
  contributor_employer: 'ACME CORP',
  contribution_receipt_amount: 2800,
  contribution_receipt_date: '2024-03-15',
  committee_name: 'BIDEN FOR PRESIDENT',
  committee_id: 'C00703975',
  contributor_city: 'SEATTLE',
  contributor_state: 'WA',
  ...overrides,
});

/** Schedule A rows as OpenFEC returns them — a full nested receiving committee. */
const nestedCommittee = (id: string) => ({
  committee_id: id,
  name: `COMMITTEE ${id}`,
  committee_type_full: 'Presidential',
  treasurer_name: 'SMITH, ANNA',
  cycles: [2020, 2022, 2024],
});

const nestedContributionRecord = (committeeId: string, overrides: Record<string, unknown> = {}) =>
  contributionRecord({
    committee_id: committeeId,
    committee: nestedCommittee(committeeId),
    ...overrides,
  });

const aggregateRecord = (overrides: Record<string, unknown> = {}) => ({
  size: 200,
  total: 5_000_000,
  count: 25_000,
  ...overrides,
});

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

const makeCtx = () => createMockContext({ errors: searchContributions.errors });

/** Both surfaces of a successful call, run through the tool's public contract. */
const callContract = async (
  input: Parameters<typeof runToolContract<typeof searchContributions>>[1],
) => {
  const result = await runToolContract(searchContributions, input);
  expect(result.isError).toBeFalsy();
  const structured = result.structuredContent as {
    results: Record<string, unknown>[];
    committee?: Record<string, unknown>;
    committees?: Record<string, Record<string, unknown>>;
    contributor_committees?: Record<string, Record<string, unknown>>;
    notice?: string;
    search_criteria: Record<string, unknown>;
  };
  const text = (result.content as ContentBlock[])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
  return { structured, text };
};

/** All `content[]` text of a tool call, joined. */
const wireText = (result: { content: unknown }): string =>
  (result.content as ContentBlock[])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');

/** One keyset page as the service resolves it. */
const seekPage = (
  results: Record<string, unknown>[],
  pagination: Record<string, unknown> = {},
  nextCursor: string | null = null,
) => ({ pagination: { count: results.length, per_page: 20, ...pagination }, results, nextCursor });

/** One aggregate page as the service resolves it. */
const aggregatePage = (
  results: Record<string, unknown>[],
  pagination: Record<string, unknown> = {},
) => ({
  pagination: { ...PAGE, count: results.length, ...pagination },
  results,
});

/**
 * An aggregate endpoint holding 150 rows that serves the page and per_page it is
 * sent, as OpenFEC does — so a capped per_page shows in the rows and the echo.
 */
const servePerPage =
  (row: (i: number) => Record<string, unknown>) =>
  async (_mode: string, params: { page: number; per_page: number }) => {
    const total = 150;
    const start = (params.page - 1) * params.per_page;
    const length = Math.max(0, Math.min(params.per_page, total - start));
    return {
      pagination: {
        page: params.page,
        pages: Math.ceil(total / params.per_page),
        count: total,
        per_page: params.per_page,
      },
      results: Array.from({ length }, (_, i) => row(start + i)),
    };
  };

const UNSCOPED_NOTICE =
  "Without committee_id or candidate_id, each row is one committee's bucket for one cycle, across every committee on file, not a combined breakdown. Pass committee_id or candidate_id to break down one committee or candidate.";
const APPROXIMATE_NOTICE =
  'The total is an upstream estimate, not a tally — treat it as an order of magnitude, not a figure to quote.';

describe('searchContributions', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('returns itemized contributions with committee_id', async () => {
      const contributions = [contributionRecord()];
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: contributions,
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchContributions.handler(input, ctx);

      expect(mockService.searchContributions).toHaveBeenCalledOnce();
      expect(result.results).toEqual(contributions);
      expect(result.next_cursor).toBeNull();
      expect(result.count).toBe(1);
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('scopes an itemized call with no cycle to the current two-year period', async () => {
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      await searchContributions.handler(input, ctx);

      expect(mockService.searchContributions.mock.calls[0]![0].two_year_transaction_period).toBe(
        CURRENT_CYCLE,
      );
    });

    it('sets enrichment notice for empty itemized contributions', async () => {
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      await searchContributions.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeDefined();
    });

    it('throws without a recipient or donor scope in itemized mode', async () => {
      const input = searchContributions.input.parse({ mode: 'itemized' });

      await expect(searchContributions.handler(input, ctx)).rejects.toBeInstanceOf(McpError);
    });

    it.each([
      ['date', { min_date: '2024-12-31', max_date: '2024-01-01' }],
      ['amount', { min_amount: 5000, max_amount: 1000 }],
    ] as const)('rejects an inverted itemized %s range before dispatch', async (_kind, range) => {
      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        ...range,
      });
      const err = (await Promise.resolve(searchContributions.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_range' });
      expect(mockService.searchContributions).not.toHaveBeenCalled();
    });

    it('rejects a malformed itemized date before dispatch', async () => {
      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        min_date: 'not-a-date',
      });
      const err = (await Promise.resolve(searchContributions.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_date', field: 'min_date' });
      expect(mockService.searchContributions).not.toHaveBeenCalled();
    });

    it('fetches by_size aggregates', async () => {
      const aggregates = [aggregateRecord()];
      mockService.getContributionAggregates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: aggregates,
      });

      const input = searchContributions.input.parse({
        mode: 'by_size',
        committee_id: 'C00703975',
      });
      const result = await searchContributions.handler(input, ctx);

      expect(mockService.getContributionAggregates).toHaveBeenCalledWith(
        'by_size',
        expect.objectContaining({ committee_id: 'C00703975' }),
        ctx,
      );
      expect(result.results).toEqual([{ ...aggregateRecord(), size_range: '$200.01 to $499.99' }]);
      expect(result.pagination).toBeDefined();
    });

    it('forwards page to the aggregate endpoint', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce({
        pagination: { page: 3, pages: 5, count: 56, per_page: 20 },
        results: [aggregateRecord()],
      });

      const input = searchContributions.input.parse({
        mode: 'by_state',
        committee_id: 'C00703975',
        page: 3,
      });
      const result = await searchContributions.handler(input, ctx);

      expect(mockService.getContributionAggregates).toHaveBeenCalledWith(
        'by_state',
        expect.objectContaining({ page: 3 }),
        ctx,
      );
      expect(result.pagination?.page).toBe(3);
    });

    it('sends and echoes an aggregate per_page of 100, returning every row upstream sent, on both surfaces', async () => {
      mockService.getContributionAggregates.mockImplementationOnce(
        servePerPage((i) => aggregateRecord({ size: 0, total: 1_000 - i })),
      );

      const result = await runToolContract(searchContributions, {
        mode: 'by_size',
        committee_id: 'C00703975',
        per_page: 100,
      });

      expect(result.isError).toBeFalsy();
      expect(mockService.getContributionAggregates.mock.calls[0]![1]).toMatchObject({
        page: 1,
        per_page: 100,
      });
      const structured = result.structuredContent as {
        results: unknown[];
        pagination: Record<string, unknown>;
      };
      expect(structured.results).toHaveLength(100);
      expect(structured.pagination).toMatchObject({ page: 1, pages: 2, count: 150, per_page: 100 });
      expect(wireText(result)).toContain('_Page 1 of 2 · 150 total · 100 per page_');
    });

    it('rejects explicit page in itemized mode before the keyset call', async () => {
      const err = await contractFailure(searchContributions, {
        mode: 'itemized',
        committee_id: 'C00703975',
        page: 7,
      });

      expect(err.data).toMatchObject({
        reason: 'inputs_not_applicable_to_mode',
        inapplicable_inputs: ['page'],
        recovery: {
          hint: declaredRecovery(searchContributions, 'inputs_not_applicable_to_mode'),
        },
      });
      expect((err.data as { supported_inputs: string[] }).supported_inputs).toEqual(
        expect.arrayContaining(['per_page', 'cursor']),
      );
      expect(mockService.searchContributions).not.toHaveBeenCalled();
    });

    it('rejects candidate_id from the concrete itemized endpoint', async () => {
      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        candidate_id: 'P00003392',
      });
      const err = (await Promise.resolve(searchContributions.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({
        reason: 'inputs_not_applicable_to_mode',
        inapplicable_inputs: ['candidate_id'],
      });
      expect(mockService.searchContributions).not.toHaveBeenCalled();
    });

    it('routes to by_size_candidate when candidate_id provided', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [aggregateRecord()],
      });

      const input = searchContributions.input.parse({
        mode: 'by_size',
        candidate_id: 'P00003392',
      });
      await searchContributions.handler(input, ctx);

      expect(mockService.getContributionAggregates).toHaveBeenCalledWith(
        'by_size_candidate',
        expect.objectContaining({ candidate_id: 'P00003392' }),
        ctx,
      );
    });

    it('hoists the shared receiving committee out of the itemized rows', async () => {
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 2, per_page: 20 },
        results: [
          nestedContributionRecord('C00703975'),
          nestedContributionRecord('C00703975', { contributor_name: 'ROE, RICHARD' }),
        ],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchContributions.handler(input, ctx);

      expect(result.committee).toMatchObject({ committee_id: 'C00703975' });
      for (const row of result.results) expect(row).not.toHaveProperty('committee');
      expect(result.results[0]!.committee_id).toBe('C00703975');
    });

    it('carries each donor committee once in contributor_committees, keyed by contributor_id', async () => {
      const contributor = {
        committee_id: 'C00010603',
        name: 'MINNESOTA DFL',
        treasurer_name: 'PARK, JOHN',
        designated_agent_name: 'AGENT, ANN',
        cycles: [2020, 2022, 2024],
      };
      mockService.searchContributions.mockResolvedValueOnce(
        seekPage([
          nestedContributionRecord('C00703975', { contributor_id: 'C00010603', contributor }),
          nestedContributionRecord('C00703975', { contributor_id: 'C00010603', contributor }),
        ]),
      );

      const { structured, text } = await callContract({
        mode: 'itemized',
        committee_id: 'C00703975',
      });

      expect(structured.contributor_committees).toEqual({ C00010603: contributor });
      for (const row of structured.results) expect(row).not.toHaveProperty('contributor');
      expect(structured).not.toHaveProperty('committees');
      expect(text.match(/\*\*MINNESOTA DFL \(C00010603\)\*\*/g)).toHaveLength(1);
      expect(text).toContain('designated_agent_name: AGENT, ANN');
      expect(text).toContain('cycles: 2020, 2022, 2024');
      expect(text.match(/contributor_id: C00010603 \(MINNESOTA DFL\)/g)).toHaveLength(2);
    });

    it('echoes the resolved mode and criteria on a non-empty itemized response', async () => {
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [contributionRecord()],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        cycle: 2024,
      });
      const result = await searchContributions.handler(input, ctx);

      expect(result.mode).toBe('itemized');
      expect(result.search_criteria).toMatchObject({ committee_id: 'C00703975', cycle: 2024 });
    });

    it('echoes the cycle it defaulted to when the caller omitted one', async () => {
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [contributionRecord()],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchContributions.handler(input, ctx);

      expect(mockService.searchContributions.mock.calls[0]![0]!.two_year_transaction_period).toBe(
        CURRENT_CYCLE,
      );
      expect(result.search_criteria).toMatchObject({ cycle: CURRENT_CYCLE });
    });

    it('echoes the cycle a by_candidate aggregate defaulted to', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [aggregateRecord()],
      });

      const input = searchContributions.input.parse({
        mode: 'by_size',
        candidate_id: 'P00003392',
      });
      const result = await searchContributions.handler(input, ctx);

      expect(mockService.getContributionAggregates.mock.calls[0]![1]!.cycle).toBe(CURRENT_CYCLE);
      expect(result.search_criteria).toMatchObject({ cycle: CURRENT_CYCLE });
    });

    it('echoes the _candidate variant the aggregate actually resolved to', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [aggregateRecord()],
      });

      const input = searchContributions.input.parse({
        mode: 'by_state',
        candidate_id: 'P00003392',
      });
      const result = await searchContributions.handler(input, ctx);

      // The caller asked for by_state; the server ran by_state_candidate.
      expect(result.mode).toBe('by_state_candidate');
      expect(result.search_criteria).toMatchObject({ mode: 'by_state' });
    });

    it.each([
      ['contributor_id', 'C00030718'],
      ['contributor_name', 'DOE'],
      ['contributor_employer', 'ACME'],
      ['contributor_occupation', 'ENGINEER'],
      ['contributor_city', 'SEATTLE'],
      ['contributor_state', 'WA'],
      ['contributor_zip', '98101'],
      ['min_date', '2024-10-01'],
      ['max_date', '2024-10-31'],
      ['min_amount', 1000],
      ['max_amount', 5000],
      ['is_individual', true],
      ['sort', '-contribution_receipt_amount'],
      ['cursor', 'abc'],
    ])('rejects itemized-only %s in an aggregate mode instead of dropping it', async (f, v) => {
      const input = searchContributions.input.parse({
        mode: 'by_state',
        committee_id: 'C00703975',
        [f]: v,
      });

      const err = await Promise.resolve(searchContributions.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({
        reason: 'itemized_only_filters_in_aggregate_mode',
        inapplicable_inputs: [f],
      });
      expect(mockService.getContributionAggregates).not.toHaveBeenCalled();
    });

    it('names the rejected inputs and the ones the aggregate does accept', async () => {
      const err = await contractFailure(searchContributions, {
        mode: 'by_state',
        committee_id: 'C00703975',
        contributor_state: 'WA',
        min_date: '2024-10-01',
      });

      expect(err.message).toContain('contributor_state');
      expect(err.message).toContain('min_date');
      expect(err.message).toContain('committee_id, candidate_id, cycle');
      expect(err.data.supported_inputs).toEqual([
        'committee_id',
        'candidate_id',
        'cycle',
        'mode',
        'page',
        'per_page',
      ]);
      expect(err.data.recovery?.hint).toContain('itemized');
    });

    it('still accepts the filters the aggregate endpoints support', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [aggregateRecord()],
      });

      const input = searchContributions.input.parse({
        mode: 'by_size',
        committee_id: 'C00703975',
        cycle: 2024,
        page: 2,
        per_page: 50,
      });
      await searchContributions.handler(input, ctx);

      expect(mockService.getContributionAggregates).toHaveBeenCalledOnce();
    });

    it('requires committee_id for by_employer mode', async () => {
      const input = searchContributions.input.parse({ mode: 'by_employer' });

      await expect(searchContributions.handler(input, ctx)).rejects.toBeInstanceOf(McpError);
    });

    it.each(['by_employer', 'by_occupation'] as const)(
      'rejects candidate_id from the concrete %s endpoint',
      async (mode) => {
        const input = searchContributions.input.parse({
          mode,
          committee_id: 'C00703975',
          candidate_id: 'P00003392',
        });
        const err = (await Promise.resolve(searchContributions.handler(input, ctx)).catch(
          (e: unknown) => e,
        )) as McpError;

        expect(err.data).toMatchObject({
          reason: 'inputs_not_applicable_to_mode',
          mode,
          inapplicable_inputs: ['candidate_id'],
          supported_inputs: ['mode', 'committee_id', 'cycle', 'page', 'per_page'],
        });
        expect(mockService.getContributionAggregates).not.toHaveBeenCalled();
      },
    );

    it.each(['by_size', 'by_state'] as const)(
      'rejects committee_id when candidate_id resolves %s to its candidate endpoint',
      async (mode) => {
        const input = searchContributions.input.parse({
          mode,
          committee_id: 'C00703975',
          candidate_id: 'P00003392',
        });
        const err = (await Promise.resolve(searchContributions.handler(input, ctx)).catch(
          (e: unknown) => e,
        )) as McpError;

        expect(err.data).toMatchObject({
          reason: 'inputs_not_applicable_to_mode',
          inapplicable_inputs: ['committee_id'],
          supported_inputs: ['mode', 'candidate_id', 'cycle', 'page', 'per_page'],
        });
        expect(mockService.getContributionAggregates).not.toHaveBeenCalled();
      },
    );

    it('passes decoded cursor indexes into params', async () => {
      const query = { mode: 'itemized', committee_id: 'C00703975' };
      const cursor = cursorFor(query, {
        last_index: '999',
        last_contribution_receipt_date: '2024-01-01',
      });

      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 50, per_page: 20 },
        results: [contributionRecord()],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({ ...query, cursor });
      await searchContributions.handler(input, ctx);

      const [callArgs, callQuery] = mockService.searchContributions.mock.calls[0]!;
      expect(callArgs.last_index).toBe('999');
      expect(callArgs.last_contribution_receipt_date).toBe('2024-01-01');
      expect(callQuery).toEqual({
        scope: 'openfec_search_contributions',
        args: { mode: 'itemized', committee_id: 'C00703975', cycle: String(CURRENT_CYCLE) },
      });
    });

    it('rejects a malformed cursor with an invalid_cursor reason and recovery hint', async () => {
      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        cursor: 'not-a-cursor',
      });

      const err = await Promise.resolve(searchContributions.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      const data = (err as McpError).data as { reason: string; recovery: { hint: string } };
      expect(data.reason).toBe('invalid_cursor');
      expect(data.recovery.hint).toContain('Omit cursor');
      expect(mockService.searchContributions).not.toHaveBeenCalled();
    });

    it('rejects a cursor replayed under a changed sort instead of silently restarting', async () => {
      const cursor = cursorFor(
        {
          mode: 'itemized',
          committee_id: 'C00431056',
          sort: 'contribution_receipt_amount',
        },
        { last_contribution_receipt_amount: '-3300.00', last_index: '4062020251206659284' },
      );

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00431056',
        cursor,
      });

      const err = await Promise.resolve(searchContributions.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      const data = (err as McpError).data as { reason: string; changed_arguments: string[] };
      expect(data.reason).toBe('cursor_query_mismatch');
      expect(data.changed_arguments).toEqual([
        'sort (cursor: "contribution_receipt_amount", call: omitted)',
      ]);
      expect(mockService.searchContributions).not.toHaveBeenCalled();
    });

    it('passes a descending sort through to the FEC params', async () => {
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [contributionRecord()],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00431056',
        sort: '-contribution_receipt_amount',
      });
      await searchContributions.handler(input, ctx);

      expect(mockService.searchContributions.mock.calls[0]![0].sort).toBe(
        '-contribution_receipt_amount',
      );
    });

    it('accepts every ascending and descending sort value the schema advertises', () => {
      for (const sort of [
        'contribution_receipt_date',
        '-contribution_receipt_date',
        'contribution_receipt_amount',
        '-contribution_receipt_amount',
      ]) {
        expect(
          searchContributions.input.parse({ mode: 'itemized', committee_id: 'C00431056', sort })
            .sort,
        ).toBe(sort);
      }
    });
  });

  describe('format', () => {
    it('renders itemized results with donor info', () => {
      const blocks = searchContributions.format!({
        results: [contributionRecord()],
        mode: 'itemized',
        next_cursor: null,
        count: 1,
        search_criteria: { mode: 'itemized', committee_id: 'C00703975' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**Mode:** itemized');
      expect(text).toContain('_Search criteria: mode=itemized · committee_id=C00703975_');
      expect(text).toContain('DOE, JANE');
      expect(text).toContain('contributor_city: SEATTLE');
      expect(text).toContain('contributor_state: WA');
      expect(text).toContain('BIDEN FOR PRESIDENT');
      expect(text).toContain('ACME CORP');
      expect(text).toContain('2024-03-15');
    });

    it('delimits next_cursor so its end is unambiguous', () => {
      const cursor = 'eyJxIjp7InNjb3BlIjoib3BlbmZlY19zZWFyY2hfY29udHJpYnV0aW9ucyJ9fQ=';
      const blocks = searchContributions.format!({
        results: [contributionRecord()],
        mode: 'itemized',
        next_cursor: cursor,
        count: 50,
        search_criteria: {},
      });

      const text = formatText(blocks);
      expect(text).toContain(`next_cursor: \`${cursor}\``);
      expect(text).not.toContain(`${cursor}_`);
    });

    it('renders aggregate results', () => {
      const blocks = searchContributions.format!({
        results: [aggregateRecord()],
        mode: 'by_size_candidate',
        pagination: { ...PAGE, count: 1 },
        search_criteria: { mode: 'by_size' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**Mode:** by_size_candidate');
      expect(text).toContain('size: 200');
      expect(text).toContain('count: 25000');
      expect(text).toContain('Page 1 of 1');
    });

    it('renders empty results message with the mode and criteria', () => {
      const blocks = searchContributions.format!({
        results: [],
        mode: 'by_employer',
        count: 0,
        search_criteria: { committee_id: 'C00703975' },
      });

      const text = formatText(blocks);
      expect(text).toContain('No results found');
      expect(text).toContain('**Mode:** by_employer');
      expect(text).toContain('committee_id: C00703975');
    });

    it('renders the hoisted committee once, above the rows', () => {
      const blocks = searchContributions.format!({
        results: [contributionRecord(), contributionRecord()],
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
      expect(text).toContain('committee_type_full: Presidential');
      expect(text).toContain('cycles: 2020, 2022, 2024');
    });

    it('renders a donor committee record left on its row in full, as a block', () => {
      const contributor = {
        committee_id: 'C00010603',
        name: 'MINNESOTA DFL',
        committee_type_full: 'Party - Qualified',
        designation_full: 'Unauthorized',
        party_full: 'DEMOCRATIC-FARMER-LABOR',
        state: 'MN',
        treasurer_name: 'PARK, JOHN',
        designated_agent_name: 'AGENT, ANN',
        cycles: [1976, 1978, 2024],
        sponsor: { nested: { deeper: 'NESTED VALUE' } },
      };
      const blocks = searchContributions.format!({
        results: [
          contributionRecord({ contributor_name: 'MINNESOTA DFL', contributor }),
          contributionRecord(),
        ],
        mode: 'itemized',
        committee: nestedCommittee('C00703975'),
        next_cursor: null,
        count: 2,
        search_criteria: {},
      });

      const text = formatText(blocks);
      expect(text).toContain(
        '  contributor:\n    MINNESOTA DFL (C00010603)\n    committee_type_full: Party - Qualified',
      );
      expect(text).toContain('    designated_agent_name: AGENT, ANN');
      expect(text).toContain('    cycles: 1976, 1978, 2024');
      expect(text).toContain('NESTED VALUE');
      expect(text).not.toContain('"committee_id"');
      // An individual donor's row carries no contributor record and renders as before.
      expect(text).toContain('**DOE, JANE**');
    });
  });

  describe('exhausted cursor', () => {
    it('renders no more-results trailer on a terminal page', () => {
      const blocks = searchContributions.format!({
        results: [contributionRecord()],
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
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({ ...query, cursor });
      const result = await searchContributions.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toContain('cursor resumed past the last matching row');
      expect(getEnrichment(ctx).notice).not.toContain('No itemized contributions matched');

      const text = formatText(searchContributions.format!(result));
      expect(text).toContain('No results at this position.');
      expect(text).toContain('1 total');
      expect(text).toContain('Omit cursor');
      expect(text).not.toContain('No results found');
      expect(text).not.toContain('broaden');
    });

    it('keeps zero-match guidance when nothing matched at all', async () => {
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchContributions.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('No itemized contributions matched');

      const text = formatText(searchContributions.format!(result));
      expect(text).toContain('No results found.');
      expect(text).not.toContain('No results at this position');
    });
  });

  describe('approximate counts', () => {
    it('marks an inexact itemized count as approximate on both surfaces', async () => {
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 1_429_442, per_page: 1, is_count_exact: false },
        results: [contributionRecord()],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        contributor_state: 'CA',
        per_page: 1,
      });
      const result = await searchContributions.handler(input, ctx);

      expect(result.count_is_approximate).toBe(true);
      expect(formatText(searchContributions.format!(result))).toContain(
        '≈1429442 total contributions (approximate)',
      );
      expect(getEnrichment(ctx).notice).toContain('upstream estimate');
    });

    it.each([
      ['an exact count', true],
      ['a count whose exactness upstream never declared', undefined],
    ])('renders %s as a plain total', async (_label, exact) => {
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: {
          count: 144_800,
          per_page: 20,
          ...(exact === undefined ? {} : { is_count_exact: exact }),
        },
        results: [contributionRecord()],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchContributions.handler(input, ctx);

      expect(result.count_is_approximate).toBeUndefined();

      const text = formatText(searchContributions.format!(result));
      expect(text).toContain('**144800 total contributions**');
      expect(text).not.toContain('approximate');
    });
  });

  describe('itemized scope', () => {
    it('declares one scope reason naming the recipient and the three donor scopes', () => {
      const reasons = searchContributions.errors?.map((entry) => entry.reason);
      expect(reasons).toContain('itemized_requires_scope');
      expect(reasons).not.toContain('itemized_requires_committee_id');

      const recovery = declaredRecovery(searchContributions, 'itemized_requires_scope');
      for (const scope of [
        'committee_id',
        'contributor_id',
        'contributor_name',
        'contributor_employer',
      ]) {
        expect(recovery).toContain(scope);
      }
    });

    it.each([
      ['contributor_id', 'C00030718'],
      ['contributor_name', 'BLOOMBERG, MICHAEL'],
      ['contributor_employer', 'ANTHROPIC'],
    ])('serves an itemized search scoped by %s alone', async (field, value) => {
      mockService.searchContributions.mockResolvedValueOnce(
        seekPage([nestedContributionRecord('C00703975')]),
      );

      const { structured } = await callContract({ mode: 'itemized', cycle: 2024, [field]: value });

      const [params] = mockService.searchContributions.mock.calls[0]!;
      expect(params).toEqual({ [field]: value, two_year_transaction_period: 2024, per_page: 20 });
      expect(structured.search_criteria).toMatchObject({ [field]: value, cycle: 2024 });
    });

    it('carries each recipient of a donor-scoped page once in committees, and names it per row', async () => {
      mockService.searchContributions.mockResolvedValueOnce(
        seekPage([
          nestedContributionRecord('C00000001', { contributor_name: 'NAR PAC' }),
          nestedContributionRecord('C00000002', { contributor_name: 'NAR PAC' }),
          nestedContributionRecord('C00000001', { contributor_name: 'NAR PAC', link_id: 7 }),
        ]),
      );

      const { structured, text } = await callContract({
        mode: 'itemized',
        contributor_id: 'C00030718',
        cycle: 2024,
      });

      expect(structured).not.toHaveProperty('committee');
      expect(structured.committees).toEqual({
        C00000001: nestedCommittee('C00000001'),
        C00000002: nestedCommittee('C00000002'),
      });
      for (const row of structured.results) expect(row).not.toHaveProperty('committee');
      expect(structured.results.map((row) => row.committee_id)).toEqual([
        'C00000001',
        'C00000002',
        'C00000001',
      ]);
      expect(text).not.toContain('applies to every row below');
      expect(text.match(/committee_id: C00000001 \(COMMITTEE C00000001\)/g)).toHaveLength(2);
      expect(text.match(/committee_id: C00000002 \(COMMITTEE C00000002\)/g)).toHaveLength(1);
      expect(text.match(/\*\*COMMITTEE C00000001 \(C00000001\)\*\*/g)).toHaveLength(1);
      expect(text.match(/\*\*COMMITTEE C00000002 \(C00000002\)\*\*/g)).toHaveLength(1);
      expect(text).toContain('committee_type_full: Presidential');
    });

    /** Only a committee_id scope pins the page to one recipient; a donor scope that happens to hit one does not. */
    it('keeps a donor-scoped page whose rows all name one recipient unhoisted, its recipient in committees', async () => {
      mockService.searchContributions.mockResolvedValueOnce(
        seekPage([
          nestedContributionRecord('C00000001', { contributor_name: 'NAR PAC', link_id: 1 }),
          nestedContributionRecord('C00000001', { contributor_name: 'NAR PAC', link_id: 2 }),
        ]),
      );

      const { structured, text } = await callContract({
        mode: 'itemized',
        contributor_id: 'C00000009',
        cycle: 2024,
      });

      expect(structured).not.toHaveProperty('committee');
      expect(structured.committees).toEqual({ C00000001: nestedCommittee('C00000001') });
      for (const row of structured.results) expect(row).not.toHaveProperty('committee');
      expect(text).not.toContain('applies to every row below');
      expect(text).toContain(
        "**Committees referenced above** — each row's committee_id names its entry:",
      );
      expect(text.match(/committee_id: C00000001 \(COMMITTEE C00000001\)/g)).toHaveLength(2);
      expect(text.match(/\*\*COMMITTEE C00000001 \(C00000001\)\*\*/g)).toHaveLength(1);
    });

    it('narrows a donor scope to one recipient and hoists that recipient', async () => {
      mockService.searchContributions.mockResolvedValueOnce(
        seekPage([nestedContributionRecord('C00840017')]),
      );

      const { structured, text } = await callContract({
        mode: 'itemized',
        contributor_id: 'C00030718',
        committee_id: 'C00840017',
        cycle: 2024,
      });

      const [params] = mockService.searchContributions.mock.calls[0]!;
      expect(params).toMatchObject({ contributor_id: 'C00030718', committee_id: 'C00840017' });
      expect(structured.committee).toMatchObject({ committee_id: 'C00840017' });
      expect(structured).not.toHaveProperty('committees');
      for (const row of structured.results) expect(row).not.toHaveProperty('committee');
      expect(text).toContain('**Committee (applies to every row below):** COMMITTEE C00840017');
    });

    it('sends a committee-scoped itemized call exactly as before', async () => {
      mockService.searchContributions.mockResolvedValueOnce(seekPage([contributionRecord()]));

      await callContract({ mode: 'itemized', committee_id: 'C00703975', cycle: 2024 });

      const [params] = mockService.searchContributions.mock.calls[0]!;
      expect(params).toEqual({
        committee_id: 'C00703975',
        two_year_transaction_period: 2024,
        per_page: 20,
      });
    });

    it.each([
      ['no filters', {}],
      ['occupation only', { contributor_occupation: 'ATTORNEY' }],
      ['city only', { contributor_city: 'SEATTLE' }],
      ['state only', { contributor_state: 'WY' }],
      ['ZIP only', { contributor_zip: '98101' }],
      ['dates only', { min_date: '2024-10-01', max_date: '2024-10-31' }],
      ['amounts only', { min_amount: 1000, max_amount: 5000 }],
      ['is_individual only', { is_individual: true }],
      ['a blank contributor_name', { contributor_name: '' }],
      ['a whitespace contributor_employer', { contributor_employer: '   ' }],
      ['a blank contributor_id', { contributor_id: '' }],
      ['a blank committee_id', { committee_id: '' }],
    ])(
      'rejects an itemized call with %s as unscoped before any upstream call',
      async (_label, filters) => {
        const err = await contractFailure(searchContributions, { mode: 'itemized', ...filters });

        expect(err.data).toMatchObject({
          reason: 'itemized_requires_scope',
          recovery: { hint: declaredRecovery(searchContributions, 'itemized_requires_scope') },
        });
        expect(mockService.searchContributions).not.toHaveBeenCalled();
      },
    );

    it('rejects a malformed contributor_id before dispatch', async () => {
      const err = await contractFailure(searchContributions, {
        mode: 'itemized',
        contributor_id: 'NAR-PAC',
      });

      expect(err.data).toMatchObject({ reason: 'invalid_committee_id', contributor_id: 'NAR-PAC' });
      expect(err.data).not.toHaveProperty('committee_id');
      expect(mockService.searchContributions).not.toHaveBeenCalled();
    });

    it('names contributor_id, not committee_id, in the message on both surfaces', async () => {
      const result = await runToolContract(searchContributions, {
        mode: 'itemized',
        committee_id: 'C00840017',
        contributor_id: 'C123',
      });

      expect(result.isError).toBe(true);
      const { message } = (result.structuredContent as { error: { message: string } }).error;
      expect(message).toMatch(/^Invalid contributor_id format\. /);
      expect(message).not.toContain('committee_id');
      expect(wireText(result)).toContain('Invalid contributor_id format.');
      expect(mockService.searchContributions).not.toHaveBeenCalled();
    });

    it('rejects a cursor replayed under a changed contributor_id', async () => {
      const cursor = cursorFor(
        { mode: 'itemized', contributor_id: 'C00030718', cycle: 2024 },
        { last_index: '4062020251206659284', last_contribution_receipt_date: '2024-10-01' },
      );

      const err = await contractFailure(searchContributions, {
        mode: 'itemized',
        contributor_id: 'C00401224',
        cycle: 2024,
        cursor,
      });

      expect(err.data.reason).toBe('cursor_query_mismatch');
      expect(err.data.changed_arguments).toEqual([
        'contributor_id (cursor: "C00030718", call: "C00401224")',
      ]);
      expect(mockService.searchContributions).not.toHaveBeenCalled();
    });

    it('rejects a contributor_state too wide to be a state code before dispatch', async () => {
      const err = await contractFailure(searchContributions, {
        mode: 'itemized',
        committee_id: 'C00703975',
        contributor_state: 'Georgia',
      });

      expect(err.data).toMatchObject({
        reason: 'invalid_state_code',
        field: 'contributor_state',
        value: 'Georgia',
      });
      expect(mockService.searchContributions).not.toHaveBeenCalled();
    });

    it('sends a contributor_state of state-code width as given', async () => {
      mockService.searchContributions.mockResolvedValueOnce(seekPage([contributionRecord()]));

      await callContract({ mode: 'itemized', committee_id: 'C00703975', contributor_state: 'ga' });

      expect(mockService.searchContributions.mock.calls[0]![0].contributor_state).toBe('ga');
    });

    /** `/schedules/schedule_a/` reads `other` as foreign, invalid, or missing states and `-` as exclude. */
    it.each(['OTHER', 'other', '-ga'])('sends the filter value %s as given', async (state) => {
      mockService.searchContributions.mockResolvedValueOnce(seekPage([contributionRecord()]));

      await callContract({ mode: 'itemized', committee_id: 'C00703975', contributor_state: state });

      expect(mockService.searchContributions.mock.calls[0]![0].contributor_state).toBe(state);
    });

    it.each(['-other', '--GA', '-GAA'])('still rejects contributor_state %s', async (state) => {
      const err = await contractFailure(searchContributions, {
        mode: 'itemized',
        committee_id: 'C00703975',
        contributor_state: state,
      });

      expect(err.data).toMatchObject({
        reason: 'invalid_state_code',
        field: 'contributor_state',
        value: state,
      });
      expect(mockService.searchContributions).not.toHaveBeenCalled();
    });
  });

  describe('memo entries', () => {
    /** Rows 3–5 restate one $23M receipt on line 17; rows 1–2 are line 11AI receipts. */
    const memoPage = () => [
      contributionRecord({ contributor_name: 'RIPPLE LABS', line_number: '11AI' }),
      contributionRecord({ contributor_name: 'AH CAPITAL', line_number: '11AI' }),
      ...[1, 2, 3].map(() =>
        contributionRecord({ contributor_name: 'COINBASE', memo_code: 'X', memoed_subtotal: true }),
      ),
    ];
    const MEMO_SENTENCE =
      '3 of 5 rows on this page are memo entries (memo_code "X"): each itemizes another row, named by back_reference_transaction_id when filed, or restates earlier activity, and FEC leaves memo entries out of report totals. Do not add them to the other rows.';

    it('counts the memo rows a page mixes with receipts and marks each one, on both surfaces', async () => {
      mockService.searchContributions.mockResolvedValueOnce(seekPage(memoPage()));

      const { structured, text } = await callContract({
        mode: 'itemized',
        committee_id: 'C00835959',
        sort: '-contribution_receipt_amount',
      });

      expect(structured.notice).toBe(MEMO_SENTENCE);
      expect(text).toContain(MEMO_SENTENCE);
      expect(text.match(/\*\*COINBASE\*\* · memo entry/g)).toHaveLength(3);
      expect(text).toContain('**RIPPLE LABS**\n');
      expect(text).not.toContain('**RIPPLE LABS** · memo entry');
      expect(structured.results.map((row) => row.memo_code)).toEqual([
        undefined,
        undefined,
        'X',
        'X',
        'X',
      ]);
    });

    it('joins the estimate sentence and the memo sentence in one notice', async () => {
      mockService.searchContributions.mockResolvedValueOnce(
        seekPage(memoPage(), { count: 1_429_442, is_count_exact: false }),
      );

      const { structured, text } = await callContract({
        mode: 'itemized',
        committee_id: 'C00835959',
      });

      expect(structured.notice).toBe(`${APPROXIMATE_NOTICE} ${MEMO_SENTENCE}`);
      expect(text).toContain(`${APPROXIMATE_NOTICE} ${MEMO_SENTENCE}`);
    });

    it('marks an all-memo page row by row without a page sentence', async () => {
      mockService.searchContributions.mockResolvedValueOnce(seekPage(memoPage().slice(2)));

      const { structured, text } = await callContract({
        mode: 'itemized',
        committee_id: 'C00835959',
      });

      expect(structured.notice).toBeUndefined();
      expect(text.match(/· memo entry/g)).toHaveLength(3);
    });
  });

  describe('aggregate scope notices', () => {
    it.each([
      ['by_size', { mode: 'by_size' }],
      ['by_state', { mode: 'by_state' }],
      ['by_size with only a cycle', { mode: 'by_size', cycle: 2024 }],
    ] as const)(
      'says an unscoped %s page is per committee, on both surfaces',
      async (_label, input) => {
        mockService.getContributionAggregates.mockResolvedValueOnce(
          aggregatePage([aggregateRecord({ committee_id: 'C00507947', cycle: 2020 })], {
            count: 40_038,
            is_count_exact: true,
          }),
        );

        const { structured, text } = await callContract(input);

        expect(structured.notice).toBe(UNSCOPED_NOTICE);
        expect(text).toContain(UNSCOPED_NOTICE);
      },
    );

    it('follows the unscoped sentence with the estimate sentence in one notice', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce(
        aggregatePage([aggregateRecord({ committee_id: 'C00507947', cycle: 2020 })], {
          count: 549_399,
          is_count_exact: false,
        }),
      );

      const { structured, text } = await callContract({ mode: 'by_size' });

      expect(structured.notice).toBe(`${UNSCOPED_NOTICE} ${APPROXIMATE_NOTICE}`);
      expect(text).toContain(`${UNSCOPED_NOTICE} ${APPROXIMATE_NOTICE}`);
    });

    it('marks a scoped aggregate page with an estimated count as an estimate alone', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce(
        aggregatePage([{ state: 'CA', total: 10, count: 1 }], {
          count: 5_000,
          is_count_exact: false,
        }),
      );

      const { structured, text } = await callContract({
        mode: 'by_state',
        committee_id: 'C00401224',
      });

      expect(structured.notice).toBe(APPROXIMATE_NOTICE);
      expect(text).toContain(APPROXIMATE_NOTICE);
    });

    it.each([
      ['committee_id', { mode: 'by_size', committee_id: 'C00718866', cycle: 2026 }],
      ['candidate_id', { mode: 'by_state', candidate_id: 'S8GA00180', cycle: 2026 }],
    ] as const)(
      'sets no notice on a %s-scoped aggregate page with a tallied count',
      async (_label, input) => {
        mockService.getContributionAggregates.mockResolvedValueOnce(
          aggregatePage([aggregateRecord()], { is_count_exact: true }),
        );

        const { structured, text } = await callContract(input);

        expect(structured.notice).toBeUndefined();
        expect(text).not.toContain('Without committee_id');
      },
    );

    it('keeps the exhausted-position notice on an unscoped page past the end', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce(
        aggregatePage([], { page: 9, pages: 3, count: 56, is_count_exact: false }),
      );

      const { structured, text } = await callContract({ mode: 'by_size', page: 9 });

      const exhausted =
        'Page 9 is past the last page of this result set — 56 total across 3 page(s). Request page 3 or lower to read them.';
      expect(structured.notice).toBe(exhausted);
      expect(text).toContain('No results at this position.');
      expect(text).not.toContain('Without committee_id');
    });
  });

  describe('size bucket labels', () => {
    it('labels each by_size floor right after size, on both surfaces, and leaves an unknown floor bare', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce(
        aggregatePage([
          { committee_id: 'C00718866', cycle: 2026, size: 0, total: 76_701_245, count: null },
          { committee_id: 'C00718866', cycle: 2026, size: 200, total: 1, count: 1 },
          { committee_id: 'C00718866', cycle: 2026, size: 500, total: 1, count: 1 },
          { committee_id: 'C00718866', cycle: 2026, size: 1000, total: 1, count: 1 },
          { committee_id: 'C00718866', cycle: 2026, size: 2000, total: 1, count: 1 },
          { committee_id: 'C00718866', cycle: 2026, size: 50, total: 1, count: 1 },
        ]),
      );

      const { structured, text } = await callContract({
        mode: 'by_size',
        committee_id: 'C00718866',
        cycle: 2026,
      });

      expect(structured.results.map((row) => row.size_range)).toEqual([
        '$200 and under (includes unitemized)',
        '$200.01 to $499.99',
        '$500 to $999.99',
        '$1,000 to $1,999.99',
        '$2,000 and over',
        undefined,
      ]);
      expect(Object.keys(structured.results[0]!)).toEqual([
        'committee_id',
        'cycle',
        'size',
        'size_range',
        'total',
        'count',
      ]);
      expect(structured.results[5]).not.toHaveProperty('size_range');
      expect(text).toContain('  size: 0\n  size_range: $200 and under (includes unitemized)');
      expect(text).toContain('  size: 2000\n  size_range: $2,000 and over');
      expect(text).not.toContain('size: 50\n  size_range');
    });

    it('labels by_size_candidate rows the same way', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce(
        aggregatePage([{ candidate_id: 'S8GA00180', cycle: 2026, size: 500, total: 1, count: 1 }]),
      );

      const { structured, text } = await callContract({
        mode: 'by_size',
        candidate_id: 'S8GA00180',
        cycle: 2026,
      });

      expect(structured.results[0]!.size_range).toBe('$500 to $999.99');
      expect(text).toContain('size_range: $500 to $999.99');
    });

    it('passes by_state rows through without a size label', async () => {
      const row = { committee_id: 'C00401224', cycle: 2020, state: 'CA', total: 10, count: 2 };
      mockService.getContributionAggregates.mockResolvedValueOnce(aggregatePage([row]));

      const { structured } = await callContract({ mode: 'by_state', committee_id: 'C00401224' });

      expect(structured.results).toEqual([row]);
    });
  });

  describe('candidate-scoped election period', () => {
    it.each([
      ['by_size', 'by_size_candidate'],
      ['by_state', 'by_state_candidate'],
    ] as const)(
      'sends and echoes election_full for a candidate-scoped %s',
      async (mode, resolved) => {
        mockService.getContributionAggregates.mockResolvedValueOnce(
          aggregatePage([aggregateRecord()]),
        );

        const { structured, text } = await callContract({
          mode,
          candidate_id: 'S8GA00180',
          cycle: 2026,
        });

        const [endpoint, params] = mockService.getContributionAggregates.mock.calls[0]!;
        expect(endpoint).toBe(resolved);
        expect(params).toMatchObject({
          candidate_id: 'S8GA00180',
          cycle: 2026,
          election_full: true,
        });
        expect(structured.search_criteria).toMatchObject({ cycle: 2026, election_full: true });
        expect(text).toContain('election_full=true');
      },
    );

    it('sends no election_full for a committee-scoped aggregate', async () => {
      mockService.getContributionAggregates.mockResolvedValueOnce(
        aggregatePage([aggregateRecord()]),
      );

      const { structured } = await callContract({
        mode: 'by_size',
        committee_id: 'C00718866',
        cycle: 2026,
      });

      expect(mockService.getContributionAggregates.mock.calls[0]![1]).not.toHaveProperty(
        'election_full',
      );
      expect(structured.search_criteria).not.toHaveProperty('election_full');
    });
  });
});
