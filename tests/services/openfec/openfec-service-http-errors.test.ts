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
import {
  later as answerAfter,
  candidateIds,
  candidateRows,
  totalsPage,
} from './candidate-totals-upstream.js';
import { FEC_404 } from './committee-totals-upstream.js';

/** OpenFEC's own JSON 422 error object, verbatim from the live API. */
const FEC_422 =
  '{"message":{"query":{"office":{"0":["Must be one of: , H, S, P."]}}},"status":422}';

/** A list parameter's rejection names each parameter with its index; verbatim from `/committees/`. */
const FEC_422_LIST =
  '{"message":{"query":{"committee_type":{"0":["Must be one of: , C, D, E, H, I, N, O, P, Q, S, U, V, W, X, Y, Z."]},"designation":{"0":["Must be one of: , A, J, P, U, B, D."]}}},"status":422}';

/** A scalar parameter's rejection carries its messages directly; verbatim from `/elections/`. */
const FEC_422_SCALAR =
  '{"message":{"query":{"office":["Must be one of: house, senate, president."]}},"status":422}';

/** A rejection OpenFEC words as one sentence; verbatim from `/elections/` with `district=five`. */
const FEC_422_STRING = '{"message":"District must be a number","status":422}';

/** A cycle past the data on file; verbatim from `/schedules/schedule_b/` with period 2028. */
const FEC_404_PERIOD =
  '{"message":"two_year_transaction_period not found. Data exists for two_year_transaction_periods between 1976 and 2026.","status":404}';

/** OpenFEC's `ApiError` defaults to 400; verbatim from `/schedules/schedule_a/` with `line_number=bogus`. */
const FEC_400_LINE = JSON.stringify({
  message:
    "Invalid line_number detected. A valid line_number is using the following format:\n'FORM-LINENUMBER'.  For example an argument such as 'F3X-16' would filter down to all schedule a entries\nfrom form F3X line number 16.",
  status: 400,
});

/** OpenFEC's database statement timeout, as `webservices/rest.py` `handle_db_timeout` answers it. */
const FEC_504_QUERY = '{"message":"Query timed out","status":504}';

/** The 504 hint, which names no input: every tool reaches it, and no input is common to all of them. */
const HINT_504 =
  'The FEC API timed out running this query. Narrow it with more selective filters, then retry.';

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

/** Every text block of a tool result, joined — the `content[]` surface a client reads. */
const contentText = (result: { content: unknown }): string =>
  (result.content as ContentBlock[])
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');

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
  /**
   * Every status answered with an OpenFEC-shaped body. On 400, 404, and 422 the
   * body's own reason is the hint; every other status keeps its fixed hint.
   */
  const cases: Array<[status: number, code: JsonRpcErrorCode, hint: string]> = [
    [400, JsonRpcErrorCode.InvalidParams, 'OpenFEC: upstream 400'],
    [403, JsonRpcErrorCode.Forbidden, 'Forbidden — the API key may be invalid or expired.'],
    [404, JsonRpcErrorCode.NotFound, 'OpenFEC: upstream 404'],
    [422, JsonRpcErrorCode.ValidationError, 'OpenFEC: upstream 422'],
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
    [504, JsonRpcErrorCode.Timeout, HINT_504],
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
    expect(err.data).toMatchObject({ operation: 'FEC /candidates/', retryAttempts: 2 });
  });
});

describe("OpenFEC's own reason in place of the fixed hint", () => {
  type Read = (svc: OpenFecService, ctx: ReturnType<typeof createMockContext>) => Promise<unknown>;
  const candidates: Read = (svc, ctx) => svc.searchCandidates({}, ctx);

  /** The rejection a read settles with when every request is answered `status` with `body`. */
  const rejectedWith = (status: number, body: string, read: Read = candidates) => {
    upstreamAnswers(http, () => answer(status, body));
    return rejection(() => read(new OpenFecService(), createMockContext()));
  };

  it('names each rejected list parameter with its messages, the index dropped', async () => {
    const err = await rejectedWith(422, FEC_422_LIST, (svc, ctx) =>
      svc.searchCommittees({ committee_type: 'ZZ', designation: 'ZZ' }, ctx),
    );

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(
      err.message.endsWith(
        'Status: 422 — OpenFEC rejected committee_type: Must be one of: , C, D, E, H, I, N, O, P, Q, S, U, V, W, X, Y, Z.; designation: Must be one of: , A, J, P, U, B, D.',
      ),
    ).toBe(true);
    expect(err.data).toMatchObject({ status: 422, body: FEC_422_LIST });
  });

  it.each([
    [
      'a scalar parameter',
      FEC_422_SCALAR,
      'OpenFEC rejected office: Must be one of: house, senate, president.',
    ],
    [
      'a list parameter with one index',
      FEC_422,
      'OpenFEC rejected office: Must be one of: , H, S, P.',
    ],
    ['a sentence', FEC_422_STRING, 'OpenFEC: District must be a number'],
  ])('renders %s as OpenFEC words it', async (_label, body, reason) => {
    const err = await rejectedWith(422, body);

    expect(err.message.endsWith(`Status: 422 — ${reason}`)).toBe(true);
    expect(err.message).not.toContain('rejected the request parameters');
    expect(err.data).toMatchObject({ status: 422, body });
  });

  it('folds a message repeated across list indices and joins distinct ones', async () => {
    const err = await rejectedWith(
      422,
      '{"message":{"query":{"party":{"0":["Must be one of: DEM, REP."],"1":["Must be one of: DEM, REP."],"2":["Longer than maximum length 3."]}}},"status":422}',
    );

    expect(
      err.message.endsWith(
        'Status: 422 — OpenFEC rejected party: Must be one of: DEM, REP. Longer than maximum length 3.',
      ),
    ).toBe(true);
  });

  it('leaves out a parameter whose messages are all blank', async () => {
    const err = await rejectedWith(
      422,
      '{"message":{"query":{"office":{"0":[""],"1":[" \\n "]},"party":{"0":["Must be one of: DEM, REP."]}}},"status":422}',
    );

    expect(
      err.message.endsWith('Status: 422 — OpenFEC rejected party: Must be one of: DEM, REP.'),
    ).toBe(true);
  });

  it("carries a 404's own reason instead of the API-path hint", async () => {
    const err = await rejectedWith(404, FEC_404_PERIOD, (svc, ctx) =>
      svc.searchDisbursements(
        { committee_id: 'C00401224', two_year_transaction_period: 2028 },
        { scope: 'openfec_search_disbursements', args: {} },
        ctx,
      ),
    );

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(
      err.message.endsWith(
        'Status: 404 — OpenFEC: two_year_transaction_period not found. Data exists for two_year_transaction_periods between 1976 and 2026.',
      ),
    ).toBe(true);
    expect(err.message).not.toContain('verify the API path');
  });

  it("carries a 400's own reason with its line breaks folded to spaces", async () => {
    const err = await rejectedWith(400, FEC_400_LINE);

    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(
      err.message.endsWith(
        "Status: 400 — OpenFEC: Invalid line_number detected. A valid line_number is using the following format: 'FORM-LINENUMBER'. For example an argument such as 'F3X-16' would filter down to all schedule a entries from form F3X line number 16.",
      ),
    ).toBe(true);
    expect(err.data).toMatchObject({ body: FEC_400_LINE });
  });

  it('keeps the API key out of a message that quotes the body', async () => {
    const err = await rejectedWith(
      422,
      `{"message":"Bad request to /v1/candidates/?api_key=${config.fecApiKey}&q=x","status":422}`,
    );

    expect(err.message).toContain('OpenFEC: Bad request to /v1/candidates/?api_key=REDACTED');
    expect(err.message).not.toContain(config.fecApiKey);
  });

  const LONG_422 = JSON.stringify({
    message: {
      query: Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`param_${i}`, ['Must be one of: A, B, C, D, E.']]),
      ),
    },
    status: 422,
  });

  it.each([
    [400, 'a plain-text page', 'Bad Request', 'Bad request — check parameter names and types.'],
    [
      400,
      'an empty message',
      '{"message":"","status":400}',
      'Bad request — check parameter names and types.',
    ],
    [
      400,
      'a message of whitespace alone',
      '{"message":" \\n\\t ","status":400}',
      'Bad request — check parameter names and types.',
    ],
    [
      422,
      'messages that are all blank',
      '{"message":{"query":{"office":[""]}},"status":422}',
      'The FEC API rejected the request parameters. Check required fields and value formats for this endpoint.',
    ],
    [404, 'an HTML page', HTML_404, 'Endpoint not found — verify the API path.'],
    [404, 'a JSON object without a status', FEC_404, 'Endpoint not found — verify the API path.'],
    [
      422,
      'JSON of another shape',
      '{"detail":"Unprocessable","status":422}',
      'The FEC API rejected the request parameters. Check required fields and value formats for this endpoint.',
    ],
    [
      422,
      'a message with no text in it',
      '{"message":{"query":{}},"status":422}',
      'The FEC API rejected the request parameters. Check required fields and value formats for this endpoint.',
    ],
    [
      422,
      'a body cut short by the error-body capture',
      LONG_422,
      'The FEC API rejected the request parameters. Check required fields and value formats for this endpoint.',
    ],
    [403, "api.data.gov's JSON", EDGE_403, 'Forbidden — the API key may be invalid or expired.'],
  ])('keeps the fixed %i hint for %s', async (status, _label, body, hint) => {
    const err = await rejectedWith(status, body);

    expect(err.message.endsWith(`Status: ${status} — ${hint}`)).toBe(true);
  });

  it('still resolves committee totals to an empty page on an OpenFEC 404 that names its status', async () => {
    upstreamAnswers(http, () => answer(404, FEC_404_PERIOD));

    const page = await new OpenFecService().getCommitteeTotals(
      'C00401224',
      { cycle: 2028, per_page: 20 },
      createMockContext(),
    );

    expect(page).toEqual({
      pagination: { page: 1, pages: 0, count: 0, per_page: 20 },
      results: [],
    });
  });

  it('still resolves a legal document to null on an OpenFEC 404 that names its status', async () => {
    upstreamAnswers(http, () =>
      answer(404, '{"message":"Could not process the request","status":404}'),
    );

    await expect(
      new OpenFecService().getLegalDocument('murs', '999999', createMockContext()),
    ).resolves.toBeNull();
  });
});

describe('a 504 OpenFEC answers when its database timed out the query', () => {
  beforeEach(() => {
    config.fecMaxRetries = 3;
  });

  const contributions = () =>
    new OpenFecService().searchContributions(
      { contributor_employer: 'Google', two_year_transaction_period: 2024 },
      { scope: 'openfec_search_contributions', args: {} },
      createMockContext(),
    );

  it('is attempted once and keeps the 504 hint', async () => {
    upstreamAnswers(http, () => answer(504, FEC_504_QUERY));

    const err = await rejection(contributions);

    expect(http.calls).toHaveLength(1);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.message.endsWith(`Status: 504 — ${HINT_504}`)).toBe(true);
    expect(err.data).toMatchObject({ status: 504, body: FEC_504_QUERY });
  });

  it.each([
    ['a gateway page', '<html><body><h1>504 Gateway Time-out</h1></body></html>'],
    ['api.data.gov JSON', '{"error":{"code":"GATEWAY_TIMEOUT","message":"Gateway timed out."}}'],
    [
      'a JSON message that only opens like OpenFEC’s own',
      '{"message":"Query timed out at the gateway","status":504}',
    ],
  ])('is retried when the body is %s', async (_label, body) => {
    vi.useFakeTimers();
    upstreamAnswers(http, () => answer(504, body));

    const settled = rejection(contributions);
    await vi.runAllTimersAsync();
    const err = await settled;

    expect(http.calls).toHaveLength(4);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.message.endsWith(`Status: 504 (failed after 4 attempts) — ${HINT_504}`)).toBe(true);
  });

  it('retries a 500 that carries the same message, as any 500', async () => {
    vi.useFakeTimers();
    upstreamAnswers(http, () => answer(500, '{"message":"Query timed out","status":500}'));

    const settled = rejection(contributions);
    await vi.runAllTimersAsync();
    const err = await settled;

    expect(http.calls).toHaveLength(4);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toContain('Status: 500 (failed after 4 attempts)');
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
  it("carries OpenFEC's JSON 422 body, and its reason on both surfaces", async () => {
    upstreamAnswers(http, () => answer(422, FEC_422));

    const { text, error } = surfaces(await runToolContract(searchCandidates, { query: 'x' }));

    const reason = 'OpenFEC rejected office: Must be one of: , H, S, P.';
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ status: 422, body: FEC_422, responseBody: FEC_422 });
    expect(error.message.endsWith(`Status: 422 — ${reason}`)).toBe(true);
    expect(text).toContain(reason);
    expect(text).not.toContain('rejected the request parameters');
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

/** An upstream that never answers: the request settles only when its signal aborts. */
const hang = (request: Request) =>
  new Promise<Response>((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), {
      once: true,
    });
  });

type ServiceRead = (
  svc: OpenFecService,
  ctx: ReturnType<typeof createMockContext>,
) => Promise<unknown>;

/** One read per request ladder: offset pages, keyset pages, legal search, election summary, legal document. */
const READS: Array<[label: string, read: ServiceRead]> = [
  ['searchCandidates', (svc, ctx) => svc.searchCandidates({}, ctx)],
  [
    'searchContributions',
    (svc, ctx) =>
      svc.searchContributions({}, { scope: 'openfec_search_contributions', args: {} }, ctx),
  ],
  ['searchLegal', (svc, ctx) => svc.searchLegal({ q: 'x' }, ctx)],
  [
    'getElectionSummary',
    (svc, ctx) => svc.getElectionSummary({ cycle: 2024, office: 'president' }, ctx),
  ],
  ['getLegalDocument', (svc, ctx) => svc.getLegalDocument('murs', '1', ctx)],
];

/** Every read runs under the call budget, whose signal carries the caller's cancellation too. */
describe('a caller cancellation on every read', () => {
  it.each(READS)('%s rejects with the cancellation', async (_label, run) => {
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

/**
 * MCP SDK clients abandon a request after 60 s. Four 30 s attempts and their
 * backoffs run about 127 s, so every read's ladder shares one 50 s budget
 * unless its caller passes what is left of its own.
 */
describe('one call budget across every attempt and backoff of a read', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    config.fecMaxRetries = 3;
    config.fecRequestTimeout = 30_000;
  });

  /** Start `run` and record, in fake time, when it settles. */
  const timed = (run: () => Promise<unknown>) => {
    const startedAt = Date.now();
    const settled: { afterMs?: number } = {};
    const call = run().finally(() => {
      settled.afterMs = Date.now() - startedAt;
    });
    call.catch(() => undefined);
    return { call, settled };
  };

  it.each(READS)('%s settles at 50 s on an upstream that never answers', async (_label, read) => {
    http.route({ match: FEC_ORIGIN, respond: hang });

    const { call, settled } = timed(() => read(new OpenFecService(), createMockContext()));
    await vi.advanceTimersByTimeAsync(49_999);
    expect(settled.afterMs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled.afterMs).toBe(50_000);
    const err = await rejection(() => call);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 50_000 });
    expect(http.calls).toHaveLength(2);
  });

  it('gives a read only the budget its caller passes', async () => {
    http.route({ match: FEC_ORIGIN, respond: hang });

    const { call, settled } = timed(() =>
      new OpenFecService().searchCandidates({}, createMockContext(), { deadlineMs: 20_000 }),
    );
    await vi.advanceTimersByTimeAsync(20_000);

    expect(settled.afterMs).toBe(20_000);
    expect((await rejection(() => call)).data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      deadlineMs: 20_000,
    });
    expect(http.calls).toHaveLength(1);
  });

  it.each([0, 1])('sends nothing when %i ms of the budget is left', async (deadlineMs) => {
    http.route({ match: FEC_ORIGIN, respond: () => Response.json({ results: [] }) });

    const { call } = timed(() =>
      new OpenFecService().searchCandidates({}, createMockContext(), { deadlineMs }),
    );
    await vi.advanceTimersByTimeAsync(1);

    const err = await rejection(() => call);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'retry_deadline_exceeded' });
    expect(http.calls).toHaveLength(0);
  });

  /**
   * With no request in flight, `withRetry` hands back the signal's own abort
   * reason, as it does for an abort in a backoff; the handler factory reports
   * that as a cancellation.
   */
  it('still reports a cancellation as a cancellation when the budget is spent', async () => {
    http.route({ match: FEC_ORIGIN, respond: () => Response.json({ results: [] }) });
    const controller = new AbortController();
    controller.abort();

    const call = new OpenFecService().searchCandidates(
      {},
      createMockContext({ signal: controller.signal }),
      { deadlineMs: 0 },
    );

    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(http.calls).toHaveLength(0);
  });
});

/**
 * `openfec_search_candidates` with totals, through the real service: the
 * candidate read and every request of the totals walk share the call's one
 * budget, and a walk that stops early is disclosed on both surfaces. Twenty
 * candidates of seven cycles are 140 totals rows, so the walk's first page of
 * 100 holds 14 candidates whole and a second request reads the rest.
 */
describe('openfec_search_candidates totals under the call budget', () => {
  const IDS = candidateIds(20);
  const ROWS = IDS.flatMap((id) => candidateRows(id, 7));
  const TOTALS = /\/v1\/candidates\/totals\/\?/;
  const CANDIDATES = /\/v1\/candidates\/\?/;

  type Respond = (request: Request) => Response | Promise<Response>;

  /** Serve the candidate page with `candidates`, and the walk's nth totals request with `totals[n - 1]`. */
  const serve = (candidates: Respond, ...totals: Respond[]) => {
    let served = 0;
    http.route({
      match: TOTALS,
      respond: (request) => totals[Math.min(served++, totals.length - 1)]!(request),
    });
    http.route({ match: CANDIDATES, respond: candidates });
  };

  const candidatePage: Respond = () =>
    Response.json({
      pagination: { count: IDS.length, page: 1, pages: 1, per_page: 20, is_count_exact: true },
      results: IDS.map((candidate_id) => ({ candidate_id, name: `CANDIDATE ${candidate_id}` })),
    });
  const totalsPageOf: Respond = (request) => totalsPage(ROWS, request, 1);

  const totalsSent = () => http.calls.filter(({ request }) => TOTALS.test(request.url)).length;

  /** The 14 candidates the first totals page holds whole, as row keys. */
  const firstPageKeys = IDS.slice(0, 14).flatMap((id) =>
    candidateRows(id, 7).map((row) => `${id}:${row.cycle}`),
  );

  it('settles at 50 s across a 30 s candidate read and a walk whose second request never answers', async () => {
    vi.useFakeTimers();
    config.fecMaxRetries = 3;
    config.fecRequestTimeout = 60_000;
    serve(answerAfter(30_000, candidatePage), answerAfter(5_000, totalsPageOf), hang);

    const startedAt = Date.now();
    const settled: { afterMs?: number } = {};
    const call = runToolContract(searchCandidates, { query: 'x', include_totals: true }).finally(
      () => {
        settled.afterMs = Date.now() - startedAt;
      },
    );
    await vi.advanceTimersByTimeAsync(49_999);
    expect(settled.afterMs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled.afterMs).toBe(50_000);
    const result = await call;
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      candidates: unknown[];
      totals: Array<{ candidate_id: string; cycle: number }>;
      notice?: string;
    };
    expect(structured.candidates).toHaveLength(20);
    expect(structured.totals.map((row) => `${row.candidate_id}:${row.cycle}`).sort()).toEqual(
      firstPageKeys.toSorted(),
    );
    expect(structured.notice).toContain('Financial totals are incomplete');
    expect(contentText(result)).toContain(structured.notice);
    expect(totalsSent()).toBe(2);
  });

  it('names a failed later request among the causes when the walk stops on one', async () => {
    serve(candidatePage, totalsPageOf, () => answer(500, '{"message":"boom","status":500}'));

    const result = await runToolContract(searchCandidates, { query: 'x', include_totals: true });

    expect(result.isError).toBeFalsy();
    const { notice } = result.structuredContent as { notice?: string };
    expect(notice).toContain('Financial totals are incomplete');
    expect(notice).toContain('a later totals request failed');
    expect(notice).toContain("this call's 50-second budget ran out");
    expect(contentText(result)).toContain(notice);
    expect(totalsSent()).toBe(2);
  });
});

/** The recovery a budget expiry carries when no answered attempt names a better one; it names no input. */
const BUDGET_HINT =
  'Retry shortly; if it runs out of time again, narrow the query with more selective filters.';

/**
 * What a read reports when its budget runs out: the failure of the last
 * attempt that got an answer — a 429, a 5xx, a gateway 504 — since its hint
 * names the caller's next step, or else a `Timeout` that names the budget and
 * carries its own recovery. An attempt the deadline itself cut off got no
 * answer; one that timed out on its own did, and replaces an earlier one.
 */
describe('what a read reports when its budget runs out', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    config.fecMaxRetries = 3;
    config.fecRequestTimeout = 30_000;
  });

  type Respond = (request: Request) => Response | Promise<Response>;

  /** Answer each attempt in turn, the last repeating. */
  const attempts = (...answers: Respond[]) => {
    let served = 0;
    http.route({
      match: FEC_ORIGIN,
      respond: (request) => answers[Math.min(served++, answers.length - 1)]!(request),
    });
  };

  /** An answer that arrives `afterMs` into its attempt. */
  const later =
    (afterMs: number, respond: () => Response): Respond =>
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(respond()), afterMs);
      });

  /** A candidates read run to its settlement 50 s into fake time. */
  async function readToTheDeadline(): Promise<McpError> {
    const settled = rejection(() => new OpenFecService().searchCandidates({}, createMockContext()));
    await vi.advanceTimersByTimeAsync(50_000);
    return settled;
  }

  it('reports a Timeout that names the budget and carries its recovery when no attempt was answered', async () => {
    attempts(hang);

    const err = await readToTheDeadline();

    expect(http.calls).toHaveLength(2);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.message).toBe(
      "FEC /candidates/ request did not finish within this call's 50-second budget (2 attempts).",
    );
    expect(err.data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      deadlineMs: 50_000,
      retryAttempts: 2,
      recovery: { hint: BUDGET_HINT },
    });
  });

  it('reports the same Timeout when the deadline cut off the only attempt', async () => {
    config.fecRequestTimeout = 60_000;
    attempts(hang);

    const err = await readToTheDeadline();

    expect(http.calls).toHaveLength(1);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.message).toBe(
      "FEC /candidates/ request did not finish within this call's 50-second budget (1 attempt).",
    );
    expect(err.data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      retryAttempts: 1,
      recovery: { hint: BUDGET_HINT },
    });
  });

  it('reports the 429 of the last attempt answered, the one the deadline cut off aside', async () => {
    attempts(() => answer(429, EDGE_429, { 'retry-after': '20' }), hang);

    const err = await readToTheDeadline();

    expect(http.calls).toHaveLength(2);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.message.endsWith(`Status: 429 — ${waited('20 seconds')}`)).toBe(true);
    expect(err.data).toMatchObject({ status: 429, retryAfter: '20' });
  });

  it.each([
    [
      'a 503',
      503,
      TEXT_503,
      JsonRpcErrorCode.ServiceUnavailable,
      'FEC API is temporarily unavailable. Retry shortly.',
    ],
    ['a gateway 504', 504, TEXT_503, JsonRpcErrorCode.Timeout, HINT_504],
  ])(
    'reports %s of the last attempt answered, with its hint',
    async (_label, status, body, code, hint) => {
      attempts(
        later(25_000, () => answer(status, body)),
        hang,
      );

      const err = await readToTheDeadline();

      expect(http.calls).toHaveLength(2);
      expect(err.code).toBe(code);
      expect(err.message.endsWith(`Status: ${status} — ${hint}`)).toBe(true);
      expect(err.data).toMatchObject({ status });
      expect(err.data).not.toHaveProperty('recovery');
    },
  );

  it('lets an attempt that timed out on its own replace an earlier 429', async () => {
    attempts(() => answer(429, EDGE_429, { 'retry-after': '1' }), hang);

    const err = await readToTheDeadline();

    expect(http.calls).toHaveLength(3);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.message).toBe(
      "FEC /candidates/ request did not finish within this call's 50-second budget (3 attempts).",
    );
    expect(err.data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      recovery: { hint: BUDGET_HINT },
    });
  });

  it('puts the recovery the service wrote on both surfaces of a tool call', async () => {
    attempts(hang);

    const call = runToolContract(searchCandidates, { query: 'x' });
    await vi.advanceTimersByTimeAsync(50_000);
    const { text, error } = surfaces(await call);

    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe(
      "FEC /candidates/ request did not finish within this call's 50-second budget (2 attempts).",
    );
    expect(error.data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      recovery: { hint: BUDGET_HINT },
    });
    expect(text).toContain(BUDGET_HINT);
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
