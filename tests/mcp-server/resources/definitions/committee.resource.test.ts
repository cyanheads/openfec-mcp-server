/**
 * @fileoverview Tests for the committee resource — fetches a committee profile
 * by FEC committee ID.
 * @module tests/mcp-server/resources/definitions/committee.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = {
  searchCandidates: vi.fn(),
  getCandidate: vi.fn(),
  getCandidateTotals: vi.fn(),
  getCandidateCommittees: vi.fn(),
  searchCommittees: vi.fn(),
  getCommittee: vi.fn(),
  getCommitteeTotals: vi.fn(),
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

/**
 * The service the resource resolves. Most cases stub it wholesale; the
 * real-service cases below swap in a live `OpenFecService` so the totals leg
 * runs through the service's own not-found normalization.
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

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { committeeResource } from '@/mcp-server/resources/definitions/committee.resource.js';
import { OpenFecService } from '@/services/openfec/openfec-service.js';

const mockFetch = vi.mocked(fetchWithTimeout);

const paramsSchema = committeeResource.params!;

describe('committeeResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeService = mockService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const pageResult = <T>(results: T[], count?: number) => ({
    pagination: { page: 1, pages: 1, count: count ?? results.length, per_page: 20 },
    results,
  });

  it('returns merged committee + totals data', async () => {
    const committee = {
      committee_id: 'C00703975',
      name: 'ACTBLUE',
      committee_type: 'N',
      designation: 'U',
    };
    const totals = {
      receipts: 12_000_000,
      disbursements: 11_500_000,
      last_cash_on_hand_end_period: 500_000,
      coverage_end_date: '2024-12-31',
    };

    mockService.getCommittee.mockResolvedValueOnce(pageResult([committee]));
    mockService.getCommitteeTotals.mockResolvedValueOnce(pageResult([totals]));

    const ctx = createMockContext({ errors: committeeResource.errors });
    const params = paramsSchema.parse({ committee_id: 'C00703975' });
    const result = await committeeResource.handler(params, ctx);

    expect(result).toEqual({ ...committee, ...totals });
    expect(mockService.getCommittee).toHaveBeenCalledWith('C00703975', ctx);
    expect(mockService.getCommitteeTotals).toHaveBeenCalledWith('C00703975', { per_page: 1 }, ctx);
  });

  it('returns committee without totals when totals result is empty', async () => {
    const committee = { committee_id: 'C00000001', name: 'NEW PAC', committee_type: 'N' };

    mockService.getCommittee.mockResolvedValueOnce(pageResult([committee]));
    mockService.getCommitteeTotals.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext({ errors: committeeResource.errors });
    const params = paramsSchema.parse({ committee_id: 'C00000001' });
    const result = await committeeResource.handler(params, ctx);

    expect(result).toEqual(committee);
  });

  it('fails the read when the totals fetch rejects', async () => {
    const committee = { committee_id: 'C00703975', name: 'ACTBLUE', committee_type: 'N' };

    mockService.getCommittee.mockResolvedValueOnce(pageResult([committee]));
    mockService.getCommitteeTotals.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', { status: 429 }),
    );

    const ctx = createMockContext({ errors: committeeResource.errors });
    const params = paramsSchema.parse({ committee_id: 'C00703975' });

    await expect(committeeResource.handler(params, ctx)).rejects.toThrow(/429/);
  });

  it('throws when committee not found', async () => {
    mockService.getCommittee.mockResolvedValueOnce(pageResult([]));
    mockService.getCommitteeTotals.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext({ errors: committeeResource.errors });
    const params = paramsSchema.parse({ committee_id: 'C99999999' });

    await expect(committeeResource.handler(params, ctx)).rejects.toThrow(
      'Committee C99999999 not found',
    );
  });

  it('validates committee_id param', () => {
    expect(() => paramsSchema.parse({})).toThrow();
    expect(() => paramsSchema.parse({ committee_id: 42 })).toThrow();
    expect(paramsSchema.parse({ committee_id: 'C00358796' })).toEqual({
      committee_id: 'C00358796',
    });
  });

  it('rejects a malformed fixed-width ID before any service call', async () => {
    const ctx = createMockContext({ errors: committeeResource.errors });
    const params = paramsSchema.parse({ committee_id: 'C001' });
    const err = await Promise.resolve(committeeResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_committee_id' });
    expect(mockService.getCommittee).not.toHaveBeenCalled();
    expect(mockService.getCommitteeTotals).not.toHaveBeenCalled();
  });
  describe('through the real service', () => {
    const envelope = <T>(results: T[]) => ({
      json: () =>
        Promise.resolve({
          api_version: '1.0',
          pagination: { count: results.length, page: 1, pages: 1, per_page: 20 },
          results,
        }),
    });
    const committee = { committee_id: 'C00703975', name: 'ACTBLUE', committee_type: 'N' };

    /** Route each request by path: the base record resolves, the totals leg gets `totals`. */
    const routeTotals = (totals: () => Promise<unknown>) =>
      mockFetch.mockImplementation((url) =>
        String(url).includes('/totals/')
          ? (totals() as never)
          : (Promise.resolve(envelope([committee])) as never),
      );

    beforeEach(() => {
      activeService = new OpenFecService();
    });

    it('resolves the base record when OpenFEC reports no totals on file', async () => {
      routeTotals(() =>
        Promise.reject(
          new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404', {
            status: 404,
            body: '{"message": "The requested URL was not found on the server."}',
          }),
        ),
      );

      const ctx = createMockContext({ errors: committeeResource.errors });
      const params = paramsSchema.parse({ committee_id: 'C00703975' });
      const result = await committeeResource.handler(params, ctx);

      expect(result).toEqual(committee);
    });

    it('fails the read when the totals leg is rate limited', async () => {
      routeTotals(() =>
        Promise.reject(
          new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', { status: 429 }),
        ),
      );

      const ctx = createMockContext({ errors: committeeResource.errors });
      const params = paramsSchema.parse({ committee_id: 'C00703975' });

      await expect(committeeResource.handler(params, ctx)).rejects.toThrow(/rate limit/i);
    });

    it('fails the read when the totals leg returns an unrecognized envelope', async () => {
      routeTotals(() => Promise.resolve({ json: () => Promise.resolve({ error: 'html' }) }));

      const ctx = createMockContext({ errors: committeeResource.errors });
      const params = paramsSchema.parse({ committee_id: 'C00703975' });

      await expect(committeeResource.handler(params, ctx)).rejects.toThrow(/unexpected response/);
    });

    it('still reports committee_not_found from the base fetch', async () => {
      mockFetch.mockImplementation((url) =>
        String(url).includes('/totals/')
          ? (Promise.reject(
              new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404', {
                status: 404,
                body: '{"message": "The requested URL was not found on the server."}',
              }),
            ) as never)
          : (Promise.resolve(envelope([])) as never),
      );

      const ctx = createMockContext({ errors: committeeResource.errors });
      const params = paramsSchema.parse({ committee_id: 'C99999999' });
      const err = await Promise.resolve(committeeResource.handler(params, ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'committee_not_found' });
    });
  });
});
