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

/** Keyset (SEEK) pagination metadata (Schedule A/B/E). */
export interface FecSeekPagination {
  count: number;
  is_count_exact?: boolean;
  last_indexes?: Record<string, string>;
  per_page: number;
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
 * uniform `results` array. Each type has its own array and total count.
 */
export interface FecLegalEnvelope {
  admin_fines: Record<string, unknown>[];
  adrs: Record<string, unknown>[];
  advisory_opinions: Record<string, unknown>[];
  murs: Record<string, unknown>[];
  statutes: Record<string, unknown>[];
  total_admin_fines: number;
  total_adrs: number;
  total_advisory_opinions: number;
  total_all: number;
  total_murs: number;
  total_statutes: number;
}

/* ------------------------------------------------------------------ */
/*  Normalized service return types                                   */
/* ------------------------------------------------------------------ */

/** Normalized result from page-based endpoints. */
export interface PageResult<T = Record<string, unknown>> {
  pagination: {
    page: number;
    pages: number;
    count: number;
    per_page: number;
  };
  results: T[];
}

/** Normalized result from keyset (SEEK) endpoints. */
export interface SeekResult<T = Record<string, unknown>> {
  nextCursor: string | null;
  pagination: {
    count: number;
    per_page: number;
  };
  results: T[];
}

/** Normalized legal search result with a flat results array. */
export interface LegalResult {
  results: Array<Record<string, unknown> & { document_type: string }>;
  totalCount: number;
}

/** Flat response from the /elections/summary/ endpoint (no pagination wrapper). */
export interface ElectionSummary {
  count: number;
  disbursements: number;
  independent_expenditures: number;
  receipts: number;
}

/* ------------------------------------------------------------------ */
/*  Query parameter types                                             */
/* ------------------------------------------------------------------ */

/** Query params passed to FEC API methods. Undefined values are stripped. */
export type FecParams = Record<string, string | number | boolean | undefined>;
