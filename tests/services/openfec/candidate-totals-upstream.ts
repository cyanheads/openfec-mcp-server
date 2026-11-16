/**
 * @fileoverview A fake of OpenFEC's `/candidates/totals/` that orders and pages
 * rows the way `TotalsCandidateView` does (fecgov/openFEC
 * `webservices/resources/candidate_aggregates.py`): it filters on the
 * `candidate_id` list (upper-cased, as `Candidate_ID` deserializes it), sorts
 * on the one `sort` column (default `-election_year`) with no tiebreaker, and
 * slices the `page` the request names. PostgreSQL returns rows that tie on the
 * sort column in no fixed order, so the fake reshuffles every tie on every
 * request: an offset walk over it repeats some rows across page boundaries and
 * never returns others, as the live API does. `later` delays any fake's answer.
 * @module tests/services/openfec/candidate-totals-upstream
 */

type Row = Record<string, unknown>;

type Respond = (request: Request) => Response | Promise<Response>;

/** The answer `respond` gives `afterMs` into its attempt. */
export const later =
  (afterMs: number, respond: Respond): Respond =>
  (request) =>
    new Promise<Response>((resolve) => {
      setTimeout(() => resolve(respond(request)), afterMs);
    });

/** A seeded generator (mulberry32), so a request's tie order is reproducible but differs per request. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Compare two sort-column values ascending, numbers numerically and anything else as text. */
function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * `count` totals rows for one candidate, newest cycle first. `electionYear`
 * gives each cycle's `election_year`: the cycle itself by default, as a House
 * candidate's rows carry it; a Senate or presidential candidate's rows carry
 * the year of the election the cycle leads to, so several cycles share one.
 */
export function candidateRows(
  candidateId: string,
  count: number,
  newest = 2026,
  electionYear: (cycle: number) => number = (cycle) => cycle,
): Row[] {
  return Array.from({ length: count }, (_, i) => {
    const cycle = newest - 2 * i;
    return {
      candidate_id: candidateId,
      cycle,
      election_year: electionYear(cycle),
      receipts: cycle * 10,
    };
  });
}

/** `count` House candidate IDs, ascending. */
export const candidateIds = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `H0CA${String(i + 1).padStart(5, '0')}`);

/**
 * Rows in the order a whole-set read returns them: newest election year first,
 * then newest cycle, then candidate ID.
 */
export function newestFirst(rows: Row[]): Row[] {
  return rows.toSorted(
    (a, b) =>
      compare(b.election_year, a.election_year) ||
      compare(b.cycle, a.cycle) ||
      compare(a.candidate_id, b.candidate_id),
  );
}

/**
 * The page of `rows` a `/candidates/totals/` request addresses. `seed` picks
 * the order of rows that tie on the sort column.
 */
export function totalsPage(rows: Row[], request: Request, seed: number): Response {
  const query = new URL(request.url).searchParams;
  const ids = new Set(query.getAll('candidate_id').map((id) => id.toUpperCase()));
  const sort = query.get('sort') ?? '-election_year';
  const descending = sort.startsWith('-');
  const column = descending ? sort.slice(1) : sort;
  const page = Number(query.get('page') ?? 1);
  const perPage = Number(query.get('per_page') ?? 20);
  const tieOrder = random(seed);
  const matched = rows
    .filter((row) => ids.size === 0 || ids.has(String(row.candidate_id)))
    .map((row) => ({ row, tie: tieOrder() }))
    .sort((a, b) => {
      const order = compare(a.row[column], b.row[column]);
      return (descending ? -order : order) || a.tie - b.tie;
    })
    .map(({ row }) => row);
  return Response.json({
    api_version: '1.0',
    pagination: {
      count: matched.length,
      is_count_exact: true,
      page,
      pages: Math.ceil(matched.length / perPage),
      per_page: perPage,
    },
    results: matched.slice((page - 1) * perPage, page * perPage),
  });
}
