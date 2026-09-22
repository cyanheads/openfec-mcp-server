/**
 * @fileoverview Tests for the search-contributions tool — itemized mode,
 * aggregate modes, cursor pagination, validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-contributions.tool.test
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

import { searchContributions } from '@/mcp-server/tools/definitions/search-contributions.tool.js';
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

    it('throws without committee_id in itemized mode', async () => {
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
      expect(result.results).toEqual(aggregates);
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

    it('rejects explicit page in itemized mode before the keyset call', async () => {
      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
        page: 7,
      });
      const err = (await Promise.resolve(searchContributions.handler(input, ctx)).catch(
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

    it('keeps the donor-as-committee contributor object, which is not a duplicate', async () => {
      const contributor = {
        committee_id: 'C00010603',
        name: 'MINNESOTA DFL',
        treasurer_name: 'PARK, JOHN',
        designated_agent_name: 'AGENT, ANN',
        cycles: [2020, 2022, 2024],
      };
      mockService.searchContributions.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [nestedContributionRecord('C00703975', { contributor })],
        nextCursor: null,
      });

      const input = searchContributions.input.parse({
        mode: 'itemized',
        committee_id: 'C00703975',
      });
      const result = await searchContributions.handler(input, ctx);

      expect(result.results[0]!.contributor).toEqual(contributor);
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
      const input = searchContributions.input.parse({
        mode: 'by_state',
        committee_id: 'C00703975',
        contributor_state: 'WA',
        min_date: '2024-10-01',
      });

      const err = (await Promise.resolve(searchContributions.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.message).toContain('contributor_state');
      expect(err.message).toContain('min_date');
      expect(err.message).toContain('committee_id, candidate_id, cycle');
      const data = err.data as { supported_inputs: string[]; recovery: { hint: string } };
      expect(data.supported_inputs).toEqual([
        'committee_id',
        'candidate_id',
        'cycle',
        'mode',
        'page',
        'per_page',
      ]);
      expect(data.recovery.hint).toContain('itemized');
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
});
