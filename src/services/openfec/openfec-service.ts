/**
 * @fileoverview OpenFEC API service. Wraps all FEC REST API interactions
 * with timeout, retry, and pagination handling. Single service used by
 * all tools and resources.
 * @module src/services/openfec/openfec-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
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

/** Encode `last_indexes` from SEEK pagination into an opaque cursor. */
export function encodeCursor(lastIndexes: Record<string, string>): string {
  return btoa(JSON.stringify(lastIndexes));
}

/** Decode an opaque cursor back to `last_indexes` query params. */
export function decodeCursor(cursor: string): Record<string, string> {
  return JSON.parse(atob(cursor));
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
      if (value !== undefined && value !== '') {
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
   * Returns a `nextCursor` from `last_indexes` when more results exist.
   */
  private async fetchSeek<T = Record<string, unknown>>(
    path: string,
    params: FecParams,
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
            nextCursor: hasMore ? encodeCursor(lastIndexes) : null,
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

  /* ---------------------------------------------------------------- */
  /*  Committees                                                      */
  /* ---------------------------------------------------------------- */

  searchCommittees(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/committees/', params, ctx);
  }

  getCommittee(committeeId: string, ctx: Context): Promise<PageResult> {
    return this.fetchPage(`/committee/${committeeId}/`, {}, ctx);
  }

  /* ---------------------------------------------------------------- */
  /*  Contributions (Schedule A)                                      */
  /* ---------------------------------------------------------------- */

  searchContributions(params: FecParams, ctx: Context): Promise<SeekResult> {
    return this.fetchSeek('/schedules/schedule_a/', params, ctx);
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

  searchDisbursements(params: FecParams, ctx: Context): Promise<SeekResult> {
    return this.fetchSeek('/schedules/schedule_b/', params, ctx);
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

  searchExpenditures(params: FecParams, ctx: Context): Promise<SeekResult> {
    return this.fetchSeek('/schedules/schedule_e/', params, ctx);
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
  const statusMatch = msg.match(/Status:\s*(\d{3})/);
  if (!statusMatch) return msg;
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
  return hint ? `${sanitizeErrorMessage(msg)} — ${hint}` : sanitizeErrorMessage(msg);
}

/**
 * Re-throw an error with its message sanitized (API key stripped)
 * and enriched with actionable context for HTTP status errors.
 * Preserves the original error as `cause` for internal debugging.
 */
function rethrowSanitized(err: unknown): never {
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

/** Classify errors as transient for retry purposes. */
function isTransientFecError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
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
