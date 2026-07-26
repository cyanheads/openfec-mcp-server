/**
 * @fileoverview OpenFEC API service. Wraps all FEC REST API interactions
 * with timeout, retry, and pagination handling. Single service used by
 * all tools and resources.
 * @module src/services/openfec/openfec-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import type {
  ElectionSummary,
  FecLegalEnvelope,
  FecPageEnvelope,
  FecParams,
  FecSeekEnvelope,
  LegalResult,
  PageResult,
  SeekResult,
} from './types.js';

/* ------------------------------------------------------------------ */
/*  Cursor encoding for keyset pagination                             */
/* ------------------------------------------------------------------ */

/**
 * The identity a keyset cursor is bound to: the tool that issued it plus the
 * caller arguments that shape the result set. OpenFEC silently ignores keyset
 * keys that do not match the active sort, so a cursor replayed against a
 * different query restarts at page one without any signal — binding the two
 * together lets `decodeCursor` reject the replay instead.
 */
export interface CursorQuery {
  /** Caller arguments that shape the keyset, stringified. */
  args: Record<string, string>;
  /** Tool name that issued the cursor. Blocks replay across the itemized tools. */
  scope: string;
}

/** Cursor payload as it is serialized: `q` = issuing query, `i` = `last_indexes`. */
interface CursorPayload {
  i: Record<string, string>;
  q: CursorQuery;
}

/**
 * Arguments left out of the cursor identity. `cursor` is not part of the query
 * it resumes, `per_page` only sets batch size, and `page` addresses the
 * page-based aggregate modes rather than the keyset — none of them change which
 * rows the keyset walks.
 */
const CURSOR_IDENTITY_EXCLUDES: ReadonlySet<string> = new Set(['cursor', 'page', 'per_page']);

const RESTART_HINT =
  'Omit cursor to restart from the first page, then paginate only with a next_cursor value returned by this same tool.';

const MISMATCH_HINT =
  'Repeat the original arguments exactly and reuse the cursor, or omit cursor to start a fresh search under the new arguments.';

/**
 * Normalize a tool's parsed input into the identity its cursors are bound to.
 * Derived from the caller's own arguments rather than the outbound FEC params
 * so a mismatch names fields the caller can actually see in the tool schema.
 */
export function cursorQuery(scope: string, input: Record<string, unknown>): CursorQuery {
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || CURSOR_IDENTITY_EXCLUDES.has(key)) continue;
    args[key] = String(value);
  }
  return { scope, args };
}

/**
 * Encode `last_indexes` and the issuing query into an opaque cursor.
 * Index values are stringified first — OpenFEC returns some of them as raw
 * numbers (Schedule E's `last_office_total_ytd`), and they go back out as
 * query params either way.
 */
export function encodeCursor(
  lastIndexes: Record<string, string | number>,
  query: CursorQuery,
): string {
  const i = Object.fromEntries(
    Object.entries(lastIndexes).map(([key, value]) => [key, String(value)]),
  );
  return btoa(JSON.stringify({ q: query, i } satisfies CursorPayload));
}

/**
 * Decode an opaque cursor back to `last_indexes` query params.
 * Throws a `validationError` when the cursor is malformed (`invalid_cursor`)
 * or was issued for a different query (`cursor_query_mismatch`).
 */
export function decodeCursor(cursor: string, expected: CursorQuery): Record<string, string> {
  const echo = cursor.length > 100 ? `${cursor.slice(0, 100)}…` : cursor;

  let raw: unknown;
  try {
    raw = JSON.parse(atob(cursor));
  } catch {
    throw validationError(
      'Pagination cursor is not decodable — it must be a next_cursor value returned by this tool, not a hand-written or truncated string.',
      { reason: 'invalid_cursor', cursor: echo, recovery: { hint: RESTART_HINT } },
    );
  }

  const payload = parseCursorPayload(raw);
  if (!payload) {
    throw validationError(
      'Pagination cursor decoded but does not have the expected shape — it must be a next_cursor value returned by the current version of this tool.',
      { reason: 'invalid_cursor', cursor: echo, recovery: { hint: RESTART_HINT } },
    );
  }

  if (payload.q.scope !== expected.scope) {
    throw validationError(
      `Pagination cursor was issued by ${payload.q.scope}, not ${expected.scope}. Cursors are not portable between tools.`,
      {
        reason: 'cursor_query_mismatch',
        issued_by: payload.q.scope,
        recovery: { hint: RESTART_HINT },
      },
    );
  }

  const changed = diffCursorArgs(payload.q.args, expected.args);
  if (changed.length > 0) {
    throw validationError(
      `Pagination cursor was issued for a different query — ${changed.join('; ')}. A cursor is only valid for an otherwise-identical call.`,
      {
        reason: 'cursor_query_mismatch',
        changed_arguments: changed,
        recovery: { hint: MISMATCH_HINT },
      },
    );
  }

  return payload.i;
}

/** True when `value` is a plain object whose values are all strings. */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

/** Narrow a decoded cursor body to a `CursorPayload`, or `null` when the shape is wrong. */
function parseCursorPayload(raw: unknown): CursorPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { q, i } = raw as { q?: unknown; i?: unknown };
  if (!isStringRecord(i) || typeof q !== 'object' || q === null) return null;
  const { scope, args } = q as { scope?: unknown; args?: unknown };
  if (typeof scope !== 'string' || !isStringRecord(args)) return null;
  return { q: { scope, args }, i };
}

/** Render one side of an argument comparison — a quoted value, or `omitted` when absent. */
function describeArg(value: string | undefined): string {
  return value === undefined ? 'omitted' : JSON.stringify(value);
}

/** Describe every argument that differs between the cursor's query and the current call. */
function diffCursorArgs(issued: Record<string, string>, current: Record<string, string>): string[] {
  const keys = [...new Set([...Object.keys(issued), ...Object.keys(current)])].sort();
  return keys
    .filter((key) => issued[key] !== current[key])
    .map(
      (key) => `${key} (cursor: ${describeArg(issued[key])}, call: ${describeArg(current[key])})`,
    );
}

/* ------------------------------------------------------------------ */
/*  Context adapter                                                   */
/* ------------------------------------------------------------------ */

/**
 * Extract a RequestContext from a handler Context.
 * Needed because `exactOptionalPropertyTypes` makes Context's optional
 * `T | undefined` fields incompatible with RequestContext's optional `T` fields.
 */
function toRequestContext(ctx: Context): RequestContext {
  const rc: RequestContext = { requestId: ctx.requestId, timestamp: ctx.timestamp };
  if (ctx.tenantId) rc.tenantId = ctx.tenantId;
  if (ctx.traceId) rc.traceId = ctx.traceId;
  if (ctx.spanId) rc.spanId = ctx.spanId;
  if (ctx.auth) rc.auth = ctx.auth;
  return rc;
}

/* ------------------------------------------------------------------ */
/*  Service class                                                     */
/* ------------------------------------------------------------------ */

export class OpenFecService {
  private readonly config: ServerConfig;

  constructor() {
    this.config = getServerConfig();
  }

  /* ---------------------------------------------------------------- */
  /*  Internal fetch helpers                                          */
  /* ---------------------------------------------------------------- */

  /** Build a full URL with query params, injecting the API key. */
  private buildUrl(path: string, params: FecParams = {}): string {
    const base = this.config.fecBaseUrl.replace(/\/$/, '');
    const url = new URL(`${base}${path}`);
    url.searchParams.set('api_key', this.config.fecApiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === '') continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, v);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * Fetch JSON from a page-based endpoint with retry.
   * Wraps the full pipeline (fetch + JSON parse) in the retry boundary.
   */
  private async fetchPage<T = Record<string, unknown>>(
    path: string,
    params: FecParams,
    ctx: Context,
  ): Promise<PageResult<T>> {
    const url = this.buildUrl(path, params);
    const reqCtx = toRequestContext(ctx);
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.config.fecRequestTimeout, reqCtx, {
            signal: ctx.signal,
          });
          const body = (await response.json()) as FecPageEnvelope<T>;
          this.validateEnvelope(body);
          return {
            pagination: {
              page: body.pagination?.page ?? 1,
              pages: body.pagination?.pages ?? 1,
              count: body.pagination?.count ?? body.results?.length ?? 0,
              per_page: body.pagination?.per_page ?? 20,
            },
            results: body.results,
          };
        },
        {
          maxRetries: this.config.fecMaxRetries,
          baseDelayMs: 1_000,
          operation: `FEC ${path}`,
          context: reqCtx,
          signal: ctx.signal,
          isTransient: isTransientFecError,
        },
      );
    } catch (err) {
      rethrowSanitized(err);
    }
  }

  /**
   * Fetch JSON from a keyset (SEEK) endpoint with retry.
   * Returns a `nextCursor` from `last_indexes` when more results exist, bound
   * to `query` so a replay under different arguments is rejected on decode.
   */
  private async fetchSeek<T = Record<string, unknown>>(
    path: string,
    params: FecParams,
    query: CursorQuery,
    ctx: Context,
  ): Promise<SeekResult<T>> {
    const url = this.buildUrl(path, params);
    const reqCtx = toRequestContext(ctx);
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.config.fecRequestTimeout, reqCtx, {
            signal: ctx.signal,
          });
          const body = (await response.json()) as FecSeekEnvelope<T>;
          this.validateEnvelope(body);
          const lastIndexes = body.pagination.last_indexes;
          const hasMore =
            lastIndexes && Object.keys(lastIndexes).length > 0 && body.results.length > 0;
          return {
            pagination: {
              count: body.pagination.count,
              per_page: body.pagination.per_page,
            },
            results: body.results,
            nextCursor: hasMore ? encodeCursor(lastIndexes, query) : null,
          };
        },
        {
          maxRetries: this.config.fecMaxRetries,
          baseDelayMs: 1_000,
          operation: `FEC ${path}`,
          context: reqCtx,
          signal: ctx.signal,
          isTransient: isTransientFecError,
        },
      );
    } catch (err) {
      rethrowSanitized(err);
    }
  }

  /** Fetch legal search results with retry. Normalizes type-keyed arrays. */
  private async fetchLegalSearch(params: FecParams, ctx: Context): Promise<LegalResult> {
    const url = this.buildUrl('/legal/search/', params);
    const reqCtx = toRequestContext(ctx);
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.config.fecRequestTimeout, reqCtx, {
            signal: ctx.signal,
          });
          const body = (await response.json()) as FecLegalEnvelope;
          const results: LegalResult['results'] = [];

          for (const ao of body.advisory_opinions ?? []) {
            results.push({ ...ao, document_type: 'advisory_opinion' });
          }
          for (const mur of body.murs ?? []) {
            results.push({ ...mur, document_type: 'mur' });
          }
          for (const adr of body.adrs ?? []) {
            results.push({ ...adr, document_type: 'adr' });
          }
          for (const fine of body.admin_fines ?? []) {
            results.push({ ...fine, document_type: 'admin_fine' });
          }
          for (const statute of body.statutes ?? []) {
            results.push({ ...statute, document_type: 'statute' });
          }

          return { results, totalCount: body.total_all ?? results.length };
        },
        {
          maxRetries: this.config.fecMaxRetries,
          baseDelayMs: 1_000,
          operation: 'FEC /legal/search/',
          context: reqCtx,
          signal: ctx.signal,
          isTransient: isTransientFecError,
        },
      );
    } catch (err) {
      rethrowSanitized(err);
    }
  }

  /** Validate that the API returned a recognizable envelope, not an HTML error page. */
  private validateEnvelope(body: unknown): void {
    if (!body || typeof body !== 'object' || !('results' in (body as Record<string, unknown>))) {
      throw new Error('FEC API returned an unexpected response (possible HTML error page)');
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Candidates                                                      */
  /* ---------------------------------------------------------------- */

  searchCandidates(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/candidates/', params, ctx);
  }

  getCandidate(candidateId: string, ctx: Context): Promise<PageResult> {
    return this.fetchPage(`/candidate/${candidateId}/`, {}, ctx);
  }

  getCandidateTotals(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/candidates/totals/', params, ctx);
  }

  getCandidateCommittees(
    candidateId: string,
    params: FecParams,
    ctx: Context,
  ): Promise<PageResult> {
    return this.fetchPage(`/candidate/${candidateId}/committees/`, params, ctx);
  }

  /* ---------------------------------------------------------------- */
  /*  Committees                                                      */
  /* ---------------------------------------------------------------- */

  searchCommittees(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/committees/', params, ctx);
  }

  getCommittee(committeeId: string, ctx: Context): Promise<PageResult> {
    return this.fetchPage(`/committee/${committeeId}/`, {}, ctx);
  }

  getCommitteeTotals(committeeId: string, params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage(`/committee/${committeeId}/totals/`, params, ctx);
  }

  /* ---------------------------------------------------------------- */
  /*  Contributions (Schedule A)                                      */
  /* ---------------------------------------------------------------- */

  searchContributions(params: FecParams, query: CursorQuery, ctx: Context): Promise<SeekResult> {
    return this.fetchSeek('/schedules/schedule_a/', params, query, ctx);
  }

  getContributionAggregates(mode: string, params: FecParams, ctx: Context): Promise<PageResult> {
    const paths: Record<string, string> = {
      by_size: '/schedules/schedule_a/by_size/',
      by_size_candidate: '/schedules/schedule_a/by_size/by_candidate/',
      by_state: '/schedules/schedule_a/by_state/',
      by_state_candidate: '/schedules/schedule_a/by_state/by_candidate/',
      by_employer: '/schedules/schedule_a/by_employer/',
      by_occupation: '/schedules/schedule_a/by_occupation/',
    };
    const path = paths[mode];
    if (!path) throw new Error(`Unknown contribution aggregate mode: ${mode}`);
    return this.fetchPage(path, params, ctx);
  }

  /* ---------------------------------------------------------------- */
  /*  Disbursements (Schedule B)                                      */
  /* ---------------------------------------------------------------- */

  searchDisbursements(params: FecParams, query: CursorQuery, ctx: Context): Promise<SeekResult> {
    return this.fetchSeek('/schedules/schedule_b/', params, query, ctx);
  }

  getDisbursementAggregates(mode: string, params: FecParams, ctx: Context): Promise<PageResult> {
    const paths: Record<string, string> = {
      by_purpose: '/schedules/schedule_b/by_purpose/',
      by_recipient: '/schedules/schedule_b/by_recipient/',
      by_recipient_id: '/schedules/schedule_b/by_recipient_id/',
    };
    const path = paths[mode];
    if (!path) throw new Error(`Unknown disbursement aggregate mode: ${mode}`);
    return this.fetchPage(path, params, ctx);
  }

  /* ---------------------------------------------------------------- */
  /*  Independent Expenditures (Schedule E)                           */
  /* ---------------------------------------------------------------- */

  searchExpenditures(params: FecParams, query: CursorQuery, ctx: Context): Promise<SeekResult> {
    return this.fetchSeek('/schedules/schedule_e/', params, query, ctx);
  }

  getExpendituresByCandidate(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/schedules/schedule_e/by_candidate/', params, ctx);
  }

  /* ---------------------------------------------------------------- */
  /*  Filings                                                         */
  /* ---------------------------------------------------------------- */

  searchFilings(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/filings/', params, ctx);
  }

  /* ---------------------------------------------------------------- */
  /*  Elections                                                       */
  /* ---------------------------------------------------------------- */

  searchElections(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/elections/', params, ctx);
  }

  /** Search elections with ZIP support — uses /elections/search/ which accepts zip. */
  searchElectionsByZip(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/elections/search/', params, ctx);
  }

  /** Fetch election summary — flat response (no pagination wrapper). */
  async getElectionSummary(params: FecParams, ctx: Context): Promise<ElectionSummary> {
    const url = this.buildUrl('/elections/summary/', params);
    const reqCtx = toRequestContext(ctx);
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.config.fecRequestTimeout, reqCtx, {
            signal: ctx.signal,
          });
          const body = (await response.json()) as ElectionSummary;
          if (typeof body?.count !== 'number') {
            throw new Error('FEC API returned an unexpected response (possible HTML error page)');
          }
          return body;
        },
        {
          maxRetries: this.config.fecMaxRetries,
          baseDelayMs: 1_000,
          operation: 'FEC /elections/summary/',
          context: reqCtx,
          signal: ctx.signal,
          isTransient: isTransientFecError,
        },
      );
    } catch (err) {
      rethrowSanitized(err);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Legal                                                           */
  /* ---------------------------------------------------------------- */

  searchLegal(params: FecParams, ctx: Context): Promise<LegalResult> {
    return this.fetchLegalSearch(params, ctx);
  }

  /* ---------------------------------------------------------------- */
  /*  Calendar                                                        */
  /* ---------------------------------------------------------------- */

  getCalendarDates(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/calendar-dates/', params, ctx);
  }

  getReportingDates(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/reporting-dates/', params, ctx);
  }

  getElectionDates(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/election-dates/', params, ctx);
  }
}

/* ------------------------------------------------------------------ */
/*  Error sanitization                                                */
/* ------------------------------------------------------------------ */

/** Strip API key values from error messages to prevent leaking secrets in tool output. */
function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/api_key=[^&\s"')]+/g, 'api_key=REDACTED');
}

/** Map HTTP status codes from upstream FEC API to actionable messages. */
function enrichStatusError(msg: string): string {
  const sanitized = sanitizeErrorMessage(msg);
  const statusMatch = sanitized.match(/Status:\s*(\d{3})/);
  if (!statusMatch) return sanitized;
  const status = Number(statusMatch[1]);
  const hints: Record<number, string> = {
    400: 'Bad request — check parameter names and types.',
    403: 'Forbidden — the API key may be invalid or expired.',
    404: 'Endpoint not found — verify the API path.',
    422: 'The FEC API rejected the request parameters. Check required fields and value formats for this endpoint.',
    429: 'FEC API rate limit exceeded. Wait a moment and retry.',
    500: 'FEC API internal error. Retry shortly.',
    502: 'FEC API is temporarily unreachable. Retry shortly.',
    503: 'FEC API is temporarily unavailable. Retry shortly.',
  };
  const hint = hints[status];
  return hint ? `${sanitized} — ${hint}` : sanitized;
}

/**
 * Re-throw an error with its message sanitized (API key stripped)
 * and enriched with actionable context for HTTP status errors.
 * Preserves McpError code and data; wraps plain Errors as new instances.
 * Preserves the original error as `cause` for internal debugging.
 */
function rethrowSanitized(err: unknown): never {
  if (err instanceof McpError) {
    throw new McpError(err.code, enrichStatusError(err.message), err.data, { cause: err });
  }
  if (err instanceof Error) {
    const clean = new Error(enrichStatusError(err.message), { cause: err });
    clean.name = err.name;
    throw clean;
  }
  throw err;
}

/* ------------------------------------------------------------------ */
/*  Transient error classification                                    */
/* ------------------------------------------------------------------ */

/** Error codes the framework assigns to retryable upstream failures. */
const TRANSIENT_ERROR_CODES: ReadonlySet<number> = new Set([
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.RateLimited,
]);

/**
 * Classify errors as transient for retry purposes.
 *
 * A structured `McpError` is classified by code — `fetchWithTimeout` maps
 * timeouts, 429s, and 5xx responses onto the transient set before this runs.
 * The message heuristics below only cover errors that never reached the
 * framework's classifier (raw socket failures, upstream HTML error pages).
 */
function isTransientFecError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof McpError && TRANSIENT_ERROR_CODES.has(error.code)) return true;
  const msg = 'message' in error ? String((error as { message: string }).message) : '';
  if (msg.includes('ServiceUnavailable') || msg.includes('503') || msg.includes('502')) return true;
  if (msg.includes('429') || msg.includes('OVER_RATE_LIMIT') || msg.includes('rate limit')) {
    return true;
  }
  if (msg.includes('unexpected response') || msg.includes('HTML error page')) return true;
  if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Singleton accessor                                                */
/* ------------------------------------------------------------------ */

let _service: OpenFecService | undefined;

export function initOpenFecService(): void {
  _service = new OpenFecService();
}

export function getOpenFecService(): OpenFecService {
  if (!_service)
    throw new Error('OpenFecService not initialized — call initOpenFecService() in setup()');
  return _service;
}
