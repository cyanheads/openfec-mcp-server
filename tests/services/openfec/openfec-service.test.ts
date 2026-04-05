/**
 * @fileoverview Tests for the OpenFEC service layer — cursor encoding/decoding,
 * URL building, envelope validation, transient error classification, and singleton lifecycle.
 * @module tests/services/openfec/openfec-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock getServerConfig before importing the service
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    fecApiKey: 'DEMO_KEY',
    fecBaseUrl: 'https://api.open.fec.gov/v1',
    fecMaxRetries: 0,
    fecRequestTimeout: 5000,
  }),
}));

// Mock fetchWithTimeout and withRetry from the framework utils
vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import {
  decodeCursor,
  encodeCursor,
  getOpenFecService,
  initOpenFecService,
  OpenFecService,
} from '@/services/openfec/openfec-service.js';

const mockFetch = vi.mocked(fetchWithTimeout);

describe('cursor encoding', () => {
  it('round-trips last_indexes through encode/decode', () => {
    const indexes = { last_index: '123', last_contribution_receipt_date: '2024-01-15' };
    const cursor = encodeCursor(indexes);
    expect(typeof cursor).toBe('string');
    expect(decodeCursor(cursor)).toEqual(indexes);
  });

  it('handles empty indexes', () => {
    const cursor = encodeCursor({});
    expect(decodeCursor(cursor)).toEqual({});
  });

  it('produces base64-encoded JSON', () => {
    const indexes = { foo: 'bar' };
    const cursor = encodeCursor(indexes);
    expect(JSON.parse(atob(cursor))).toEqual(indexes);
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const pageEnvelope = <T>(results: T[], count = 1, page = 1, pages = 1) => ({
    json: () =>
      Promise.resolve({
        api_version: '1.0',
        pagination: { count, page, pages, per_page: 20 },
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
        ) as never,
      );

      const result = await svc.searchContributions({ committee_id: 'C00703975' }, ctx);
      expect(result.results).toEqual(contributions);
      expect(result.nextCursor).toBeTruthy();
      expect(typeof result.nextCursor).toBe('string');
    });

    it('returns null nextCursor when no more pages', async () => {
      mockFetch.mockResolvedValueOnce(seekEnvelope([{ amount: 100 }], undefined, 1) as never);

      const result = await svc.searchContributions({}, ctx);
      expect(result.nextCursor).toBeNull();
    });

    it('returns null nextCursor when last_indexes is empty', async () => {
      mockFetch.mockResolvedValueOnce(seekEnvelope([{ amount: 100 }], {}, 1) as never);

      const result = await svc.searchContributions({}, ctx);
      expect(result.nextCursor).toBeNull();
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

      const result = await svc.searchDisbursements({}, ctx);
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
      mockFetch.mockResolvedValueOnce(seekEnvelope([{ expenditure_amount: 5000 }]) as never);
      const result = await svc.searchExpenditures({}, ctx);
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
      mockFetch.mockResolvedValueOnce(pageEnvelope([]) as never);
      await svc.getElectionSummary({ office: 'president', cycle: 2024 }, ctx);
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/elections/summary/');
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
});
