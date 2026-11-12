/**
 * @fileoverview Upstream HTTP failures through the real framework fetch path.
 * Only the network boundary is faked (`createFetchMock` installed as the global
 * `fetch`): `fetchWithTimeout` builds the status-mapped `McpError`, `withRetry`
 * decides whether to retry, and the service rethrows what comes back. The other
 * service tests stub `fetchWithTimeout` with hand-written messages, so they
 * cannot see a drift in the message format the status hint is read from, or in
 * which captured error body the framework lets reach the client.
 * @module tests/services/openfec/openfec-service-http-errors.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  fecApiKey: 'SUPER_SECRET_API_KEY_XYZ',
  fecBaseUrl: 'https://api.open.fec.gov/v1',
  fecMaxRetries: 0,
  fecRequestTimeout: 5000,
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));

import { searchCandidates } from '@/mcp-server/tools/definitions/search-candidates.tool.js';
import { initOpenFecService, OpenFecService } from '@/services/openfec/openfec-service.js';
import { FEC_404 } from './committee-totals-upstream.js';

/** OpenFEC's own JSON 422 error object, verbatim from the live API. */
const FEC_422 =
  '{"message":{"query":{"office":{"0":["Must be one of: , H, S, P."]}}},"status":422}';

/** The api.data.gov edge answers key failures with a JSON object of its own. */
const EDGE_403 =
  '{\n  "error": {\n    "code": "API_KEY_INVALID",\n    "message": "An invalid api_key was supplied. Get one at https://api.data.gov/signup/"\n  }\n}';

/** A path the API does not route answers with an HTML page. */
const HTML_404 =
  '<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>404 Not Found: The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n';

/** A gateway outage page in plain text. */
const TEXT_503 =
  'upstream connect error or disconnect/reset before headers. reset reason: overflow';

/** The api.data.gov edge's answer to an exhausted key, verbatim from a live DEMO_KEY 429. */
const EDGE_429 =
  '{"error":{"code":"OVER_RATE_LIMIT","message":"You have exceeded your rate limit of 40 calls per hour for the DEMO_KEY, 1000 calls per hour for a personal key, or 120 calls per minute for an upgraded key. You can either try again later, sign up for a personal key at https://api.data.gov/signup/, or email apiinfo@fec.gov to upgrade your key."}}';

/** The 429 hint's parts, as the service words them. */
const NO_RESET = 'FEC API rate limit exceeded. OpenFEC gave no reset time, so the wait is unknown.';
const waited = (wait: string) =>
  `FEC API rate limit exceeded. OpenFEC asked to wait ${wait} before the next request.`;
const DEMO_KEY_ADVICE =
  ' This server is using DEMO_KEY, whose small daily allowance is shared by every caller on this IP; setting FEC_API_KEY to a personal key (free at https://api.data.gov/signup/) lifts the shared limit.';

const PERSONAL_KEY = config.fecApiKey;

const FEC_ORIGIN = /^https:\/\/api\.open\.fec\.gov\/v1\//;

/** An upstream answer with the content type its body implies. */
const answer = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: {
      'content-type': body.startsWith('{') ? 'application/json' : 'text/html; charset=utf-8',
      ...headers,
    },
  });

/** Route every OpenFEC request to the given answers, one per request, the last repeating. */
const upstreamAnswers = (http: FetchMockHarness, ...answers: Array<() => Response>) => {
  let served = 0;
  http.route({
    match: FEC_ORIGIN,
    respond: () => {
      const next = answers[Math.min(served, answers.length - 1)]!;
      served++;
      return next();
    },
  });
};

/** The rejection a service call settles with. */
async function rejection(run: () => Promise<unknown>): Promise<McpError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }
  throw new Error('expected the call to reject');
}

interface WireFailure {
  code: number;
  data?: Record<string, unknown>;
  message: string;
}

/** The two client surfaces of a failed tool call. */
const surfaces = (result: { content: unknown; structuredContent?: unknown }) => {
  const [block] = result.content as ContentBlock[];
  if (block?.type !== 'text') throw new Error('no text block');
  return {
    text: block.text,
    error: (result.structuredContent as { error: WireFailure }).error,
  };
};

let http: FetchMockHarness;

beforeEach(() => {
  config.fecApiKey = PERSONAL_KEY;
  config.fecMaxRetries = 0;
  config.fecRequestTimeout = 5000;
  initOpenFecService();
  http = createFetchMock();
  http.install();
});

afterEach(() => {
  http.restore();
  vi.useRealTimers();
});

describe('status hints on errors fetchWithTimeout builds', () => {
  const cases: Array<[status: number, code: JsonRpcErrorCode, hint: string]> = [
    [400, JsonRpcErrorCode.InvalidParams, 'Bad request — check parameter names and types.'],
    [403, JsonRpcErrorCode.Forbidden, 'Forbidden — the API key may be invalid or expired.'],
    [404, JsonRpcErrorCode.NotFound, 'Endpoint not found — verify the API path.'],
    [
      422,
      JsonRpcErrorCode.ValidationError,
      'The FEC API rejected the request parameters. Check required fields and value formats for this endpoint.',
    ],
    [429, JsonRpcErrorCode.RateLimited, NO_RESET],
    [500, JsonRpcErrorCode.ServiceUnavailable, 'FEC API internal error. Retry shortly.'],
    [
      502,
      JsonRpcErrorCode.ServiceUnavailable,
      'FEC API is temporarily unreachable. Retry shortly.',
    ],
    [
      503,
      JsonRpcErrorCode.ServiceUnavailable,
      'FEC API is temporarily unavailable. Retry shortly.',
    ],
    [
      504,
      JsonRpcErrorCode.Timeout,
      'The FEC API timed out running this query. Narrow it — supply cycle, a committee_id or candidate_id, or a tighter date range — then retry.',
    ],
  ];

  it.each(cases)('HTTP %i keeps its code and ends with its hint', async (status, code, hint) => {
    upstreamAnswers(http, () =>
      answer(status, `{"message":"upstream ${status}","status":${status}}`),
    );

    const err = await rejection(() =>
      new OpenFecService().searchCandidates({}, createMockContext()),
    );

    expect(err.code).toBe(code);
    expect(err.message).toMatch(new RegExp(`Status: ${status}\\b`));
    expect(err.message.endsWith(` — ${hint}`)).toBe(true);
    expect(err.message).not.toContain(config.fecApiKey);
    expect(err.data).toMatchObject({ status });
  });

  it('keeps the hint when retries run out on a transient status', async () => {
    config.fecMaxRetries = 1;
    upstreamAnswers(http, () => answer(503, TEXT_503, { 'retry-after': '0' }));

    const err = await rejection(() =>
      new OpenFecService().searchCandidates({}, createMockContext()),
    );

    expect(http.calls).toHaveLength(2);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toContain('Status: 503 (failed after 2 attempts)');
    expect(err.message.endsWith(' — FEC API is temporarily unavailable. Retry shortly.')).toBe(
      true,
    );
  });
});

describe("OpenFEC's own 404 reads as no record", () => {
  it('committee totals resolve to an empty page', async () => {
    upstreamAnswers(http, () => answer(404, FEC_404));

    const page = await new OpenFecService().getCommitteeTotals(
      'C00000000',
      { cycle: 2024, per_page: 20 },
      createMockContext(),
    );

    expect(page).toEqual({
      pagination: { page: 1, pages: 0, count: 0, per_page: 20 },
      results: [],
    });
  });

  it('a legal document resolves to null', async () => {
    upstreamAnswers(http, () => answer(404, FEC_404));

    await expect(
      new OpenFecService().getLegalDocument('murs', '999999', createMockContext()),
    ).resolves.toBeNull();
  });

  it('an HTML 404 stays a failure for committee totals', async () => {
    upstreamAnswers(http, () => answer(404, HTML_404));

    const err = await rejection(() =>
      new OpenFecService().getCommitteeTotals('C00000000', {}, createMockContext()),
    );

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message.endsWith(' — Endpoint not found — verify the API path.')).toBe(true);
  });

  it('an HTML 404 stays a failure for a legal document', async () => {
    upstreamAnswers(http, () => answer(404, HTML_404));

    const err = await rejection(() =>
      new OpenFecService().getLegalDocument('murs', '999999', createMockContext()),
    );

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
  });
});

describe('what a caller receives for an upstream failure', () => {
  it("carries OpenFEC's JSON 422 body, which names the rejected parameter", async () => {
    upstreamAnswers(http, () => answer(422, FEC_422));

    const { text, error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ status: 422, body: FEC_422, responseBody: FEC_422 });
    expect(text).toContain('rejected the request parameters');
  });

  it("carries api.data.gov's JSON 403 body", async () => {
    upstreamAnswers(http, () => answer(403, EDGE_403));

    const { error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.data).toMatchObject({ status: 403, body: EDGE_403 });
  });

  it.each([
    ['an HTML 404 page', 404, HTML_404],
    ['a plain-text 503 page', 503, TEXT_503],
  ])('keeps %s off both surfaces', async (_label, status, page) => {
    upstreamAnswers(http, () => answer(status, page));

    const { text, error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    expect(error.data).toMatchObject({ status });
    expect(error.data).not.toHaveProperty('body');
    expect(error.data).not.toHaveProperty('responseBody');
    for (const surface of [text, JSON.stringify(error)]) {
      expect(surface).not.toContain('<html');
      expect(surface).not.toContain('<title>');
      expect(surface).not.toContain('reset reason');
    }
  });

  it.each([
    ['an HTML page', HTML_404],
    ['JSON without a results array', '{"results":null,"pagination":{}}'],
  ])('reads %s served with 200 as an upstream outage, retried', async (_label, page) => {
    config.fecMaxRetries = 1;
    upstreamAnswers(http, () => answer(200, page));

    const { text, error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    expect(http.calls).toHaveLength(2);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('unexpected response (possible HTML error page)');
    for (const surface of [text, JSON.stringify(error)]) {
      expect(surface).not.toContain('<!doctype');
      expect(surface).not.toContain('not valid JSON');
    }
  });

  it('decides on the last attempt when retries run out', async () => {
    config.fecMaxRetries = 1;
    upstreamAnswers(
      http,
      () => answer(503, '{"message":"Service Unavailable","status":503}', { 'retry-after': '0' }),
      () => answer(503, TEXT_503, { 'retry-after': '0' }),
    );

    const { error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    expect(http.calls).toHaveLength(2);
    expect(error.data).toMatchObject({ status: 503, retryAttempts: 2 });
    expect(error.data).not.toHaveProperty('body');
  });

  it('names the Retry-After wait in the 429 hint and the content trailer', async () => {
    upstreamAnswers(http, () =>
      answer(
        429,
        '{"error":{"code":"OVER_RATE_LIMIT","message":"You have exceeded your rate limit."}}',
        { 'retry-after': '3600' },
      ),
    );

    const { text, error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ retryAfter: '3600' });
    expect(error.message.endsWith(` — ${waited('about 1 hour')}`)).toBe(true);
    expect(text).toContain(waited('about 1 hour'));
    expect(text).toContain('retry after `3600`');
  });

  it('never puts the API key on either surface', async () => {
    upstreamAnswers(http, () => answer(422, FEC_422));

    const { text, error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    expect(text).not.toContain(config.fecApiKey);
    expect(JSON.stringify(error)).not.toContain(config.fecApiKey);
  });

  it('carries a JSON error body that opens with whitespace', async () => {
    const padded = `\n  ${FEC_422}`;
    upstreamAnswers(http, () => answer(422, padded));

    const { error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    expect(error.data).toMatchObject({ status: 422, body: padded });
  });
});

/**
 * The keyset, legal, and election-summary reads run no retry deadline, so the
 * caller's signal reaches their request only through `getJson()`'s fallback.
 */
describe('a caller cancellation on the reads without a retry deadline', () => {
  const hang = (request: Request) =>
    new Promise<Response>((_, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), {
        once: true,
      });
    });

  it.each([
    [
      'searchContributions',
      (svc: OpenFecService, ctx: ReturnType<typeof createMockContext>) =>
        svc.searchContributions({}, { scope: 'openfec_search_contributions', args: {} }, ctx),
    ],
    [
      'searchLegal',
      (svc: OpenFecService, ctx: ReturnType<typeof createMockContext>) =>
        svc.searchLegal({ q: 'x' }, ctx),
    ],
    [
      'getElectionSummary',
      (svc: OpenFecService, ctx: ReturnType<typeof createMockContext>) =>
        svc.getElectionSummary({ cycle: 2024, office: 'president' }, ctx),
    ],
    [
      'getLegalDocument',
      (svc: OpenFecService, ctx: ReturnType<typeof createMockContext>) =>
        svc.getLegalDocument('murs', '1', ctx),
    ],
  ])('%s rejects with the cancellation', async (_label, run) => {
    config.fecRequestTimeout = 1000;
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal });
    http.route({
      match: FEC_ORIGIN,
      respond: (request) => {
        queueMicrotask(() => controller.abort());
        return hang(request);
      },
    });

    const err = await rejection(() => run(new OpenFecService(), ctx));

    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});

describe('a 429 through the real retry path', () => {
  beforeEach(() => {
    config.fecMaxRetries = 3;
  });

  /** An exhausted key, as the api.data.gov edge answers it, with the wait it sends. */
  const exhausted = (retryAfter?: string) =>
    upstreamAnswers(http, () =>
      answer(429, EDGE_429, retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
    );

  /** A call rejected after fake timers run every honored wait and backoff to the end. */
  async function rejectionAfterTimers(): Promise<McpError> {
    vi.useFakeTimers();
    const settled = rejection(() => new OpenFecService().searchCandidates({}, createMockContext()));
    await vi.runAllTimersAsync();
    return settled;
  }

  it('on a personal key, names the wait without retrying into it and gives no key advice', async () => {
    exhausted('46840');

    const { text, error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    expect(http.calls).toHaveLength(1);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.message.endsWith(`Status: 429 — ${waited('about 13 hours')}`)).toBe(true);
    expect(text).toContain(waited('about 13 hours'));
    expect(text).toContain('retry after `46840`');
    for (const surface of [text, error.message]) {
      expect(surface).not.toContain('FEC_API_KEY');
      expect(surface).not.toContain('DEMO_KEY');
    }
    for (const surface of [text, JSON.stringify(error)]) {
      expect(surface).not.toContain('a moment');
      expect(surface).not.toContain(PERSONAL_KEY);
    }
  });

  it('on DEMO_KEY, names the wait and points at a personal FEC_API_KEY', async () => {
    config.fecApiKey = 'DEMO_KEY';
    exhausted('46840');

    const { text, error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    expect(http.calls).toHaveLength(1);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(
      error.message.endsWith(`Status: 429 — ${waited('about 13 hours')}${DEMO_KEY_ADVICE}`),
    ).toBe(true);
    expect(text).toContain(`${waited('about 13 hours')}${DEMO_KEY_ADVICE}`);
    expect(text).toContain('retry after `46840`');
    for (const surface of [text, JSON.stringify(error)]) {
      expect(surface).not.toContain('a moment');
      expect(surface).not.toContain('api_key=');
    }
  });

  it("passes Retry-After through unchanged and keeps api.data.gov's JSON body", async () => {
    exhausted('46840');

    const { error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    expect(error.data).toMatchObject({ status: 429, retryAfter: '46840', body: EDGE_429 });
  });

  it('reads an HTTP-date Retry-After as the wait from now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T10:59:20Z'));
    exhausted('Fri, 13 Nov 2026 00:00:00 GMT');

    const err = await rejection(() =>
      new OpenFecService().searchCandidates({}, createMockContext()),
    );

    expect(http.calls).toHaveLength(1);
    expect(err.message.endsWith(`Status: 429 — ${waited('about 13 hours')}`)).toBe(true);
    expect(err.data).toMatchObject({ retryAfter: 'Fri, 13 Nov 2026 00:00:00 GMT' });
  });

  it('names a short wait after the retries that honored it run out', async () => {
    exhausted('2');

    const err = await rejectionAfterTimers();

    expect(http.calls).toHaveLength(4);
    expect(
      err.message.endsWith(`Status: 429 (failed after 4 attempts) — ${waited('2 seconds')}`),
    ).toBe(true);
    expect(err.data).toMatchObject({ retryAfter: '2', retryAttempts: 4 });
  });

  it.each([
    ['absent', undefined],
    ['unparseable', 'soon'],
  ])('says OpenFEC gave no reset time when Retry-After is %s', async (_label, retryAfter) => {
    exhausted(retryAfter);

    const err = await rejectionAfterTimers();

    expect(http.calls).toHaveLength(4);
    expect(err.message.endsWith(`Status: 429 (failed after 4 attempts) — ${NO_RESET}`)).toBe(true);
    expect(err.message).not.toContain('a moment');
  });
});
