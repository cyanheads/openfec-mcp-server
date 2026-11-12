/**
 * @fileoverview A fake of OpenFEC's `/committee/{committee_id}/history/` and
 * `/committee/{committee_id}/totals/` endpoints over live captures
 * (`tests/fixtures/committee-totals.json`). The totals fake resolves the way
 * OpenFEC's `TotalsCommitteeView` does: it takes the committee's newest
 * history row among the requested cycles, reads only the one totals table that
 * row's committee type maps to, answers 404 when no history row matches, then
 * sorts and pages that table's rows.
 * @module tests/services/openfec/committee-totals-upstream
 */

import { readFileSync } from 'node:fs';
import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';

type Row = Record<string, unknown>;

/** One committee's captured history rows and its totals rows, keyed by OpenFEC totals table. */
export interface CommitteeRecord {
  history: Row[];
  totals: Partial<Record<'pac-party' | 'presidential' | 'house-senate' | 'ie-only', Row[]>>;
}

/**
 * Live captures (fields trimmed): `C00703975` (P 2020–2024, N 2026),
 * `C00580100` (P 2016–2020, Q 2022–2026), the single-type control `C00010603`
 * (Y 1976–2026, totals 1980–2026), and an unassigned `C99999998`.
 */
export const COMMITTEES = JSON.parse(
  readFileSync(new URL('../../fixtures/committee-totals.json', import.meta.url), 'utf8'),
) as Record<'C00703975' | 'C00580100' | 'C00010603' | 'C99999998', CommitteeRecord>;

/** OpenFEC's own JSON body for a 404. */
export const FEC_404 =
  '{"message":"The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again."}';

const FEC_ORIGIN = 'https://api.open.fec.gov';
const COMMITTEE_PATH = /^\/v1\/committee\/(C\d{8})\/(history|totals)\/$/;

/** The parts of a request to the committee history or totals endpoint, or null for any other URL. */
export function committeeRequest(
  url: string,
): { committeeId: string; endpoint: 'history' | 'totals'; query: URLSearchParams } | null {
  const parsed = new URL(url);
  const match = parsed.origin === FEC_ORIGIN ? COMMITTEE_PATH.exec(parsed.pathname) : null;
  if (!match) return null;
  return {
    committeeId: match[1]!,
    endpoint: match[2] as 'history' | 'totals',
    query: parsed.searchParams,
  };
}

/** `totals_schema_map` in OpenFEC's `webservices/resources/totals.py`. */
const tableOf = (committeeType: unknown): keyof CommitteeRecord['totals'] => {
  if (committeeType === 'P') return 'presidential';
  if (committeeType === 'H' || committeeType === 'S') return 'house-senate';
  if (committeeType === 'I') return 'ie-only';
  return 'pac-party';
};

/** Sort as PostgreSQL does for OpenFEC: NULL above every value. */
const sortRows = (rows: Row[], sort: string): Row[] => {
  const descending = sort.startsWith('-');
  const field = descending ? sort.slice(1) : sort;
  const key = (row: Row) =>
    typeof row[field] === 'number' ? (row[field] as number) : Number.POSITIVE_INFINITY;
  return rows.toSorted((a, b) => {
    const diff = key(a) - key(b);
    if (Number.isNaN(diff)) return 0;
    return descending ? -diff : diff;
  });
};

/** A page-based OpenFEC envelope over `rows`, paged by the request's `page` and `per_page`. */
const pageEnvelope = (rows: Row[], query: URLSearchParams): Response => {
  const page = Number(query.get('page') ?? 1);
  const perPage = Number(query.get('per_page') ?? 20);
  return Response.json({
    api_version: '1.0',
    pagination: {
      count: rows.length,
      is_count_exact: true,
      page,
      pages: Math.ceil(rows.length / perPage),
      per_page: perPage,
    },
    results: rows.slice((page - 1) * perPage, page * perPage),
  });
};

/** Answer one history or totals request for `record` as OpenFEC would. */
function answerCommitteeRequest(
  record: CommitteeRecord,
  endpoint: 'history' | 'totals',
  query: URLSearchParams,
): Response {
  if (endpoint === 'history') return pageEnvelope(sortRows(record.history, '-cycle'), query);

  const cycles = query.getAll('cycle').map(Number);
  const matching = record.history.filter(
    (row) => cycles.length === 0 || cycles.includes(row.cycle as number),
  );
  const newest = sortRows(matching, '-cycle')[0];
  if (!newest) {
    return new Response(FEC_404, { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const rows = (record.totals[tableOf(newest.committee_type)] ?? []).filter(
    (row) => cycles.length === 0 || cycles.includes(row.cycle as number),
  );
  return pageEnvelope(sortRows(rows, query.get('sort') ?? '-cycle'), query);
}

/**
 * Route the committee history and totals endpoints for `committees` (the live
 * captures by default) to the fake. Register failure routes first: the harness
 * matches routes in registration order.
 */
export function routeCommitteeTotals(
  http: FetchMockHarness,
  committees: Record<string, CommitteeRecord> = COMMITTEES,
): void {
  http.route({
    match: (request) => {
      const parts = committeeRequest(request.url);
      return parts !== null && Object.hasOwn(committees, parts.committeeId);
    },
    respond: (request) => {
      const { committeeId, endpoint, query } = committeeRequest(request.url)!;
      return answerCommitteeRequest(committees[committeeId]!, endpoint, query);
    },
  });
}

/** Each request the harness served, as `endpoint?query` with the API key left out. */
export function requestsSent(http: FetchMockHarness): string[] {
  return http.calls.map(({ request }) => {
    const parts = committeeRequest(request.url);
    if (!parts) return request.url;
    const query = new URLSearchParams(parts.query);
    query.delete('api_key');
    const search = query.toString();
    return `${parts.committeeId}/${parts.endpoint}${search ? `?${search}` : ''}`;
  });
}
