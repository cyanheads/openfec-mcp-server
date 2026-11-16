/**
 * @fileoverview Tests for the search-coordinated-expenditures tool — Schedule F
 * page-based search, committee hoisting, ID validation, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-coordinated-expenditures.tool.test
 */

import type { CallToolResult, ContentBlock } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = {
  searchCandidates: vi.fn(),
  getCandidate: vi.fn(),
  getCandidateTotals: vi.fn(),
  getCandidateCommittees: vi.fn(),
  searchCommittees: vi.fn(),
  getCommittee: vi.fn(),
  getCommitteeTotals: vi.fn(),
  getCommitteeTotalsByEntityType: vi.fn(),
  searchContributions: vi.fn(),
  getContributionAggregates: vi.fn(),
  searchDisbursements: vi.fn(),
  getDisbursementAggregates: vi.fn(),
  searchExpenditures: vi.fn(),
  getExpendituresByCandidate: vi.fn(),
  searchCoordinatedExpenditures: vi.fn(),
  searchFilings: vi.fn(),
  searchElections: vi.fn(),
  searchElectionsByZip: vi.fn(),
  getElectionSummary: vi.fn(),
  searchLegal: vi.fn(),
  getLegalDocument: vi.fn(),
  getCalendarDates: vi.fn(),
  getReportingDates: vi.fn(),
  getElectionDates: vi.fn(),
};

vi.mock('@/services/openfec/openfec-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/openfec/openfec-service.js')>()),
  getOpenFecService: () => mockService,
}));

import { searchCoordinatedExpenditures } from '@/mcp-server/tools/definitions/search-coordinated-expenditures.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

const committee = (id = 'C00003418') => ({
  committee_id: id,
  name: 'REPUBLICAN NATIONAL COMMITTEE',
  committee_type_full: 'Party - Qualified',
  designation_full: 'Unauthorized',
  party_full: 'REPUBLICAN PARTY',
  state: 'DC',
});

const row = (overrides: Record<string, unknown> = {}) => ({
  candidate_id: 'P80001571',
  candidate_name: 'TRUMP, DONALD J',
  candidate_office: 'P',
  committee_id: 'C00003418',
  expenditure_amount: 9_000_000,
  expenditure_date: '2024-08-07T00:00:00',
  expenditure_purpose_full: 'MEDIA BUY',
  expenditure_type_full: 'COORDINATED EXPENDITURE',
  payee_name: 'NATIONAL MEDIA RESEARCH',
  subordinate_committee_id: 'C00003418',
  committee: committee(),
  subordinate_committee: committee(),
  ...overrides,
});

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

/** All `content[]` text of a tool call, enrichment trailer included. */
const wireText = (result: CallToolResult) =>
  result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

/**
 * A Schedule F memo row: memo_code "X" and no memoed_subtotal, which Schedule F
 * does not carry.
 */
const memoRow = (overrides: Record<string, unknown> = {}) =>
  row({
    memo_code: 'X',
    memo_text: 'MEMO ENTRY',
    back_reference_transaction_id: 'SF-1063568',
    payee_name: 'FAIRMONT HOTELS',
    expenditure_amount: 26,
    ...overrides,
  });

const MEMO_SENTENCE = (n: number, m: number) =>
  `${n} of ${m} rows on this page are memo entries (memo_code "X"): each itemizes another row, named by back_reference_transaction_id when filed, or restates earlier activity, and FEC leaves memo entries out of report totals. Do not add them to the other rows.`;

const makeCtx = () => createMockContext();

describe('searchCoordinatedExpenditures', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it.each([
      ['date', { min_date: '2024-12-31', max_date: '2024-01-01' }],
      ['amount', { min_amount: 5000, max_amount: 1000 }],
    ] as const)('rejects an inverted %s range before dispatch', async (_kind, range) => {
      const input = searchCoordinatedExpenditures.input.parse(range);
      const err = (await Promise.resolve(searchCoordinatedExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_range' });
      expect(mockService.searchCoordinatedExpenditures).not.toHaveBeenCalled();
    });

    it('rejects malformed dates before dispatch', async () => {
      const input = searchCoordinatedExpenditures.input.parse({ min_date: '2024-00-01' });
      const err = (await Promise.resolve(searchCoordinatedExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_date', field: 'min_date' });
      expect(mockService.searchCoordinatedExpenditures).not.toHaveBeenCalled();
    });

    it('sends only the filters the caller supplied, under Schedule F parameter names', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [row()],
      });

      const input = searchCoordinatedExpenditures.input.parse({
        candidate_id: 'P80001571',
        cycle: 2024,
        payee_name: 'MEDIA',
        min_amount: 1000,
        max_date: '2024-11-05',
        sort: '-expenditure_amount',
      });
      await searchCoordinatedExpenditures.handler(input, ctx);

      expect(mockService.searchCoordinatedExpenditures).toHaveBeenCalledOnce();
      const params = mockService.searchCoordinatedExpenditures.mock.calls[0]![0];
      expect(params).toEqual({
        page: 1,
        per_page: 20,
        candidate_id: 'P80001571',
        cycle: 2024,
        payee_name: 'MEDIA',
        min_amount: 1000,
        max_date: '2024-11-05',
        sort: '-expenditure_amount',
      });
    });

    it('echoes the effective criteria minus paging arguments', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [row()],
      });

      const input = searchCoordinatedExpenditures.input.parse({ cycle: 2024, per_page: 5 });
      const result = await searchCoordinatedExpenditures.handler(input, ctx);

      expect(result.search_criteria).toEqual({ cycle: 2024 });
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('hoists the committee and drops subordinate_committee when scoped to one committee', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 2 },
        results: [row(), row({ expenditure_amount: 73_563 })],
      });

      const input = searchCoordinatedExpenditures.input.parse({ committee_id: 'C00003418' });
      const result = await searchCoordinatedExpenditures.handler(input, ctx);

      expect(result.committee).toMatchObject({ committee_id: 'C00003418' });
      expect(result).not.toHaveProperty('committees');
      for (const r of result.results) {
        expect(r).not.toHaveProperty('committee');
        expect(r).not.toHaveProperty('subordinate_committee');
        expect(r).toHaveProperty('subordinate_committee_id', 'C00003418');
      }
    });

    it('carries each spender once in committees when the query spans committees, still dropping subordinate_committee', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 3 },
        results: [
          row(),
          row({ committee_id: 'C00010603', committee: committee('C00010603') }),
          row({ expenditure_amount: 73_563 }),
        ],
      });

      const input = searchCoordinatedExpenditures.input.parse({ cycle: 2024 });
      const result = await searchCoordinatedExpenditures.handler(input, ctx);

      expect(result.committee).toBeUndefined();
      expect(result.committees).toEqual({
        C00003418: committee(),
        C00010603: committee('C00010603'),
      });
      for (const r of result.results) {
        expect(r).not.toHaveProperty('committee');
        expect(r).not.toHaveProperty('subordinate_committee');
      }
      expect(result.results.map((r) => r.committee_id)).toEqual([
        'C00003418',
        'C00010603',
        'C00003418',
      ]);
    });

    it("keeps another cycle's record for the same spender on its row", async () => {
      const cycle2018 = { ...committee('C00010603'), cycle: 2018, treasurer_name: 'DERROUGH' };
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 2 },
        results: [
          row({ committee_id: 'C00010603', committee: { ...committee('C00010603'), cycle: 2016 } }),
          row({ committee_id: 'C00010603', committee: cycle2018 }),
        ],
      });

      const input = searchCoordinatedExpenditures.input.parse({ candidate_id: 'P00003392' });
      const result = await searchCoordinatedExpenditures.handler(input, ctx);

      expect(result.committees).toEqual({ C00010603: { ...committee('C00010603'), cycle: 2016 } });
      expect(result.results[0]).not.toHaveProperty('committee');
      expect(result.results[1]!.committee).toEqual(cycle2018);
    });

    it('sets an enrichment notice when nothing matched', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: PAGE,
        results: [],
      });

      const input = searchCoordinatedExpenditures.input.parse({ cycle: 2024 });
      await searchCoordinatedExpenditures.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toContain('No coordinated party expenditures matched');
    });

    it('rejects a malformed committee_id before calling the API', async () => {
      const input = searchCoordinatedExpenditures.input.parse({ committee_id: 'NOPE' });
      const err = await Promise.resolve(searchCoordinatedExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_committee_id' });
      expect(mockService.searchCoordinatedExpenditures).not.toHaveBeenCalled();
    });

    it('rejects a malformed candidate_id before calling the API', async () => {
      const input = searchCoordinatedExpenditures.input.parse({ candidate_id: 'X123' });
      const err = await Promise.resolve(searchCoordinatedExpenditures.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_candidate_id' });
      expect(mockService.searchCoordinatedExpenditures).not.toHaveBeenCalled();
    });

    it('rejects a sort field Schedule F does not expose', () => {
      expect(() =>
        searchCoordinatedExpenditures.input.parse({ sort: '-office_total_ytd' }),
      ).toThrow();
    });
  });

  describe('format', () => {
    it('renders the amount, candidate, date, and remaining row fields', () => {
      const blocks = searchCoordinatedExpenditures.format!({
        results: [row()],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { cycle: 2024 },
      });

      const text = formatText(blocks);
      expect(text).toContain('**$9,000,000 for TRUMP, DONALD J** — 2024-08-07');
      expect(text).toContain('payee_name: NATIONAL MEDIA RESEARCH');
      expect(text).toContain('expenditure_type_full: COORDINATED EXPENDITURE');
      expect(text).toContain('Page 1 of 1 · 1 total · 20 per page');
      expect(text).toContain('_Search criteria: cycle=2024_');
    });

    it('renders the hoisted committee header once', () => {
      const blocks = searchCoordinatedExpenditures.format!({
        results: [row(), row()],
        committee: committee(),
        pagination: { ...PAGE, count: 2 },
        search_criteria: { committee_id: 'C00003418' },
      });

      const text = formatText(blocks);
      expect(text.match(/applies to every row below/g)).toHaveLength(1);
      expect(text).toContain('REPUBLICAN NATIONAL COMMITTEE (C00003418)');
    });

    it('renders each spender once, in full, and names it on every row that references it', () => {
      const rnc = {
        ...committee(),
        treasurer_name: 'DOE, JANE',
        street_1: '310 FIRST STREET SE',
        cycles: [1976, 1978],
      };
      const dnc = { ...committee('C00010603'), name: 'DNC SERVICES CORP' };
      const bare = (overrides: Record<string, unknown>) => {
        const { committee: _c, subordinate_committee: _s, ...rest } = row(overrides);
        return rest;
      };
      const blocks = searchCoordinatedExpenditures.format!({
        results: [
          bare({ payee_name: 'PAYEE ONE' }),
          bare({ committee_id: 'C00010603', payee_name: 'PAYEE TWO' }),
          bare({ payee_name: 'PAYEE THREE' }),
        ],
        committees: { C00003418: rnc, C00010603: dnc },
        pagination: { ...PAGE, count: 3 },
        search_criteria: { candidate_id: 'P80001571' },
      });

      const text = formatText(blocks);
      expect(text).not.toContain('{"');
      expect(
        text.match(/ {2}committee_id: C00003418 \(REPUBLICAN NATIONAL COMMITTEE\)/g),
      ).toHaveLength(2);
      expect(text).toContain('  committee_id: C00010603 (DNC SERVICES CORP)');
      expect(text.match(/\*\*REPUBLICAN NATIONAL COMMITTEE \(C00003418\)\*\*/g)).toHaveLength(1);
      expect(text.match(/\*\*DNC SERVICES CORP \(C00010603\)\*\*/g)).toHaveLength(1);
      for (const [key, value] of Object.entries(rnc)) {
        if (key === 'name' || key === 'committee_id') continue;
        expect(text).toContain(`  ${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      const heading = text.indexOf('**Committees referenced above**');
      expect(heading).toBeGreaterThan(text.indexOf('PAYEE THREE'));
      expect(heading).toBeLessThan(text.indexOf('Page 1 of 1'));
    });

    it("renders a spender record left on its row in full — another cycle's record — never as JSON", () => {
      const { subordinate_committee: _dropped, ...first } = row({
        committee: { ...committee(), cycle: 2018, sponsor: { nested: { deeper: 'NESTED VALUE' } } },
      });
      const blocks = searchCoordinatedExpenditures.format!({
        results: [first],
        pagination: { ...PAGE, count: 1 },
        search_criteria: { candidate_id: 'P80001571' },
      });

      const text = formatText(blocks);
      expect(text).not.toContain('{"committee_id"');
      expect(text).toContain(
        '  committee:\n    REPUBLICAN NATIONAL COMMITTEE (C00003418)\n    committee_type_full: Party - Qualified',
      );
      expect(text).toContain('    cycle: 2018');
      // A field with no known shape inside the record keeps the generic rendering.
      expect(text).toContain('    sponsor: {"nested":{"deeper":"NESTED VALUE"}}');
      expect(text).toContain('payee_name: NATIONAL MEDIA RESEARCH');
    });

    it('renders the empty state with the criteria echo and a recovery hint', () => {
      const blocks = searchCoordinatedExpenditures.format!({
        results: [],
        pagination: PAGE,
        search_criteria: { committee_id: 'C00703975', cycle: 2024 },
      });

      const text = formatText(blocks);
      expect(text).toContain('No results found.');
      expect(text).toContain('committee_id: C00703975');
      expect(text).toContain('only party committees report Schedule F');
    });
  });

  describe('exhausted position', () => {
    it('reports a page past the end as exhausted on both surfaces', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { page: 7, pages: 3, count: 52, per_page: 20 },
        results: [],
      });

      const input = searchCoordinatedExpenditures.input.parse({
        committee_id: 'C00003418',
        page: 7,
      });
      const result = await searchCoordinatedExpenditures.handler(input, ctx);

      expect(result.pagination).toMatchObject({ page: 7, pages: 3, count: 52 });
      expect(getEnrichment(ctx).notice).toContain('Page 7 is past the last page');
      expect(getEnrichment(ctx).notice).not.toContain('No coordinated party expenditures matched');

      const text = formatText(searchCoordinatedExpenditures.format!(result));
      expect(text).toContain('No results at this position.');
      expect(text).toContain('52 total');
      expect(text).not.toContain('No results found');
    });

    it('keeps zero-match guidance when nothing matched at all', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { page: 1, pages: 0, count: 0, per_page: 20 },
        results: [],
      });

      const input = searchCoordinatedExpenditures.input.parse({ committee_id: 'C00703975' });
      const result = await searchCoordinatedExpenditures.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('No coordinated party expenditures matched');

      const text = formatText(searchCoordinatedExpenditures.format!(result));
      expect(text).toContain('No results found.');
      expect(text).not.toContain('No results at this position');
    });
  });

  describe('memo entries', () => {
    it('names the memo rows on a mixed page in the notice on both surfaces', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 25 },
        results: [memoRow(), row(), memoRow({ expenditure_amount: 31 })],
      });

      const result = await runToolContract(searchCoordinatedExpenditures, {
        cycle: 2024,
        max_amount: 100,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.notice).toBe(MEMO_SENTENCE(2, 3));
      expect(wireText(result)).toContain(MEMO_SENTENCE(2, 3));
      expect((structured.results as Record<string, unknown>[]).map((r) => r.memo_code)).toEqual([
        'X',
        undefined,
        'X',
      ]);
    });

    it('carries no memo sentence on a page without memo rows', async () => {
      mockService.searchCoordinatedExpenditures.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 2 },
        results: [row(), row()],
      });

      const result = await runToolContract(searchCoordinatedExpenditures, { cycle: 2024 });

      expect((result.structuredContent as Record<string, unknown>).notice).toBeUndefined();
      expect(wireText(result)).not.toContain('memo entries');
    });

    it("marks each memo row's header and leaves the others unmarked", () => {
      const blocks = searchCoordinatedExpenditures.format!({
        results: [memoRow(), row()],
        pagination: { ...PAGE, count: 2 },
        search_criteria: { cycle: 2024 },
      });

      const text = formatText(blocks);
      expect(text).toContain('**$26 for TRUMP, DONALD J** — 2024-08-07 · memo entry\n');
      expect(text).toContain('**$9,000,000 for TRUMP, DONALD J** — 2024-08-07\n');
    });

    it('describes memo_code on the row', () => {
      const description =
        searchCoordinatedExpenditures.output.shape.results.element.description ?? '';
      expect(description).toContain('memo_code "X"');
      expect(description).toContain('never add it to the other rows');
    });
  });
});
