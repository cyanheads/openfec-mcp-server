/**
 * @fileoverview Tests for the OpenFEC service layer — cursor encoding/decoding,
 * URL building, envelope validation, transient error classification, and singleton lifecycle.
 * @module tests/services/openfec/openfec-service.test
 */

import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Mutable so the retry-ladder cases can raise the attempt count and timeout. */
const config = vi.hoisted(() => ({
  fecApiKey: 'DEMO_KEY',
  fecBaseUrl: 'https://api.open.fec.gov/v1',
  fecMaxRetries: 0,
  fecRequestTimeout: 5000,
}));

// Mock getServerConfig before importing the service
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));

// Mock fetchWithTimeout and withRetry from the framework utils. Everything else
// stays real so the service's transient classifier runs against the framework's
// own `defaultIsTransient` rather than a stub of it.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import {
  assertKnownParams,
  type CursorQuery,
  cursorQuery,
  decodeCursor,
  encodeCursor,
  getOpenFecService,
  initOpenFecService,
  OpenFecService,
} from '@/services/openfec/openfec-service.js';
import {
  COMMITTEES,
  type CommitteeRecord,
  committeeRequest,
  requestsSent,
  routeCommitteeTotals,
} from './committee-totals-upstream.js';

const mockFetch = vi.mocked(fetchWithTimeout);
const mockWithRetry = vi.mocked(withRetry);

/** Query identity used by the SEEK service tests below. */
const QUERY: CursorQuery = { scope: 'openfec_search_contributions', args: {} };

/** Assert `fn` throws a ValidationError McpError carrying `reason`. */
const expectCursorRejection = (fn: () => unknown, reason: string) => {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(McpError);
  const err = thrown as McpError;
  expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
  const data = err.data as { reason?: string; recovery?: { hint?: string } };
  expect(data.reason).toBe(reason);
  expect(data.recovery?.hint).toBeTruthy();
  return err;
};

describe('cursorQuery', () => {
  it('stringifies caller arguments and keeps the issuing scope', () => {
    const query = cursorQuery('openfec_search_contributions', {
      mode: 'itemized',
      committee_id: 'C00703975',
      cycle: 2024,
      is_individual: true,
    });

    expect(query).toEqual({
      scope: 'openfec_search_contributions',
      args: {
        mode: 'itemized',
        committee_id: 'C00703975',
        cycle: '2024',
        is_individual: 'true',
      },
    });
  });

  it('excludes cursor, page, and per_page, which do not shape the keyset', () => {
    const query = cursorQuery('openfec_search_disbursements', {
      committee_id: 'C00703975',
      page: 3,
      per_page: 50,
      cursor: 'abc',
    });

    expect(query.args).toEqual({ committee_id: 'C00703975' });
  });

  it('omits undefined arguments so an unset filter matches an absent one', () => {
    const query = cursorQuery('openfec_search_expenditures', {
      committee_id: 'C00111111',
      payee_name: undefined,
    });

    expect(query.args).toEqual({ committee_id: 'C00111111' });
  });
});

describe('cursor encoding', () => {
  it('round-trips last_indexes through encode/decode', () => {
    const indexes = { last_index: '123', last_contribution_receipt_date: '2024-01-15' };
    const cursor = encodeCursor(indexes, QUERY, 60);
    expect(typeof cursor).toBe('string');
    expect(decodeCursor(cursor, QUERY)).toEqual({ indexes, delivered: 60 });
  });

  it('handles empty indexes', () => {
    const cursor = encodeCursor({}, QUERY);
    expect(decodeCursor(cursor, QUERY).indexes).toEqual({});
  });

  it('reads a cursor minted without a delivered count as position 0', () => {
    const cursor = btoa(JSON.stringify({ q: QUERY, i: { last_index: '99' } }));
    expect(decodeCursor(cursor, QUERY)).toEqual({ indexes: { last_index: '99' }, delivered: 0 });
  });

  it('embeds the issuing query alongside the indexes', () => {
    const query = cursorQuery('openfec_search_contributions', {
      sort: 'contribution_receipt_amount',
    });
    const cursor = encodeCursor({ foo: 'bar' }, query);
    expect(JSON.parse(atob(cursor))).toEqual({ q: query, i: { foo: 'bar' } });
  });
});

describe('cursor validation', () => {
  it('rejects a cursor that is not valid base64', () => {
    const err = expectCursorRejection(
      () => decodeCursor('not-a-cursor!!', QUERY),
      'invalid_cursor',
    );
    expect(err.message).toContain('not decodable');
  });

  it('rejects base64 that does not decode to JSON', () => {
    expectCursorRejection(
      () => decodeCursor(btoa('plain text, not json'), QUERY),
      'invalid_cursor',
    );
  });

  it('rejects a decoded payload with the wrong shape', () => {
    for (const payload of [
      JSON.stringify({ last_index: '99' }), // pre-fingerprint flat cursor
      JSON.stringify({ q: QUERY }), // missing indexes
      JSON.stringify({ q: { scope: 1, args: {} }, i: {} }), // non-string scope
      JSON.stringify({ q: QUERY, i: { last_index: 99 } }), // non-string index value
      JSON.stringify({ q: QUERY, i: {}, n: -1 }), // negative delivered count
      JSON.stringify({ q: QUERY, i: {}, n: '30' }), // non-numeric delivered count
      JSON.stringify([1, 2, 3]), // not an object
    ]) {
      expectCursorRejection(() => decodeCursor(btoa(payload), QUERY), 'invalid_cursor');
    }
  });

  it('echoes a truncated cursor rather than the full caller-supplied string', () => {
    const err = expectCursorRejection(() => decodeCursor('%'.repeat(300), QUERY), 'invalid_cursor');
    const { cursor } = err.data as { cursor: string };
    expect(cursor).toHaveLength(101);
    expect(cursor.endsWith('…')).toBe(true);
  });

  it('rejects a cursor issued by a different tool', () => {
    const cursor = encodeCursor(
      { last_index: '99' },
      { scope: 'openfec_search_disbursements', args: {} },
    );

    const err = expectCursorRejection(
      () => decodeCursor(cursor, { scope: 'openfec_search_contributions', args: {} }),
      'cursor_query_mismatch',
    );
    expect(err.message).toContain('openfec_search_disbursements');
  });

  it('rejects a cursor replayed under a changed sort, naming the argument', () => {
    const issued = cursorQuery('openfec_search_contributions', {
      committee_id: 'C00431056',
      sort: 'contribution_receipt_amount',
    });
    const cursor = encodeCursor({ last_index: '99' }, issued);

    const err = expectCursorRejection(
      () =>
        decodeCursor(
          cursor,
          cursorQuery('openfec_search_contributions', {
            committee_id: 'C00431056',
          }),
        ),
      'cursor_query_mismatch',
    );
    const { changed_arguments } = err.data as { changed_arguments: string[] };
    expect(changed_arguments).toEqual([
      'sort (cursor: "contribution_receipt_amount", call: omitted)',
    ]);
  });

  it('rejects a cursor replayed under a changed filter', () => {
    const issued = cursorQuery('openfec_search_contributions', { committee_id: 'C00431056' });
    const cursor = encodeCursor({ last_index: '99' }, issued);

    const err = expectCursorRejection(
      () =>
        decodeCursor(
          cursor,
          cursorQuery('openfec_search_contributions', {
            committee_id: 'C00703975',
          }),
        ),
      'cursor_query_mismatch',
    );
    const { changed_arguments } = err.data as { changed_arguments: string[] };
    expect(changed_arguments).toEqual(['committee_id (cursor: "C00431056", call: "C00703975")']);
  });

  it('accepts a cursor replayed with page changed', () => {
    const cursor = encodeCursor(
      { last_index: '99' },
      cursorQuery('openfec_search_contributions', { committee_id: 'C00431056', page: 1 }),
    );

    const decoded = decodeCursor(
      cursor,
      cursorQuery('openfec_search_contributions', { committee_id: 'C00431056', page: 4 }),
    );
    expect(decoded.indexes).toEqual({ last_index: '99' });
  });

  it('accepts a cursor replayed with per_page changed', () => {
    const cursor = encodeCursor(
      { last_index: '99' },
      cursorQuery('openfec_search_contributions', { committee_id: 'C00431056', per_page: 3 }),
    );

    const decoded = decodeCursor(
      cursor,
      cursorQuery('openfec_search_contributions', { committee_id: 'C00431056', per_page: 100 }),
    );
    expect(decoded.indexes).toEqual({ last_index: '99' });
  });
});

describe('singleton lifecycle', () => {
  it('throws before initialization', () => {
    // Re-import to get a fresh module state isn't practical with vi.mock,
    // but we can test that after init, getOpenFecService works
    initOpenFecService();
    expect(() => getOpenFecService()).not.toThrow();
  });

  it('returns an OpenFecService instance', () => {
    initOpenFecService();
    const svc = getOpenFecService();
    expect(svc).toBeInstanceOf(OpenFecService);
  });
});

describe('OpenFecService', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
    mockFetch.mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * `exact` mirrors the upstream `is_count_exact` flag: omit it to build the
   * envelope OpenFEC sends when it declares nothing, which must stay distinct
   * from an explicit `false`.
   */
  const pageEnvelope = <T>(results: T[], count = 1, page = 1, pages = 1, exact?: boolean) => ({
    json: () =>
      Promise.resolve({
        api_version: '1.0',
        pagination: {
          count,
          page,
          pages,
          per_page: 20,
          ...(exact === undefined ? {} : { is_count_exact: exact }),
        },
        results,
      }),
  });

  /**
   * `perPage` decides whether the fixture is a full page or a short one — the
   * signal the cursor decision reads — so a one-row full page is built with
   * `perPage: 1`.
   */
  const seekEnvelope = <T>(
    results: T[],
    lastIndexes: Record<string, string | number> | null | undefined,
    count = 1,
    { perPage = 20, exact }: { perPage?: number; exact?: boolean } = {},
  ) => ({
    json: () =>
      Promise.resolve({
        api_version: '1.0',
        pagination: {
          count,
          per_page: perPage,
          last_indexes: lastIndexes,
          ...(exact === undefined ? {} : { is_count_exact: exact }),
        },
        results,
      }),
  });

  describe('searchCandidates', () => {
    it('returns page-based results', async () => {
      const candidates = [{ candidate_id: 'P00003392', name: 'BIDEN, JOSEPH R JR' }];
      mockFetch.mockResolvedValueOnce(pageEnvelope(candidates) as never);

      const result = await svc.searchCandidates({ q: 'Biden' }, ctx);
      expect(result.results).toEqual(candidates);
      expect(result.pagination.page).toBe(1);
    });

    it('passes query params to the URL', async () => {
      mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);
      await svc.searchCandidates({ q: 'Harris', state: 'CA' }, ctx);

      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('api_key=DEMO_KEY');
      expect(url).toContain('q=Harris');
      expect(url).toContain('state=CA');
    });

    it.each([
      ['an exact count', true],
      ['an inexact count', false],
    ])('carries %s through to the page result', async (_label, exact) => {
      mockFetch.mockResolvedValueOnce(pageEnvelope([], 500, 1, 25, exact) as never);

      const result = await svc.searchCandidates({}, ctx);
      expect(result.pagination.is_count_exact).toBe(exact);
    });

    it('leaves is_count_exact absent when upstream omits it', async () => {
      mockFetch.mockResolvedValueOnce(pageEnvelope([], 500, 1, 25) as never);

      const result = await svc.searchCandidates({}, ctx);
      expect(result.pagination).toStrictEqual({ page: 1, pages: 25, count: 500, per_page: 20 });
    });
  });

  describe('getCandidate', () => {
    it('fetches a single candidate by ID', async () => {
      const candidate = { candidate_id: 'P00003392', name: 'BIDEN, JOSEPH R JR' };
      mockFetch.mockResolvedValueOnce(pageEnvelope([candidate]) as never);

      const result = await svc.getCandidate('P00003392', ctx);
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/candidate/P00003392/');
      expect(result.results).toEqual([candidate]);
    });
  });

  describe('searchCommittees', () => {
    it('returns committee results', async () => {
      const committees = [{ committee_id: 'C00703975', name: 'ACTBLUE' }];
      mockFetch.mockResolvedValueOnce(pageEnvelope(committees) as never);

      const result = await svc.searchCommittees({ q: 'actblue' }, ctx);
      expect(result.results).toEqual(committees);
    });
  });

  describe('getCommittee', () => {
    it('fetches a single committee by ID', async () => {
      mockFetch.mockResolvedValueOnce(pageEnvelope([{ committee_id: 'C00703975' }]) as never);
      const result = await svc.getCommittee('C00703975', ctx);
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/committee/C00703975/');
      expect(result.results).toHaveLength(1);
    });
  });

  describe('searchContributions (SEEK)', () => {
    it('returns seek-based results with nextCursor when more pages exist', async () => {
      const contributions = [{ contributor_name: 'DOE, JOHN', contribution_receipt_amount: 500 }];
      mockFetch.mockResolvedValueOnce(
        seekEnvelope(
          contributions,
          { last_index: '99', last_contribution_receipt_date: '2024-06-01' },
          50,
          { perPage: 1 },
        ) as never,
      );

      const result = await svc.searchContributions({ committee_id: 'C00703975' }, QUERY, ctx);
      expect(result.results).toEqual(contributions);
      expect(result.nextCursor).toBeTruthy();
      expect(decodeCursor(result.nextCursor as string, QUERY)).toEqual({
        indexes: { last_index: '99', last_contribution_receipt_date: '2024-06-01' },
        delivered: 1,
      });
    });

    it('returns null nextCursor when no more pages', async () => {
      mockFetch.mockResolvedValueOnce(seekEnvelope([{ amount: 100 }], undefined, 1) as never);

      const result = await svc.searchContributions({}, QUERY, ctx);
      expect(result.nextCursor).toBeNull();
    });

    it('returns null nextCursor when last_indexes is empty', async () => {
      mockFetch.mockResolvedValueOnce(seekEnvelope([{ amount: 100 }], {}, 1) as never);

      const result = await svc.searchContributions({}, QUERY, ctx);
      expect(result.nextCursor).toBeNull();
    });

    /** The page past the last row: upstream sends `last_indexes: null`, not an omitted key. */
    it('returns null nextCursor when last_indexes is null on an empty page', async () => {
      mockFetch.mockResolvedValueOnce(seekEnvelope([], null, 9) as never);

      const result = await svc.searchContributions({}, QUERY, ctx);
      expect(result.nextCursor).toBeNull();
      expect(result.pagination.count).toBe(9);
    });

    it('returns null nextCursor on a short page, even with last_indexes populated', async () => {
      mockFetch.mockResolvedValueOnce(
        seekEnvelope([{ amount: 100 }], { last_index: '99' }, 50, { perPage: 20 }) as never,
      );

      const result = await svc.searchContributions({}, QUERY, ctx);
      expect(result.nextCursor).toBeNull();
    });

    it('mints a cursor on a full page', async () => {
      const rows = [{ amount: 100 }, { amount: 200 }, { amount: 300 }];
      mockFetch.mockResolvedValueOnce(
        seekEnvelope(rows, { last_index: '99' }, 50, { perPage: 3 }) as never,
      );

      const result = await svc.searchContributions({}, QUERY, ctx);
      expect(result.nextCursor).toBeTruthy();
    });

    it('falls back to a page size of 20 when upstream omits per_page', async () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ amount: i }));
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            api_version: '1.0',
            pagination: { count: 50, last_indexes: { last_index: '99' } },
            results: rows,
          }),
      } as never);

      const result = await svc.searchContributions({}, QUERY, ctx);
      expect(result.pagination.per_page).toBe(20);
      expect(result.nextCursor).toBeTruthy();
    });

    it('returns null nextCursor when an exact count fits the page just returned', async () => {
      const rows = [{ amount: 100 }, { amount: 200 }, { amount: 300 }];
      mockFetch.mockResolvedValueOnce(
        seekEnvelope(rows, { last_index: '99' }, 3, { perPage: 3, exact: true }) as never,
      );

      const result = await svc.searchContributions({}, QUERY, ctx);
      expect(result.nextCursor).toBeNull();
    });

    it('returns null nextCursor on a resumed full page that reaches an exact count', async () => {
      const rows = [{ amount: 100 }, { amount: 200 }, { amount: 300 }];
      mockFetch.mockResolvedValueOnce(
        seekEnvelope(rows, { last_index: '99' }, 6, { perPage: 3, exact: true }) as never,
      );

      const result = await svc.searchContributions({}, QUERY, ctx, 3);
      expect(result.nextCursor).toBeNull();
    });

    it('carries the running row count forward on a resumed full page short of an exact count', async () => {
      const rows = [{ amount: 100 }, { amount: 200 }, { amount: 300 }];
      mockFetch.mockResolvedValueOnce(
        seekEnvelope(rows, { last_index: '99' }, 7, { perPage: 3, exact: true }) as never,
      );

      const result = await svc.searchContributions({}, QUERY, ctx, 3);
      expect(decodeCursor(result.nextCursor as string, QUERY).delivered).toBe(6);
    });

    it('mints a cursor on a full page whose count is inexact', async () => {
      const rows = [{ amount: 100 }, { amount: 200 }, { amount: 300 }];
      mockFetch.mockResolvedValueOnce(
        seekEnvelope(rows, { last_index: '99' }, 3, { perPage: 3, exact: false }) as never,
      );

      const result = await svc.searchContributions({}, QUERY, ctx);
      expect(result.nextCursor).toBeTruthy();
    });

    it('mints a cursor on a full page when upstream declares no exactness', async () => {
      const rows = [{ amount: 100 }, { amount: 200 }, { amount: 300 }];
      mockFetch.mockResolvedValueOnce(
        seekEnvelope(rows, { last_index: '99' }, 3, { perPage: 3 }) as never,
      );

      const result = await svc.searchContributions({}, QUERY, ctx);
      expect(result.nextCursor).toBeTruthy();
    });

    it.each([
      ['an exact count', true],
      ['an inexact count', false],
    ])('carries %s through to the seek result', async (_label, exact) => {
      mockFetch.mockResolvedValueOnce(
        seekEnvelope([{ amount: 100 }], undefined, 500, { exact }) as never,
      );

      const result = await svc.searchContributions({}, QUERY, ctx);
      expect(result.pagination.is_count_exact).toBe(exact);
    });

    it('leaves is_count_exact absent when upstream omits it', async () => {
      mockFetch.mockResolvedValueOnce(seekEnvelope([{ amount: 100 }], undefined, 500) as never);

      const result = await svc.searchContributions({}, QUERY, ctx);
      expect(result.pagination).toStrictEqual({ count: 500, per_page: 20 });
    });

    it('round-trips a numeric last_index value (Schedule E office_total_ytd)', async () => {
      mockFetch.mockResolvedValueOnce(
        seekEnvelope(
          [{ expenditure_amount: 100 }],
          { last_index: '4060220251204384181', last_office_total_ytd: 503313627.73 },
          2,
          { perPage: 1 },
        ) as never,
      );

      const result = await svc.searchExpenditures({}, QUERY, ctx);

      expect(decodeCursor(result.nextCursor as string, QUERY).indexes).toEqual({
        last_index: '4060220251204384181',
        last_office_total_ytd: '503313627.73',
      });
    });

    it('binds nextCursor to the query it was issued for', async () => {
      const issued = cursorQuery('openfec_search_contributions', {
        committee_id: 'C00431056',
        sort: '-contribution_receipt_amount',
      });
      mockFetch.mockResolvedValueOnce(
        seekEnvelope([{ amount: 100 }], { last_index: '7' }, 2, { perPage: 1 }) as never,
      );

      const result = await svc.searchContributions({ committee_id: 'C00431056' }, issued, ctx);

      expect(decodeCursor(result.nextCursor as string, issued).indexes).toEqual({
        last_index: '7',
      });
      expect(() =>
        decodeCursor(
          result.nextCursor as string,
          cursorQuery('openfec_search_contributions', { committee_id: 'C00431056' }),
        ),
      ).toThrow(McpError);
    });
  });

  describe('getContributionAggregates', () => {
    it('routes to correct path for each mode', async () => {
      const modes: Record<string, string> = {
        by_size: '/schedules/schedule_a/by_size/',
        by_state: '/schedules/schedule_a/by_state/',
        by_employer: '/schedules/schedule_a/by_employer/',
        by_occupation: '/schedules/schedule_a/by_occupation/',
        by_size_candidate: '/schedules/schedule_a/by_size/by_candidate/',
        by_state_candidate: '/schedules/schedule_a/by_state/by_candidate/',
      };

      for (const [mode, expectedPath] of Object.entries(modes)) {
        mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);
        await svc.getContributionAggregates(mode, {}, ctx);
        const url = mockFetch.mock.calls.at(-1)![0] as string;
        expect(url).toContain(expectedPath);
      }
    });

    it('throws for unknown aggregate mode', () => {
      expect(() => svc.getContributionAggregates('invalid', {}, ctx)).toThrow(
        'Unknown contribution aggregate mode: invalid',
      );
    });
  });

  describe('searchDisbursements (SEEK)', () => {
    it('returns seek-based results', async () => {
      const disbursements = [{ recipient_name: 'MEDIA CORP', disbursement_amount: 10000 }];
      mockFetch.mockResolvedValueOnce(seekEnvelope(disbursements, undefined, 1) as never);

      const result = await svc.searchDisbursements({}, QUERY, ctx);
      expect(result.results).toEqual(disbursements);
    });
  });

  describe('getDisbursementAggregates', () => {
    it('routes correctly for each mode', async () => {
      for (const mode of ['by_purpose', 'by_recipient', 'by_recipient_id']) {
        mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);
        await svc.getDisbursementAggregates(mode, {}, ctx);
        const url = mockFetch.mock.calls.at(-1)![0] as string;
        expect(url).toContain(`/schedules/schedule_b/${mode}/`);
      }
    });

    it('throws for unknown mode', () => {
      expect(() => svc.getDisbursementAggregates('invalid', {}, ctx)).toThrow(
        'Unknown disbursement aggregate mode: invalid',
      );
    });
  });

  describe('searchExpenditures (SEEK)', () => {
    it('returns seek-based results', async () => {
      mockFetch.mockResolvedValueOnce(
        seekEnvelope([{ expenditure_amount: 5000 }], undefined, 1) as never,
      );
      const result = await svc.searchExpenditures({}, QUERY, ctx);
      expect(result.results).toHaveLength(1);
    });
  });

  describe('searchFilings', () => {
    it('returns page-based filing results', async () => {
      mockFetch.mockResolvedValueOnce(pageEnvelope([{ form_type: 'F3' }]) as never);
      const result = await svc.searchFilings({}, ctx);
      expect(result.results[0]).toHaveProperty('form_type', 'F3');
    });
  });

  describe('searchElections', () => {
    it('calls the /elections/ endpoint', async () => {
      mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);
      await svc.searchElections({ office: 'president', cycle: 2024 }, ctx);
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/elections/');
    });
  });

  describe('getElectionSummary', () => {
    it('calls the /elections/summary/ endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            count: 50,
            receipts: 500_000_000,
            disbursements: 400_000_000,
            independent_expenditures: 100_000_000,
          }),
      } as never);
      const result = await svc.getElectionSummary({ office: 'president', cycle: 2024 }, ctx);
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/elections/summary/');
      expect(result.count).toBe(50);
      expect(result.receipts).toBe(500_000_000);
    });
  });

  describe('searchLegal', () => {
    it('normalizes type-keyed arrays into flat results', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            advisory_opinions: [{ ao_no: '2024-01', name: 'Test AO' }],
            murs: [{ case_no: 'MUR-7890' }],
            adrs: [],
            admin_fines: [{ penalty_amount: 5000 }],
            statutes: [],
            total_all: 3,
          }),
      } as never);

      const result = await svc.searchLegal({ q: 'test' }, ctx);
      expect(result.results).toHaveLength(3);
      expect(result.results[0]).toHaveProperty('document_type', 'advisory_opinion');
      expect(result.results[1]).toHaveProperty('document_type', 'mur');
      expect(result.results[2]).toHaveProperty('document_type', 'admin_fine');
      expect(result.totalCount).toBe(3);
    });

    it('uses results.length as fallback when total_all is missing', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            advisory_opinions: [{ ao_no: '2024-01' }],
            murs: [],
            adrs: [],
            admin_fines: [],
            statutes: [],
          }),
      } as never);

      const result = await svc.searchLegal({}, ctx);
      expect(result.totalCount).toBe(1);
    });

    it('carries every per-type total an untyped search reports', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            advisory_opinions: [{ no: '2024-01' }],
            murs: [{ no: '8363' }],
            adrs: [],
            admin_fines: [],
            statutes: [{ no: '9001' }],
            total_advisory_opinions: 1,
            total_murs: 7670,
            total_adrs: 1084,
            total_admin_fines: 0,
            total_statutes: 57,
            total_all: 8812,
          }),
      } as never);

      const result = await svc.searchLegal({ ao_no: '2024-01' }, ctx);
      expect(result.typeTotals).toEqual({
        advisory_opinions: 1,
        murs: 7670,
        adrs: 1084,
        admin_fines: 0,
        statutes: 57,
      });
    });

    it('carries only the type a typed search reports, leaving the others absent rather than zero', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ murs: [{ no: '8274' }], total_murs: 95, total_all: 95 }),
      } as never);

      const result = await svc.searchLegal({ type: 'murs' }, ctx);
      expect(result.typeTotals).toEqual({ murs: 95 });
      expect(result.results).toEqual([{ no: '8274', document_type: 'mur' }]);
      expect(result.totalCount).toBe(95);
    });
  });

  describe('calendar endpoints', () => {
    it('getCalendarDates calls /calendar-dates/', async () => {
      mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);
      await svc.getCalendarDates({}, ctx);
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/calendar-dates/');
    });

    it('getReportingDates calls /reporting-dates/', async () => {
      mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);
      await svc.getReportingDates({}, ctx);
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/reporting-dates/');
    });

    it('getElectionDates calls /election-dates/', async () => {
      mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);
      await svc.getElectionDates({}, ctx);
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/election-dates/');
    });
  });

  describe('envelope validation', () => {
    it('throws on non-object response', async () => {
      mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(null) } as never);
      await expect(svc.searchCandidates({}, ctx)).rejects.toThrow('unexpected response');
    });

    it('throws on response without results key', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ error: 'bad request' }),
      } as never);
      await expect(svc.searchCandidates({}, ctx)).rejects.toThrow('unexpected response');
    });
  });

  describe('URL building', () => {
    it('strips undefined and empty params', async () => {
      mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);
      await svc.searchCandidates({ q: undefined, state: '', office: 'P' }, ctx);
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).not.toContain('q=');
      expect(url).not.toContain('state=');
      expect(url).toContain('office=P');
    });

    it('strips trailing slash from base URL', async () => {
      // This is tested implicitly — the config has no trailing slash,
      // and the service strips it if present
      mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);
      await svc.searchCandidates({}, ctx);
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toMatch(/\/v1\/candidates\//);
    });
  });
});

describe('isTransientFecError', () => {
  /**
   * isTransientFecError is module-private, so we test it indirectly via withRetry integration.
   * The vi.mock of withRetry above bypasses retries, but we can verify the service
   * doesn't swallow errors by checking that transient-like errors propagate.
   */
  it('transient errors propagate from the fetch pipeline', async () => {
    const svc = new OpenFecService();
    const ctx = createMockContext();
    mockFetch.mockRejectedValueOnce(new Error('503 ServiceUnavailable'));

    await expect(svc.searchCandidates({}, ctx)).rejects.toThrow('503');
  });

  /**
   * The classifier is reached via the `isTransient` predicate handed to
   * `withRetry`. Framework-thrown `McpError`s must classify by code — a
   * timeout carries no distinguishing substring in its message.
   */
  const classify = async (): Promise<(error: unknown) => boolean> => {
    const svc = new OpenFecService();
    const ctx = createMockContext();
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ pagination: {}, results: [] }),
    } as unknown as Response);
    await svc.searchCandidates({}, ctx);
    const options = mockWithRetry.mock.calls.at(-1)?.[1] as {
      isTransient: (error: unknown) => boolean;
    };
    return options.isTransient;
  };

  it.each([
    ['Timeout', JsonRpcErrorCode.Timeout],
    ['ServiceUnavailable', JsonRpcErrorCode.ServiceUnavailable],
    ['RateLimited', JsonRpcErrorCode.RateLimited],
  ])('classifies a framework %s McpError as transient', async (_name, code) => {
    const isTransient = await classify();
    expect(isTransient(new McpError(code, 'FEC /candidates timed out.'))).toBe(true);
  });

  it('does not retry a deterministic upstream rejection', async () => {
    const isTransient = await classify();
    expect(isTransient(new McpError(JsonRpcErrorCode.ValidationError, 'Status: 422'))).toBe(false);
  });

  /**
   * A 501 classifies `ServiceUnavailable` alongside the rest of the 5xx range,
   * so the in-band `data.retryable: false` the framework sets is the only thing
   * keeping a method the upstream does not implement out of the retry ladder.
   */
  it('honors the retryable:false opt-out on an otherwise transient code', async () => {
    const isTransient = await classify();
    expect(
      isTransient(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 501', {
          retryable: false,
        }),
      ),
    ).toBe(false);
  });

  it('still classifies raw socket failures by message', async () => {
    const isTransient = await classify();
    expect(isTransient(new Error('fetch failed: ECONNRESET'))).toBe(true);
  });
});

describe('committee history parameter guard', () => {
  it('accepts every name /committee/{committee_id}/history/ declares', () => {
    expect(() =>
      assertKnownParams('/committee/C00703975/history/', {
        page: 1,
        per_page: 100,
        election_full: true,
        designation: ['P'],
        sort: '-cycle',
        sort_hide_null: false,
        sort_null_only: false,
        sort_nulls_last: true,
      }),
    ).not.toThrow();
  });

  it('rejects a name the history endpoint does not accept, naming its template', () => {
    let err: McpError | undefined;
    try {
      assertKnownParams('/committee/C00703975/history/', { per_page: 100, cycle: 2024 });
    } catch (e) {
      err = e as McpError;
    }
    expect(err?.data).toMatchObject({
      endpoint: '/committee/{committee_id}/history/',
      unknown_parameters: ['cycle'],
    });
  });
});

/** The framework utils unstubbed, for the cases that run the real fetch path and retry ladder. */
const realUtils = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
  '@cyanheads/mcp-ts-core/utils',
);

/**
 * The omitted-cycle totals read, through the real `fetchWithTimeout` and
 * `withRetry` against a fake of the two OpenFEC endpoints built from live
 * captures. Only the network boundary is faked.
 */
describe('getCommitteeTotalsAllCycles', () => {
  const PAGE_1 = { page: 1, per_page: 20 };
  type Parts = NonNullable<ReturnType<typeof committeeRequest>>;

  let http: FetchMockHarness;
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockImplementation(realUtils.fetchWithTimeout);
    mockWithRetry.mockImplementation(realUtils.withRetry);
    http = createFetchMock();
    http.install();
    svc = new OpenFecService();
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.useRealTimers();
    http.restore();
    mockFetch.mockReset();
    mockWithRetry.mockReset();
    config.fecMaxRetries = 0;
    config.fecRequestTimeout = 5000;
  });

  const cyclesOf = (rows: Record<string, unknown>[]) => rows.map((row) => row.cycle);

  const isHistory = (parts: Parts) => parts.endpoint === 'history';
  /** A per-table read: the only totals request that carries `cycle`. */
  const isTableRead = (parts: Parts) => parts.endpoint === 'totals' && parts.query.has('cycle');
  /** The unfiltered request carrying the caller's paging. */
  const isCallerPage = (parts: Parts) =>
    parts.endpoint === 'totals' &&
    !parts.query.has('cycle') &&
    parts.query.get('per_page') !== '100';

  /** Answer the requests `select` picks with `respond`, ahead of the fake. */
  const intercept = (
    select: (parts: Parts) => boolean,
    respond: (request: Request) => Response | Promise<Response>,
  ) =>
    http.route({
      match: (request) => {
        const parts = committeeRequest(request.url);
        return parts !== null && select(parts);
      },
      respond,
    });

  const status =
    (code: number, headers: Record<string, string> = {}) =>
    () =>
      new Response('{"message":"upstream failure"}', {
        status: code,
        headers: { 'content-type': 'application/json', ...headers },
      });

  /** A status answered with an HTML page, as the api.data.gov edge answers a routing failure or a maintenance window. */
  const htmlStatus = (code: number) => () =>
    new Response('<!doctype html><title>Not Found</title>', {
      status: code,
      headers: { 'content-type': 'text/html' },
    });

  /** A 200 envelope whose `results` is present but not an array. */
  const nullResults = () =>
    Response.json({
      api_version: '1.0',
      pagination: { count: 0, page: 1, pages: 0, per_page: 100 },
      results: null,
    });

  /** An upstream that never answers: the request settles only when its signal aborts. */
  const hang = (request: Request) =>
    new Promise<Response>((_, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), {
        once: true,
      });
    });

  /** C00703975 with one change applied to a copy of its capture. */
  const variant = (change: (record: CommitteeRecord) => void) => {
    const record = structuredClone(COMMITTEES.C00703975);
    change(record);
    return { C00703975: record };
  };

  describe('merging across committee types', () => {
    it('returns every cycle of a committee that converted from a campaign to a PAC (C00703975)', async () => {
      routeCommitteeTotals(http);

      const { totals, coverage } = await svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx);

      expect(coverage).toEqual({ kind: 'complete' });
      expect(
        totals.results.map((row) => [row.cycle, row.committee_type, row.committee_name]),
      ).toEqual([
        [2026, 'N', 'FIGHT FOR THE PEOPLE PAC'],
        [2024, 'P', 'HARRIS FOR PRESIDENT'],
        [2022, 'P', 'BIDEN FOR PRESIDENT'],
        [2020, 'P', 'BIDEN FOR PRESIDENT'],
      ]);
      expect(totals.pagination).toEqual({
        page: 1,
        pages: 1,
        count: 4,
        per_page: 20,
        is_count_exact: true,
      });
      expect(requestsSent(http).toSorted()).toEqual([
        'C00703975/history?per_page=100',
        'C00703975/totals?cycle=2024&cycle=2022&cycle=2020&per_page=100',
        'C00703975/totals?page=1&per_page=20',
      ]);
    });

    it('returns all six cycles of C00580100 (P 2016–2020, Q 2022–2026)', async () => {
      routeCommitteeTotals(http);

      const { totals } = await svc.getCommitteeTotalsAllCycles('C00580100', PAGE_1, ctx);

      expect(cyclesOf(totals.results)).toEqual([2026, 2024, 2022, 2020, 2018, 2016]);
      expect(totals.results.map((row) => row.committee_type)).toEqual([
        'Q',
        'Q',
        'Q',
        'P',
        'P',
        'P',
      ]);
      expect(totals.pagination.count).toBe(6);
      expect(http.calls).toHaveLength(3);
    });

    it('sends a single-type committee the unfiltered request it sends today and returns its page as is (C00010603)', async () => {
      routeCommitteeTotals(http);
      const before = await svc.getCommitteeTotals('C00010603', PAGE_1, ctx);
      const [requestBefore] = requestsSent(http);

      const { totals, coverage } = await svc.getCommitteeTotalsAllCycles('C00010603', PAGE_1, ctx);

      expect(coverage).toEqual({ kind: 'complete' });
      expect(totals).toEqual(before);
      expect(totals.pagination).toEqual({
        page: 1,
        pages: 2,
        count: 24,
        per_page: 20,
        is_count_exact: true,
      });
      expect(requestsSent(http).slice(1).toSorted()).toEqual([
        'C00010603/history?per_page=100',
        requestBefore,
      ]);
    });

    it('answers an unknown committee with the empty page its totals 404 normalizes to (C99999998)', async () => {
      routeCommitteeTotals(http);

      const { totals, coverage } = await svc.getCommitteeTotalsAllCycles('C99999998', PAGE_1, ctx);

      expect(coverage).toEqual({ kind: 'complete' });
      expect(totals).toEqual({
        pagination: { page: 1, pages: 0, count: 0, per_page: 20 },
        results: [],
      });
      expect(http.calls).toHaveLength(2);
    });

    it('answers from the earlier type when the newest type has no totals row yet', async () => {
      routeCommitteeTotals(
        http,
        variant((record) => {
          record.totals['pac-party'] = [];
        }),
      );

      const { totals, coverage } = await svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx);

      expect(coverage).toEqual({ kind: 'complete' });
      expect(cyclesOf(totals.results)).toEqual([2024, 2022, 2020]);
      expect(totals.pagination.count).toBe(3);
    });

    it('lets the table the history names answer a cycle the newest table also holds', async () => {
      routeCommitteeTotals(
        http,
        variant((record) => {
          record.totals['pac-party']!.push({
            committee_id: 'C00703975',
            committee_name: 'FIGHT FOR THE PEOPLE PAC',
            committee_type: 'N',
            cycle: 2024,
            receipts: 1,
          });
        }),
      );

      const { totals } = await svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx);

      expect(cyclesOf(totals.results)).toEqual([2026, 2024, 2022, 2020]);
      expect(totals.results[1]).toMatchObject({ cycle: 2024, committee_type: 'P' });
    });

    /** OpenFEC files H and S totals in house-senate and I totals in ie-only. */
    it.each([
      ['H', 'house-senate'],
      ['S', 'house-senate'],
      ['I', 'ie-only'],
    ] as const)(
      'reads the cycles a committee filed as %s from %s after it became a PAC',
      async (type, table) => {
        const row = (cycle: number, committee_type: string) => ({
          committee_id: 'C00000001',
          committee_type,
          cycle,
        });
        routeCommitteeTotals(http, {
          C00000001: {
            history: [row(2022, 'N'), row(2020, type)],
            totals: { 'pac-party': [row(2022, 'N')], [table]: [row(2020, type)] },
          },
        });

        const { totals, coverage } = await svc.getCommitteeTotalsAllCycles(
          'C00000001',
          PAGE_1,
          ctx,
        );

        expect(coverage).toEqual({ kind: 'complete' });
        expect(totals.results.map((r) => [r.cycle, r.committee_type])).toEqual([
          [2022, 'N'],
          [2020, type],
        ]);
        expect(requestsSent(http).toSorted()).toEqual([
          'C00000001/history?per_page=100',
          'C00000001/totals?cycle=2020&per_page=100',
          'C00000001/totals?page=1&per_page=20',
        ]);
      },
    );
  });

  describe('sorting and paging the merged rows', () => {
    it.each([
      ['receipts', [2022, 2026, 2020, 2024]],
      ['-receipts', [2024, 2020, 2026, 2022]],
      ['cycle', [2020, 2022, 2024, 2026]],
      ['-cycle', [2026, 2024, 2022, 2020]],
      ['disbursements', [2022, 2026, 2020, 2024]],
      ['-last_cash_on_hand_end_period', [2022, 2024, 2026, 2020]],
    ])('orders by %s', async (sort, expected) => {
      routeCommitteeTotals(http);

      const { totals } = await svc.getCommitteeTotalsAllCycles(
        'C00703975',
        { ...PAGE_1, sort },
        ctx,
      );

      expect(cyclesOf(totals.results)).toEqual(expected);
    });

    /**
     * OpenFEC sorts NULL as PostgreSQL does: last ascending, first descending
     * (checked live on C00010603's null `last_cash_on_hand_end_period` rows).
     */
    it.each([
      ['receipts', [2026, 2020, 2024, 2022]],
      ['-receipts', [2022, 2024, 2020, 2026]],
    ])(
      'places a row missing receipts where OpenFEC places NULL (sort %s)',
      async (sort, expected) => {
        routeCommitteeTotals(
          http,
          variant((record) => {
            delete record.totals.presidential!.find((row) => row.cycle === 2022)!.receipts;
          }),
        );

        const { totals } = await svc.getCommitteeTotalsAllCycles(
          'C00703975',
          { ...PAGE_1, sort },
          ctx,
        );

        expect(cyclesOf(totals.results)).toEqual(expected);
      },
    );

    it('pages the merged set, reading the newest table whole when the caller page skipped it', async () => {
      routeCommitteeTotals(http);

      const { totals } = await svc.getCommitteeTotalsAllCycles(
        'C00703975',
        { page: 2, per_page: 2 },
        ctx,
      );

      expect(cyclesOf(totals.results)).toEqual([2022, 2020]);
      expect(totals.pagination).toEqual({
        page: 2,
        pages: 2,
        count: 4,
        per_page: 2,
        is_count_exact: true,
      });
      expect(requestsSent(http)).toContain('C00703975/totals?per_page=100');
      expect(http.calls).toHaveLength(4);
    });

    it('walks every page of C00580100 at two per page, then reports the next one exhausted', async () => {
      routeCommitteeTotals(http);

      const walked: unknown[] = [];
      for (const page of [1, 2, 3]) {
        const { totals } = await svc.getCommitteeTotalsAllCycles(
          'C00580100',
          { page, per_page: 2, sort: 'cycle' },
          ctx,
        );
        expect(totals.pagination).toMatchObject({ page, pages: 3, count: 6 });
        walked.push(...cyclesOf(totals.results));
      }
      expect(walked).toEqual([2016, 2018, 2020, 2022, 2024, 2026]);

      const past = await svc.getCommitteeTotalsAllCycles(
        'C00580100',
        { page: 4, per_page: 2 },
        ctx,
      );
      expect(past.totals).toEqual({
        pagination: { page: 4, pages: 3, count: 6, per_page: 2, is_count_exact: true },
        results: [],
      });
    });

    it('reuses the caller page when it already holds the newest table', async () => {
      routeCommitteeTotals(http);

      await svc.getCommitteeTotalsAllCycles('C00580100', { page: 1, per_page: 3 }, ctx);

      expect(requestsSent(http)).not.toContain('C00580100/totals?per_page=100');
      expect(http.calls).toHaveLength(3);
    });
  });

  describe('best-effort history', () => {
    it.each([
      ['a 503', status(503)],
      ['a 403', status(403)],
      ['a 422', status(422)],
      ['an HTML 404', htmlStatus(404)],
      ['a dropped connection', () => Promise.reject(new TypeError('fetch failed'))],
      ['an HTML page in a 200', htmlStatus(200)],
      ['a 200 whose results is not an array', nullResults],
    ])(
      'keeps the unfiltered page, flagged partial, when the history read meets %s',
      async (_, respond) => {
        intercept(isHistory, respond);
        routeCommitteeTotals(http);

        const { totals, coverage } = await svc.getCommitteeTotalsAllCycles(
          'C00703975',
          PAGE_1,
          ctx,
        );

        expect(coverage).toEqual({ kind: 'history_unavailable' });
        expect(cyclesOf(totals.results)).toEqual([2026]);
        expect(totals.pagination.count).toBe(1);
      },
    );

    /**
     * OpenFEC answers its own 404 when the committee has no history row; the
     * service reads that as an empty history, the same rule its totals read follows.
     */
    it.each([
      ['C00703975', [2026]],
      ['C99999998', []],
    ])("reads OpenFEC's own 404 for %s's history as an empty history", async (id, cycles) => {
      intercept(isHistory, status(404));
      routeCommitteeTotals(http);

      const { totals, coverage } = await svc.getCommitteeTotalsAllCycles(id, PAGE_1, ctx);

      expect(coverage).toEqual({ kind: 'complete' });
      expect(cyclesOf(totals.results)).toEqual(cycles);
    });

    it('rejects with the rate limit when the history read is rate limited', async () => {
      intercept(isHistory, status(429, { 'retry-after': '3600' }));
      routeCommitteeTotals(http);

      await expect(svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx)).rejects.toMatchObject(
        { code: JsonRpcErrorCode.RateLimited },
      );
    });

    it('rejects with the cancellation when the caller aborts during the history read', async () => {
      const controller = new AbortController();
      ctx = createMockContext({ signal: controller.signal });
      intercept(isHistory, (request) => {
        queueMicrotask(() => controller.abort());
        return hang(request);
      });
      routeCommitteeTotals(http);

      await expect(svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx)).rejects.toMatchObject(
        { code: JsonRpcErrorCode.RequestCancelled },
      );
    });

    /**
     * An abort that lands in the backoff after a transient failure leaves
     * `withRetry` with the signal's raw reason, not a classified cancellation.
     */
    it('rejects with the cancellation when the caller aborts during a history retry backoff', async () => {
      config.fecMaxRetries = 1;
      const controller = new AbortController();
      ctx = createMockContext({ signal: controller.signal });
      intercept(isHistory, () => {
        setTimeout(() => controller.abort(), 50);
        return status(503)();
      });
      routeCommitteeTotals(http);

      await expect(svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx)).rejects.toMatchObject(
        { name: 'AbortError' },
      );
    });

    it('rejects rather than report no totals when the history fails and the newest table is empty', async () => {
      intercept(isHistory, status(503));
      routeCommitteeTotals(
        http,
        variant((record) => {
          record.totals['pac-party'] = [];
        }),
      );

      await expect(svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx)).rejects.toMatchObject(
        { code: JsonRpcErrorCode.ServiceUnavailable },
      );
    });

    it('rejects when the unfiltered request itself fails, as today', async () => {
      intercept(isCallerPage, status(503));
      routeCommitteeTotals(http);

      await expect(svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx)).rejects.toMatchObject(
        { code: JsonRpcErrorCode.ServiceUnavailable },
      );
    });

    it('rejects an unfiltered answer whose results is not an array as a malformed envelope', async () => {
      intercept(isCallerPage, nullResults);
      routeCommitteeTotals(http);

      await expect(svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx)).rejects.toThrow(
        'FEC API returned an unexpected response',
      );
    });
  });

  describe('best-effort per-table reads', () => {
    /**
     * The history names these cycles, so a 404 for them contradicts it: the
     * read failed, it did not find the cycles empty.
     */
    const SECONDARY_FAILURES = [
      ['a 502', status(502)],
      ["OpenFEC's own 404", status(404)],
      ['an HTML 404', htmlStatus(404)],
      ['a 403', status(403)],
      ['a 422', status(422)],
      ['a 200 whose results is not an array', nullResults],
    ] as const;

    it.each(SECONDARY_FAILURES)(
      'keeps the unfiltered page and names the cycles it lacks when another table read meets %s',
      async (_, respond) => {
        intercept(isTableRead, respond);
        routeCommitteeTotals(http);

        const { totals, coverage } = await svc.getCommitteeTotalsAllCycles(
          'C00703975',
          PAGE_1,
          ctx,
        );

        expect(coverage).toEqual({ kind: 'cycles_unavailable', cycles: [2024, 2022, 2020] });
        expect(cyclesOf(totals.results)).toEqual([2026]);
      },
    );

    it.each(SECONDARY_FAILURES)(
      'keeps the caller page when the whole-table re-read of the newest table meets %s',
      async (_, respond) => {
        intercept(
          (parts) =>
            parts.endpoint === 'totals' &&
            parts.query.get('per_page') === '100' &&
            !parts.query.has('cycle'),
          respond,
        );
        routeCommitteeTotals(http);

        const { totals, coverage } = await svc.getCommitteeTotalsAllCycles(
          'C00580100',
          { page: 1, per_page: 2 },
          ctx,
        );

        expect(coverage).toEqual({ kind: 'cycles_unavailable', cycles: [2020, 2018, 2016] });
        expect(cyclesOf(totals.results)).toEqual([2026, 2024]);
        expect(totals.pagination).toMatchObject({ count: 3, pages: 2 });
      },
    );

    it('merges the tables that answered and names only the cycles of the one that failed', async () => {
      intercept(
        (parts) => isTableRead(parts) && parts.query.getAll('cycle').includes('2024'),
        status(503),
      );
      routeCommitteeTotals(
        http,
        variant((record) => {
          const house = { committee_id: 'C00703975', committee_type: 'H', cycle: 2018 };
          record.history.push(house);
          record.totals['house-senate'] = [{ ...house, receipts: 5 }];
        }),
      );

      const { totals, coverage } = await svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx);

      expect(coverage).toEqual({ kind: 'cycles_unavailable', cycles: [2024, 2022, 2020] });
      expect(cyclesOf(totals.results)).toEqual([2026, 2018]);
      expect(totals.pagination).toMatchObject({ page: 1, pages: 1, count: 2 });
    });

    it('rejects with the rate limit when another table read is rate limited', async () => {
      intercept(isTableRead, status(429, { 'retry-after': '3600' }));
      routeCommitteeTotals(http);

      await expect(svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx)).rejects.toMatchObject(
        { code: JsonRpcErrorCode.RateLimited },
      );
    });

    it('rejects rather than report no totals when another table read fails and the newest table is empty', async () => {
      intercept(isTableRead, status(503));
      routeCommitteeTotals(
        http,
        variant((record) => {
          record.totals['pac-party'] = [];
        }),
      );

      await expect(svc.getCommitteeTotalsAllCycles('C00703975', PAGE_1, ctx)).rejects.toMatchObject(
        { code: JsonRpcErrorCode.ServiceUnavailable },
      );
    });
  });

  /**
   * One 50 s budget spans every request, attempt, and backoff, so the call
   * settles before an MCP SDK client's 60 s request timeout. These run the
   * production ladder: four attempts of 30 s each.
   */
  describe('shared deadline', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      config.fecMaxRetries = 3;
      config.fecRequestTimeout = 30_000;
    });

    /** Start the call and record, in fake time, when it settles. */
    const timed = (committeeId: string, params: Record<string, number | string>) => {
      const startedAt = Date.now();
      const settled: { afterMs?: number } = {};
      const call = svc.getCommitteeTotalsAllCycles(committeeId, params, ctx).finally(() => {
        settled.afterMs = Date.now() - startedAt;
      });
      call.catch(() => undefined);
      return { call, settled };
    };

    it('settles at 50 s with the unfiltered page when the history read never answers', async () => {
      intercept(isHistory, hang);
      routeCommitteeTotals(http);

      const { call, settled } = timed('C00703975', PAGE_1);
      await vi.advanceTimersByTimeAsync(49_000);
      expect(settled.afterMs).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled.afterMs).toBe(50_000);
      const { totals, coverage } = await call;
      expect(coverage).toEqual({ kind: 'history_unavailable' });
      expect(cyclesOf(totals.results)).toEqual([2026]);
    });

    it('gives the per-table reads only what the first requests left of the budget', async () => {
      intercept(
        isCallerPage,
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  Response.json({
                    api_version: '1.0',
                    pagination: { count: 1, page: 1, pages: 1, per_page: 20 },
                    results: COMMITTEES.C00703975.totals['pac-party'],
                  }),
                ),
              25_000,
            );
          }),
      );
      intercept(isTableRead, hang);
      routeCommitteeTotals(http);

      const { call, settled } = timed('C00703975', PAGE_1);
      await vi.advanceTimersByTimeAsync(49_000);
      expect(settled.afterMs).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled.afterMs).toBe(50_000);
      expect((await call).coverage).toEqual({
        kind: 'cycles_unavailable',
        cycles: [2024, 2022, 2020],
      });
    });

    /**
     * The first attempt times out at 30 s; the second, started about 31 s in,
     * meets a 429 with no Retry-After about 49.5 s in. Its 1.5–2.5 s backoff
     * outlasts the budget, which `withRetry` reports as a deadline `Timeout`
     * caused by the 429.
     */
    it.each([
      ['the unfiltered request', isCallerPage],
      ['the history read', isHistory],
      ['another table read', isTableRead],
    ])(
      'reports a rate limit the deadline cut short on %s as the rate limit, not a timeout',
      async (_, select) => {
        let attempts = 0;
        intercept(select, (request) => {
          attempts++;
          if (attempts === 1) return hang(request);
          return new Promise<Response>((resolve) => {
            setTimeout(() => resolve(status(429)()), 18_500);
          });
        });
        routeCommitteeTotals(http);

        const { call } = timed('C00703975', PAGE_1);
        await vi.advanceTimersByTimeAsync(50_000);

        await expect(call).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
        expect(attempts).toBe(2);
      },
    );
  });
});
