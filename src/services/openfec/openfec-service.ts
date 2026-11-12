/**
 * @fileoverview OpenFEC API service. Wraps all FEC REST API interactions
 * with timeout, retry, and pagination handling. Single service used by
 * all tools and resources.
 * @module src/services/openfec/openfec-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  fetchWithTimeout,
  type RetryAttempt,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import type {
  ElectionSummary,
  FecLegalEnvelope,
  FecPageEnvelope,
  FecParams,
  FecSeekEnvelope,
  LegalDocType,
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

/**
 * Cursor payload as it is serialized: `q` = issuing query, `i` = `last_indexes`,
 * `n` = rows delivered through the page that minted it.
 */
interface CursorPayload {
  i: Record<string, string>;
  n?: number;
  q: CursorQuery;
}

/** Where a keyset walk resumes: the upstream keys, and how many rows came before. */
export interface CursorPosition {
  /**
   * Rows delivered by the pages before this one, which lets an exact count say
   * the walk is over. A cursor minted without it reads as 0, which can only
   * under-count the position — it never ends a walk early.
   */
  delivered: number;
  /** `last_indexes` query params to send upstream. */
  indexes: Record<string, string>;
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
 * Encode `last_indexes`, the issuing query, and the rows delivered so far into
 * an opaque cursor. Index values are stringified first — OpenFEC returns some
 * of them as raw numbers (Schedule E's `last_office_total_ytd`), and they go
 * back out as query params either way.
 */
export function encodeCursor(
  lastIndexes: Record<string, string | number>,
  query: CursorQuery,
  delivered?: number,
): string {
  const i = Object.fromEntries(
    Object.entries(lastIndexes).map(([key, value]) => [key, String(value)]),
  );
  const payload: CursorPayload =
    delivered === undefined ? { q: query, i } : { q: query, i, n: delivered };
  return btoa(JSON.stringify(payload));
}

/**
 * Decode an opaque cursor back to its resume position: the `last_indexes`
 * query params and the rows delivered before it.
 * Throws a `validationError` when the cursor is malformed (`invalid_cursor`)
 * or was issued for a different query (`cursor_query_mismatch`).
 */
export function decodeCursor(cursor: string, expected: CursorQuery): CursorPosition {
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

  return { indexes: payload.i, delivered: payload.n ?? 0 };
}

/** True when `value` is a plain object whose values are all strings. */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

/** Narrow a decoded cursor body to a `CursorPayload`, or `null` when the shape is wrong. */
function parseCursorPayload(raw: unknown): CursorPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { q, i, n } = raw as { q?: unknown; i?: unknown; n?: unknown };
  if (!isStringRecord(i) || typeof q !== 'object' || q === null) return null;
  if (n !== undefined && !(Number.isSafeInteger(n) && (n as number) >= 0)) return null;
  const { scope, args } = q as { scope?: unknown; args?: unknown };
  if (typeof scope !== 'string' || !isStringRecord(args)) return null;
  return n === undefined ? { q: { scope, args }, i } : { q: { scope, args }, i, n: n as number };
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

  '/committee/{committee_id}/history/': paramSet(`
    page per_page election_full designation sort sort_hide_null sort_null_only sort_nulls_last`),

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

  '/election-dates/': paramSet(`
    page per_page election_state election_district election_party office_sought
    min_election_date max_election_date election_type_id min_create_date max_create_date
    min_update_date max_update_date election_year min_primary_general_date
    max_primary_general_date sort sort_hide_null sort_null_only sort_nulls_last`),
};

/**
 * Interpolated request paths mapped back to the spec template their allowlist
 * entry is keyed on. `buildUrl` receives the path with the identifier already
 * substituted, so without this step the guard silently skips every endpoint
 * that takes one in the path.
 */
const PATH_TEMPLATES: readonly (readonly [RegExp, string])[] = [
  [/^\/legal\/docs\/[^/]+\/[^/]+$/, '/legal/docs/{doc_type}/{no}'],
  [/^\/committee\/[^/]+\/history\/$/, '/committee/{committee_id}/history/'],
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
/*  Legal search document types                                       */
/* ------------------------------------------------------------------ */

/** Every `/legal/search/` document type, in the order results are flattened. */
export const LEGAL_DOC_TYPES = [
  'advisory_opinions',
  'murs',
  'adrs',
  'admin_fines',
  'statutes',
] as const satisfies readonly LegalDocType[];

/** The singular `document_type` each flattened result is tagged with, keyed by its plural type. */
export const LEGAL_DOCUMENT_TYPE: Readonly<Record<LegalDocType, string>> = {
  advisory_opinions: 'advisory_opinion',
  murs: 'mur',
  adrs: 'adr',
  admin_fines: 'admin_fine',
  statutes: 'statute',
};

/* ------------------------------------------------------------------ */
/*  Pagination normalization                                          */
/* ------------------------------------------------------------------ */

/**
 * The upstream count-exactness flag as a spreadable fragment. An absent flag
 * stays absent: OpenFEC declares `is_count_exact` optional, and defaulting it
 * to `false` would label an exact count an estimate.
 */
function exactness(value: boolean | undefined): { is_count_exact?: boolean } {
  return value === undefined ? {} : { is_count_exact: value };
}

/* ------------------------------------------------------------------ */
/*  Committee totals across committee-type changes                    */
/* ------------------------------------------------------------------ */

/**
 * The OpenFEC table a committee type's totals live in, as OpenFEC's own
 * `totals_schema_map` assigns it (`webservices/resources/totals.py`): P to the
 * presidential table, H and S to house-senate, I to ie-only, and every other
 * type — PACs and parties — to pac-party. `/committee/{committee_id}/totals/`
 * reads only the table its newest matching history row maps to, so a committee
 * that changed type (a campaign committee converted to a PAC) loses every
 * cycle filed under the earlier type unless each table is asked for its own.
 */
type TotalsTable = 'presidential' | 'house-senate' | 'ie-only' | 'pac-party';

function totalsTable(committeeType: unknown): TotalsTable {
  switch (committeeType) {
    case 'P':
      return 'presidential';
    case 'H':
    case 'S':
      return 'house-senate';
    case 'I':
      return 'ie-only';
    default:
      return 'pac-party';
  }
}

/**
 * Page size for the history read and for each per-table totals read. Both hold
 * one row per two-year cycle, so one page of 100 covers every cycle since the
 * FEC began publishing.
 */
const WHOLE_HISTORY_PER_PAGE = 100;

/**
 * Wall-clock budget shared by every request an omitted-cycle totals call makes,
 * retries and backoffs included. MCP SDK clients abandon a request after 60 s
 * by default; settling at 50 s leaves the answer, partial or not, time to
 * reach them.
 */
const ALL_CYCLES_DEADLINE_MS = 50_000;

/** How completely an omitted-cycle totals call read the committee's history. */
export type CycleCoverage =
  /** Every totals table the committee's history spans was read and merged. */
  | { kind: 'complete' }
  /**
   * The history read failed, so the page is the one OpenFEC answers when no
   * cycle is sent — the newest type's table alone — and cycles filed under an
   * earlier committee type are unknown.
   */
  | { kind: 'history_unavailable' }
  /**
   * The history files these cycles under another committee type, and the page
   * lacks them: their table could not be read, or the newest table could not
   * be read whole for the merge, leaving the caller's page of it alone.
   */
  | { kind: 'cycles_unavailable'; cycles: number[] };

/** Result of `OpenFecService.getCommitteeTotalsAllCycles`. */
export interface AllCyclesTotals {
  coverage: CycleCoverage;
  totals: PageResult;
}

/**
 * The cycles a committee's history files under each totals table, newest table
 * first — the one an unfiltered totals request reads. A row without a numeric
 * cycle cannot be attributed and is skipped.
 */
function cyclesByTable(history: Record<string, unknown>[]): Map<TotalsTable, number[]> {
  const filed = history
    .flatMap((row) =>
      typeof row.cycle === 'number'
        ? [{ cycle: row.cycle, table: totalsTable(row.committee_type) }]
        : [],
    )
    .sort((a, b) => b.cycle - a.cycle);
  const tables = new Map<TotalsTable, number[]>();
  for (const { cycle, table } of filed) {
    const cycles = tables.get(table);
    if (cycles) cycles.push(cycle);
    else tables.set(table, [cycle]);
  }
  return tables;
}

/** True when a page holds every row its query matched: none matched, or page 1 holds them all. */
function holdsEveryRow({ pagination, results }: PageResult): boolean {
  return pagination.count === 0 || (pagination.page === 1 && results.length >= pagination.count);
}

/**
 * One page of merged totals rows, ordered and paged as OpenFEC orders and pages
 * one table: `sort` defaults to `-cycle`, and a missing value sorts where
 * PostgreSQL puts NULL — after every value ascending, before every value
 * descending. Every column the tool sorts on is numeric.
 */
function pageOfTotals(rows: Record<string, unknown>[], params: FecParams): PageResult {
  const sort = typeof params.sort === 'string' && params.sort !== '' ? params.sort : '-cycle';
  const descending = sort.startsWith('-');
  const field = descending ? sort.slice(1) : sort;
  const key = (row: Record<string, unknown>) => {
    const value = row[field];
    return typeof value === 'number' ? value : Number.POSITIVE_INFINITY;
  };
  const sorted = rows.toSorted((a, b) => {
    const diff = key(a) - key(b);
    if (Number.isNaN(diff)) return 0;
    return descending ? -diff : diff;
  });
  const page = Number(params.page) || 1;
  const perPage = Number(params.per_page) || 20;
  return {
    pagination: {
      page,
      pages: Math.ceil(sorted.length / perPage),
      count: sorted.length,
      per_page: perPage,
      is_count_exact: true,
    },
    results: sorted.slice((page - 1) * perPage, page * perPage),
  };
}

/** Milliseconds left of a budget of `totalMs` that starts now, never below 0. */
function countdown(totalMs: number): () => number {
  const startedAt = Date.now();
  return () => Math.max(0, totalMs - (Date.now() - startedAt));
}

/**
 * The rate limit a shared-deadline expiry hides. When the deadline runs out
 * during the backoff after a 429, `withRetry` reports a `Timeout` caused by
 * that 429; the caller's next step is still the 429's — wait out the window —
 * so the 429 is what the call reports.
 */
function rateLimitBehindDeadline(err: unknown): McpError | undefined {
  if (!(err instanceof McpError) || err.data?.reason !== 'retry_deadline_exceeded') return;
  for (let cause: unknown = err.cause; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof McpError && cause.code === JsonRpcErrorCode.RateLimited) return cause;
  }
  return;
}

/** Rethrow a failed omitted-cycle read, surfacing a rate limit a deadline expiry hides. */
function throwReadFailure(err: unknown): never {
  const rateLimit = rateLimitBehindDeadline(err);
  if (rateLimit) rethrowSanitized(rateLimit);
  throw err;
}

/**
 * Whether a failed history-driven read leaves the reads that succeeded
 * standing as a disclosed partial answer. Only a caller cancellation and a
 * rate limit — the caller's next step is to stop or to wait, whatever the
 * other reads found — fail the call. Any other failure (a 4xx, a 5xx, a
 * timeout, a dropped connection, a malformed answer) leaves a gap the
 * coverage notice names, never a rejected call the unfiltered page answered.
 */
function degradesToPartial(err: unknown, ctx: Context): boolean {
  if (ctx.signal.aborted || rateLimitBehindDeadline(err)) return false;
  return !(err instanceof McpError && err.code === JsonRpcErrorCode.RateLimited);
}

/**
 * Throw unless `answer` can stand as a disclosed partial answer: every failed
 * read degrades, and the answer holds totals. An empty answer would read as
 * "no totals on file", which the failed reads leave unproven.
 */
function assertPartialAnswer(failures: unknown[], answer: PageResult, ctx: Context): void {
  const fatal =
    failures.find((err) => !degradesToPartial(err, ctx)) ??
    (answer.pagination.count === 0 ? failures[0] : undefined);
  if (fatal !== undefined) throwReadFailure(fatal);
}

/**
 * What a 2xx answer that is not an OpenFEC envelope — an edge error page served
 * with 200, an envelope without its `results` array — fails with: an upstream
 * outage, retried like a 503 and reported as `ServiceUnavailable` once the
 * retries run out.
 */
function unexpectedResponse(cause?: unknown): McpError {
  return serviceUnavailable(
    'FEC API returned an unexpected response (possible HTML error page)',
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

/** Per-request options for `fetchPage`. */
interface FetchPageOptions {
  /** Wall-clock budget across every attempt and backoff of this request — `withRetry`'s `deadlineMs`. */
  deadlineMs?: number;
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
   * GET `url` under the service timeout and the caller's signal and parse the
   * body as JSON. The body of a non-2xx answer rides the thrown error's `data`;
   * `rethrowSanitized` decides which bodies go on to the client. A 2xx body
   * that is not JSON — an edge maintenance or error page served with 200 —
   * fails as `unexpectedResponse`, which is retried, rather than as the
   * parser's `SyntaxError`, which the framework reads as a caller-input error
   * and whose message quotes the page. Inside a retry ladder with a deadline,
   * `attempt` carries the signal that also fires at the deadline and the time
   * left before it, which caps this request's own timeout.
   */
  private async getJson(url: string, ctx: Context, attempt?: RetryAttempt): Promise<unknown> {
    const timeoutMs = Math.min(
      this.config.fecRequestTimeout,
      attempt?.remainingMs ?? Number.POSITIVE_INFINITY,
    );
    const response = await fetchWithTimeout(url, timeoutMs, ctx, {
      signal: attempt?.signal ?? ctx.signal,
      exposeErrorBody: true,
    });
    try {
      return await response.json();
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      throw unexpectedResponse(err);
    }
  }

  /**
   * Fetch JSON from a page-based endpoint with retry.
   * Wraps the full pipeline (fetch + JSON parse) in the retry boundary.
   * `options.deadlineMs` bounds the whole ladder — every attempt and backoff.
   */
  private async fetchPage<T = Record<string, unknown>>(
    path: string,
    params: FecParams,
    ctx: Context,
    options: FetchPageOptions = {},
  ): Promise<PageResult<T>> {
    const url = this.buildUrl(path, params);
    try {
      return await withRetry(
        async (attempt) => {
          const body = (await this.getJson(url, ctx, attempt)) as FecPageEnvelope<T>;
          this.validateEnvelope(body);
          return {
            pagination: {
              page: body.pagination?.page ?? 1,
              pages: body.pagination?.pages ?? 1,
              count: body.pagination?.count ?? body.results.length,
              per_page: body.pagination?.per_page ?? 20,
              ...exactness(body.pagination?.is_count_exact),
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
          ...options,
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
   * `delivered` is the rows the walk returned before this page (the resumed
   * cursor's `CursorPosition.delivered`, 0 on a first page).
   */
  private async fetchSeek<T = Record<string, unknown>>(
    path: string,
    params: FecParams,
    query: CursorQuery,
    ctx: Context,
    delivered: number,
  ): Promise<SeekResult<T>> {
    const url = this.buildUrl(path, params);
    try {
      return await withRetry(
        async () => {
          const body = (await this.getJson(url, ctx)) as FecSeekEnvelope<T>;
          this.validateEnvelope(body);
          const { count, is_count_exact, last_indexes: lastIndexes } = body.pagination;
          /** Optional in the upstream SeekInfo schema, and it decides whether a cursor is minted — same fallback fetchPage uses. */
          const per_page = body.pagination.per_page ?? 20;
          const rows = body.results.length;
          /**
           * OpenFEC populates `last_indexes` for the last row of every page,
           * terminal pages included, so on its own it cannot say whether more
           * rows exist. A page shorter than `per_page` is the end of the set,
           * and so is a full page an exact count says reaches the last row —
           * the SEEK envelope carries no `page` to compare against `pages`,
           * so the cursor carries the running row count instead.
           */
          const deliveredThroughPage = delivered + rows;
          const reachedCount = is_count_exact === true && count <= deliveredThroughPage;
          /** The page past the last row carries `last_indexes: null`, not an omitted key. */
          const hasMore =
            lastIndexes != null &&
            Object.keys(lastIndexes).length > 0 &&
            rows >= per_page &&
            !reachedCount;
          return {
            pagination: { count, per_page, ...exactness(is_count_exact) },
            results: body.results,
            nextCursor: hasMore ? encodeCursor(lastIndexes, query, deliveredThroughPage) : null,
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
          const body = (await this.getJson(url, ctx)) as FecLegalEnvelope;
          const results: LegalResult['results'] = [];
          const typeTotals: LegalResult['typeTotals'] = {};

          for (const type of LEGAL_DOC_TYPES) {
            const documentType = LEGAL_DOCUMENT_TYPE[type];
            for (const doc of body[type] ?? [])
              results.push({ ...doc, document_type: documentType });
            const total = body[`total_${type}`];
            if (typeof total === 'number') typeTotals[type] = total;
          }

          return { results, totalCount: body.total_all ?? results.length, typeTotals };
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

  /**
   * Validate that the API returned a recognizable envelope — an object whose
   * `results` is an array, as every page and keyset envelope in the spec declares.
   */
  private validateEnvelope(body: unknown): void {
    if (
      !body ||
      typeof body !== 'object' ||
      !Array.isArray((body as Record<string, unknown>).results)
    ) {
      throw unexpectedResponse();
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
   * Per-cycle financial totals for one committee. OpenFEC answers 404 when the
   * committee has no history row for the requested cycles (an ID that does not
   * exist, or a cycle it did not file) and 200 with no rows when it has history
   * but no totals row; its own not-found response is normalized to an empty
   * page, so both read alike. "No totals on file" is a result the caller
   * reports, not an API-path error.
   */
  getCommitteeTotals(
    committeeId: string,
    params: FecParams,
    ctx: Context,
    options?: FetchPageOptions,
  ): Promise<PageResult> {
    return emptyOnUpstreamNotFound(
      this.fetchPage(`/committee/${committeeId}/totals/`, params, ctx, options),
      params,
    );
  }

  /**
   * Every cycle a committee has filed totals for, across changes of committee
   * type, paged by `params` (`page`, `per_page`, `sort` — never `cycle`).
   *
   * Without a cycle OpenFEC reads only the totals table of the committee's
   * newest type (`totalsTable`), so the committee's history is read beside
   * that unfiltered request; OpenFEC's own 404 for the history reads as an
   * empty one, as it does for the totals. A history inside one table returns
   * the unfiltered page as it came. Otherwise every other table is asked for
   * the cycles the history files under it, the newest table is read whole
   * when the caller's page did not hold all of it, and the merged rows are
   * sorted and paged here. Those history-driven reads are best-effort: a
   * failed one leaves the reads that succeeded standing, with `coverage`
   * naming the cycles the answer lacks — any 404 included, since the history
   * just named those cycles. A cancellation, a rate limit, and any failure of
   * the unfiltered request still reject. Every request shares one deadline.
   */
  async getCommitteeTotalsAllCycles(
    committeeId: string,
    params: FecParams,
    ctx: Context,
  ): Promise<AllCyclesTotals> {
    const remainingMs = countdown(ALL_CYCLES_DEADLINE_MS);
    const historyParams: FecParams = { per_page: WHOLE_HISTORY_PER_PAGE };
    const readTable = (tableParams: FecParams) =>
      this.fetchPage(`/committee/${committeeId}/totals/`, tableParams, ctx, {
        deadlineMs: remainingMs(),
      });

    const [history, unfilteredRead] = await Promise.allSettled([
      emptyOnUpstreamNotFound(
        this.fetchPage(`/committee/${committeeId}/history/`, historyParams, ctx, {
          deadlineMs: remainingMs(),
        }),
        historyParams,
      ),
      this.getCommitteeTotals(committeeId, params, ctx, { deadlineMs: remainingMs() }),
    ]);
    if (unfilteredRead.status === 'rejected') throwReadFailure(unfilteredRead.reason);
    const unfiltered = unfilteredRead.value;
    if (history.status === 'rejected') {
      assertPartialAnswer([history.reason], unfiltered, ctx);
      return { totals: unfiltered, coverage: { kind: 'history_unavailable' } };
    }

    const otherTables = [...cyclesByTable(history.value.results).values()].slice(1);
    if (otherTables.length === 0) return { totals: unfiltered, coverage: { kind: 'complete' } };

    const [newestRead, ...otherReads] = await Promise.allSettled([
      holdsEveryRow(unfiltered) ? unfiltered : readTable({ per_page: WHOLE_HISTORY_PER_PAGE }),
      ...otherTables.map((cycles) =>
        readTable({ cycle: cycles.map(String), per_page: WHOLE_HISTORY_PER_PAGE }),
      ),
    ]);
    const failures = [newestRead, ...otherReads].flatMap((read) =>
      read.status === 'rejected' ? [read.reason] : [],
    );

    /** Without the whole newest table the merge cannot be paged, so the caller's page of it stands alone. */
    if (newestRead.status === 'rejected') {
      assertPartialAnswer(failures, unfiltered, ctx);
      return {
        totals: unfiltered,
        coverage: { kind: 'cycles_unavailable', cycles: otherTables.flat() },
      };
    }

    /**
     * Each cycle is answered by the table its history row names, as an explicit
     * `cycle` request is: a row the newest table also holds for such a cycle
     * gives way to that table's.
     */
    const otherRows = otherReads.flatMap((read) =>
      read.status === 'fulfilled' ? read.value.results : [],
    );
    const otherCycles = new Set(otherRows.map((row) => row.cycle));
    const merged = [
      ...newestRead.value.results.filter((row) => !otherCycles.has(row.cycle)),
      ...otherRows,
    ];
    const totals = pageOfTotals(merged, params);
    const unread = otherTables.filter((_, i) => otherReads[i]?.status === 'rejected').flat();
    if (unread.length === 0) return { totals, coverage: { kind: 'complete' } };
    assertPartialAnswer(failures, totals, ctx);
    return { totals, coverage: { kind: 'cycles_unavailable', cycles: unread } };
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

  /** `delivered`: rows the walk returned before this page — `CursorPosition.delivered`. */
  searchContributions(
    params: FecParams,
    query: CursorQuery,
    ctx: Context,
    delivered = 0,
  ): Promise<SeekResult> {
    return this.fetchSeek('/schedules/schedule_a/', params, query, ctx, delivered);
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

  /** `delivered`: rows the walk returned before this page — `CursorPosition.delivered`. */
  searchDisbursements(
    params: FecParams,
    query: CursorQuery,
    ctx: Context,
    delivered = 0,
  ): Promise<SeekResult> {
    return this.fetchSeek('/schedules/schedule_b/', params, query, ctx, delivered);
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

  /** `delivered`: rows the walk returned before this page — `CursorPosition.delivered`. */
  searchExpenditures(
    params: FecParams,
    query: CursorQuery,
    ctx: Context,
    delivered = 0,
  ): Promise<SeekResult> {
    return this.fetchSeek('/schedules/schedule_e/', params, query, ctx, delivered);
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
          const body = (await this.getJson(url, ctx)) as ElectionSummary;
          if (typeof body?.count !== 'number') throw unexpectedResponse();
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
      return await withRetry(async () => unwrapLegalDocument(await this.getJson(url, ctx)), {
        maxRetries: this.config.fecMaxRetries,
        baseDelayMs: 1_000,
        operation: `FEC ${path}`,
        context: ctx,
        signal: ctx.signal,
        isTransient: isTransientFecError,
      });
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
    throw unexpectedResponse();
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

/** `read`, with OpenFEC's own "no such record" 404 resolved as an empty page echoing `params`. */
async function emptyOnUpstreamNotFound(
  read: Promise<PageResult>,
  params: FecParams,
): Promise<PageResult> {
  try {
    return await read;
  } catch (err) {
    if (!isUpstreamNotFound(err)) throw err;
    return emptyPage(params);
  }
}

/* ------------------------------------------------------------------ */
/*  Error sanitization                                                */
/* ------------------------------------------------------------------ */

/** Strip API key values from error messages to prevent leaking secrets in tool output. */
function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/api_key=[^&\s"')]+/g, 'api_key=REDACTED');
}

/**
 * The wait an upstream `Retry-After` asks for, in ms, or `undefined` when there
 * is none to read. Reads the value the way `withRetry` does — delta-seconds (a
 * bare integer, or a number), or an HTTP-date as the time from now clamped at
 * 0 — so the wait a message names is the one retry honored or declined. The
 * framework's own parser is not on the public `/utils` export. The input is one
 * response header, so its length is bounded by the runtime's header limit.
 */
function retryAfterMs(retryAfter: unknown): number | undefined {
  if (typeof retryAfter === 'number') {
    return Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : undefined;
  }
  if (typeof retryAfter !== 'string') return;
  const value = retryAfter.trim();
  if (value === '') return;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** A wait in the units a reader plans by: exact seconds under a minute, then rounded minutes or hours. */
function describeWait(ms: number): string {
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return count(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${count(minutes, 'minute')}`;
  return `about ${count(Math.round(seconds / 3600), 'hour')}`;
}

/**
 * The 429 hint. An exhausted api.data.gov key stays blocked until its window
 * resets — hours, for `DEMO_KEY`'s daily allowance — so the hint names the wait
 * OpenFEC sent instead of guessing one, and on `DEMO_KEY` points at the personal
 * key that lifts the shared limit. It states no limit figure: the published
 * `DEMO_KEY` figures disagree with each other and with what OpenFEC enforces.
 */
function rateLimitHint(retryAfter: unknown): string {
  const waitMs = retryAfterMs(retryAfter);
  const wait =
    waitMs === undefined
      ? 'OpenFEC gave no reset time, so the wait is unknown.'
      : `OpenFEC asked to wait ${describeWait(waitMs)} before the next request.`;
  const keyAdvice =
    getServerConfig().fecApiKey === 'DEMO_KEY'
      ? ' This server is using DEMO_KEY, whose small daily allowance is shared by every caller on this IP; setting FEC_API_KEY to a personal key (free at https://api.data.gov/signup/) lifts the shared limit.'
      : '';
  return `FEC API rate limit exceeded. ${wait}${keyAdvice}`;
}

/**
 * Map HTTP status codes from upstream FEC API to actionable messages. A 429's
 * hint reads `retryAfter`, the raw `Retry-After` the error carries.
 */
function enrichStatusError(msg: string, retryAfter?: unknown): string {
  const sanitized = sanitizeErrorMessage(msg);
  const statusMatch = sanitized.match(/Status:\s*(\d{3})/);
  if (!statusMatch) return sanitized;
  const status = Number(statusMatch[1]);
  const hints: Record<number, string> = {
    400: 'Bad request — check parameter names and types.',
    403: 'Forbidden — the API key may be invalid or expired.',
    404: 'Endpoint not found — verify the API path.',
    422: 'The FEC API rejected the request parameters. Check required fields and value formats for this endpoint.',
    500: 'FEC API internal error. Retry shortly.',
    502: 'FEC API is temporarily unreachable. Retry shortly.',
    503: 'FEC API is temporarily unavailable. Retry shortly.',
    504: 'The FEC API timed out running this query. Narrow it — supply cycle, a committee_id or candidate_id, or a tighter date range — then retry.',
  };
  const hint = status === 429 ? rateLimitHint(retryAfter) : hints[status];
  return hint ? `${sanitized} — ${hint}` : sanitized;
}

/**
 * The captured error body a caller may see. Every request opts into
 * `exposeErrorBody`, so a non-2xx body arrives on `data.body` (and its alias
 * `data.responseBody`) bound for the client. It goes on only when it is the
 * API's own JSON error object: OpenFEC's names the parameter it rejected
 * (`{"message":{"query":{"office":…}},"status":422}`), api.data.gov's the key
 * or quota problem. An HTML or plain-text page from the edge is markup, not
 * guidance, and is dropped here; `fetchWithTimeout`'s failure log already
 * recorded it.
 */
function withClientBody(data: McpError['data']): McpError['data'] {
  if (typeof data?.body !== 'string' || data.body.trimStart().startsWith('{')) return data;
  const { body: _page, responseBody: _alias, ...rest } = data;
  return rest;
}

/**
 * Re-throw an error with its message sanitized (API key stripped)
 * and enriched with actionable context for HTTP status errors.
 * Preserves McpError code and data, less a non-JSON error body; wraps plain
 * Errors as new instances. Preserves the original error as `cause` for
 * internal debugging.
 */
function rethrowSanitized(err: unknown): never {
  if (err instanceof McpError) {
    const message = enrichStatusError(err.message, err.data?.retryAfter);
    throw new McpError(err.code, message, withClientBody(err.data), { cause: err });
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
 * framework's classifier (raw socket failures). A 2xx answer that is not an
 * OpenFEC envelope already arrives as `ServiceUnavailable` (`unexpectedResponse`).
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
