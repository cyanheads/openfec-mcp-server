/**
 * @fileoverview Types for OpenFEC API responses and service return values.
 * Covers the three pagination models (page-based, keyset/SEEK, legal search)
 * and normalized result shapes returned by the service layer.
 * @module src/services/openfec/types
 */

/* ------------------------------------------------------------------ */
/*  Raw FEC API envelope shapes                                       */
/* ------------------------------------------------------------------ */

/** Page-based pagination metadata (candidates, committees, filings, elections, calendar). */
export interface FecPagePagination {
  count: number;
  is_count_exact?: boolean;
  page: number;
  pages: number;
  per_page: number;
}

/**
 * Keyset (SEEK) pagination metadata (Schedule A/B/E).
 *
 * `last_indexes` values are scalars whose JSON type follows the sorted column:
 * amounts and dates come back quoted, but some numeric columns (Schedule E's
 * `office_total_ytd`) come back as raw numbers.
 */
export interface FecSeekPagination {
  count: number;
  is_count_exact?: boolean;
  /** Null on the page past the last row; populated on every page that carries rows, terminal ones included. */
  last_indexes?: Record<string, string | number> | null;
  /** Sent upstream but deliberately not carried into `SeekResult`: derived from `count`, with no `page` to compare it against. */
  pages?: number;
  per_page?: number;
}

/** Standard FEC API response envelope with page-based pagination. */
export interface FecPageEnvelope<T = Record<string, unknown>> {
  api_version: string;
  pagination: FecPagePagination;
  results: T[];
}

/** FEC API response envelope with keyset pagination. */
export interface FecSeekEnvelope<T = Record<string, unknown>> {
  api_version: string;
  pagination: FecSeekPagination;
  results: T[];
}

/**
 * Legal search response — type-keyed result arrays instead of a
 * uniform `results` array. Each type has its own array and total count; a
 * search scoped by `type` carries only that type's pair.
 */
export interface FecLegalEnvelope {
  admin_fines?: Record<string, unknown>[];
  adrs?: Record<string, unknown>[];
  advisory_opinions?: Record<string, unknown>[];
  murs?: Record<string, unknown>[];
  statutes?: Record<string, unknown>[];
  total_admin_fines?: number;
  total_adrs?: number;
  total_advisory_opinions?: number;
  total_all: number;
  total_murs?: number;
  total_statutes?: number;
}

/* ------------------------------------------------------------------ */
/*  Normalized service return types                                   */
/* ------------------------------------------------------------------ */

/**
 * Normalized result from page-based endpoints.
 *
 * `is_count_exact` carries the upstream flag verbatim: `false` marks `count` as
 * an estimate, and an absent flag means upstream said nothing — it is never
 * defaulted to `false`, which would label an exact count approximate.
 */
export interface PageResult<T = Record<string, unknown>> {
  pagination: {
    page: number;
    pages: number;
    count: number;
    per_page: number;
    is_count_exact?: boolean;
  };
  results: T[];
}

/**
 * Normalized result from keyset (SEEK) endpoints.
 *
 * `pages` is deliberately not carried: the SEEK envelope has no `page` to
 * compare it against, and when the count is an estimate `pages` is derived from
 * that estimate and inherits its error.
 */
export interface SeekResult<T = Record<string, unknown>> {
  nextCursor: string | null;
  pagination: {
    count: number;
    per_page: number;
    is_count_exact?: boolean;
  };
  results: T[];
}

/** The five `/legal/search/` document types, in the plural form `type` takes. */
export type LegalDocType = 'advisory_opinions' | 'murs' | 'adrs' | 'admin_fines' | 'statutes';

/** Normalized legal search result with a flat results array. */
export interface LegalResult {
  results: Array<Record<string, unknown> & { document_type: string }>;
  /** `total_all` — the sum across every type upstream searched. */
  totalCount: number;
  /**
   * The per-type `total_<type>` counts upstream reported. A typed search
   * reports only its own type; the other keys are absent, not zero.
   */
  typeTotals: Partial<Record<LegalDocType, number>>;
}

/** Flat response from the /elections/summary/ endpoint (no pagination wrapper). */
export interface ElectionSummary {
  count: number;
  disbursements: number;
  /**
   * Unreconciled upstream aggregate from /elections/summary/ — may be wildly inflated
   * due to double-counting across reporting periods. Surface with a caveat; use
   * /schedules/schedule_e/by_candidate/ for verified per-committee totals.
   */
  independent_expenditures: number;
  receipts: number;
}

/* ------------------------------------------------------------------ */
/*  Query parameter types                                             */
/* ------------------------------------------------------------------ */

/** Query params passed to FEC API methods. Undefined values are stripped. Arrays serialize as repeated query params. */
export type FecParams = Record<string, string | number | boolean | string[] | undefined>;
