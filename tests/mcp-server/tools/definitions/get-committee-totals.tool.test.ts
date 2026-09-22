/**
 * @fileoverview Tests for the get-committee-totals tool — both modes, the
 * mode-scope error contract, and format rendering.
 * @module tests/mcp-server/tools/definitions/get-committee-totals.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

import { getCommitteeTotals } from '@/mcp-server/tools/definitions/get-committee-totals.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

const totalsRow = (overrides: Record<string, unknown> = {}) => ({
  committee_id: 'C00703975',
  committee_name: 'FIGHT FOR THE PEOPLE PAC',
  committee_state: 'PA',
  committee_type_full: 'PAC - Nonqualified',
  cycle: 2026,
  receipts: 17_365_125.38,
  disbursements: 18_290_442.96,
  last_cash_on_hand_end_period: 836_739.05,
  last_debts_owed_by_committee: 0,
  coverage_end_date: '2026-06-30T00:00:00',
  ...overrides,
});

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

const makeCtx = () => createMockContext({ errors: getCommitteeTotals.errors });

describe('getCommitteeTotals', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    vi.clearAllMocks();
  });

  describe('single mode', () => {
    it('is the default mode and fetches one committee per-cycle totals', async () => {
      mockService.getCommitteeTotals.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 2 },
        results: [totalsRow(), totalsRow({ cycle: 2024, receipts: 9_000_000 })],
      });

      const input = getCommitteeTotals.input.parse({ committee_id: 'C00703975' });
      const result = await getCommitteeTotals.handler(input, ctx);

      expect(result.mode).toBe('single');
      expect(mockService.getCommitteeTotals).toHaveBeenCalledWith(
        'C00703975',
        { page: 1, per_page: 20 },
        ctx,
      );
      expect(mockService.getCommitteeTotalsByEntityType).not.toHaveBeenCalled();
      expect(result.results).toHaveLength(2);
      expect(getEnrichment(ctx).totalCount).toBe(2);
      expect(result.search_criteria).toEqual({ committee_id: 'C00703975', mode: 'single' });
    });

    it('passes cycle and sort through to the single-committee endpoint', async () => {
      mockService.getCommitteeTotals.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [totalsRow({ cycle: 2024 })],
      });

      const input = getCommitteeTotals.input.parse({
        committee_id: 'C00703975',
        cycle: 2024,
        sort: '-cycle',
      });
      await getCommitteeTotals.handler(input, ctx);

      expect(mockService.getCommitteeTotals.mock.calls[0]![1]).toEqual({
        page: 1,
        per_page: 20,
        cycle: 2024,
        sort: '-cycle',
      });
    });

    it('throws committee_totals_not_found when the committee has no totals at all', async () => {
      mockService.getCommitteeTotals.mockResolvedValueOnce({ pagination: PAGE, results: [] });

      const input = getCommitteeTotals.input.parse({ committee_id: 'C99999999' });
      const err = await Promise.resolve(getCommitteeTotals.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
      expect((err as McpError).data).toMatchObject({
        reason: 'committee_totals_not_found',
        committee_id: 'C99999999',
      });
      expect((err as McpError).message).toContain('no financial totals on file');
      expect((err as McpError).data).toHaveProperty('recovery.hint');
    });

    it('names the cycle when the miss is cycle-scoped', async () => {
      mockService.getCommitteeTotals.mockResolvedValueOnce({ pagination: PAGE, results: [] });

      const input = getCommitteeTotals.input.parse({
        committee_id: 'C00703975',
        cycle: 1990,
      });
      const err = await Promise.resolve(getCommitteeTotals.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as McpError).message).toContain('cycle 1990');
      expect((err as McpError).data).toMatchObject({ cycle: 1990 });
    });

    it('throws committee_id_required_for_single_mode when no committee_id is given', async () => {
      const input = getCommitteeTotals.input.parse({});
      const err = await Promise.resolve(getCommitteeTotals.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
      expect((err as McpError).data).toMatchObject({
        reason: 'committee_id_required_for_single_mode',
      });
      expect(mockService.getCommitteeTotals).not.toHaveBeenCalled();
    });

    it('rejects grouped-search filters rather than dropping them', async () => {
      const input = getCommitteeTotals.input.parse({
        committee_id: 'C00703975',
        committee_state: 'PA',
        min_receipts: 1_000_000,
      });
      const err = await Promise.resolve(getCommitteeTotals.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as McpError).data).toMatchObject({
        reason: 'inputs_not_applicable_to_mode',
        inapplicable_inputs: ['committee_state', 'min_receipts'],
      });
      expect((err as McpError).message).toContain('/committee/{committee_id}/totals/');
      expect(mockService.getCommitteeTotals).not.toHaveBeenCalled();
    });

    it('rejects a malformed committee_id before calling the API', async () => {
      const input = getCommitteeTotals.input.parse({ committee_id: 'P00003392' });
      const err = await Promise.resolve(getCommitteeTotals.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as McpError).data).toMatchObject({ reason: 'invalid_committee_id' });
      expect(mockService.getCommitteeTotals).not.toHaveBeenCalled();
    });
  });

  describe('by_entity_type mode', () => {
    it.each([
      ['receipts', { min_receipts: 2_000_000, max_receipts: 1_000_000 }],
      ['disbursements', { min_disbursements: 2_000_000, max_disbursements: 1_000_000 }],
    ] as const)('rejects an inverted %s range before dispatch', async (_kind, range) => {
      const input = getCommitteeTotals.input.parse({
        mode: 'by_entity_type',
        entity_type: 'pac',
        ...range,
      });
      const err = (await Promise.resolve(getCommitteeTotals.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_range' });
      expect(mockService.getCommitteeTotalsByEntityType).not.toHaveBeenCalled();
    });

    it('sends the entity type in the path and the curated filters as params', async () => {
      mockService.getCommitteeTotalsByEntityType.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 16 },
        results: [totalsRow({ committee_name: 'PEOPLE FOR PATTY MURRAY', committee_state: 'WA' })],
      });

      const input = getCommitteeTotals.input.parse({
        mode: 'by_entity_type',
        entity_type: 'house-senate',
        cycle: 2024,
        committee_state: 'WA',
        committee_designation: 'P',
        organization_type: 'C',
        min_receipts: 1_000_000,
        max_disbursements: 50_000_000,
        sort: '-receipts',
      });
      const result = await getCommitteeTotals.handler(input, ctx);

      expect(result.mode).toBe('by_entity_type');
      expect(mockService.getCommitteeTotalsByEntityType).toHaveBeenCalledOnce();
      const [entityType, params] = mockService.getCommitteeTotalsByEntityType.mock.calls[0]!;
      expect(entityType).toBe('house-senate');
      expect(params).toEqual({
        page: 1,
        per_page: 20,
        cycle: 2024,
        committee_state: 'WA',
        committee_designation: 'P',
        organization_type: 'C',
        min_receipts: 1_000_000,
        max_disbursements: 50_000_000,
        sort: '-receipts',
      });
      expect(getEnrichment(ctx).totalCount).toBe(16);
    });

    it('throws entity_type_required_for_group_mode without an entity_type', async () => {
      const input = getCommitteeTotals.input.parse({ mode: 'by_entity_type' });
      const err = await Promise.resolve(getCommitteeTotals.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
      expect((err as McpError).data).toMatchObject({
        reason: 'entity_type_required_for_group_mode',
        valid_entity_types: [
          'presidential',
          'pac',
          'party',
          'pac-party',
          'house-senate',
          'ie-only',
        ],
      });
      expect(mockService.getCommitteeTotalsByEntityType).not.toHaveBeenCalled();
    });

    it('narrows the grouped search to one committee when committee_id is supplied', async () => {
      mockService.getCommitteeTotalsByEntityType.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 12 },
        results: [totalsRow()],
      });

      const input = getCommitteeTotals.input.parse({
        mode: 'by_entity_type',
        entity_type: 'pac',
        committee_id: 'C00703975',
      });
      await getCommitteeTotals.handler(input, ctx);

      expect(mockService.getCommitteeTotalsByEntityType.mock.calls[0]![1]).toMatchObject({
        committee_id: 'C00703975',
      });
    });

    it('sets an enrichment notice on an empty grouped search instead of throwing', async () => {
      mockService.getCommitteeTotalsByEntityType.mockResolvedValueOnce({
        pagination: PAGE,
        results: [],
      });

      const input = getCommitteeTotals.input.parse({
        mode: 'by_entity_type',
        entity_type: 'ie-only',
        min_receipts: 1_000_000_000,
      });
      const result = await getCommitteeTotals.handler(input, ctx);

      expect(result.results).toHaveLength(0);
      expect(getEnrichment(ctx).notice).toContain('No committee totals matched');
    });

    it('rejects an entity_type outside the closed enum', () => {
      expect(() =>
        getCommitteeTotals.input.parse({ mode: 'by_entity_type', entity_type: 'house' }),
      ).toThrow();
    });
  });

  describe('format', () => {
    it('renders the mode, per-row header, remaining fields, and pagination', () => {
      const blocks = getCommitteeTotals.format!({
        results: [totalsRow()],
        mode: 'single',
        pagination: { ...PAGE, count: 1 },
        search_criteria: { committee_id: 'C00703975', mode: 'single' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**Mode:** single');
      expect(text).toContain(
        '**FIGHT FOR THE PEOPLE PAC** (C00703975) · cycle 2026 — $17,365,125.38 raised',
      );
      expect(text).toContain('disbursements: 18290442.96');
      expect(text).toContain('last_cash_on_hand_end_period: 836739.05');
      expect(text).toContain('Page 1 of 1 · 1 total · 20 per page');
      expect(text).toContain('_Search criteria: committee_id=C00703975 · mode=single_');
    });

    it('renders unknown receipts as N/A rather than inventing a figure', () => {
      const blocks = getCommitteeTotals.format!({
        results: [totalsRow({ receipts: null })],
        mode: 'by_entity_type',
        pagination: { ...PAGE, count: 1 },
        search_criteria: { mode: 'by_entity_type', entity_type: 'pac' },
      });

      expect(formatText(blocks)).toContain('— N/A raised');
    });

    it('renders the empty state with the mode and criteria echo', () => {
      const blocks = getCommitteeTotals.format!({
        results: [],
        mode: 'by_entity_type',
        pagination: PAGE,
        search_criteria: { mode: 'by_entity_type', entity_type: 'ie-only' },
      });

      const text = formatText(blocks);
      expect(text).toContain('No results found.');
      expect(text).toContain('**Mode:** by_entity_type');
      expect(text).toContain('entity_type: ie-only');
    });
  });

  describe('exhausted position', () => {
    it('returns a past-the-end single-mode page as a result, not a not-found error', async () => {
      mockService.getCommitteeTotals.mockResolvedValueOnce({
        pagination: { page: 99, pages: 1, count: 1, per_page: 20 },
        results: [],
      });

      const input = getCommitteeTotals.input.parse({ committee_id: 'C00703975', page: 99 });
      const result = await getCommitteeTotals.handler(input, ctx);

      expect(result.pagination).toMatchObject({ page: 99, pages: 1, count: 1 });
      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toContain('Page 99 is past the last page');

      const text = formatText(getCommitteeTotals.format!(result));
      expect(text).toContain('No results at this position.');
      expect(text).toContain('1 total');
      expect(text).not.toContain('No results found');
    });

    it('still throws committee_totals_not_found for a genuine miss', async () => {
      mockService.getCommitteeTotals.mockResolvedValueOnce({
        pagination: { page: 99, pages: 0, count: 0, per_page: 20 },
        results: [],
      });

      const input = getCommitteeTotals.input.parse({ committee_id: 'C99999999', page: 99 });
      const err = await Promise.resolve(getCommitteeTotals.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as McpError).data).toMatchObject({ reason: 'committee_totals_not_found' });
    });

    it('reports a past-the-end by_entity_type page as exhausted', async () => {
      mockService.getCommitteeTotalsByEntityType.mockResolvedValueOnce({
        pagination: { page: 8, pages: 3, count: 47, per_page: 20 },
        results: [],
      });

      const input = getCommitteeTotals.input.parse({
        mode: 'by_entity_type',
        entity_type: 'pac',
        page: 8,
      });
      const result = await getCommitteeTotals.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('Page 8 is past the last page');
      expect(getEnrichment(ctx).notice).not.toContain('No committee totals matched');

      const text = formatText(getCommitteeTotals.format!(result));
      expect(text).toContain('No results at this position.');
      expect(text).toContain('47 total');
    });

    it('keeps zero-match guidance when the grouped search matched nothing', async () => {
      mockService.getCommitteeTotalsByEntityType.mockResolvedValueOnce({
        pagination: { page: 1, pages: 0, count: 0, per_page: 20 },
        results: [],
      });

      const input = getCommitteeTotals.input.parse({
        mode: 'by_entity_type',
        entity_type: 'ie-only',
        min_receipts: 999_999_999,
      });
      const result = await getCommitteeTotals.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('No committee totals matched');

      const text = formatText(getCommitteeTotals.format!(result));
      expect(text).toContain('No results found.');
      expect(text).not.toContain('No results at this position');
    });
  });
});
