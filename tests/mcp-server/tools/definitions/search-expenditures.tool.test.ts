/**
 * @fileoverview Tests for the search-expenditures tool — itemized mode,
 * by_candidate aggregates, support/oppose mapping, cursor pagination,
 * and format rendering.
 * @module tests/mcp-server/tools/definitions/search-expenditures.tool.test
 */

import type { CallToolResult, ContentBlock } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { APPROXIMATE_COUNT_NOTICE } from '@/mcp-server/tools/definitions/utils/format-helpers.js';
import { cursorQuery, encodeCursor } from '@/services/openfec/openfec-service.js';
import { contractFailure, declaredRecovery } from './contract-failure.js';

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

/** The production-shaped surfaces of one `runToolContract` call. */
const surfaces = (result: CallToolResult) => ({
  structured: result.structuredContent as Record<string, unknown> & { notice?: string },
  text: result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n'),
});

/** Occurrences of `fragment` in `text`. */
const occurrences = (text: string, fragment: string) => text.split(fragment).length - 1;

describe('searchExpenditures', () => {
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
      const input = searchExpenditures.input.parse({ mode: 'itemized', ...range });
      const err = (await Promise.resolve(searchExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_range' });
      expect(mockService.searchExpenditures).not.toHaveBeenCalled();
    });

    it('rejects a malformed itemized date before dispatch', async () => {
      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        max_date: 'tomorrow',
      });
      const err = (await Promise.resolve(searchExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_date', field: 'max_date' });
      expect(mockService.searchExpenditures).not.toHaveBeenCalled();
    });

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
      const err = await contractFailure(searchExpenditures, { mode: 'by_candidate', cycle: 2024 });

      expect(err.data.reason).toBe('by_candidate_requires_scope');
      expect(err.data.recovery?.hint).toContain('candidate_office');
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
      const err = await contractFailure(searchExpenditures, {
        mode: 'by_candidate',
        candidate_id: 'S6FL00123',
        min_date: '2024-10-01',
        max_date: '2024-10-31',
        payee_name: 'NOSUCHPAYEE',
      });

      expect(err.message).toContain('payee_name');
      expect(err.message).toContain('min_date');
      expect(err.message).toContain('max_date');
      // The rejection names the mode's supported inputs, not just the bad ones.
      expect(err.message).toContain('candidate_id');
      expect(err.message).toContain('support_oppose');
      expect(err.data.supported_inputs).toContain('cycle');
      expect(err.data.recovery?.hint).toContain('itemized');
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

    it('sends election_full=true upstream in by_candidate mode and echoes it on both surfaces', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [byCandidateRecord()],
      });

      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_id: 'P80000722',
        cycle: 2024,
      });
      expect(input.election_full).toBeUndefined();
      const result = await searchExpenditures.handler(input, ctx);

      expect(mockService.getExpendituresByCandidate.mock.calls[0]![0]).toMatchObject({
        election_full: true,
        cycle: 2024,
      });
      expect(result.search_criteria).toMatchObject({ election_full: true, cycle: 2024 });
      expect(formatText(searchExpenditures.format!(result))).toContain('election_full=true');
    });

    it('forwards an explicit election_full=false for the two-year cycle alone', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [byCandidateRecord()],
      });

      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_id: 'P80000722',
        cycle: 2024,
        election_full: false,
      });
      const result = await searchExpenditures.handler(input, ctx);

      expect(mockService.getExpendituresByCandidate.mock.calls[0]![0].election_full).toBe(false);
      expect(result.search_criteria).toMatchObject({ election_full: false });
      expect(formatText(searchExpenditures.format!(result))).toContain('election_full=false');
    });

    it('echoes the effective election_full on an empty by_candidate response too', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 0, pages: 0 },
        results: [],
      });

      const input = searchExpenditures.input.parse({
        mode: 'by_candidate',
        candidate_id: 'P80000722',
      });
      const result = await searchExpenditures.handler(input, ctx);

      expect(result.search_criteria).toMatchObject({ election_full: true });
      expect(formatText(searchExpenditures.format!(result))).toContain('election_full: true');
    });

    it.each([
      [{ election_full: true }, ['election_full']],
      [{ election_full: false }, ['election_full']],
      [{ election_full: true, page: 2 }, ['page', 'election_full']],
    ])(
      'rejects %o in itemized mode, whose endpoint has no such parameter',
      async (extra, named) => {
        const err = await contractFailure(searchExpenditures, {
          mode: 'itemized',
          candidate_id: 'P80000722',
          ...extra,
        });

        expect(err.data).toMatchObject({
          reason: 'inputs_not_applicable_to_mode',
          inapplicable_inputs: named,
          recovery: { hint: expect.stringContaining('election_full') },
        });
        expect(err.message).toContain('election_full');
        expect(mockService.searchExpenditures).not.toHaveBeenCalled();
      },
    );

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

    it('moves each spender into the committees map when the query spans committees', async () => {
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
      for (const row of result.results) expect(row).not.toHaveProperty('committee');
      expect(result.committees?.C00111111).toEqual(nestedCommittee('C00111111'));
      expect(result.committees?.C00222222).toEqual(nestedCommittee('C00222222'));
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

    it('rejects explicit page in itemized mode before the keyset call', async () => {
      const err = await contractFailure(searchExpenditures, {
        mode: 'itemized',
        committee_id: 'C00111111',
        page: 5,
      });

      expect(err.data).toMatchObject({
        reason: 'inputs_not_applicable_to_mode',
        inapplicable_inputs: ['page'],
        recovery: {
          hint: declaredRecovery(searchExpenditures, 'inputs_not_applicable_to_mode'),
        },
      });
      expect((err.data as { supported_inputs: string[] }).supported_inputs).toEqual(
        expect.arrayContaining(['per_page', 'cursor']),
      );
      expect(mockService.searchExpenditures).not.toHaveBeenCalled();
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

    it('renders a committee record left on its row in full, as a block rather than a JSON dump', () => {
      const deep = {
        ...nestedCommittee('C00111111'),
        designation_full: 'Unauthorized',
        state: 'DC',
        designated_agent_street1: '430 SOUTH CAPITOL STREET SE',
      };
      /** The handler drops the nested candidate sub-object before format() sees a row. */
      const { candidate: _first, ...first }: Record<string, unknown> = nestedExpenditureRecord(
        'C00111111',
        { committee: deep },
      );
      const { candidate: _second, ...second }: Record<string, unknown> = nestedExpenditureRecord(
        'C00222222',
        { payee_name: 'SECOND PAYEE' },
      );
      const blocks = searchExpenditures.format!({
        results: [first, second],
        mode: 'itemized',
        next_cursor: null,
        count: 2,
        search_criteria: { mode: 'itemized', candidate_id: 'H2OH01234' },
      });

      const text = formatText(blocks);
      expect(text).not.toContain('{"');
      expect(text).toContain(
        [
          '  committee:',
          '    PAC C00111111 (C00111111)',
          '    committee_type_full: Super PAC',
          '    treasurer_name: ROE, RICHARD',
          '    cycles: 2020, 2022, 2024',
          '    designation_full: Unauthorized',
          '    state: DC',
          '    designated_agent_street1: 430 SOUTH CAPITOL STREET SE',
        ].join('\n'),
      );
      expect(text).toContain('  committee:\n    PAC C00222222 (C00222222)');
      // The rest of each row still renders.
      expect(text).toContain('MEDIA PARTNERS LLC');
      expect(text).toContain('SECOND PAYEE');
    });

    it('falls back to the committee ID when a per-row committee has no name', () => {
      const blocks = searchExpenditures.format!({
        results: [expenditureRecord({ committee: { committee_id: 'C00999999' } })],
        mode: 'itemized',
        next_cursor: null,
        count: 1,
        search_criteria: {},
      });

      const text = formatText(blocks);
      expect(text).toContain('  committee:\n    C00999999');
      expect(text).not.toContain('{"');
    });
  });

  describe('exhausted cursor', () => {
    it('renders no more-results trailer on a terminal page', () => {
      const blocks = searchExpenditures.format!({
        results: [expenditureRecord()],
        mode: 'itemized',
        next_cursor: null,
        count: 1,
        search_criteria: { mode: 'itemized', cycle: 2024 },
      });

      const text = formatText(blocks);
      expect(text).not.toContain('More results available');
      expect(text).not.toContain('next_cursor');
    });

    it('reports a spent cursor as exhausted on both surfaces', async () => {
      const query = { mode: 'itemized', committee_id: 'C00111111' };
      const cursor = cursorFor(query, { last_index: '999' });
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 9, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({ ...query, cursor });
      const result = await searchExpenditures.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(9);
      expect(getEnrichment(ctx).notice).toContain('cursor resumed past the last matching row');
      expect(getEnrichment(ctx).notice).not.toContain('No independent expenditures matched');

      const text = formatText(searchExpenditures.format!(result));
      expect(text).toContain('No results at this position.');
      expect(text).toContain('9 total');
      expect(text).not.toContain('No results found');
      expect(text).not.toContain('broaden');
    });

    it('keeps zero-match guidance when nothing matched at all', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 0, per_page: 20 },
        results: [],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({
        mode: 'itemized',
        committee_id: 'C00111111',
      });
      const result = await searchExpenditures.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('No independent expenditures matched');

      const text = formatText(searchExpenditures.format!(result));
      expect(text).toContain('No results found.');
      expect(text).not.toContain('No results at this position');
    });
  });

  describe('approximate counts', () => {
    it('marks an inexact itemized count as approximate on both surfaces', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 1_601_546, per_page: 1, is_count_exact: false },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({ mode: 'itemized', per_page: 1 });
      const result = await searchExpenditures.handler(input, ctx);

      expect(result.count_is_approximate).toBe(true);
      expect(formatText(searchExpenditures.format!(result))).toContain(
        '≈1601546 total independent expenditures (approximate)',
      );
      expect(getEnrichment(ctx).notice).toContain('upstream estimate');
    });

    it.each([
      ['an exact count', true],
      ['a count whose exactness upstream never declared', undefined],
    ])('renders %s as a plain total', async (_label, exact) => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: {
          count: 144_800,
          per_page: 20,
          ...(exact === undefined ? {} : { is_count_exact: exact }),
        },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const input = searchExpenditures.input.parse({ mode: 'itemized' });
      const result = await searchExpenditures.handler(input, ctx);

      expect(result.count_is_approximate).toBeUndefined();

      const text = formatText(searchExpenditures.format!(result));
      expect(text).toContain('**144800 total independent expenditures**');
      expect(text).not.toContain('approximate');
    });
  });

  describe('by_candidate order', () => {
    const NULL_FLAGS = ['sort_hide_null', 'sort_nulls_last', 'sort_null_only'] as const;

    it.each([1, 3])(
      'leads page %i with the largest totals by sending sort -total',
      async (page) => {
        mockService.getExpendituresByCandidate.mockResolvedValueOnce({
          pagination: { page, pages: 23, count: 112, per_page: 5 },
          results: [byCandidateRecord()],
        });

        await runToolContract(searchExpenditures, {
          mode: 'by_candidate',
          candidate_id: 'S8GA00180',
          cycle: 2026,
          per_page: 5,
          page,
        });

        const params = mockService.getExpendituresByCandidate.mock.calls[0]![0];
        expect(params).toMatchObject({ sort: '-total', page });
      },
    );

    it('sends no null-handling flag beside the fixed order', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [byCandidateRecord()],
      });

      await runToolContract(searchExpenditures, {
        mode: 'by_candidate',
        candidate_id: 'S8GA00180',
      });

      const params = mockService.getExpendituresByCandidate.mock.calls[0]![0];
      for (const flag of NULL_FLAGS) expect(params).not.toHaveProperty(flag);
    });

    it('does not echo the fixed order in search_criteria on either surface', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [byCandidateRecord()],
      });

      const { structured, text } = surfaces(
        await runToolContract(searchExpenditures, {
          mode: 'by_candidate',
          candidate_id: 'S8GA00180',
          cycle: 2024,
        }),
      );

      expect(structured.search_criteria).not.toHaveProperty('sort');
      expect(text).not.toContain('-total');
    });

    it('sends no sort upstream in itemized mode when the caller omits one', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      await runToolContract(searchExpenditures, { candidate_id: 'S8GA00180' });

      const params = mockService.searchExpenditures.mock.calls[0]![0];
      expect(params).not.toHaveProperty('sort');
      for (const flag of NULL_FLAGS) expect(params).not.toHaveProperty(flag);
    });

    it('says in the mode description that by_candidate rows come largest total first', () => {
      expect(searchExpenditures.input.shape.mode.description).toContain('largest total first');
    });
  });

  describe('is_notice', () => {
    it('describes all three settings and defers summing report rows to the memo rule', () => {
      const description = searchExpenditures.input.shape.is_notice.description ?? '';

      expect(description).toContain('Omitted returns both');
      expect(description).toContain('false returns periodic-report rows only');
      expect(description).toContain('true returns 24/48-hour notices only');
      expect(description).toContain('memo entries');
    });

    it('keeps its boolean validation', () => {
      expect(searchExpenditures.input.parse({ is_notice: false }).is_notice).toBe(false);
      expect(searchExpenditures.input.parse({}).is_notice).toBeUndefined();
      expect(searchExpenditures.input.safeParse({ is_notice: 'true' }).success).toBe(false);
    });

    it('forwards an explicit is_notice=false to the itemized endpoint', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      await runToolContract(searchExpenditures, { candidate_id: 'S8GA00180', is_notice: false });

      expect(mockService.searchExpenditures.mock.calls[0]![0].is_notice).toBe(false);
    });
  });

  /**
   * `/by_candidate/` leaves 24/48-hour notices out, so spending reported only on
   * a notice is missing from the current cycle's totals. The clock is pinned so
   * the current cycle is a fact of the test, not of the day it runs.
   */
  describe('current-cycle notice gap (by_candidate)', () => {
    const GAP = 'by_candidate totals come from periodic reports only';

    const runByCandidate = (
      args: Record<string, unknown>,
      rows: unknown[] = [byCandidateRecord()],
    ) => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: rows.length, pages: rows.length > 0 ? 1 : 0 },
        results: rows,
      });
      return runToolContract(searchExpenditures, { mode: 'by_candidate', ...args });
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      ['omitted', {}],
      ['the current cycle', { cycle: 2026 }],
      ['a later cycle', { cycle: 2028 }],
    ])(
      'names the itemized notice call when cycle is %s, on both surfaces',
      async (_label, cycleArg) => {
        const { structured, text } = surfaces(
          await runByCandidate({ candidate_id: 'S8GA00180', ...cycleArg }),
        );

        expect(structured.notice).toContain(GAP);
        expect(structured.notice).toContain('mode: "itemized", is_notice: true');
        expect(structured.notice).toContain('candidate_id: "S8GA00180"');
        expect(text).toContain(structured.notice);
      },
    );

    it('carries no gap sentence for an earlier cycle, whose notices are all on reports', async () => {
      const { structured, text } = surfaces(
        await runByCandidate({ candidate_id: 'S6PA00217', cycle: 2024 }),
      );

      expect(structured.notice).toBeUndefined();
      expect(text).not.toContain(GAP);
    });

    it('derives the current cycle from the clock: in an odd year the next even cycle is current', async () => {
      vi.setSystemTime(new Date('2027-03-01T12:00:00Z'));

      const past = surfaces(await runByCandidate({ candidate_id: 'S8GA00180', cycle: 2026 }));
      const current = surfaces(await runByCandidate({ candidate_id: 'S8GA00180', cycle: 2028 }));

      expect(past.structured.notice).toBeUndefined();
      expect(current.structured.notice).toContain(GAP);
    });

    it('names the race scope the caller passed when there is no candidate_id', async () => {
      const { structured } = surfaces(
        await runByCandidate({
          candidate_office: 'H',
          candidate_office_state: 'GA',
          candidate_office_district: '07',
          support_oppose: 'S',
          cycle: 2026,
        }),
      );

      expect(structured.notice).toContain(
        'mode: "itemized", is_notice: true, support_oppose: "S", candidate_office: "H", candidate_office_state: "GA", candidate_office_district: "07", cycle: 2026',
      );
      expect(structured.notice).not.toContain('candidate_id');
    });

    it('keeps the committee_id the caller narrowed the aggregate to in the itemized call', async () => {
      const { structured, text } = surfaces(
        await runByCandidate({ candidate_id: 'S8GA00180', committee_id: 'C00571703' }),
      );

      expect(structured.notice).toContain(
        'mode: "itemized", is_notice: true, committee_id: "C00571703", candidate_id: "S8GA00180"',
      );
      expect(text).toContain(structured.notice);
    });

    it('leaves a blank scope input out of the itemized call', async () => {
      const { structured } = surfaces(
        await runByCandidate({
          candidate_office: 'P',
          committee_id: '',
          candidate_id: '',
          candidate_office_state: '',
          candidate_office_district: '',
          cycle: 2026,
        }),
      );

      expect(structured.notice).toContain(
        'Find it with mode: "itemized", is_notice: true, candidate_office: "P", cycle: 2026 — ',
      );
      expect(structured.notice).not.toContain('""');
    });

    it('names no input to leave out when the caller passed neither page nor election_full', async () => {
      const { structured } = surfaces(
        await runByCandidate({ candidate_id: 'S8GA00180', cycle: 2026, per_page: 100 }),
      );

      expect(structured.notice).toContain('candidate_id: "S8GA00180", cycle: 2026 — ');
      expect(structured.notice).not.toContain('which itemized mode rejects');
    });

    it.each([
      ['page', { page: 2 }, ['page']],
      ['election_full', { election_full: false }, ['election_full']],
      ['page and election_full', { page: 2, election_full: true }, ['page', 'election_full']],
    ] as const)(
      'tells a caller who passed %s to leave it out of the itemized call, which rejects it',
      async (_label, extra, dropped) => {
        const byCandidate = { candidate_id: 'S8GA00180', cycle: 2026, per_page: 100, ...extra };
        const { structured, text } = surfaces(await runByCandidate(byCandidate));

        expect(structured.notice).toContain(
          `is_notice: true, candidate_id: "S8GA00180", cycle: 2026, without ${dropped.join(' or ')}, which itemized mode rejects — `,
        );
        expect(text).toContain(structured.notice);

        // Replayed over the caller's by_candidate arguments, the call fails on exactly the inputs named…
        const replay = { ...byCandidate, mode: 'itemized' as const, is_notice: true };
        const err = await contractFailure(searchExpenditures, replay);
        expect(err.data).toMatchObject({
          reason: 'inputs_not_applicable_to_mode',
          inapplicable_inputs: [...dropped],
        });

        // …and runs once they are left out.
        mockService.searchExpenditures.mockResolvedValueOnce({
          pagination: { count: 0, per_page: 100 },
          results: [],
          nextCursor: null,
        });
        const kept = Object.fromEntries(
          Object.entries(replay).filter(([key]) => !(dropped as readonly string[]).includes(key)),
        );
        expect((await runToolContract(searchExpenditures, kept)).isError).toBeFalsy();
        expect(mockService.searchExpenditures.mock.calls[0]![0]).toMatchObject({
          candidate_id: 'S8GA00180',
          cycle: 2026,
          is_notice: true,
          per_page: 100,
        });
      },
    );

    it('follows the zero-match sentence on an empty current-cycle page, in one notice', async () => {
      const { structured, text } = surfaces(
        await runByCandidate(
          {
            candidate_office: 'H',
            candidate_office_state: 'GA',
            candidate_office_district: '07',
            cycle: 2026,
          },
          [],
        ),
      );

      const notice = structured.notice ?? '';
      const zeroMatch = notice.indexOf('No periodic report lists independent expenditures');
      expect(zeroMatch).toBe(0);
      expect(notice.indexOf(GAP)).toBeGreaterThan(zeroMatch);
      // The race scope was right; the empty answer must not send the caller to re-check it.
      expect(notice).not.toContain('Verify the candidate_id');
      expect(text).toContain(notice);
      expect(text).not.toContain('Try a different cycle');
    });

    it('keeps the input check on an empty earlier-cycle page, with no gap sentence', async () => {
      const { structured } = surfaces(
        await runByCandidate({ candidate_id: 'S6PA00217', cycle: 2024 }, []),
      );

      expect(structured.notice).toBe(
        'No expenditures by candidate matched. Not every race draws outside spending; if you expected rows, check the cycle and the candidate_id or race scope.',
      );
    });

    it('follows the exhausted-page sentence past the last current-cycle page', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { page: 9, pages: 2, count: 30, per_page: 20 },
        results: [],
      });

      const { structured } = surfaces(
        await runToolContract(searchExpenditures, {
          mode: 'by_candidate',
          candidate_id: 'S8GA00180',
          page: 9,
        }),
      );

      const notice = structured.notice ?? '';
      expect(notice.indexOf('Page 9 is past the last page')).toBe(0);
      expect(notice.indexOf(GAP)).toBeGreaterThan(0);
    });
  });

  describe('state and party codes', () => {
    it.each([
      ['itemized', 'candidate_office_state', 'Georgia', 'invalid_state_code', {}],
      [
        'by_candidate',
        'candidate_office_state',
        'Georgia',
        'invalid_state_code',
        { mode: 'by_candidate', candidate_office: 'S' },
      ],
      ['itemized', 'candidate_party', 'Democratic', 'invalid_party_code', {}],
    ] as const)(
      'rejects %s %s %s before any request, with the expected form on both surfaces',
      async (_mode, field, value, reason, extra) => {
        const result = await runToolContract(searchExpenditures, {
          ...extra,
          [field]: value,
        });

        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as {
          error: {
            data: { reason: string; field: string; value: string; recovery: { hint: string } };
          };
        };
        expect(error.data).toMatchObject({ reason, field, value });
        expect(error.data.recovery.hint.length).toBeGreaterThan(0);
        expect(surfaces(result).text).toContain(error.data.recovery.hint);
        expect(mockService.searchExpenditures).not.toHaveBeenCalled();
        expect(mockService.getExpendituresByCandidate).not.toHaveBeenCalled();
      },
    );

    it('still names candidate_party as itemized-only in by_candidate, however wide', async () => {
      const err = await contractFailure(searchExpenditures, {
        mode: 'by_candidate',
        candidate_id: 'S8GA00180',
        candidate_party: 'Democratic',
      });

      expect(err.data).toMatchObject({
        reason: 'itemized_only_filters_in_aggregate_mode',
        inapplicable_inputs: ['candidate_party'],
      });
    });

    it.each([
      ['GA', 'DEM'],
      ['ga', 'dem'],
      ['US', 'W'],
      ['00', 'D/C'],
      ['14', 'N/A'],
      ['D', 'REP'],
      ['ZZ', 'LIB'],
    ])('sends state %s and party %s to the itemized endpoint as given', async (state, party) => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const result = await runToolContract(searchExpenditures, {
        candidate_office_state: state,
        candidate_party: party,
      });

      expect(result.isError).toBeFalsy();
      expect(mockService.searchExpenditures.mock.calls[0]![0]).toMatchObject({
        candidate_office_state: state,
        candidate_party: party,
      });
    });

    /** `/schedules/schedule_e/` reads `other` as foreign, invalid, or missing states and `-` as exclude. */
    it.each([
      ['other', 'DEM'],
      ['OTHER', 'W'],
      ['-GA', '-DEM'],
      ['-ga', '-d/c'],
    ])('sends the itemized filter values %s and %s as given', async (state, party) => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const result = await runToolContract(searchExpenditures, {
        candidate_office_state: state,
        candidate_party: party,
      });

      expect(result.isError).toBeFalsy();
      expect(mockService.searchExpenditures.mock.calls[0]![0]).toMatchObject({
        candidate_office_state: state,
        candidate_party: party,
      });
    });

    it.each([
      ['candidate_office_state', '-other', 'invalid_state_code'],
      ['candidate_office_state', '--GA', 'invalid_state_code'],
      ['candidate_party', '-DEMO', 'invalid_party_code'],
    ] as const)('still rejects itemized %s %s', async (field, value, reason) => {
      const err = await contractFailure(searchExpenditures, { [field]: value });

      expect(err.data).toMatchObject({ reason, field, value });
      expect(mockService.searchExpenditures).not.toHaveBeenCalled();
    });

    /** `/schedules/schedule_e/by_candidate/` matches its state exactly, so neither value selects a race. */
    it.each(['other', '-GA'])('rejects by_candidate state %s before any request', async (state) => {
      const err = await contractFailure(searchExpenditures, {
        mode: 'by_candidate',
        candidate_office: 'S',
        candidate_office_state: state,
      });

      expect(err.data).toMatchObject({
        reason: 'invalid_state_code',
        field: 'candidate_office_state',
        value: state,
      });
      expect(mockService.getExpendituresByCandidate).not.toHaveBeenCalled();
    });

    it('sends a valid by_candidate state as given', async () => {
      mockService.getExpendituresByCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [byCandidateRecord()],
      });

      await runToolContract(searchExpenditures, {
        mode: 'by_candidate',
        candidate_office: 'S',
        candidate_office_state: 'ga',
        cycle: 2024,
      });

      expect(mockService.getExpendituresByCandidate.mock.calls[0]![0].state).toBe('ga');
    });

    it('leaves an empty candidate_office_state unchecked and unsent', async () => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: 1, per_page: 20 },
        results: [expenditureRecord()],
        nextCursor: null,
      });

      const result = await runToolContract(searchExpenditures, {
        candidate_office_state: '',
        candidate_party: '',
      });

      expect(result.isError).toBeFalsy();
      const params = mockService.searchExpenditures.mock.calls[0]![0];
      expect(params).not.toHaveProperty('candidate_office_state');
      expect(params).not.toHaveProperty('candidate_party');
    });

    it('describes candidate_party as the code OpenFEC files, up to three characters', () => {
      expect(searchExpenditures.input.shape.candidate_party.description).toContain(
        'Party code as OpenFEC files it, up to three characters (e.g., DEM, REP, LIB, W).',
      );
    });
  });

  /**
   * The row-kind helper and the committee map are tabled at their own seam; these
   * cases prove only this tool's wiring — one per side of each branch, both surfaces.
   */
  describe('itemized rows not to be summed', () => {
    const NOTICE_SENTENCE = 'rows on this page are 24/48-hour notices';
    const MEMO_SENTENCE = 'rows on this page are memo entries';
    const reportRow = (overrides: Record<string, unknown> = {}) =>
      expenditureRecord({ candidate_name: 'OSSOFF, T. JONATHAN', ...overrides });
    const noticeRow = () => reportRow({ is_notice: true, filing_form: 'F24' });
    const memoRow = () => reportRow({ memo_code: 'X', memoed_subtotal: true });

    const runItemized = (rows: unknown[], pagination: Record<string, unknown> = {}) => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: rows.length, per_page: 20, ...pagination },
        results: rows,
        nextCursor: null,
      });
      return runToolContract(searchExpenditures, { candidate_id: 'S8GA00180' });
    };

    it('counts the notice rows a page mixes with report rows and marks each notice header', async () => {
      const { structured, text } = surfaces(
        await runItemized([reportRow(), noticeRow(), reportRow()]),
      );

      expect(structured.notice).toContain(`1 of 3 ${NOTICE_SENTENCE}`);
      expect(text).toContain(structured.notice);
      expect(occurrences(text, '**[SUPPORT] OSSOFF, T. JONATHAN** · 24/48-hour notice')).toBe(1);
      expect(occurrences(text, '**[SUPPORT] OSSOFF, T. JONATHAN**\n')).toBe(2);
      // The rows themselves are unchanged: the kind stays readable from each one.
      expect((structured.results as Record<string, unknown>[]).map((r) => r.is_notice)).toEqual([
        false,
        true,
        false,
      ]);
    });

    it('carries no notice sentence on an all-notice page, but still marks every header', async () => {
      const { structured, text } = surfaces(await runItemized([noticeRow(), noticeRow()]));

      expect(structured.notice).toBeUndefined();
      expect(occurrences(text, '· 24/48-hour notice')).toBe(2);
    });

    it('counts the memo rows a page mixes with other rows and marks each memo header', async () => {
      const { structured, text } = surfaces(
        await runItemized([reportRow(), memoRow(), reportRow(), memoRow(), reportRow()]),
      );

      expect(structured.notice).toContain(`2 of 5 ${MEMO_SENTENCE}`);
      expect(structured.notice).not.toContain(NOTICE_SENTENCE);
      expect(text).toContain(structured.notice);
      expect(occurrences(text, '** · memo entry')).toBe(2);
      expect((structured.results as Record<string, unknown>[]).map((r) => r.memo_code)).toEqual([
        undefined,
        'X',
        undefined,
        'X',
        undefined,
      ]);
    });

    it('carries no memo sentence on an all-memo page', async () => {
      const { structured, text } = surfaces(await runItemized([memoRow(), memoRow()]));

      expect(structured.notice).toBeUndefined();
      expect(occurrences(text, '· memo entry')).toBe(2);
    });

    it('composes the approximate count, memo, and notice sentences into one notice, in that order', async () => {
      const both = reportRow({ is_notice: true, memo_code: 'X' });
      const { structured, text } = surfaces(
        await runItemized([reportRow(), memoRow(), noticeRow(), both], {
          count: 1_601_546,
          is_count_exact: false,
        }),
      );

      const notice = structured.notice ?? '';
      expect(notice.indexOf(APPROXIMATE_COUNT_NOTICE)).toBe(0);
      const memo = notice.indexOf(`2 of 4 ${MEMO_SENTENCE}`);
      const notices = notice.indexOf(`2 of 4 ${NOTICE_SENTENCE}`);
      expect(memo).toBeGreaterThan(0);
      expect(notices).toBeGreaterThan(memo);
      expect(text).toContain(notice);
      expect(text).toContain('**[SUPPORT] OSSOFF, T. JONATHAN** · memo entry · 24/48-hour notice');
    });

    it('keeps the zero-match sentence alone on an empty page', async () => {
      const { structured } = surfaces(await runItemized([]));

      expect(structured.notice).toBe(
        'No independent expenditures matched. Try a different cycle, broaden filters, or verify the candidate_id/committee_id. Not all races attract significant outside spending.',
      );
    });

    it('names memo_code, memoed_subtotal, and is_notice in the row description', () => {
      const rowDescription = searchExpenditures.output.shape.results.element.description ?? '';

      for (const field of ['memo_code', 'memoed_subtotal', 'is_notice']) {
        expect(rowDescription).toContain(field);
      }
    });
  });

  describe('committees map', () => {
    /** Rows as format() receives them: the handler drops the nested candidate sub-object. */
    const spanningRows = () => [
      nestedExpenditureRecord('C00111111', { payee_name: 'FIRST PAYEE' }),
      nestedExpenditureRecord('C00222222', { payee_name: 'SECOND PAYEE' }),
      nestedExpenditureRecord('C00111111', { payee_name: 'THIRD PAYEE' }),
    ];

    const runSpanning = (rows: unknown[], args: Record<string, unknown>) => {
      mockService.searchExpenditures.mockResolvedValueOnce({
        pagination: { count: rows.length, per_page: 20 },
        results: rows,
        nextCursor: null,
      });
      return runToolContract(searchExpenditures, args);
    };

    it('carries each spender once, in full, on both surfaces of a page spanning committees', async () => {
      const { structured, text } = surfaces(
        await runSpanning(spanningRows(), { candidate_id: 'H2OH01234' }),
      );

      const committees = structured.committees as Record<string, Record<string, unknown>>;
      expect(Object.keys(committees)).toEqual(['C00111111', 'C00222222']);
      expect(committees.C00111111).toEqual(nestedCommittee('C00111111'));
      for (const row of structured.results as Record<string, unknown>[]) {
        expect(row).not.toHaveProperty('committee');
      }

      // Parity: every key and value of every record reaches content[], once.
      expect(occurrences(text, "**Committees referenced above** — each row's committee_id")).toBe(
        1,
      );
      for (const id of ['C00111111', 'C00222222']) {
        expect(occurrences(text, `**PAC ${id} (${id})**`)).toBe(1);
      }
      expect(occurrences(text, '  committee_type_full: Super PAC')).toBe(2);
      expect(occurrences(text, '  treasurer_name: ROE, RICHARD')).toBe(2);
      expect(occurrences(text, '  cycles: 2020, 2022, 2024')).toBe(2);
      // Each row still names the committee it references, read from the map.
      expect(occurrences(text, '  committee_id: C00111111 (PAC C00111111)')).toBe(2);
      expect(occurrences(text, '  committee_id: C00222222 (PAC C00222222)')).toBe(1);
      // The map renders after the rows.
      expect(text.indexOf('**Committees referenced above**')).toBeGreaterThan(
        text.indexOf('THIRD PAYEE'),
      );
    });

    it('carries no map when the caller scoped the page to one committee_id', async () => {
      const rows = [
        nestedExpenditureRecord('C00111111'),
        nestedExpenditureRecord('C00111111', { payee_name: 'SECOND PAYEE' }),
      ];
      const { structured, text } = surfaces(await runSpanning(rows, { committee_id: 'C00111111' }));

      expect(structured).not.toHaveProperty('committees');
      expect(structured.committee).toEqual(nestedCommittee('C00111111'));
      expect(text).not.toContain('**Committees referenced above**');
      expect(occurrences(text, '  treasurer_name: ROE, RICHARD')).toBe(1);
    });

    it('carries no map when no row embeds a committee record', async () => {
      const { structured, text } = surfaces(
        await runSpanning([expenditureRecord(), expenditureRecord()], {
          candidate_id: 'H2OH01234',
        }),
      );

      expect(structured).not.toHaveProperty('committees');
      expect(text).not.toContain('**Committees referenced above**');
      expect(text).toContain('  committee_id: C00111111\n');
    });
  });
});
