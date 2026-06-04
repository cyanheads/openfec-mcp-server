/**
 * @fileoverview Security and error-sanitization tests for the OpenFEC service.
 * Verifies that API keys are never leaked in error messages or tool output,
 * HTTP status codes produce actionable hints, and error messages stay clean.
 * @module tests/services/openfec/openfec-service-security.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    fecApiKey: 'SUPER_SECRET_API_KEY_XYZ',
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
      await svc.searchContributions({}, ctx);
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
