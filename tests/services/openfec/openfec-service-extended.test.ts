/**
 * @fileoverview Extended service tests covering methods not exercised in the
 * primary test file: getCandidateCommittees, getCommitteeTotals,
 * getCommitteeTotalsByEntityType, searchCoordinatedExpenditures,
 * getLegalDocument, searchElectionsByZip, URL array params, SEEK edge cases,
 * the outbound parameter-name guard, and transient error classification.
 * @module tests/services/openfec/openfec-service-extended.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import {
  assertKnownParams,
  type CursorQuery,
  OpenFecService,
} from '@/services/openfec/openfec-service.js';

/** Query identity for the keyset (SEEK) calls exercised below. */
const QUERY: CursorQuery = { scope: 'openfec_search_contributions', args: {} };

const mockFetch = vi.mocked(fetchWithTimeout);

const pageEnvelope = <T>(results: T[], count = 1) => ({
  json: () =>
    Promise.resolve({
      api_version: '1.0',
      pagination: { count, page: 1, pages: 1, per_page: 20 },
      results,
    }),
});

/** The JSON error body OpenFEC itself returns for an unknown record. */
const apiNotFound = () =>
  new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404', {
    status: 404,
    body: '{"message": "The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again."}',
  });

/** The plain-text 404 the api.data.gov edge returns when the upstream host is unreachable. */
const edgeNotFound = () =>
  new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404', {
    status: 404,
    body: "404 Not Found: Requested route ('api.open.fec.gov') does not exist.",
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

  it('normalizes an OpenFEC 404 to an empty page echoing the paging arguments', async () => {
    mockFetch.mockRejectedValueOnce(apiNotFound());

    const result = await svc.getCommitteeTotals('C99999999', { page: 2, per_page: 50 }, ctx);

    expect(result.results).toEqual([]);
    expect(result.pagination).toEqual({ page: 2, pages: 0, count: 0, per_page: 50 });
  });

  it('propagates an edge routing 404 rather than reporting the committee as empty', async () => {
    mockFetch.mockRejectedValueOnce(edgeNotFound());

    await expect(svc.getCommitteeTotals('C00703975', {}, ctx)).rejects.toThrow(/404/);
  });

  it('still propagates a non-404 failure', async () => {
    mockFetch.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 503', {
        status: 503,
      }),
    );

    await expect(svc.getCommitteeTotals('C00703975', {}, ctx)).rejects.toThrow(/503/);
  });
});

describe('getCommitteeTotalsByEntityType', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('puts the entity type in the path and the filters in the query', async () => {
    mockFetch.mockResolvedValueOnce(pageEnvelope([{ committee_id: 'C00401224' }]) as never);

    const result = await svc.getCommitteeTotalsByEntityType(
      'house-senate',
      { cycle: 2024, committee_state: 'WA', min_receipts: 1_000_000 },
      ctx,
    );

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('/totals/house-senate/');
    expect(url).toContain('committee_state=WA');
    expect(url).toContain('min_receipts=1000000');
    expect(result.results[0]).toHaveProperty('committee_id', 'C00401224');
  });
});

describe('searchCoordinatedExpenditures', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('calls the page-based Schedule F endpoint', async () => {
    mockFetch.mockResolvedValueOnce(
      pageEnvelope([{ candidate_id: 'P80001571', expenditure_amount: 9_000_000 }]) as never,
    );

    const result = await svc.searchCoordinatedExpenditures(
      { candidate_id: 'P80001571', cycle: 2024, page: 1, per_page: 20 },
      ctx,
    );

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('/schedules/schedule_f/');
    expect(url).toContain('candidate_id=P80001571');
    expect(result.pagination.page).toBe(1);
  });
});

describe('getLegalDocument', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  const jsonBody = (body: unknown) => ({ json: () => Promise.resolve(body) });

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('unwraps the docs array the live endpoint returns', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonBody({
        docs: [{ ao_no: '2024-01', documents: [{ category: 'Final Opinion' }] }],
      }) as never,
    );

    const doc = await svc.getLegalDocument('advisory_opinions', '2024-01', ctx);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('/legal/docs/advisory_opinions/2024-01');
    expect(doc).toMatchObject({ ao_no: '2024-01' });
  });

  it('accepts the flat single object the OpenAPI spec documents', async () => {
    mockFetch.mockResolvedValueOnce(jsonBody({ no: 7226, name: 'Example Committee' }) as never);

    const doc = await svc.getLegalDocument('murs', '7226', ctx);

    expect(doc).toEqual({ no: 7226, name: 'Example Committee' });
  });

  it('returns null for an empty docs array', async () => {
    mockFetch.mockResolvedValueOnce(jsonBody({ docs: [] }) as never);

    await expect(svc.getLegalDocument('murs', '99999999', ctx)).resolves.toBeNull();
  });

  it('returns null for an empty flat body', async () => {
    mockFetch.mockResolvedValueOnce(jsonBody({}) as never);

    await expect(svc.getLegalDocument('statutes', '0', ctx)).resolves.toBeNull();
  });

  it('keeps a flat record whose own docs property is empty', async () => {
    mockFetch.mockResolvedValueOnce(jsonBody({ no: 1, name: 'Statute', docs: [] }) as never);

    await expect(svc.getLegalDocument('statutes', '1', ctx)).resolves.toEqual({
      no: 1,
      name: 'Statute',
      docs: [],
    });
  });

  it('returns null on an OpenFEC 404', async () => {
    mockFetch.mockRejectedValueOnce(apiNotFound());

    await expect(svc.getLegalDocument('adrs', '1', ctx)).resolves.toBeNull();
  });

  it('propagates an edge routing 404 rather than reporting the document as missing', async () => {
    mockFetch.mockRejectedValueOnce(edgeNotFound());

    await expect(svc.getLegalDocument('murs', '7226', ctx)).rejects.toThrow(/404/);
  });

  it('propagates an upstream 500 rather than reporting it as missing', async () => {
    // No HTTP status maps to InternalError — 500 classifies ServiceUnavailable
    // like the rest of the 5xx range.
    mockFetch.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 500', {
        status: 500,
      }),
    );

    let caught: unknown;
    try {
      await svc.getLegalDocument('murs', '7226', ctx);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((caught as McpError).message).toMatch(/500/);
  });

  it('rejects a non-object body as an upstream error page', async () => {
    mockFetch.mockResolvedValueOnce(jsonBody('<html>Internal Server Error</html>') as never);

    await expect(svc.getLegalDocument('murs', '7226', ctx)).rejects.toThrow(/unexpected response/);
  });

  it('percent-encodes the path segments', async () => {
    mockFetch.mockResolvedValueOnce(jsonBody({ docs: [{ no: 1 }] }) as never);

    await svc.getLegalDocument('murs', '72 26/../secret', ctx);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('/legal/docs/murs/72%2026%2F..%2Fsecret');
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

    const result = await svc.searchContributions({}, QUERY, ctx);
    expect(result.nextCursor).toBeNull();
  });

  it('nextCursor is null when last_indexes has keys but empty results', async () => {
    mockFetch.mockResolvedValueOnce(
      seekEnvelope([], { last_index: '99', last_date: '2024-01-01' }, 0) as never,
    );

    const result = await svc.searchDisbursements({}, QUERY, ctx);
    expect(result.nextCursor).toBeNull();
  });

  it('seek results propagate pagination count', async () => {
    mockFetch.mockResolvedValueOnce(seekEnvelope([{ amount: 100 }], undefined, 500) as never);

    const result = await svc.searchExpenditures({}, QUERY, ctx);
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

  it('sends the endpoint its own filter names verbatim', async () => {
    mockFetch.mockResolvedValueOnce(pageEnvelope([{ candidate_id: 'H2OH09999' }]) as never);

    await svc.getExpendituresByCandidate(
      { office: 'house', state: 'OH', district: '09', support_oppose: 'S', cycle: 2024 },
      ctx,
    );

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('office=house');
    expect(url).toContain('state=OH');
    expect(url).toContain('district=09');
    expect(url).toContain('support_oppose=S');
  });
});

describe('outbound parameter-name guard', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    [
      '/schedules/schedule_a/by_employer/',
      { page: 1, per_page: 20, cycle: 2024, committee_id: 'C00703975' },
    ],
    [
      '/schedules/schedule_a/by_occupation/',
      { page: 1, per_page: 20, cycle: 2024, committee_id: 'C00703975' },
    ],
    [
      '/schedules/schedule_a/by_size/',
      { page: 1, per_page: 20, cycle: 2024, committee_id: 'C00703975' },
    ],
    [
      '/schedules/schedule_a/by_state/',
      { page: 1, per_page: 20, cycle: 2024, committee_id: 'C00703975' },
    ],
    [
      '/schedules/schedule_a/by_size/by_candidate/',
      { page: 1, per_page: 20, cycle: 2024, candidate_id: 'P00003392' },
    ],
    [
      '/schedules/schedule_a/by_state/by_candidate/',
      { page: 1, per_page: 20, cycle: 2024, candidate_id: 'P00003392' },
    ],
    [
      '/elections/summary/',
      { state: 'AZ', district: '00', cycle: 2024, office: 'senate', election_full: true },
    ],
    [
      '/election-dates/',
      {
        page: 1,
        per_page: 20,
        election_state: 'CA',
        election_district: '14',
        office_sought: 'H',
        election_year: 2026,
        min_election_date: '2026-01-01',
        max_election_date: '2026-12-31',
      },
    ],
  ] as const)('accepts the parameters declared for %s', (path, params) => {
    expect(() => assertKnownParams(path, params)).not.toThrow();
  });

  it.each([
    ['/schedules/schedule_a/by_employer/', { candidate_id: 'P00003392' }, 'candidate_id'],
    ['/schedules/schedule_a/by_occupation/', { candidate_id: 'P00003392' }, 'candidate_id'],
    ['/schedules/schedule_a/by_size/', { candidate_id: 'P00003392' }, 'candidate_id'],
    ['/schedules/schedule_a/by_state/', { candidate_id: 'P00003392' }, 'candidate_id'],
    ['/schedules/schedule_a/by_size/by_candidate/', { committee_id: 'C00703975' }, 'committee_id'],
    ['/schedules/schedule_a/by_state/by_candidate/', { committee_id: 'C00703975' }, 'committee_id'],
    ['/elections/summary/', { page: 2 }, 'page'],
    ['/election-dates/', { district: '14' }, 'district'],
    ['/election-dates/', { state: 'CA' }, 'state'],
  ] as const)('rejects %s from %s', (path, params, field) => {
    expect(() => assertKnownParams(path, params)).toThrow(field);
  });

  it('accepts every name /schedules/schedule_e/by_candidate/ declares', () => {
    expect(() =>
      assertKnownParams('/schedules/schedule_e/by_candidate/', {
        page: 1,
        per_page: 20,
        state: 'OH',
        district: '09',
        cycle: 2024,
        office: 'house',
        election_full: true,
        candidate_id: 'H2OH09999',
        committee_id: 'C00111111',
        support_oppose: 'S',
        sort: '-total',
        sort_hide_null: true,
        sort_null_only: false,
        sort_nulls_last: true,
      }),
    ).not.toThrow();
  });

  it('accepts the keyset cursor keys Schedule B and E hand back', () => {
    expect(() =>
      assertKnownParams('/schedules/schedule_b/', {
        last_index: 42,
        last_disbursement_date: '2024-05-10',
        last_disbursement_amount: 150_000,
      }),
    ).not.toThrow();
    expect(() =>
      assertKnownParams('/schedules/schedule_e/', {
        last_index: 42,
        last_expenditure_date: '2024-10-01',
        last_expenditure_amount: 500_000,
        last_office_total_ytd: 1_000,
        sort_null_only: false,
      }),
    ).not.toThrow();
  });

  it('rejects an itemized filter name aimed at the by_candidate endpoint', () => {
    expect(() =>
      assertKnownParams('/schedules/schedule_e/by_candidate/', {
        candidate_id: 'P80001571',
        support_oppose_indicator: 'S',
      }),
    ).toThrow(/support_oppose_indicator/);
  });

  it('names every offending parameter and the endpoint', () => {
    let err: McpError | undefined;
    try {
      assertKnownParams('/legal/search/', {
        q: 'test',
        min_date: '2024-01-01',
        max_date: '2024-12-31',
      });
    } catch (e) {
      err = e as McpError;
    }

    expect(err).toBeInstanceOf(McpError);
    expect(err?.code).toBe(JsonRpcErrorCode.InternalError);
    expect(err?.data).toMatchObject({
      endpoint: '/legal/search/',
      unknown_parameters: ['max_date', 'min_date'],
    });
  });

  it('leaves endpoints without a declared allowlist unchecked', () => {
    expect(() => assertKnownParams('/candidates/', { not_a_real_param: 1 })).not.toThrow();
  });

  it('accepts every name /schedules/schedule_f/ declares', () => {
    expect(() =>
      assertKnownParams('/schedules/schedule_f/', {
        committee_id: 'C00003418',
        candidate_id: 'P80001571',
        cycle: 2024,
        payee_name: 'MEDIA',
        min_date: '2024-01-01',
        max_date: '2024-11-05',
        min_amount: 1000,
        max_amount: 9_000_000,
        form_line_number: 'F3X-25',
        image_number: '202407209661626669',
        page: 1,
        per_page: 20,
        sort: '-expenditure_amount',
        sort_hide_null: true,
        sort_null_only: false,
        sort_nulls_last: true,
      }),
    ).not.toThrow();
  });

  it('rejects a Schedule E filter name aimed at Schedule F', () => {
    expect(() =>
      assertKnownParams('/schedules/schedule_f/', { support_oppose_indicator: 'S' }),
    ).toThrow(/support_oppose_indicator/);
  });

  it('resolves an interpolated committee-totals path to its spec template', () => {
    expect(() =>
      assertKnownParams('/committee/C00703975/totals/', { page: 1, per_page: 20, cycle: 2024 }),
    ).not.toThrow();

    let err: McpError | undefined;
    try {
      assertKnownParams('/committee/C00703975/totals/', { committee_state: 'PA' });
    } catch (e) {
      err = e as McpError;
    }
    expect(err?.data).toMatchObject({
      endpoint: '/committee/{committee_id}/totals/',
      unknown_parameters: ['committee_state'],
    });
  });

  it('resolves an interpolated entity-type totals path to its spec template', () => {
    expect(() =>
      assertKnownParams('/totals/house-senate/', {
        committee_state: 'WA',
        min_receipts: 1_000_000,
        max_disbursements: 5,
        organization_type: 'C',
        committee_designation: 'P',
        committee_type: 'H',
        cycle: 2024,
        page: 1,
        per_page: 20,
        sort: '-receipts',
      }),
    ).not.toThrow();
    expect(() => assertKnownParams('/totals/pac/', { q: 'anything' })).toThrow(/does not accept/);
  });

  it('rejects any query parameter on the legal detail endpoint', () => {
    expect(() => assertKnownParams('/legal/docs/murs/7226', {})).not.toThrow();
    expect(() => assertKnownParams('/legal/docs/murs/7226', { q: 'test' })).toThrow(
      /\/legal\/docs\/\{doc_type\}\/\{no\}/,
    );
  });

  it('fires through the service before any request is made', async () => {
    await expect(svc.searchLegal({ min_penalty_amount: 100 }, ctx)).rejects.toThrow(
      /does not accept/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
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
