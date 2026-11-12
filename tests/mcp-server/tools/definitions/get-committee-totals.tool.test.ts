/**
 * @fileoverview Tests for the get-committee-totals tool — both modes, the
 * mode-scope error contract, and format rendering.
 * @module tests/mcp-server/tools/definitions/get-committee-totals.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = {
  searchCandidates: vi.fn(),
  getCandidate: vi.fn(),
  getCandidateTotals: vi.fn(),
  getCandidateCommittees: vi.fn(),
  searchCommittees: vi.fn(),
  getCommittee: vi.fn(),
  getCommitteeTotals: vi.fn(),
  getCommitteeTotalsAllCycles: vi.fn(),
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

/**
 * The service the tool resolves. Most cases stub it; the real-service cases
 * swap in a live `OpenFecService` so the merge runs against a fake upstream.
 */
let activeService: unknown = mockService;

vi.mock('@/services/openfec/openfec-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/openfec/openfec-service.js')>()),
  getOpenFecService: () => activeService,
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    fecApiKey: 'DEMO_KEY',
    fecBaseUrl: 'https://api.open.fec.gov/v1',
    fecMaxRetries: 0,
    fecRequestTimeout: 5000,
  }),
}));

import { getCommitteeTotals } from '@/mcp-server/tools/definitions/get-committee-totals.tool.js';
import { OpenFecService } from '@/services/openfec/openfec-service.js';
import {
  committeeRequest,
  FEC_404,
  requestsSent,
  routeCommitteeTotals,
} from '../../../services/openfec/committee-totals-upstream.js';
import { contractFailure, declaredRecovery } from './contract-failure.js';

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

/** An omitted-cycle service result that read every table the committee spans. */
const allCycles = (pagination: typeof PAGE, results: Record<string, unknown>[]) => ({
  totals: { pagination, results },
  coverage: { kind: 'complete' },
});

describe('getCommitteeTotals', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    vi.clearAllMocks();
    activeService = mockService;
  });

  describe('single mode', () => {
    it('is the default mode and reads every cycle of one committee when cycle is omitted', async () => {
      mockService.getCommitteeTotalsAllCycles.mockResolvedValueOnce(
        allCycles({ ...PAGE, count: 2 }, [
          totalsRow(),
          totalsRow({ cycle: 2024, receipts: 9_000_000 }),
        ]),
      );

      const input = getCommitteeTotals.input.parse({ committee_id: 'C00703975' });
      const result = await getCommitteeTotals.handler(input, ctx);

      expect(result.mode).toBe('single');
      expect(mockService.getCommitteeTotalsAllCycles).toHaveBeenCalledWith(
        'C00703975',
        { page: 1, per_page: 20 },
        ctx,
      );
      expect(mockService.getCommitteeTotals).not.toHaveBeenCalled();
      expect(mockService.getCommitteeTotalsByEntityType).not.toHaveBeenCalled();
      expect(result.results).toHaveLength(2);
      expect(getEnrichment(ctx).totalCount).toBe(2);
      expect(getEnrichment(ctx).notice).toBeUndefined();
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
      expect(mockService.getCommitteeTotalsAllCycles).not.toHaveBeenCalled();
    });

    it.each([
      [
        'history_unavailable',
        { kind: 'history_unavailable' },
        "This committee's filing history could not be read from OpenFEC, so these totals cover only the cycles filed under its current committee type — cycles filed under an earlier type may be missing. Retry the call, or pass cycle to read one cycle directly.",
      ],
      [
        'cycles_unavailable',
        { kind: 'cycles_unavailable', cycles: [2024, 2022, 2020] },
        'Totals for cycle(s) 2024, 2022, 2020, which this committee filed under another committee type, could not be read from OpenFEC, so these totals leave them out. Retry the call, or pass cycle to read one of those cycles directly.',
      ],
    ])('states a %s partial read as a notice', async (_kind, coverage, notice) => {
      mockService.getCommitteeTotalsAllCycles.mockResolvedValueOnce({
        totals: { pagination: { ...PAGE, count: 1 }, results: [totalsRow()] },
        coverage,
      });

      const input = getCommitteeTotals.input.parse({ committee_id: 'C00703975' });
      const result = await getCommitteeTotals.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      expect(getEnrichment(ctx).notice).toBe(notice);
    });

    it('throws committee_totals_not_found when the committee has no totals at all', async () => {
      mockService.getCommitteeTotalsAllCycles.mockResolvedValueOnce(allCycles(PAGE, []));

      const err = await contractFailure(getCommitteeTotals, { committee_id: 'C99999999' });

      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data).toMatchObject({
        reason: 'committee_totals_not_found',
        committee_id: 'C99999999',
        recovery: {
          hint: declaredRecovery(getCommitteeTotals, 'committee_totals_not_found'),
        },
      });
      expect(err.message).toContain('no financial totals on file');
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
      mockService.getCommitteeTotalsAllCycles.mockResolvedValueOnce(
        allCycles({ page: 99, pages: 1, count: 1, per_page: 20 }, []),
      );

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
      mockService.getCommitteeTotalsAllCycles.mockResolvedValueOnce(
        allCycles({ page: 99, pages: 0, count: 0, per_page: 20 }, []),
      );

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

/**
 * The omitted-cycle path end to end — tool, real service, real fetch path —
 * against a fake of OpenFEC's history and totals endpoints built from live
 * captures, asserted on both client surfaces.
 */
describe('getCommitteeTotals through the real service', () => {
  let http: FetchMockHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    activeService = new OpenFecService();
    http = createFetchMock();
    http.install();
    routeCommitteeTotals(http);
  });

  afterEach(() => {
    http.restore();
    activeService = mockService;
  });

  /** Both success surfaces of one call. */
  const call = async (input: Record<string, unknown>) => {
    const result = await runToolContract(getCommitteeTotals, input);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      results: Record<string, unknown>[];
      pagination: Record<string, unknown>;
      notice?: string;
    };
    const text = (result.content as ContentBlock[])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    return { structured, text, cycles: structured.results.map((row) => row.cycle) };
  };

  it('returns every cycle of a committee that changed type (C00703975)', async () => {
    const { structured, text, cycles } = await call({ committee_id: 'C00703975' });

    expect(cycles).toEqual([2026, 2024, 2022, 2020]);
    expect(structured.results.map((row) => row.committee_type)).toEqual(['N', 'P', 'P', 'P']);
    expect(structured.pagination).toMatchObject({ page: 1, pages: 1, count: 4 });
    for (const header of [
      '**FIGHT FOR THE PEOPLE PAC** (C00703975) · cycle 2026 — $17,845,359.85 raised',
      '**HARRIS FOR PRESIDENT** (C00703975) · cycle 2024 — $1,175,189,365.41 raised',
      '**BIDEN FOR PRESIDENT** (C00703975) · cycle 2022 — $12,107,733.17 raised',
      '**BIDEN FOR PRESIDENT** (C00703975) · cycle 2020 — $1,074,179,976.03 raised',
    ]) {
      expect(text).toContain(header);
    }
    expect(text).toContain('Page 1 of 1 · 4 total · 20 per page');
  });

  it('sorts and pages the merged rows', async () => {
    expect((await call({ committee_id: 'C00703975', sort: 'receipts' })).cycles).toEqual([
      2022, 2026, 2020, 2024,
    ]);

    const paged = await call({ committee_id: 'C00703975', per_page: 2, page: 2 });
    expect(paged.cycles).toEqual([2022, 2020]);
    expect(paged.structured.pagination).toMatchObject({ page: 2, pages: 2, count: 4 });
    expect(paged.text).toContain('Page 2 of 2 · 4 total · 2 per page');
  });

  it('reports a page past the merged set as exhausted, not as committee_totals_not_found', async () => {
    const { structured, text } = await call({ committee_id: 'C00703975', per_page: 2, page: 3 });

    const notice =
      'Page 3 is past the last page of this result set — 4 total across 2 page(s). Request page 2 or lower to read them.';
    expect(structured.notice).toBe(notice);
    expect(text).toContain('No results at this position.');
    expect(text).toContain(notice);
  });

  /** Answer the requests `select` picks with a JSON error, ahead of the fake. */
  const failFor = (
    select: (parts: NonNullable<ReturnType<typeof committeeRequest>>) => boolean,
    status: number,
    body: string,
  ) => {
    http.reset();
    http.route({
      match: (request) => {
        const parts = committeeRequest(request.url);
        return parts !== null && select(parts);
      },
      respond: () =>
        new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    });
    routeCommitteeTotals(http);
  };

  it.each([
    ['answers 200 with no rows', false],
    ['answers 404', true],
  ])(
    'fails with committee_totals_not_found for an ID with no totals whose history %s (C99999998)',
    async (_, historyNotFound) => {
      if (historyNotFound) failFor((parts) => parts.endpoint === 'history', 404, FEC_404);

      const err = await contractFailure(getCommitteeTotals, { committee_id: 'C99999998' });

      expect(err.data).toMatchObject({ reason: 'committee_totals_not_found' });
    },
  );

  it('names the cycles a secondary 404 left unread instead of reporting the committee missing', async () => {
    failFor(
      (parts) => parts.endpoint === 'totals' && parts.query.get('per_page') === '100',
      404,
      FEC_404,
    );

    const { structured, text } = await call({ committee_id: 'C00703975', per_page: 2, page: 2 });

    expect(structured.results).toEqual([]);
    expect(structured.pagination).toMatchObject({ page: 2, count: 1 });
    expect(structured.notice).toContain('Page 2 is past the last page');
    expect(structured.notice).toContain('cycle(s) 2024, 2022, 2020');
    expect(text).toContain('cycle(s) 2024, 2022, 2020');
  });

  it('states a partial read on both surfaces when the history read fails', async () => {
    failFor((parts) => parts.endpoint === 'history', 503, '{"message":"upstream failure"}');

    const { structured, text, cycles } = await call({ committee_id: 'C00703975' });

    expect(cycles).toEqual([2026]);
    expect(structured.notice).toContain('cycles filed under an earlier type may be missing');
    expect(text).toContain('cycles filed under an earlier type may be missing');
  });

  it('reads an explicit cycle in one request, without the history', async () => {
    const { cycles } = await call({ committee_id: 'C00703975', cycle: 2020 });

    expect(cycles).toEqual([2020]);
    expect(requestsSent(http)).toEqual(['C00703975/totals?page=1&per_page=20&cycle=2020']);
  });

  it('reads mode by_entity_type in one request, without the history', async () => {
    http.route({
      match: (request) => new URL(request.url).pathname === '/v1/totals/presidential/',
      respond: Response.json({
        api_version: '1.0',
        pagination: { count: 0, page: 1, pages: 0, per_page: 20 },
        results: [],
      }),
    });

    await call({ mode: 'by_entity_type', entity_type: 'presidential', committee_id: 'C00703975' });

    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0]!.request.url).pathname).toBe('/v1/totals/presidential/');
  });
});
