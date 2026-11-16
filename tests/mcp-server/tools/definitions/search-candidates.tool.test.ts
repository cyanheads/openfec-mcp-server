/**
 * @fileoverview Tests for the search-candidates tool — single lookup, search,
 * totals merging, validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-candidates.tool.test
 */

import type { CallToolResult, ContentBlock } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = {
  searchCandidates: vi.fn(),
  getCandidate: vi.fn(),
  getCandidateTotals: vi.fn(),
  getAllCandidateTotals: vi.fn(),
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

import { searchCandidates } from '@/mcp-server/tools/definitions/search-candidates.tool.js';
import { contractFailure, declaredRecovery } from './contract-failure.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

const candidateRecord = (overrides: Record<string, unknown> = {}) => ({
  candidate_id: 'P00003392',
  name: 'BIDEN, JOSEPH R JR',
  party_full: 'DEMOCRATIC PARTY',
  party: 'DEM',
  state: 'DE',
  office_full: 'President',
  office: 'P',
  incumbent_challenge_full: 'Incumbent',
  incumbent_challenge: 'I',
  district_number: 0,
  ...overrides,
});

const totalsRecord = (overrides: Record<string, unknown> = {}) => ({
  candidate_id: 'P00003392',
  receipts: 250_000_000,
  disbursements: 200_000_000,
  cash_on_hand_end_period: 50_000_000,
  debts_owed_by_committee: 1_000_000,
  coverage_end_date: '2024-06-30',
  ...overrides,
});

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

/** Every text block of a tool result, joined — the `content[]` surface a client reads. */
const contentText = (result: CallToolResult): string =>
  result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

/** The deadline the tool hands each service read. */
const BUDGET = { deadlineMs: expect.any(Number) };

const makeCtx = () => createMockContext({ errors: searchCandidates.errors });

describe('searchCandidates', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('handler', () => {
    it('searches candidates by query', async () => {
      const candidates = [candidateRecord()];
      mockService.searchCandidates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: candidates,
      });

      const input = searchCandidates.input.parse({ query: 'Biden' });
      const result = await searchCandidates.handler(input, ctx);

      expect(mockService.searchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'Biden', page: 1, per_page: 20 }),
        ctx,
        BUDGET,
      );
      expect(result.candidates).toEqual(candidates);
      expect(result.pagination.count).toBe(1);
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
      // The echo lands on non-empty responses too, so filters can be verified.
      expect(result.search_criteria).toEqual({ query: 'Biden', include_totals: false });
      expect(result.search_criteria).not.toHaveProperty('per_page');
      expect(formatText(searchCandidates.format!(result))).toContain('include_totals=false');
    });

    it('fetches a single candidate by ID', async () => {
      const candidates = [candidateRecord()];
      mockService.getCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: candidates,
      });
      mockService.getAllCandidateTotals.mockResolvedValueOnce({
        results: [totalsRecord()],
        complete: true,
      });

      const input = searchCandidates.input.parse({ candidate_id: 'P00003392' });
      const result = await searchCandidates.handler(input, ctx);

      expect(mockService.getCandidate).toHaveBeenCalledWith('P00003392', ctx, BUDGET);
      expect(result.candidates).toEqual(candidates);
    });

    it('keeps candidate-ID totals scope in structured and formatted criteria', async () => {
      mockService.getCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [candidateRecord()],
      });
      mockService.getAllCandidateTotals.mockResolvedValueOnce({
        results: [totalsRecord({ cycle: 2024 })],
        complete: true,
      });

      const input = searchCandidates.input.parse({
        candidate_id: 'P00003392',
        cycle: 2024,
        election_year: 2024,
        include_totals: true,
      });
      const result = await searchCandidates.handler(input, ctx);

      expect(mockService.getAllCandidateTotals).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate_id: ['P00003392'],
          cycle: 2024,
          election_year: 2024,
        }),
        ctx,
        BUDGET,
      );
      expect(result.search_criteria).toEqual({
        candidate_id: 'P00003392',
        cycle: 2024,
        election_year: 2024,
        include_totals: true,
      });
      const text = formatText(searchCandidates.format!(result));
      expect(text).toContain('candidate_id=P00003392');
      expect(text).toContain('cycle=2024');
      expect(text).toContain('election_year=2024');
      expect(text).toContain('include_totals=true');
    });

    it('auto-includes totals when fetching by candidate_id', async () => {
      mockService.getCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [candidateRecord()],
      });
      mockService.getAllCandidateTotals.mockResolvedValueOnce({
        results: [totalsRecord()],
        complete: true,
      });

      const input = searchCandidates.input.parse({ candidate_id: 'P00003392' });
      const result = await searchCandidates.handler(input, ctx);

      expect(mockService.getAllCandidateTotals).toHaveBeenCalledOnce();
      expect(result.totals).toEqual([totalsRecord()]);
      expect(result.search_criteria).toEqual({
        candidate_id: 'P00003392',
        include_totals: true,
      });
      expect(formatText(searchCandidates.format!(result))).toContain('include_totals=true');
    });

    it('throws on invalid candidate_id format with a friendly McpError', async () => {
      // .regex() removed from Zod schema — validation now fires in handler via validateCandidateId
      const input = searchCandidates.input.parse({ candidate_id: 'INVALID' });
      const err = await Promise.resolve(searchCandidates.handler(input, ctx)).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_candidate_id' });
    });

    it("keys the totals walk to the page's candidates, never the candidate search's paging", async () => {
      const candidates = [
        candidateRecord({ candidate_id: 'S2CA01110', name: 'SMITH, A' }),
        candidateRecord({ candidate_id: 'S8MO00301', name: 'SMITH, B' }),
      ];
      mockService.searchCandidates.mockResolvedValueOnce({
        pagination: { page: 2, pages: 5, count: 90, per_page: 10 },
        results: candidates,
      });
      mockService.getAllCandidateTotals.mockResolvedValueOnce({
        results: [
          totalsRecord({ candidate_id: 'S2CA01110', cycle: 2024 }),
          totalsRecord({ candidate_id: 'S8MO00301', cycle: 2020 }),
        ],
        complete: true,
      });

      const input = searchCandidates.input.parse({
        query: 'smith',
        office: 'S',
        per_page: 10,
        page: 2,
        include_totals: true,
      });
      const result = await searchCandidates.handler(input, ctx);

      expect(mockService.getAllCandidateTotals).toHaveBeenCalledOnce();
      const [params] = mockService.getAllCandidateTotals.mock.calls[0]!;
      expect(params).toMatchObject({ candidate_id: ['S2CA01110', 'S8MO00301'] });
      expect(params).not.toHaveProperty('page');
      expect(params).not.toHaveProperty('per_page');
      expect(result.totals).toHaveLength(2);
      expect(mockService.getCandidateTotals).not.toHaveBeenCalled();
    });

    it('spends one budget across the candidate read and the totals walk', async () => {
      vi.useFakeTimers();
      mockService.searchCandidates.mockImplementationOnce(async () => {
        vi.advanceTimersByTime(30_000);
        return {
          pagination: { ...PAGE, count: 1 },
          results: [candidateRecord({ candidate_id: 'S2CA01110' })],
        };
      });
      mockService.getAllCandidateTotals.mockResolvedValueOnce({ results: [], complete: true });

      const input = searchCandidates.input.parse({ query: 'smith', include_totals: true });
      await searchCandidates.handler(input, ctx);

      expect(mockService.searchCandidates.mock.calls[0]![2]).toEqual({ deadlineMs: 50_000 });
      expect(mockService.getAllCandidateTotals.mock.calls[0]![2]).toEqual({ deadlineMs: 20_000 });
    });

    it('skips totals when include_totals=false', async () => {
      mockService.getCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [candidateRecord()],
      });

      const input = searchCandidates.input.parse({
        candidate_id: 'P00003392',
        include_totals: false,
      });
      const result = await searchCandidates.handler(input, ctx);

      expect(mockService.getAllCandidateTotals).not.toHaveBeenCalled();
      expect(result.totals).toBeUndefined();
    });

    it.each([
      [{ cycle: 2024 }, ['cycle']],
      [{ election_year: 2024 }, ['election_year']],
      [{ cycle: 2024, election_year: 2024 }, ['cycle', 'election_year']],
    ] as const)(
      'rejects totals-only scope %o when totals are disabled',
      async (totalsScope, inapplicableInputs) => {
        const err = await contractFailure(searchCandidates, {
          candidate_id: 'P00003392',
          include_totals: false,
          ...totalsScope,
        });

        expect(err.data).toMatchObject({
          reason: 'inputs_not_applicable_to_id_lookup',
          inapplicable_inputs: inapplicableInputs,
          supported_inputs: ['candidate_id', 'include_totals'],
        });
        expect(err.data.recovery?.hint).toContain('include_totals');
        expect(mockService.getCandidate).not.toHaveBeenCalled();
        expect(mockService.getAllCandidateTotals).not.toHaveBeenCalled();
      },
    );

    it('rejects every explicit search-only input on the direct-ID path', async () => {
      const err = await contractFailure(searchCandidates, {
        candidate_id: 'P00003392',
        query: 'Biden',
        state: 'ZZ',
        district: '99',
        office: 'P',
        party: 'DEM',
        incumbent_challenge: 'I',
        candidate_status: 'C',
        has_raised_funds: true,
        page: 2,
        per_page: 50,
      });

      expect(err.data).toMatchObject({
        reason: 'inputs_not_applicable_to_id_lookup',
        inapplicable_inputs: [
          'query',
          'state',
          'district',
          'office',
          'party',
          'incumbent_challenge',
          'candidate_status',
          'has_raised_funds',
          'page',
          'per_page',
        ],
        supported_inputs: ['candidate_id', 'include_totals', 'cycle', 'election_year'],
      });
      expect(err.data.recovery?.hint).toBe(
        declaredRecovery(searchCandidates, 'inputs_not_applicable_to_id_lookup'),
      );
      expect(mockService.getCandidate).not.toHaveBeenCalled();
      expect(mockService.getAllCandidateTotals).not.toHaveBeenCalled();
      expect(mockService.searchCandidates).not.toHaveBeenCalled();
    });

    it('reports an inapplicable state on the direct-ID path before checking its width', async () => {
      const err = await contractFailure(searchCandidates, {
        candidate_id: 'P00003392',
        state: 'Georgia',
      });

      expect(err.data).toMatchObject({
        reason: 'inputs_not_applicable_to_id_lookup',
        inapplicable_inputs: ['state'],
      });
      expect(mockService.getCandidate).not.toHaveBeenCalled();
    });

    /**
     * The incomplete-totals notice advises a single candidate_id; a caller who
     * keeps the search's own arguments beside it reads which to drop from the
     * message, since content[] carries no data object.
     */
    it('names the refused inputs in the message on both surfaces', async () => {
      const result = await runToolContract(searchCandidates, {
        office: 'H',
        incumbent_challenge: 'I',
        per_page: 100,
        include_totals: true,
        candidate_id: 'H0AL02087',
      });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { message: string } };
      const message =
        'A direct candidate_id lookup cannot apply office, incumbent_challenge, per_page.';
      expect(error.message).toBe(message);
      expect(contentText(result)).toContain(message);
      expect(mockService.getCandidate).not.toHaveBeenCalled();
    });

    it('sets enrichment notice when search returns empty results', async () => {
      mockService.searchCandidates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 0 },
        results: [],
      });

      const input = searchCandidates.input.parse({ query: 'Nonexistent Candidate' });
      await searchCandidates.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeDefined();
      expect(getEnrichment(ctx).notice).toContain('No candidates matched');
    });
  });

  describe('format', () => {
    it('renders the criteria echo on a non-empty response', () => {
      const blocks = searchCandidates.format!({
        candidates: [candidateRecord()],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { query: 'Biden', office: 'P' },
      });

      expect(formatText(blocks)).toContain('_Search criteria: query=Biden · office=P_');
    });

    it('renders candidate lines with pagination', () => {
      const blocks = searchCandidates.format!({
        candidates: [candidateRecord()],
        pagination: { ...PAGE, count: 1 },
        search_criteria: {},
      });

      const text = formatText(blocks);
      expect(text).toContain('**BIDEN, JOSEPH R JR** (P00003392)');
      expect(text).toContain('DEMOCRATIC PARTY');
      expect(text).toContain('President');
      expect(text).toContain('DE');
      expect(text).toContain('Page 1 of 1');
      expect(text).toContain('1 total');
      expect(text).toContain('per page');
    });

    it('renders "No candidates found" for empty results', () => {
      const blocks = searchCandidates.format!({
        candidates: [],
        pagination: PAGE,
        search_criteria: { query: 'NOSUCHCANDIDATE' },
      });

      expect(formatText(blocks)).toContain('No results found');
    });

    it('merges financial totals into candidate lines', () => {
      const blocks = searchCandidates.format!({
        candidates: [candidateRecord()],
        totals: [totalsRecord()],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { candidate_id: 'P00003392' },
      });

      const text = formatText(blocks);
      expect(text).toContain('receipts:');
      expect(text).toContain('disbursements:');
      expect(text).toContain('cash_on_hand_end_period:');
      expect(text).toContain('debts_owed_by_committee:');
      expect(text).toContain('coverage_end_date: 2024-06-30');
    });

    it('renders every totals row for a candidate, one per cycle', () => {
      const blocks = searchCandidates.format!({
        candidates: [candidateRecord()],
        totals: [
          totalsRecord({ cycle: 2016, receipts: 1_000_000 }),
          totalsRecord({ cycle: 2008, receipts: 2_000_000 }),
        ],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { candidate_id: 'P00003392' },
      });

      const text = formatText(blocks);
      expect(text).toContain('— Financial Totals (cycle 2016) —');
      expect(text).toContain('— Financial Totals (cycle 2008) —');
      expect(text).toContain('receipts: 1000000');
      expect(text).toContain('receipts: 2000000');
    });
  });

  describe('totals walk', () => {
    const smiths = () => ({
      pagination: { ...PAGE, count: 2 },
      results: [
        candidateRecord({ candidate_id: 'S2CA01110', name: 'SMITH, A' }),
        candidateRecord({ candidate_id: 'S8MO00301', name: 'SMITH, B' }),
      ],
    });

    it('advertises no missing_totals field', () => {
      expect(searchCandidates.output.shape).not.toHaveProperty('missing_totals');
    });

    it('renders every totals row the walk read, with no notice, when it read every page', async () => {
      mockService.searchCandidates.mockResolvedValueOnce(smiths());
      mockService.getAllCandidateTotals.mockResolvedValueOnce({
        results: [
          totalsRecord({ candidate_id: 'S2CA01110', cycle: 2024, receipts: 2_024 }),
          totalsRecord({ candidate_id: 'S8MO00301', cycle: 1998, receipts: 1_998 }),
        ],
        complete: true,
      });

      const result = await runToolContract(searchCandidates, {
        query: 'smith',
        include_totals: true,
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totals).toEqual([
        expect.objectContaining({ candidate_id: 'S2CA01110', cycle: 2024 }),
        expect.objectContaining({ candidate_id: 'S8MO00301', cycle: 1998 }),
      ]);
      expect(structured).not.toHaveProperty('notice');
      expect(structured).not.toHaveProperty('missing_totals');
      const text = contentText(result);
      expect(text).toContain('— Financial Totals (cycle 2024) —');
      expect(text).toContain('— Financial Totals (cycle 1998) —');
      expect(text).toContain('receipts: 1998');
      expect(text).not.toContain('incomplete');
    });

    /** The walk reads candidates whole, so one it never reached shows no totals at all. */
    it('renders the totals read so far with an incomplete notice when the walk ended early', async () => {
      mockService.searchCandidates.mockResolvedValueOnce(smiths());
      mockService.getAllCandidateTotals.mockResolvedValueOnce({
        results: [totalsRecord({ candidate_id: 'S2CA01110', cycle: 2024, receipts: 2_024 })],
        complete: false,
      });

      const result = await runToolContract(searchCandidates, {
        query: 'smith',
        include_totals: true,
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totals).toEqual([
        expect.objectContaining({ candidate_id: 'S2CA01110', cycle: 2024 }),
      ]);
      expect(structured.candidates).toHaveLength(2);
      expect(structured.notice).toContain('Financial totals are incomplete');
      expect(structured.notice).toContain(
        'a candidate shown without financial totals may still have them on file',
      );
      expect(structured.notice).not.toContain('earliest');
      expect(structured.notice).toContain('candidate_id');
      const text = contentText(result);
      expect(text).toContain('— Financial Totals (cycle 2024) —');
      expect(text).toContain('receipts: 2024');
      expect(text).toContain(structured.notice as string);
    });

    it('discloses a walk that read nothing before its budget ran out', async () => {
      mockService.getCandidate.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [candidateRecord()],
      });
      mockService.getAllCandidateTotals.mockResolvedValueOnce({ results: [], complete: false });

      const result = await runToolContract(searchCandidates, { candidate_id: 'P00003392' });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totals).toEqual([]);
      expect(structured.notice).toContain('Financial totals are incomplete');
      const text = contentText(result);
      expect(text).toContain('**BIDEN, JOSEPH R JR** (P00003392)');
      expect(text).not.toContain('— Financial Totals');
      expect(text).toContain('Financial totals are incomplete');
    });
  });

  describe('state and party codes', () => {
    it.each([
      [
        'state',
        { state: 'Georgia', office: 'S', cycle: 2026 },
        'invalid_state_code',
        'Georgia',
        'Use the postal code (GA for Georgia, PR for Puerto Rico); OpenFEC files presidential candidates under US and foreign addresses under ZZ.',
      ],
      [
        'party',
        { party: 'Democratic', state: 'GA', office: 'S', cycle: 2026 },
        'invalid_party_code',
        'Democratic',
        'Use the code, not the party name: DEM, REP, LIB, GRE, IND, W (write-in).',
      ],
    ] as const)(
      'rejects a spelled-out %s before any request, on both surfaces',
      async (field, args, reason, value, hint) => {
        const result = await runToolContract(searchCandidates, args);

        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as {
          error: { data: Record<string, unknown> };
        };
        expect(error.data).toMatchObject({ reason, field, value, recovery: { hint } });
        const text = contentText(result);
        expect(text).toContain(`"${value}"`);
        expect(text).toContain(hint);
        expect(text).toContain(reason);
        expect(mockService.searchCandidates).not.toHaveBeenCalled();
        expect(mockService.getAllCandidateTotals).not.toHaveBeenCalled();
      },
    );

    it.each(['GA', 'ga', 'US', 'ZZ', '00', '14', 'D'])('sends state %s as given', async (state) => {
      mockService.searchCandidates.mockResolvedValueOnce({ pagination: PAGE, results: [] });

      await searchCandidates.handler(searchCandidates.input.parse({ state }), ctx);

      expect(mockService.searchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ state }),
        ctx,
        BUDGET,
      );
    });

    it.each(['DEM', 'dem', 'W', 'D/C', 'N/A'])('sends party %s as given', async (party) => {
      mockService.searchCandidates.mockResolvedValueOnce({ pagination: PAGE, results: [] });

      await searchCandidates.handler(searchCandidates.input.parse({ party }), ctx);

      expect(mockService.searchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ party }),
        ctx,
        BUDGET,
      );
    });

    /** `/candidates/` filters both through filter_multi, where a leading `-` excludes the code. */
    it('sends an excluded state and party as given', async () => {
      mockService.searchCandidates.mockResolvedValueOnce({ pagination: PAGE, results: [] });

      await searchCandidates.handler(
        searchCandidates.input.parse({ state: '-GA', party: '-DEM' }),
        ctx,
      );

      expect(mockService.searchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ state: '-GA', party: '-DEM' }),
        ctx,
        BUDGET,
      );
    });

    /** `/candidates/` has no `other` state: only the STATE_OTHER endpoints do. */
    it.each([
      ['state', { state: 'other' }, 'invalid_state_code', 'other'],
      ['state', { state: '-GAA' }, 'invalid_state_code', '-GAA'],
      ['party', { party: '-DEMO' }, 'invalid_party_code', '-DEMO'],
    ] as const)('rejects %s %j before any request', async (field, args, reason, value) => {
      const err = await contractFailure(searchCandidates, args);

      expect(err.data).toMatchObject({ reason, field, value });
      expect(mockService.searchCandidates).not.toHaveBeenCalled();
    });

    it('skips both checks for the empty strings a form client sends', async () => {
      mockService.searchCandidates.mockResolvedValueOnce({ pagination: PAGE, results: [] });

      const input = searchCandidates.input.parse({ query: 'smith', state: '', party: '' });
      await searchCandidates.handler(input, ctx);

      expect(mockService.searchCandidates).toHaveBeenCalledOnce();
    });
  });

  describe('exhausted position', () => {
    it('reports a page past the end as exhausted on both surfaces', async () => {
      mockService.searchCandidates.mockResolvedValueOnce({
        pagination: { page: 2, pages: 1, count: 1, per_page: 5 },
        results: [],
      });

      const input = searchCandidates.input.parse({ query: 'BIDEN', page: 2, per_page: 5 });
      const result = await searchCandidates.handler(input, ctx);

      expect(result.pagination).toMatchObject({ page: 2, pages: 1, count: 1 });
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toContain('Page 2 is past the last page');
      expect(getEnrichment(ctx).notice).not.toContain('No candidates matched');

      const text = formatText(searchCandidates.format!(result));
      expect(text).toContain('No results at this position.');
      expect(text).toContain('1 total');
      expect(text).toContain('Request page 1 or lower');
      expect(text).not.toContain('No results found');
      expect(text).not.toContain('Try broadening your search');
    });

    it('keeps zero-match guidance when nothing matched at all', async () => {
      mockService.searchCandidates.mockResolvedValueOnce({
        pagination: { page: 1, pages: 0, count: 0, per_page: 20 },
        results: [],
      });

      const input = searchCandidates.input.parse({ query: 'NOSUCHCANDIDATE' });
      const result = await searchCandidates.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('No candidates matched');

      const text = formatText(searchCandidates.format!(result));
      expect(text).toContain('No results found.');
      expect(text).not.toContain('No results at this position');
    });
  });
});
