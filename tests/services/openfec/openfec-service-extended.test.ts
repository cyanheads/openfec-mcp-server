/**
 * @fileoverview Extended service tests covering methods not exercised in the
 * primary test file: getCandidateCommittees, getCommitteeTotals,
 * searchElectionsByZip, URL array params, SEEK edge cases, and transient
 * error classification.
 * @module tests/services/openfec/openfec-service-extended.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    fecApiKey: 'DEMO_KEY',
    fecBaseUrl: 'https://api.open.fec.gov/v1',
    fecMaxRetries: 0,
    fecRequestTimeout: 5000,
  }),
}));

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { OpenFecService } from '@/services/openfec/openfec-service.js';

const mockFetch = vi.mocked(fetchWithTimeout);

const pageEnvelope = <T>(results: T[], count = 1) => ({
  json: () =>
    Promise.resolve({
      api_version: '1.0',
      pagination: { count, page: 1, pages: 1, per_page: 20 },
      results,
    }),
});

const seekEnvelope = <T>(
  results: T[],
  lastIndexes: Record<string, string> | undefined,
  count = 1,
) => ({
  json: () =>
    Promise.resolve({
      api_version: '1.0',
      pagination: { count, per_page: 20, last_indexes: lastIndexes },
      results,
    }),
});

describe('getCandidateCommittees', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('calls the /candidate/<id>/committees/ endpoint', async () => {
    mockFetch.mockResolvedValueOnce(pageEnvelope([{ committee_id: 'C00703975' }]) as never);

    const result = await svc.getCandidateCommittees('P00003392', {}, ctx);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('/candidate/P00003392/committees/');
    expect(result.results).toHaveLength(1);
  });

  it('passes filter params to the URL', async () => {
    mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);

    await svc.getCandidateCommittees('P00003392', { designation: 'P' }, ctx);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('designation=P');
  });

  it('returns pagination metadata', async () => {
    mockFetch.mockResolvedValueOnce(pageEnvelope([{ committee_id: 'C00703975' }], 3) as never);

    const result = await svc.getCandidateCommittees('P00003392', {}, ctx);
    expect(result.pagination.count).toBe(3);
  });
});

describe('getCommitteeTotals', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('calls the /committee/<id>/totals/ endpoint', async () => {
    mockFetch.mockResolvedValueOnce(
      pageEnvelope([{ receipts: 1_000_000, disbursements: 900_000 }]) as never,
    );

    const result = await svc.getCommitteeTotals('C00703975', {}, ctx);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('/committee/C00703975/totals/');
    expect(result.results[0]).toHaveProperty('receipts', 1_000_000);
  });

  it('passes params to the URL', async () => {
    mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);

    await svc.getCommitteeTotals('C00703975', { per_page: 1 }, ctx);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('per_page=1');
  });
});

describe('searchElectionsByZip', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('calls the /elections/search/ endpoint', async () => {
    mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);

    await svc.searchElectionsByZip({ zip: '98101', cycle: 2024 }, ctx);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('/elections/search/');
    expect(url).toContain('zip=98101');
  });
});

describe('URL building — array params', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('appends multiple values for the same param key', async () => {
    mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);

    await svc.getCandidateTotals({ candidate_id: ['P00003392', 'P80001571', 'P80000722'] }, ctx);

    const url = mockFetch.mock.calls[0]![0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded.match(/candidate_id=/g)).toHaveLength(3);
    expect(decoded).toContain('candidate_id=P00003392');
    expect(decoded).toContain('candidate_id=P80001571');
    expect(decoded).toContain('candidate_id=P80000722');
  });

  it('strips empty-string array values', async () => {
    mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);

    await svc.searchCandidates({ q: '', office: 'P' }, ctx);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).not.toContain('q=');
    expect(url).toContain('office=P');
  });
});

describe('SEEK pagination edge cases', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('nextCursor is null when results are empty even if last_indexes is present', async () => {
    mockFetch.mockResolvedValueOnce(seekEnvelope([], { last_index: '99' }, 0) as never);

    const result = await svc.searchContributions({}, ctx);
    expect(result.nextCursor).toBeNull();
  });

  it('nextCursor is null when last_indexes has keys but empty results', async () => {
    mockFetch.mockResolvedValueOnce(
      seekEnvelope([], { last_index: '99', last_date: '2024-01-01' }, 0) as never,
    );

    const result = await svc.searchDisbursements({}, ctx);
    expect(result.nextCursor).toBeNull();
  });

  it('seek results propagate pagination count', async () => {
    mockFetch.mockResolvedValueOnce(seekEnvelope([{ amount: 100 }], undefined, 500) as never);

    const result = await svc.searchExpenditures({}, ctx);
    expect(result.pagination.count).toBe(500);
    expect(result.pagination.per_page).toBe(20);
  });
});

describe('getExpendituresByCandidate', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('calls the by_candidate endpoint', async () => {
    mockFetch.mockResolvedValueOnce(
      pageEnvelope([{ candidate_id: 'P00003392', total: 500_000 }]) as never,
    );

    const result = await svc.getExpendituresByCandidate({ candidate_id: 'P00003392' }, ctx);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('/schedules/schedule_e/by_candidate/');
    expect(result.results[0]).toHaveProperty('candidate_id', 'P00003392');
  });
});

describe('transient error classification', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('propagates ECONNRESET errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(svc.searchCandidates({}, ctx)).rejects.toThrow('ECONNRESET');
  });

  it('propagates ETIMEDOUT errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    await expect(svc.searchCandidates({}, ctx)).rejects.toThrow('ETIMEDOUT');
  });

  it('propagates rate limit errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('429 OVER_RATE_LIMIT'));

    await expect(svc.searchCandidates({}, ctx)).rejects.toThrow();
  });

  it('non-Error throws pass through unchanged', async () => {
    mockFetch.mockRejectedValueOnce('plain string error');

    await expect(svc.searchCandidates({}, ctx)).rejects.toBe('plain string error');
  });
});
