/**
 * @fileoverview OpenFEC API service. Wraps all FEC REST API interactions
 * with timeout, retry, and pagination handling. Single service used by
 * all tools and resources.
 * @module src/services/openfec/openfec-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
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
/*  Outbound parameter-name guard                                     */
/* ------------------------------------------------------------------ */

/**
 * Accepted query-parameter names per endpoint, copied verbatim from
 * `docs/openapi-spec.json`. OpenFEC answers HTTP 200 for a parameter name it
 * does not recognize and silently drops the filter, so a misspelled or
 * wrong-endpoint name returns a full, unfiltered result set that looks correct.
 * Checking the outbound names against the spec turns that into a loud failure.
 *
 * Endpoints absent from this map are not checked — entries are added as the
 * endpoints they cover are worked on, not by auditing the whole spec at once.
 */
const paramSet = (names: string): ReadonlySet<string> => new Set(names.trim().split(/\s+/));

const ENDPOINT_PARAMS: Record<string, ReadonlySet<string>> = {
  '/schedules/schedule_a/by_employer/': paramSet(`
    page per_page cycle employer committee_id sort sort_hide_null sort_null_only
    sort_nulls_last`),

  '/schedules/schedule_a/by_occupation/': paramSet(`
    page per_page cycle occupation committee_id sort sort_hide_null sort_null_only
    sort_nulls_last`),

  '/schedules/schedule_a/by_size/': paramSet(`
    page per_page cycle size committee_id sort sort_hide_null sort_null_only sort_nulls_last`),

  '/schedules/schedule_a/by_size/by_candidate/': paramSet(`
    page per_page candidate_id cycle election_full sort sort_hide_null sort_null_only
    sort_nulls_last`),

  '/schedules/schedule_a/by_state/': paramSet(`
    page per_page cycle state committee_id hide_null sort sort_hide_null sort_null_only
    sort_nulls_last`),

  '/schedules/schedule_a/by_state/by_candidate/': paramSet(`
    page per_page candidate_id cycle election_full sort sort_hide_null sort_null_only
    sort_nulls_last`),

  '/schedules/schedule_b/': paramSet(`
    image_number min_image_number max_image_number min_amount max_amount min_date max_date
    committee_id disbursement_description disbursement_purpose_category last_disbursement_amount
    last_disbursement_date line_number recipient_city recipient_committee_id recipient_name
    recipient_state spender_committee_designation spender_committee_org_type spender_committee_type
    two_year_transaction_period per_page last_index sort sort_hide_null sort_null_only`),

  '/schedules/schedule_e/': paramSet(`
    image_number min_image_number max_image_number min_amount max_amount min_date max_date
    candidate_office candidate_party candidate_office_state candidate_office_district cycle
    committee_id candidate_id filing_form last_expenditure_date last_expenditure_amount
    last_office_total_ytd payee_name support_oppose_indicator last_support_oppose_indicator
    is_notice min_dissemination_date max_dissemination_date min_filing_date max_filing_date
    most_recent q_spender form_line_number per_page last_index sort sort_hide_null sort_null_only
    sort_nulls_last`),

  '/schedules/schedule_e/by_candidate/': paramSet(`
    page per_page state district cycle office election_full candidate_id committee_id
    support_oppose sort sort_hide_null sort_null_only sort_nulls_last`),

  '/legal/search/': paramSet(`
    q from_hit hits_returned type ao_no ao_year ao_name ao_min_issue_date ao_max_issue_date
    ao_min_request_date ao_max_request_date ao_min_document_date ao_max_document_date
    ao_doc_category_id ao_is_pending ao_status ao_requestor ao_requestor_type
    ao_regulatory_citation ao_statutory_citation ao_citation_require_all ao_commenter
    ao_representative case_no case_respondents case_election_cycles case_min_open_date
    primary_subject_id secondary_subject_id case_max_open_date case_min_close_date
    case_max_close_date case_min_document_date case_max_document_date case_regulatory_citation
    case_statutory_citation case_citation_require_all q_exclude case_doc_category_id mur_type
    mur_disposition_category_id af_name af_committee_id af_report_year af_min_rtb_date
    af_max_rtb_date af_rtb_fine_amount af_min_fd_date af_max_fd_date af_fd_fine_amount sort
    case_min_penalty_amount case_max_penalty_amount q_proximity max_gaps proximity_preserve_order
    proximity_filter proximity_filter_term filename`),

  /** Takes no query parameter beyond `api_key`; both inputs ride in the path. */
  '/legal/docs/{doc_type}/{no}': new Set<string>(),

  '/schedules/schedule_f/': paramSet(`
    image_number min_image_number max_image_number min_amount max_amount min_date max_date
    candidate_id payee_name committee_id cycle form_line_number page per_page sort
    sort_hide_null sort_null_only sort_nulls_last`),

  '/committee/{committee_id}/totals/': paramSet(`
    page per_page cycle sort sort_hide_null sort_null_only sort_nulls_last`),

  '/totals/{entity_type}/': paramSet(`
    page per_page cycle committee_designation committee_id committee_type committee_state
    filing_frequency treasurer_name min_disbursements max_disbursements min_receipts max_receipts
    min_last_cash_on_hand_end_period max_last_cash_on_hand_end_period
    min_last_debts_owed_by_committee max_last_debts_owed_by_committee sponsor_candidate_id
    organization_type min_first_f1_date max_first_f1_date sort sort_hide_null sort_null_only
    sort_nulls_last`),

  '/elections/summary/': paramSet(`state district cycle office election_full`),
};

/**
 * Interpolated request paths mapped back to the spec template their allowlist
 * entry is keyed on. `buildUrl` receives the path with the identifier already
 * substituted, so without this step the guard silently skips every endpoint
 * that takes one in the path.
 */
const PATH_TEMPLATES: readonly (readonly [RegExp, string])[] = [
  [/^\/legal\/docs\/[^/]+\/[^/]+$/, '/legal/docs/{doc_type}/{no}'],
  [/^\/committee\/[^/]+\/totals\/$/, '/committee/{committee_id}/totals/'],
  [
    /^\/totals\/(presidential|pac|party|pac-party|house-senate|ie-only)\/$/,
    '/totals/{entity_type}/',
  ],
];

/** Resolve a request path to its allowlist key, or return it unchanged. */
function allowlistKey(path: string): string {
  return PATH_TEMPLATES.find(([pattern]) => pattern.test(path))?.[1] ?? path;
}

/**
 * Throw when an outbound parameter name is not one the endpoint accepts.
 * Only the names are reported — values may carry caller data.
 */
export function assertKnownParams(path: string, params: FecParams): void {
  const key = allowlistKey(path);
  const accepted = ENDPOINT_PARAMS[key];
  if (!accepted) return;
  const unknown = Object.keys(params)
    .filter((name) => !accepted.has(name))
    .sort();
  if (unknown.length === 0) return;
  throw new McpError(
    JsonRpcErrorCode.InternalError,
    `Refusing to call ${key} with parameter(s) it does not accept: ${unknown.join(', ')}. OpenFEC would answer 200 and silently ignore them, returning an unfiltered result set.`,
    { endpoint: key, unknown_parameters: unknown },
  );
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

  /**
   * Build a full URL with query params, injecting the API key.
   * Every outbound request funnels through here, so this is where parameter
   * names are checked against the endpoint's accepted set.
   */
  private buildUrl(path: string, params: FecParams = {}): string {
    assertKnownParams(path, params);
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
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.config.fecRequestTimeout, ctx, {
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
          context: ctx,
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
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.config.fecRequestTimeout, ctx, {
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
          context: ctx,
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
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.config.fecRequestTimeout, ctx, {
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
          context: ctx,
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

  /**
   * Per-cycle financial totals for one committee. OpenFEC answers 404 for every
   * miss here — an ID that does not exist, a cycle the committee did not file,
   * and a committee that has never filed a Form 3/3X/3P alike — so its own
   * not-found response is normalized to an empty page. "No totals on file" is a
   * result the caller reports, not an API-path error.
   */
  async getCommitteeTotals(
    committeeId: string,
    params: FecParams,
    ctx: Context,
  ): Promise<PageResult> {
    try {
      return await this.fetchPage(`/committee/${committeeId}/totals/`, params, ctx);
    } catch (err) {
      if (!isUpstreamNotFound(err)) throw err;
      return emptyPage(params);
    }
  }

  /** Committee totals grouped by entity type — a page of committees, not one committee. */
  getCommitteeTotalsByEntityType(
    entityType: string,
    params: FecParams,
    ctx: Context,
  ): Promise<PageResult> {
    return this.fetchPage(`/totals/${entityType}/`, params, ctx);
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
  /*  Coordinated Expenditures (Schedule F)                           */
  /* ---------------------------------------------------------------- */

  searchCoordinatedExpenditures(params: FecParams, ctx: Context): Promise<PageResult> {
    return this.fetchPage('/schedules/schedule_f/', params, ctx);
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
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.config.fecRequestTimeout, ctx, {
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
          context: ctx,
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

  /**
   * Fetch one legal document by type and number. Neither of the two envelopes
   * this endpoint answers with is the `results` array `fetchPage` expects, so
   * it needs its own fetch. Resolves to null when no such record exists.
   */
  async getLegalDocument(
    docType: string,
    no: string,
    ctx: Context,
  ): Promise<Record<string, unknown> | null> {
    const path = `/legal/docs/${encodeURIComponent(docType)}/${encodeURIComponent(no)}`;
    const url = this.buildUrl(path, {});
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.config.fecRequestTimeout, ctx, {
            signal: ctx.signal,
          });
          return unwrapLegalDocument(await response.json());
        },
        {
          maxRetries: this.config.fecMaxRetries,
          baseDelayMs: 1_000,
          operation: `FEC ${path}`,
          context: ctx,
          signal: ctx.signal,
          isTransient: isTransientFecError,
        },
      );
    } catch (err) {
      if (isUpstreamNotFound(err)) return null;
      rethrowSanitized(err);
    }
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
/*  Upstream "no such record" handling                                */
/* ------------------------------------------------------------------ */

/**
 * True when OpenFEC itself answered "no such record" — a 404 whose body is the
 * API's own JSON error object. Callers treat that as an empty result rather
 * than a failure, since the generic status hint ("verify the API path") points
 * at the wrong thing when the real problem is an unknown ID.
 *
 * The body check is load-bearing, not decoration: the api.data.gov edge also
 * answers 404 with a plain-text routing error when the whole upstream host is
 * unreachable, and reporting that as "this committee has no totals" would be a
 * confidently wrong answer. Anything that is not the API's JSON error shape
 * stays a failure and propagates.
 */
function isUpstreamNotFound(err: unknown): boolean {
  if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.NotFound) return false;
  const body = (err.data as { body?: unknown } | undefined)?.body;
  if (typeof body !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && 'message' in parsed;
  } catch {
    return false;
  }
}

/**
 * Narrow a `/legal/docs/{doc_type}/{no}` body to the single record it carries.
 *
 * Live responses wrap the record in a `docs` array; `docs/openapi-spec.json`
 * documents a flat object with the same fields at the top level. Both shapes
 * are accepted. A `docs` array holding a record wins, since the flat schema
 * declares a `docs` property of its own — an empty one there is not evidence
 * of a miss, only a body that is nothing but an empty `docs` is.
 */
function unwrapLegalDocument(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('FEC API returned an unexpected response (possible HTML error page)');
  }
  const record = body as Record<string, unknown>;
  const first = Array.isArray(record.docs) ? record.docs[0] : undefined;
  if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
    return first as Record<string, unknown>;
  }
  const keys = Object.keys(record);
  if (keys.length === 0 || (keys.length === 1 && keys[0] === 'docs')) return null;
  return record;
}

/** A zero-result page echoing the paging arguments the request carried. */
function emptyPage(params: FecParams): PageResult {
  return {
    pagination: {
      page: Number(params.page) || 1,
      pages: 0,
      count: 0,
      per_page: Number(params.per_page) || 20,
    },
    results: [],
  };
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
    504: 'The FEC API timed out running this query. Narrow it — supply cycle, a committee_id or candidate_id, or a tighter date range — then retry.',
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

/**
 * Classify errors as transient for retry purposes.
 *
 * A structured `McpError` is handed to the framework's own `defaultIsTransient`
 * — `fetchWithTimeout` maps timeouts, 429s, and 5xx responses onto the transient
 * set before this runs, and delegating keeps that set from being mirrored here,
 * where it would drift. Delegating also honors the in-band `data.retryable:
 * false` opt-out, which is what keeps a 501 out of the ladder now that it
 * classifies `ServiceUnavailable` like every other 5xx.
 *
 * The message heuristics below only cover errors that never reached the
 * framework's classifier (raw socket failures, upstream HTML error pages).
 * `withRetry`'s `isTransient` replaces the default outright, so a plain `Error`
 * reaches them rather than being assumed transient.
 */
function isTransientFecError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof McpError) return defaultIsTransient(error);
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
