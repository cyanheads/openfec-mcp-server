/**
 * @fileoverview Tests for the election resource — fetches an election race summary
 * with optional state and district parsed from the URI path.
 * @module tests/mcp-server/resources/definitions/election.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

vi.mock('@/services/openfec/openfec-service.js', () => ({
  getOpenFecService: () => mockService,
}));

import {
  electionDistrictResource,
  electionResource,
  electionStateResource,
} from '@/mcp-server/resources/definitions/election.resource.js';

/**
 * The resource declares no output schema, so its handler is typed `unknown`.
 * This mirrors the object `fetchElection()` actually returns.
 */
type ElectionResult = {
  cycle: string;
  office: string;
  state?: string | undefined;
  district?: string | undefined;
  candidates: unknown[];
  pagination: { page: number; pages: number; count: number; per_page: number };
  truncation_notice?: string;
  empty_result_notice?: string;
};

const electionParams = electionResource.params!;
const electionStateParams = electionStateResource.params!;
const electionDistrictParams = electionDistrictResource.params!;

describe('electionResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const pageResult = <T>(results: T[], count?: number) => ({
    pagination: { page: 1, pages: 1, count: count ?? results.length, per_page: 20 },
    results,
  });

  it('returns election data for presidential race', async () => {
    const candidates = [
      { candidate_id: 'P00003392', total_receipts: 500000 },
      { candidate_id: 'P80001571', total_receipts: 600000 },
    ];
    mockService.searchElections.mockResolvedValueOnce(pageResult(candidates));

    const ctx = createMockContext({ uri: new URL('openfec:///election/2024/P') });
    const params = electionParams.parse({ cycle: '2024', office: 'P' });
    const result = (await electionResource.handler(params, ctx)) as ElectionResult;

    expect(result).toEqual({
      cycle: '2024',
      office: 'P',
      state: undefined,
      district: undefined,
      candidates,
      pagination: { page: 1, pages: 1, count: 2, per_page: 20 },
    });
    expect(result).not.toHaveProperty('truncation_notice');
    expect(mockService.searchElections).toHaveBeenCalledWith(
      { cycle: '2024', office: 'president', election_full: true },
      ctx,
    );
  });

  it('discloses truncation and names the paging tool when more pages exist', async () => {
    mockService.searchElections.mockResolvedValueOnce({
      pagination: { page: 1, pages: 44, count: 869, per_page: 20 },
      results: [{ candidate_id: 'P80001571' }],
    });

    const ctx = createMockContext({ uri: new URL('openfec:///election/2024/P') });
    const params = electionParams.parse({ cycle: '2024', office: 'P' });
    const result = (await electionResource.handler(params, ctx)) as ElectionResult;

    expect(result.pagination).toEqual({ page: 1, pages: 44, count: 869, per_page: 20 });
    const notice = result.truncation_notice;
    expect(notice).toContain('page 1 of 44');
    expect(notice).toContain('869 candidates total');
    expect(notice).toContain('openfec_lookup_elections');
  });

  it('passes state via electionStateResource', async () => {
    mockService.searchElections.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext({ uri: new URL('openfec:///election/2024/S/AZ') });
    const params = electionStateParams.parse({
      cycle: '2024',
      office: 'S',
      state: 'AZ',
    });
    await electionStateResource.handler(params, ctx);

    expect(mockService.searchElections).toHaveBeenCalledWith(
      { cycle: '2024', office: 'senate', state: 'AZ', election_full: true },
      ctx,
    );
  });

  it('passes district via electionDistrictResource', async () => {
    mockService.searchElections.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext({ uri: new URL('openfec:///election/2024/H/CA/12') });
    const params = electionDistrictParams.parse({
      cycle: '2024',
      office: 'H',
      state: 'CA',
      district: '12',
    });
    const result = (await electionDistrictResource.handler(params, ctx)) as ElectionResult;

    expect(mockService.searchElections).toHaveBeenCalledWith(
      { cycle: '2024', office: 'house', state: 'CA', district: '12', election_full: true },
      ctx,
    );
    expect(result.state).toBe('CA');
    expect(result.district).toBe('12');
  });

  it('validates cycle and office params', () => {
    expect(() => electionParams.parse({})).toThrow();
    expect(() => electionParams.parse({ cycle: '2024' })).toThrow();
    expect(() => electionParams.parse({ office: 'P' })).toThrow();
    expect(() => electionParams.parse({ cycle: '2024', office: 'S' })).toThrow();
    expect(electionStateParams.parse({ cycle: '2024', office: 'S', state: 'VT' })).toEqual({
      cycle: '2024',
      office: 'S',
      state: 'VT',
    });
  });
  describe('empty result', () => {
    const emptyPage = { pagination: { page: 1, pages: 0, count: 0, per_page: 20 }, results: [] };

    it.each([
      ['presidential', electionResource, { cycle: '2023', office: 'P' }],
      ['state', electionStateResource, { cycle: '2024', office: 'S', state: 'XX' }],
      [
        'district',
        electionDistrictResource,
        { cycle: '2024', office: 'H', state: 'WA', district: '99' },
      ],
    ] as const)(
      'explains a zero-candidate %s race instead of returning a bare list',
      async (_, def, raw) => {
        mockService.searchElections.mockResolvedValueOnce(emptyPage);

        const ctx = createMockContext();
        const params = def.params!.parse(raw);
        const result = (await def.handler(params as never, ctx)) as ElectionResult;

        expect(result.candidates).toEqual([]);
        expect(result.pagination).toEqual(emptyPage.pagination);
        const notice = result.empty_result_notice;
        expect(notice).toContain('No election races matched');
        expect(notice).toContain('cycle is an even year');
        expect(notice).toContain('state code is correct');
        expect(notice).toContain('district exists for the given state');
        expect(result).not.toHaveProperty('truncation_notice');
      },
    );

    it('carries no empty notice on a single-page race with candidates', async () => {
      mockService.searchElections.mockResolvedValueOnce(
        pageResult([{ candidate_id: 'S4AZ00139' }]),
      );

      const ctx = createMockContext();
      const params = electionStateParams.parse({ cycle: '2024', office: 'S', state: 'AZ' });
      const result = (await electionStateResource.handler(params, ctx)) as ElectionResult;

      expect(result).not.toHaveProperty('empty_result_notice');
      expect(result).not.toHaveProperty('truncation_notice');
    });

    it('carries only the truncation notice on a multi-page race', async () => {
      mockService.searchElections.mockResolvedValueOnce({
        pagination: { page: 1, pages: 3, count: 45, per_page: 20 },
        results: [{ candidate_id: 'H2CA30291' }],
      });

      const ctx = createMockContext();
      const params = electionDistrictParams.parse({
        cycle: '2024',
        office: 'H',
        state: 'CA',
        district: '30',
      });
      const result = (await electionDistrictResource.handler(params, ctx)) as ElectionResult;

      expect(result.truncation_notice).toContain('page 1 of 3');
      expect(result).not.toHaveProperty('empty_result_notice');
    });
  });

  describe('office rejection names the sibling templates', () => {
    /** The rejection message a template's params schema produces for `office`. */
    const officeMessage = (
      schema: typeof electionParams | typeof electionStateParams | typeof electionDistrictParams,
      raw: Record<string, string>,
    ) => {
      const parsed = schema.safeParse(raw);
      expect(parsed.success).toBe(false);
      const issue = parsed.error?.issues.find((i) => i.path[0] === 'office');
      if (!issue) throw new Error('no office issue raised');
      return issue.message;
    };

    it.each(['Z', 'S', 'H'])(
      'presidential template rejects %s and points at senate and house',
      (office) => {
        const message = officeMessage(electionParams, { cycle: '2024', office });
        expect(message).toContain('openfec://election/{cycle}/S/{state}');
        expect(message).toContain('openfec://election/{cycle}/H/{state}/{district}');
      },
    );

    it.each(['Z', 'P'])(
      'state template rejects %s and points at presidential and district',
      (office) => {
        const message = officeMessage(electionStateParams, { cycle: '2024', office, state: 'AZ' });
        expect(message).toContain('openfec://election/{cycle}/P');
        expect(message).toContain('openfec://election/{cycle}/H/{state}/{district}');
      },
    );

    it.each(['Z', 'S', 'P'])(
      'district template rejects %s and points at presidential and senate',
      (office) => {
        const message = officeMessage(electionDistrictParams, {
          cycle: '2024',
          office,
          state: 'CA',
          district: '12',
        });
        expect(message).toContain('openfec://election/{cycle}/P');
        expect(message).toContain('openfec://election/{cycle}/S/{state}');
      },
    );

    it('surfaces the custom message through a thrown parse', () => {
      expect(() => electionParams.parse({ cycle: '2024', office: 'Z' })).toThrow(
        /openfec:\/\/election\/\{cycle\}\/S\/\{state\}/,
      );
    });
  });
});
