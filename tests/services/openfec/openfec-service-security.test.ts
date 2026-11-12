/**
 * @fileoverview Security and error-sanitization tests for the OpenFEC service.
 * Verifies that API keys are never leaked in error messages or tool output,
 * HTTP status codes produce actionable hints, and error messages stay clean.
 * @module tests/services/openfec/openfec-service-security.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  fecApiKey: 'SUPER_SECRET_API_KEY_XYZ',
  fecBaseUrl: 'https://api.open.fec.gov/v1',
  fecMaxRetries: 0,
  fecRequestTimeout: 5000,
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { type CursorQuery, OpenFecService } from '@/services/openfec/openfec-service.js';

/** Query identity for the keyset (SEEK) call exercised below. */
const QUERY: CursorQuery = { scope: 'openfec_search_contributions', args: {} };

const mockFetch = vi.mocked(fetchWithTimeout);

describe('API key security', () => {
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

  it('does not expose the API key in fetch errors', async () => {
    mockFetch.mockRejectedValueOnce(
      new Error(
        'Request failed: https://api.open.fec.gov/v1/candidates/?api_key=SUPER_SECRET_API_KEY_XYZ&q=test Status: 403',
      ),
    );

    let caught: Error | undefined;
    try {
      await svc.searchCandidates({ q: 'test' }, ctx);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain('SUPER_SECRET_API_KEY_XYZ');
    expect(caught!.message).toContain('REDACTED');
  });

  it('does not expose the API key when the URL appears in error context', async () => {
    mockFetch.mockRejectedValueOnce(
      new Error('ECONNRESET: api_key=SUPER_SECRET_API_KEY_XYZ failed'),
    );

    let caught: Error | undefined;
    try {
      await svc.searchCommittees({ q: 'test' }, ctx);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain('SUPER_SECRET_API_KEY_XYZ');
  });

  it('preserves original error as cause while sanitizing the wrapper', async () => {
    const original = new Error('Connection refused: api_key=SUPER_SECRET_API_KEY_XYZ');
    mockFetch.mockRejectedValueOnce(original);

    let caught: Error | undefined;
    try {
      await svc.searchCandidates({}, ctx);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    // The wrapper message is sanitized
    expect(caught!.message).not.toContain('SUPER_SECRET_API_KEY_XYZ');
    // The cause is set but the rethrown error is a new Error instance
    expect(caught!.cause).toBe(original);
  });

  it('redacts multiple occurrences of the API key in a single message', async () => {
    mockFetch.mockRejectedValueOnce(
      new Error('api_key=SUPER_SECRET_API_KEY_XYZ and also api_key=SUPER_SECRET_API_KEY_XYZ again'),
    );

    let caught: Error | undefined;
    try {
      await svc.searchCandidates({}, ctx);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught!.message.indexOf('SUPER_SECRET_API_KEY_XYZ')).toBe(-1);
  });
});

describe('HTTP status error hints', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  const statusCases: [number, string][] = [
    [400, 'Bad request'],
    [403, 'API key'],
    [404, 'Endpoint not found'],
    [422, 'rejected the request parameters'],
    [429, 'rate limit'],
    [500, 'internal error'],
    [502, 'temporarily unreachable'],
    [503, 'temporarily unavailable'],
    [504, 'timed out running this query'],
  ];

  for (const [status, hint] of statusCases) {
    it(`enriches ${status} errors with an actionable hint`, async () => {
      mockFetch.mockRejectedValueOnce(new Error(`Status: ${status}`));

      let caught: Error | undefined;
      try {
        await svc.searchCandidates({}, ctx);
      } catch (e) {
        caught = e as Error;
      }

      expect(caught).toBeDefined();
      expect(caught!.message.toLowerCase()).toContain(hint.toLowerCase());
    });
  }

  it('passes through error messages without status codes unchanged (except sanitization)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed: unexpected EOF'));

    let caught: Error | undefined;
    try {
      await svc.searchCandidates({}, ctx);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain('fetch failed');
  });
});

describe('429 hint: the wait OpenFEC named, and key advice on DEMO_KEY', () => {
  const PERSONAL_KEY = config.fecApiKey;
  const DEMO_KEY_ADVICE =
    ' This server is using DEMO_KEY, whose small daily allowance is shared by every caller on this IP; setting FEC_API_KEY to a personal key (free at https://api.data.gov/signup/) lifts the shared limit.';
  const NO_RESET =
    'FEC API rate limit exceeded. OpenFEC gave no reset time, so the wait is unknown.';
  const waited = (wait: string) =>
    `FEC API rate limit exceeded. OpenFEC asked to wait ${wait} before the next request.`;

  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    config.fecApiKey = PERSONAL_KEY;
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
    mockFetch.mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    config.fecApiKey = PERSONAL_KEY;
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  /** A 429 as `fetchWithTimeout` builds it, carrying the raw `Retry-After` when given. */
  const rateLimited = (data: Record<string, unknown> = {}, status = 'Status: 429') =>
    new McpError(
      JsonRpcErrorCode.RateLimited,
      `Fetch failed for https://api.open.fec.gov/…?…. ${status}`,
      { status: 429, statusCode: 429, ...data },
    );

  /** What `searchCandidates` rejects with when the fetch throws `err`. */
  async function rejection(err: Error): Promise<McpError> {
    mockFetch.mockRejectedValueOnce(err);
    try {
      await svc.searchCandidates({}, ctx);
    } catch (e) {
      return e as McpError;
    }
    throw new Error('expected the call to reject');
  }

  const waits: [label: string, retryAfter: unknown, wait: string][] = [
    ['46840 s (an exhausted daily key)', '46840', 'about 13 hours'],
    ['0 s', '0', '0 seconds'],
    ['1 s', '1', '1 second'],
    ['59 s', '59', '59 seconds'],
    ['60 s', '60', 'about 1 minute'],
    ['89 s', '89', 'about 1 minute'],
    ['90 s', '90', 'about 2 minutes'],
    ['3569 s', '3569', 'about 59 minutes'],
    ['3570 s, which rounds to the hour', '3570', 'about 1 hour'],
    ['5400 s', '5400', 'about 2 hours'],
    ['a padded value', ' 120 ', 'about 2 minutes'],
    ['a numeric value, read as seconds', 60, 'about 1 minute'],
  ];

  it.each(waits)('names the wait for Retry-After %s', async (_label, retryAfter, wait) => {
    const err = await rejection(rateLimited({ retryAfter }));

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.message.endsWith(`Status: 429 — ${waited(wait)}`)).toBe(true);
    expect(err.message).not.toContain('a moment');
  });

  it('reads an HTTP-date Retry-After as the time from now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T10:59:20Z'));

    const err = await rejection(rateLimited({ retryAfter: 'Fri, 13 Nov 2026 00:00:00 GMT' }));

    expect(err.message.endsWith(` — ${waited('about 13 hours')}`)).toBe(true);
  });

  it('reads an HTTP-date already past as no wait', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T10:59:20Z'));

    const err = await rejection(rateLimited({ retryAfter: 'Thu, 12 Nov 2026 10:00:00 GMT' }));

    expect(err.message.endsWith(` — ${waited('0 seconds')}`)).toBe(true);
  });

  it.each([
    ['absent', {}],
    ['unparseable', { retryAfter: 'soon' }],
    ['empty', { retryAfter: '' }],
    ['negative', { retryAfter: -5 }],
  ])('says OpenFEC gave no reset time when Retry-After is %s', async (_label, data) => {
    const err = await rejection(rateLimited(data));

    expect(err.message.endsWith(`Status: 429 — ${NO_RESET}`)).toBe(true);
    expect(err.message).not.toContain('a moment');
  });

  it('keeps the exhausted-retries suffix ahead of the hint', async () => {
    const err = await rejection(
      rateLimited({ retryAfter: '2', retryAttempts: 4 }, 'Status: 429 (failed after 4 attempts)'),
    );

    expect(
      err.message.endsWith(`Status: 429 (failed after 4 attempts) — ${waited('2 seconds')}`),
    ).toBe(true);
  });

  it('passes data.retryAfter through unchanged', async () => {
    const err = await rejection(rateLimited({ retryAfter: '46840' }));

    expect(err.data?.retryAfter).toBe('46840');
  });

  it('gives no key advice on a personal key', async () => {
    const err = await rejection(rateLimited({ retryAfter: '46840' }));

    expect(err.message).not.toContain('FEC_API_KEY');
    expect(err.message).not.toContain('DEMO_KEY');
  });

  it('points DEMO_KEY at a personal FEC_API_KEY after the wait', async () => {
    config.fecApiKey = 'DEMO_KEY';

    const err = await rejection(rateLimited({ retryAfter: '46840' }));

    expect(err.message.endsWith(` — ${waited('about 13 hours')}${DEMO_KEY_ADVICE}`)).toBe(true);
    expect(err.message).not.toContain('api_key=');
  });

  it('points DEMO_KEY at a personal FEC_API_KEY when no reset time came back', async () => {
    config.fecApiKey = 'DEMO_KEY';

    const err = await rejection(rateLimited());

    expect(err.message.endsWith(` — ${NO_RESET}${DEMO_KEY_ADVICE}`)).toBe(true);
  });

  it('advises a plain Error 429 the same way, with no wait to name', async () => {
    config.fecApiKey = 'DEMO_KEY';

    const err = await rejection(new Error('Request failed: Status: 429'));

    expect(err).not.toBeInstanceOf(McpError);
    expect(err.message.endsWith(` — ${NO_RESET}${DEMO_KEY_ADVICE}`)).toBe(true);
  });

  it.each([
    ['fetchPage', (s: OpenFecService) => s.searchCandidates({}, ctx)],
    ['fetchSeek', (s: OpenFecService) => s.searchContributions({}, QUERY, ctx)],
    ['fetchLegalSearch', (s: OpenFecService) => s.searchLegal({}, ctx)],
    ['getElectionSummary', (s: OpenFecService) => s.getElectionSummary({}, ctx)],
    ['getLegalDocument', (s: OpenFecService) => s.getLegalDocument('murs', '1', ctx)],
  ])('%s rethrows a 429 with the wait and the key advice', async (_site, call) => {
    config.fecApiKey = 'DEMO_KEY';
    mockFetch.mockRejectedValueOnce(rateLimited({ retryAfter: '46840' }));

    await expect(call(svc)).rejects.toThrow(`— ${waited('about 13 hours')}${DEMO_KEY_ADVICE}`);
  });
});

describe('envelope validation', () => {
  let svc: OpenFecService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new OpenFecService();
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  it('throws on array response (not an object)', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve([1, 2, 3]) } as never);
    await expect(svc.searchCandidates({}, ctx)).rejects.toThrow('unexpected response');
  });

  it('throws on string response', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve('<html>503 Service Unavailable</html>'),
    } as never);
    await expect(svc.searchCandidates({}, ctx)).rejects.toThrow('unexpected response');
  });

  it('throws on response missing results key', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ pagination: { count: 0 } }),
    } as never);
    await expect(svc.searchCandidates({}, ctx)).rejects.toThrow('unexpected response');
  });

  it('getElectionSummary throws when count field is missing', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ receipts: 100 }),
    } as never);
    await expect(svc.getElectionSummary({ office: 'president', cycle: 2024 }, ctx)).rejects.toThrow(
      'unexpected response',
    );
  });
});

describe('rethrowSanitized — McpError preservation', () => {
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

  it('preserves McpError code when fetchWithTimeout throws a McpError', async () => {
    const mcpErr = new McpError(JsonRpcErrorCode.NotFound, 'Status: 404 Not Found', {
      statusCode: 404,
    });
    mockFetch.mockRejectedValueOnce(mcpErr);

    let caught: unknown;
    try {
      await svc.searchCandidates({}, ctx);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('preserves McpError data when fetchWithTimeout throws a McpError', async () => {
    const data = { statusCode: 429, retryAfter: 60 };
    const mcpErr = new McpError(
      JsonRpcErrorCode.RateLimited,
      'Status: 429 Too Many Requests',
      data,
    );
    mockFetch.mockRejectedValueOnce(mcpErr);

    let caught: unknown;
    try {
      await svc.searchCandidates({}, ctx);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
    expect((caught as McpError).data).toMatchObject({ statusCode: 429, retryAfter: 60 });
  });

  it('enriches McpError message with status hint while preserving the code (422 → ValidationError)', async () => {
    const mcpErr = new McpError(
      JsonRpcErrorCode.ValidationError,
      'Fetch failed for https://api.open.fec.gov/v1/schedules/schedule_a/. Status: 422 Unprocessable Entity',
      { statusCode: 422 },
    );
    mockFetch.mockRejectedValueOnce(mcpErr);

    let caught: unknown;
    try {
      await svc.searchContributions({}, QUERY, ctx);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect((caught as McpError).message).toContain('rejected the request parameters');
  });

  it('sets the original McpError as cause', async () => {
    const mcpErr = new McpError(JsonRpcErrorCode.NotFound, 'Status: 404 Not Found');
    mockFetch.mockRejectedValueOnce(mcpErr);

    let caught: unknown;
    try {
      await svc.searchCandidates({}, ctx);
    } catch (e) {
      caught = e;
    }

    expect((caught as McpError).cause).toBe(mcpErr);
  });

  it('sanitizes api_key in McpError message', async () => {
    const mcpErr = new McpError(
      JsonRpcErrorCode.Forbidden,
      'Fetch failed: api_key=SUPER_SECRET_API_KEY_XYZ Status: 403 Forbidden',
    );
    mockFetch.mockRejectedValueOnce(mcpErr);

    let caught: unknown;
    try {
      await svc.searchCandidates({}, ctx);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).message).not.toContain('SUPER_SECRET_API_KEY_XYZ');
    expect((caught as McpError).message).toContain('REDACTED');
  });
});
