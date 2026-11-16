/**
 * @fileoverview End-to-end page tests for the high-volume search tools — the
 * caller's `per_page` is the page, and every row upstream sends comes back:
 * each tool runs through its public contract (handler, format, enrichment)
 * against the real OpenFEC service, with only the upstream HTTP boundary faked.
 * The fake upstream honors `per_page`, `page`, and `last_index` the way OpenFEC
 * does, so pagination walks exercise the same cursor and page arithmetic a live
 * call would.
 * @module tests/mcp-server/tools/definitions/response-bounds.test
 */

import type { CallToolResult } from '@cyanheads/mcp-ts-core';
import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    fecApiKey: 'TEST_KEY',
    fecBaseUrl: 'https://api.open.fec.gov/v1',
    fecMaxRetries: 0,
    fecRequestTimeout: 5000,
  }),
}));

import { searchCandidates } from '@/mcp-server/tools/definitions/search-candidates.tool.js';
import { searchContributions } from '@/mcp-server/tools/definitions/search-contributions.tool.js';
import { searchCoordinatedExpenditures } from '@/mcp-server/tools/definitions/search-coordinated-expenditures.tool.js';
import { searchDisbursements } from '@/mcp-server/tools/definitions/search-disbursements.tool.js';
import { searchExpenditures } from '@/mcp-server/tools/definitions/search-expenditures.tool.js';
import { searchFilings } from '@/mcp-server/tools/definitions/search-filings.tool.js';
import { APPROXIMATE_COUNT_NOTICE } from '@/mcp-server/tools/definitions/utils/format-helpers.js';
import { initOpenFecService } from '@/services/openfec/openfec-service.js';

/* ------------------------------------------------------------------ */
/*  Fake upstream                                                     */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

/** A nested committee record the way Schedule A/B/E/F rows embed it, nulls included. */
const committeeRecord = (id: string): Row => ({
  committee_id: id,
  name: `COMMITTEE ${id}`,
  committee_type_full: 'Super PAC (Independent Expenditure-Only)',
  designation_full: 'Unauthorized',
  party_full: null,
  state: 'DC',
  treasurer_name: 'ROE, RICHARD',
  designated_agent_middle_name: null,
  organization_type_full: '',
  candidate_ids: [],
  cycles: [2022, 2024],
  is_active: true,
});

/**
 * An OpenFEC keyset endpoint over `rows`. `last_index` is the row's position, so
 * a request resumes exactly after the last row it was handed — the property a
 * next_cursor has to preserve.
 */
const keysetUpstream = (rows: readonly Row[]) => (request: Request) => {
  const url = new URL(request.url);
  const perPage = Number(url.searchParams.get('per_page') ?? 20);
  const after = url.searchParams.get('last_index');
  const start = after === null ? 0 : Number(after) + 1;
  const page = rows.slice(start, start + perPage);
  return Response.json({
    api_version: '1.0',
    pagination: {
      count: rows.length,
      is_count_exact: true,
      per_page: perPage,
      pages: Math.ceil(rows.length / perPage),
      last_indexes: page.length > 0 ? { last_index: String(start + page.length - 1) } : null,
    },
    results: page,
  });
};

/** An OpenFEC page-based endpoint over `rows`. */
const pagedUpstream = (rows: readonly Row[]) => (request: Request) => {
  const url = new URL(request.url);
  const perPage = Number(url.searchParams.get('per_page') ?? 20);
  const page = Number(url.searchParams.get('page') ?? 1);
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

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const contributionRows = (n: number): Row[] =>
  range(n).map((i) => ({
    contributor_name: `DONOR ${i}`,
    contribution_receipt_amount: 100 + i,
    contribution_receipt_date: '2024-03-15',
    committee_id: 'C00703975',
    committee: committeeRecord('C00703975'),
    contributor: null,
    memo_text: null,
    is_individual: true,
    sub_id: String(i),
  }));

const disbursementRows = (n: number): Row[] =>
  range(n).map((i) => ({
    recipient_name: `VENDOR ${i}`,
    disbursement_amount: 1000 + i,
    committee_id: 'C00703975',
    committee: committeeRecord('C00703975'),
    memo_text: null,
    sub_id: String(i),
  }));

/** Candidate-scoped Schedule E rows spanning two spending committees. */
const expenditureRows = (n: number): Row[] =>
  range(n).map((i) => {
    const committeeId = i % 2 === 0 ? 'C00000001' : 'C00000002';
    return {
      support_oppose_indicator: 'S',
      candidate_id: 'P80000722',
      candidate_name: 'HARRIS, KAMALA',
      committee_id: committeeId,
      committee: committeeRecord(committeeId),
      candidate: { candidate_id: 'P80000722', idx: i, two_year_period: 2024 },
      expenditure_amount: 0,
      is_notice: false,
      payee_name: `PAYEE ${i}`,
      memo_text: null,
      sub_id: String(i),
    };
  });

const coordinatedRows = (n: number): Row[] =>
  range(n).map((i) => {
    const committeeId = i % 2 === 0 ? 'C00003418' : 'C00010603';
    return {
      candidate_id: 'P80000722',
      candidate_name: 'HARRIS, KAMALA',
      committee_id: committeeId,
      committee: committeeRecord(committeeId),
      subordinate_committee: null,
      expenditure_amount: 1000 + i,
      expenditure_date: '2024-08-07T00:00:00',
      payee_name: `PAYEE ${i}`,
      memo_text: null,
      sub_id: String(i),
    };
  });

const filingRows = (n: number): Row[] =>
  range(n).map((i) => ({
    form_type: 'F3P',
    committee_id: `C${String(i).padStart(8, '0')}`,
    committee_name: `FILER ${i}`,
    is_amended: false,
    total_receipts: 0,
    amendment_chain: [],
    csv_url: null,
    fec_file_id: String(i),
  }));

const candidateRows = (n: number): Row[] =>
  range(n).map((i) => ({
    candidate_id: `H4CA${String(i).padStart(5, '0')}`,
    name: `CANDIDATE ${i}`,
    state: 'CA',
    office: 'H',
    party: 'DEM',
    cycles: [2024],
  }));

/** `/candidates/totals/` — one row per requested candidate. */
const totalsUpstream = (request: Request) => {
  const ids = new URL(request.url).searchParams.getAll('candidate_id');
  return Response.json({
    api_version: '1.0',
    pagination: { count: ids.length, page: 1, pages: 1, per_page: 100, is_count_exact: true },
    results: ids.map((id) => ({ candidate_id: id, cycle: 2024, receipts: 1000, disbursements: 0 })),
  });
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

let http: FetchMockHarness;

beforeEach(() => {
  initOpenFecService();
  http = createFetchMock();
  http.install();
});

afterEach(() => {
  http.restore();
});

/** Upstream request URLs for one endpoint path, in call order. */
const upstreamCalls = (path: string) =>
  http.calls.map((c) => new URL(c.request.url)).filter((u) => u.pathname.endsWith(path));

const sc = (result: CallToolResult) => result.structuredContent as Record<string, unknown>;

const text = (result: CallToolResult) =>
  result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

const rowsOf = (result: CallToolResult) => (sc(result).results ?? sc(result).candidates) as Row[];

/* ------------------------------------------------------------------ */
/*  Characterization — behavior the page size never changed           */
/* ------------------------------------------------------------------ */

describe('per_page below the maximum', () => {
  it.each([
    ['openfec_search_contributions', '/schedules/schedule_a/'],
    ['openfec_search_disbursements', '/schedules/schedule_b/'],
    ['openfec_search_expenditures', '/schedules/schedule_e/'],
    ['openfec_search_coordinated_expenditures', '/schedules/schedule_f/'],
    ['openfec_search_filings', '/filings/'],
  ] as const)('%s forwards a per_page of 20 unchanged', async (name, path) => {
    const cases = {
      openfec_search_contributions: [
        searchContributions,
        { committee_id: 'C00703975', cycle: 2024 },
        contributionRows(3),
        keysetUpstream,
      ],
      openfec_search_disbursements: [
        searchDisbursements,
        { committee_id: 'C00703975', cycle: 2024 },
        disbursementRows(3),
        keysetUpstream,
      ],
      openfec_search_expenditures: [
        searchExpenditures,
        { candidate_id: 'P80000722', cycle: 2024 },
        expenditureRows(3),
        keysetUpstream,
      ],
      openfec_search_coordinated_expenditures: [
        searchCoordinatedExpenditures,
        { candidate_id: 'P80000722', cycle: 2024 },
        coordinatedRows(3),
        pagedUpstream,
      ],
      openfec_search_filings: [searchFilings, { form_type: 'F3P' }, filingRows(3), pagedUpstream],
    } as const;
    const [definition, args, rows, upstream] = cases[name];
    http.route({ match: new RegExp(`${path}\\?`), respond: upstream(rows) });

    const result = await runToolContract(
      definition as typeof searchFilings,
      {
        ...args,
        per_page: 20,
      } as never,
    );

    expect(result.isError).toBeFalsy();
    expect(upstreamCalls(path)[0]!.searchParams.get('per_page')).toBe('20');
    expect(rowsOf(result)).toHaveLength(3);
  });

  it('walks every keyset row exactly once through next_cursor', async () => {
    const rows = expenditureRows(45);
    http.route({ match: /\/schedules\/schedule_e\/\?/, respond: keysetUpstream(rows) });

    const seen: unknown[] = [];
    let cursor: string | undefined;
    for (let call = 0; call < 10; call++) {
      const result = await runToolContract(searchExpenditures, {
        candidate_id: 'P80000722',
        cycle: 2024,
        per_page: 20,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...rowsOf(result).map((r) => r.sub_id));
      cursor = (sc(result).next_cursor as string | null) ?? undefined;
      if (!cursor) break;
    }

    expect(seen).toEqual(rows.map((r) => r.sub_id));
  });

  it('keeps meaningful falsy values — false and 0 are facts, not empty fields', async () => {
    http.route({
      match: /\/schedules\/schedule_e\/\?/,
      respond: keysetUpstream(expenditureRows(2)),
    });

    const result = await runToolContract(searchExpenditures, {
      candidate_id: 'P80000722',
      cycle: 2024,
    });

    const [row] = rowsOf(result);
    expect(row).toMatchObject({ is_notice: false, expenditure_amount: 0 });
    expect(row).not.toHaveProperty('committee');
    expect((sc(result).committees as Record<string, Row>).C00000001).toMatchObject({
      is_active: true,
    });
    expect(text(result)).toContain('is_notice: false');
    expect(text(result)).toContain('expenditure_amount: 0');
  });

  it('forwards the candidate search per_page unchanged when totals are not requested', async () => {
    http.route({ match: /\/candidates\/\?/, respond: pagedUpstream(candidateRows(3)) });

    const result = await runToolContract(searchCandidates, { state: 'CA', per_page: 100 });

    expect(result.isError).toBeFalsy();
    expect(upstreamCalls('/candidates/')[0]!.searchParams.get('per_page')).toBe('100');
    expect(sc(result).pagination).toMatchObject({ per_page: 100 });
  });

  it('merges one totals row per candidate when include_totals is set', async () => {
    http.route(
      { match: /\/candidates\/totals\/\?/, respond: totalsUpstream },
      { match: /\/candidates\/\?/, respond: pagedUpstream(candidateRows(3)) },
    );

    const result = await runToolContract(searchCandidates, {
      state: 'CA',
      cycle: 2024,
      include_totals: true,
    });

    expect(sc(result).totals).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ */
/*  Null/empty-field drop                                             */
/* ------------------------------------------------------------------ */

/** Every key path in `value` whose value is null, '', [], or {}. */
const emptyPaths = (value: unknown, path = ''): string[] => {
  if (value === null || value === '') return [path];
  if (Array.isArray(value)) {
    if (value.length === 0) return [path];
    return value.flatMap((v, i) =>
      typeof v === 'object' && v !== null ? emptyPaths(v, `${path}[${i}]`) : [],
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Row);
    if (entries.length === 0) return [path];
    return entries.flatMap(([k, v]) => emptyPaths(v, path ? `${path}.${k}` : k));
  }
  return [];
};

describe('null and empty fields', () => {
  it.each([
    [
      'contributions',
      searchContributions,
      { committee_id: 'C00703975', cycle: 2024 },
      /\/schedules\/schedule_a\/\?/,
      () => keysetUpstream(contributionRows(2)),
    ],
    [
      'disbursements',
      searchDisbursements,
      { committee_id: 'C00703975', cycle: 2024 },
      /\/schedules\/schedule_b\/\?/,
      () => keysetUpstream(disbursementRows(2)),
    ],
    [
      'expenditures, per-row committee',
      searchExpenditures,
      { candidate_id: 'P80000722', cycle: 2024 },
      /\/schedules\/schedule_e\/\?/,
      () => keysetUpstream(expenditureRows(2)),
    ],
    [
      'coordinated expenditures, per-row committee',
      searchCoordinatedExpenditures,
      { candidate_id: 'P80000722', cycle: 2024 },
      /\/schedules\/schedule_f\/\?/,
      () => pagedUpstream(coordinatedRows(2)),
    ],
    [
      'filings',
      searchFilings,
      { form_type: 'F3P' },
      /\/filings\/\?/,
      () => pagedUpstream(filingRows(2)),
    ],
  ] as const)(
    'are dropped from %s rows at every depth',
    async (_label, definition, args, match, upstream) => {
      http.route({ match, respond: upstream() });

      const result = await runToolContract(definition as typeof searchFilings, args as never);

      expect(result.isError).toBeFalsy();
      const structured = sc(result);
      expect(emptyPaths(structured.results)).toEqual([]);
      if (structured.committee) expect(emptyPaths(structured.committee)).toEqual([]);
    },
  );

  it('are dropped from candidate rows and their totals', async () => {
    const withGaps = candidateRows(2).map((c) => ({
      ...c,
      district: null,
      election_districts: [],
    }));
    http.route(
      {
        match: /\/candidates\/totals\/\?/,
        respond: async (request) => {
          const body = (await totalsUpstream(request).json()) as { results: Row[] };
          return Response.json({
            ...body,
            results: body.results.map((r) => ({ ...r, address_street_2: null })),
          });
        },
      },
      { match: /\/candidates\/\?/, respond: pagedUpstream(withGaps) },
    );

    const result = await runToolContract(searchCandidates, {
      state: 'CA',
      cycle: 2024,
      include_totals: true,
    });

    expect(emptyPaths(sc(result).candidates)).toEqual([]);
    expect(emptyPaths(sc(result).totals)).toEqual([]);
  });

  it('keep the rows otherwise intact on both surfaces', async () => {
    http.route({ match: /\/filings\/\?/, respond: pagedUpstream(filingRows(1)) });

    const result = await runToolContract(searchFilings, { form_type: 'F3P' });

    expect(rowsOf(result)[0]).toEqual({
      form_type: 'F3P',
      committee_id: 'C00000000',
      committee_name: 'FILER 0',
      is_amended: false,
      total_receipts: 0,
      fec_file_id: '0',
    });
    expect(text(result)).toContain('is_amended: false');
    expect(text(result)).toContain('total_receipts: 0');
  });
});

/* ------------------------------------------------------------------ */
/*  The caller's per_page is the page                                 */
/* ------------------------------------------------------------------ */

type Definition = typeof searchFilings;

/** The largest page a caller can ask for — OpenFEC's own maximum. */
const MAX_PER_PAGE = 100;

/** The fields that once disclosed a page cut below the caller's per_page. */
const BOUND_FIELDS = ['truncated', 'shown', 'cap'] as const;

/** Text a page cut below the caller's per_page used to carry on `content[]`. */
const BOUND_TEXT = ['100,000-byte', 'per_page applied', 'Rows in this page', 'Page bounded'];

interface Scope {
  args: Record<string, unknown>;
  definition: Definition;
  label: string;
  make: (n: number) => Row[];
  path: string;
  routes?: () => void;
}

/** Every keyset scope that once sent upstream a per_page below the caller's. */
const KEYSET_SCOPES: Scope[] = [
  {
    label: 'contributions',
    definition: searchContributions as unknown as Definition,
    args: { committee_id: 'C00703975', cycle: 2024 },
    path: '/schedules/schedule_a/',
    make: contributionRows,
  },
  {
    label: 'disbursements',
    definition: searchDisbursements as unknown as Definition,
    args: { committee_id: 'C00703975', cycle: 2024 },
    path: '/schedules/schedule_b/',
    make: disbursementRows,
  },
  {
    label: 'expenditures scoped by candidate (per-row committee)',
    definition: searchExpenditures as unknown as Definition,
    args: { candidate_id: 'P80000722', cycle: 2024 },
    path: '/schedules/schedule_e/',
    make: expenditureRows,
  },
  {
    label: 'expenditures scoped by committee (hoisted committee)',
    definition: searchExpenditures as unknown as Definition,
    args: { committee_id: 'C00000001', cycle: 2024 },
    path: '/schedules/schedule_e/',
    make: (n) =>
      expenditureRows(n).map((r) => ({
        ...r,
        committee_id: 'C00000001',
        committee: committeeRecord('C00000001'),
      })),
  },
];

/** Every page-based scope that once sent upstream a per_page below the caller's. */
const PAGED_SCOPES: Scope[] = [
  {
    label: 'coordinated expenditures scoped by candidate (per-row committee)',
    definition: searchCoordinatedExpenditures as unknown as Definition,
    args: { candidate_id: 'P80000722', cycle: 2024 },
    path: '/schedules/schedule_f/',
    make: coordinatedRows,
  },
  {
    label: 'coordinated expenditures scoped by committee (hoisted committee)',
    definition: searchCoordinatedExpenditures as unknown as Definition,
    args: { committee_id: 'C00003418' },
    path: '/schedules/schedule_f/',
    make: (n) =>
      coordinatedRows(n).map((r) => ({
        ...r,
        committee_id: 'C00003418',
        committee: committeeRecord('C00003418'),
      })),
  },
  {
    label: 'filings',
    definition: searchFilings,
    args: { form_type: 'F3P' },
    path: '/filings/',
    make: filingRows,
  },
  {
    label: 'candidates with totals for one cycle',
    definition: searchCandidates as unknown as Definition,
    args: { state: 'CA', office: 'H', cycle: 2024, include_totals: true },
    path: '/candidates/',
    make: candidateRows,
    routes: () => http.route({ match: /\/candidates\/totals\/\?/, respond: totalsUpstream }),
  },
  {
    label: 'candidates with totals for one election year',
    definition: searchCandidates as unknown as Definition,
    args: { office: 'S', election_year: 2024, include_totals: true },
    path: '/candidates/',
    make: candidateRows,
    routes: () => http.route({ match: /\/candidates\/totals\/\?/, respond: totalsUpstream }),
  },
  {
    label: 'candidates with totals across every cycle',
    definition: searchCandidates as unknown as Definition,
    args: { state: 'CA', office: 'H', include_totals: true },
    path: '/candidates/',
    make: candidateRows,
    routes: () => http.route({ match: /\/candidates\/totals\/\?/, respond: totalsUpstream }),
  },
];

/** The path regex for an endpoint's query URL, so `/candidates/` never matches `/candidates/totals/`. */
const endpoint = (path: string) => new RegExp(`${path.replaceAll('/', '\\/')}\\?`);

/** Assert a page carries no page-bound disclosure on either surface. */
const expectNoBound = (result: CallToolResult) => {
  for (const field of BOUND_FIELDS) expect(sc(result)).not.toHaveProperty(field);
  const rendered = text(result);
  for (const fragment of BOUND_TEXT) expect(rendered).not.toContain(fragment);
};

describe.each(KEYSET_SCOPES)('keyset page — $label', ({ definition, args, path, make }) => {
  it('sends the per_page requested and returns every row upstream sent, on both surfaces', async () => {
    const rows = make(MAX_PER_PAGE * 2 + 50);
    http.route({ match: endpoint(path), respond: keysetUpstream(rows) });

    const result = await runToolContract(definition, { ...args, per_page: MAX_PER_PAGE } as never);

    expect(result.isError).toBeFalsy();
    expect(upstreamCalls(path)[0]!.searchParams.get('per_page')).toBe(String(MAX_PER_PAGE));
    expect(rowsOf(result).map((r) => r.sub_id)).toEqual(
      rows.slice(0, MAX_PER_PAGE).map((r) => r.sub_id),
    );
    expect(sc(result).count).toBe(rows.length);
    expect(sc(result).totalCount).toBe(rows.length);
    expect(sc(result).next_cursor).toEqual(expect.any(String));
    expect(sc(result).notice).toBeUndefined();
    expectNoBound(result);
    const rendered = text(result);
    expect(rendered).toContain('sub_id: 0');
    expect(rendered).toContain(`sub_id: ${MAX_PER_PAGE - 1}`);
    expect(rendered).not.toContain(`sub_id: ${MAX_PER_PAGE}`);
    expect(rendered).toContain(`next_cursor: \`${String(sc(result).next_cursor)}\``);
  });

  it('walks every row exactly once at the requested per_page, each page resuming after the last', async () => {
    const rows = make(MAX_PER_PAGE * 2 + 50);
    http.route({ match: endpoint(path), respond: keysetUpstream(rows) });

    const seen: unknown[] = [];
    let cursor: string | undefined;
    for (let call = 0; call < 10; call++) {
      const result = await runToolContract(definition, {
        ...args,
        per_page: MAX_PER_PAGE,
        ...(cursor ? { cursor } : {}),
      } as never);
      expectNoBound(result);
      seen.push(...rowsOf(result).map((r) => r.sub_id));
      cursor = (sc(result).next_cursor as string | null) ?? undefined;
      if (!cursor) break;
    }

    expect(seen).toEqual(rows.map((r) => r.sub_id));
    const calls = upstreamCalls(path);
    expect(calls.map((u) => u.searchParams.get('per_page'))).toEqual(['100', '100', '100']);
    expect(calls.map((u) => u.searchParams.get('last_index'))).toEqual([null, '99', '199']);
  });

  it('ends the walk on a full page that holds the last row', async () => {
    const rows = make(MAX_PER_PAGE * 2);
    http.route({ match: endpoint(path), respond: keysetUpstream(rows) });

    const first = await runToolContract(definition, { ...args, per_page: MAX_PER_PAGE } as never);
    expect(rowsOf(first)).toHaveLength(MAX_PER_PAGE);
    expect(sc(first).next_cursor).toEqual(expect.any(String));

    const second = await runToolContract(definition, {
      ...args,
      per_page: MAX_PER_PAGE,
      cursor: sc(first).next_cursor,
    } as never);

    expect(rowsOf(second).map((r) => r.sub_id)).toEqual(
      rows.slice(MAX_PER_PAGE).map((r) => r.sub_id),
    );
    expect(sc(second).next_cursor).toBeNull();
    expect(text(second)).not.toContain('next_cursor');
    expectNoBound(second);
  });

  it('returns a naturally short page whole, with nothing to continue', async () => {
    const rows = make(37);
    http.route({ match: endpoint(path), respond: keysetUpstream(rows) });

    const result = await runToolContract(definition, { ...args, per_page: MAX_PER_PAGE } as never);

    expect(rowsOf(result).map((r) => r.sub_id)).toEqual(rows.map((r) => r.sub_id));
    expect(sc(result).next_cursor).toBeNull();
    expect(sc(result).notice).toBeUndefined();
    expectNoBound(result);
  });

  it('reports an empty match as one, with no bound', async () => {
    http.route({ match: endpoint(path), respond: keysetUpstream([]) });

    const result = await runToolContract(definition, { ...args, per_page: MAX_PER_PAGE } as never);

    expect(rowsOf(result)).toEqual([]);
    expect(text(result)).toContain('No results found.');
    expectNoBound(result);
  });

  it('reports a cursor that resumes past the last row as exhausted, with no bound', async () => {
    const rows = make(MAX_PER_PAGE);
    http.route({
      match: endpoint(path),
      respond: (request) => {
        const url = new URL(request.url);
        url.searchParams.set('last_index', String(rows.length - 1));
        return keysetUpstream(rows)(new Request(url));
      },
    });
    const first = await runToolContract(definition, { ...args, per_page: MAX_PER_PAGE } as never);
    expect(sc(first).results ?? []).toEqual([]);

    expect(sc(first).notice).toContain('past the last matching row');
    expectNoBound(first);
  });
});

/** The field that identifies a row of each page-based scope, and how `content[]` renders it. */
const rowKey = (path: string) => (path === '/candidates/' ? 'candidate_id' : null);
const renderedId = (path: string, row: Row) => {
  const key = rowKey(path);
  if (key) return String(row[key]);
  const last = Object.keys(row).at(-1)!;
  return `${last}: ${String(row[last])}`;
};
const idOf = (path: string, row: Row) => row[rowKey(path) ?? Object.keys(row).at(-1)!];

describe.each(PAGED_SCOPES)('paged — $label', ({ definition, args, path, make, routes }) => {
  it('sends and echoes the per_page requested, returning every row upstream sent on both surfaces', async () => {
    const rows = make(MAX_PER_PAGE * 2 + 50);
    routes?.();
    http.route({ match: endpoint(path), respond: pagedUpstream(rows) });

    const result = await runToolContract(definition, { ...args, per_page: MAX_PER_PAGE } as never);

    expect(result.isError).toBeFalsy();
    expect(upstreamCalls(path)[0]!.searchParams.get('per_page')).toBe(String(MAX_PER_PAGE));
    expect(rowsOf(result).map((r) => idOf(path, r))).toEqual(
      rows.slice(0, MAX_PER_PAGE).map((r) => idOf(path, r)),
    );
    expect(sc(result).pagination).toMatchObject({
      page: 1,
      pages: 3,
      count: rows.length,
      per_page: MAX_PER_PAGE,
    });
    expect(sc(result).totalCount).toBe(rows.length);
    expect(sc(result).notice).toBeUndefined();
    expectNoBound(result);
    const rendered = text(result);
    expect(rendered).toContain(renderedId(path, rows[0]!));
    expect(rendered).toContain(renderedId(path, rows[MAX_PER_PAGE - 1]!));
    expect(rendered).not.toContain(renderedId(path, rows[MAX_PER_PAGE]!));
    expect(rendered).toContain(`Page 1 of 3 · ${rows.length} total · ${MAX_PER_PAGE} per page`);
  });

  it('walks every row exactly once at the requested per_page, page 2 starting at row 101', async () => {
    const rows = make(MAX_PER_PAGE * 2 + 50);
    routes?.();
    http.route({ match: endpoint(path), respond: pagedUpstream(rows) });

    const pages: Row[][] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await runToolContract(definition, {
        ...args,
        per_page: MAX_PER_PAGE,
        page,
      } as never);
      expectNoBound(result);
      const pagination = sc(result).pagination as { pages: number; per_page: number };
      expect(pagination.per_page).toBe(MAX_PER_PAGE);
      pages.push(rowsOf(result));
      if (page >= pagination.pages) break;
    }

    expect(pages.flat().map((r) => idOf(path, r))).toEqual(rows.map((r) => idOf(path, r)));
    expect(idOf(path, pages[1]![0]!)).toBe(idOf(path, rows[MAX_PER_PAGE]!));
    expect(upstreamCalls(path).map((u) => u.searchParams.get('per_page'))).toEqual([
      '100',
      '100',
      '100',
    ]);
  });

  it('returns a naturally short page whole', async () => {
    const rows = make(37);
    routes?.();
    http.route({ match: endpoint(path), respond: pagedUpstream(rows) });

    const result = await runToolContract(definition, { ...args, per_page: MAX_PER_PAGE } as never);

    expect(rowsOf(result).map((r) => idOf(path, r))).toEqual(rows.map((r) => idOf(path, r)));
    expect(sc(result).pagination).toMatchObject({ page: 1, pages: 1, per_page: MAX_PER_PAGE });
    expect(sc(result).notice).toBeUndefined();
    expectNoBound(result);
  });

  it('reports an empty match as one, with no bound', async () => {
    routes?.();
    http.route({ match: endpoint(path), respond: pagedUpstream([]) });

    const result = await runToolContract(definition, { ...args, per_page: MAX_PER_PAGE } as never);

    expect(rowsOf(result)).toEqual([]);
    expect(text(result)).toContain('No results found.');
    expectNoBound(result);
  });

  it('reports a page past the end as exhausted, with no bound', async () => {
    routes?.();
    http.route({ match: endpoint(path), respond: pagedUpstream(make(MAX_PER_PAGE * 2)) });

    const result = await runToolContract(definition, {
      ...args,
      per_page: MAX_PER_PAGE,
      page: 9,
    } as never);

    expect(rowsOf(result)).toEqual([]);
    expect(sc(result).notice).toContain('past the last page');
    expectNoBound(result);
  });
});

describe('per_page schema bounds', () => {
  it.each([
    ['openfec_search_contributions', searchContributions],
    ['openfec_search_disbursements', searchDisbursements],
    ['openfec_search_expenditures', searchExpenditures],
    ['openfec_search_coordinated_expenditures', searchCoordinatedExpenditures],
    ['openfec_search_filings', searchFilings],
    ['openfec_search_candidates', searchCandidates],
  ] as const)('%s still accepts per_page 100 and rejects 101 and 0', (_name, definition) => {
    const { input } = definition as unknown as Definition;
    const base = definition === searchDisbursements ? { committee_id: 'C00703975' } : {};
    expect(input.safeParse({ ...base, per_page: 100 }).success).toBe(true);
    expect(input.safeParse({ ...base, per_page: 101 }).success).toBe(false);
    expect(input.safeParse({ ...base, per_page: 0 }).success).toBe(false);
  });
});

describe('scopes that never cut a page', () => {
  it('sends a candidate search without totals at the per_page requested', async () => {
    http.route({ match: endpoint('/candidates/'), respond: pagedUpstream(candidateRows(150)) });

    const result = await runToolContract(searchCandidates, { state: 'CA', per_page: 100 });

    expect(upstreamCalls('/candidates/')[0]!.searchParams.get('per_page')).toBe('100');
    expect(rowsOf(result)).toHaveLength(100);
    expectNoBound(result);
  });

  it('sends an aggregate mode at the per_page requested', async () => {
    http.route({
      match: endpoint('/schedules/schedule_e/by_candidate/'),
      respond: pagedUpstream(range(150).map((i) => ({ candidate_id: `P${i}`, total: i }))),
    });

    const result = await runToolContract(searchExpenditures, {
      mode: 'by_candidate',
      candidate_id: 'P80000722',
      per_page: 100,
    });

    expect(
      upstreamCalls('/schedules/schedule_e/by_candidate/')[0]!.searchParams.get('per_page'),
    ).toBe('100');
    expectNoBound(result);
  });
});

describe('an estimated total on a full page', () => {
  it('carries the estimate notice alone on both surfaces', async () => {
    const rows = contributionRows(MAX_PER_PAGE * 2);
    http.route({
      match: endpoint('/schedules/schedule_a/'),
      respond: async (request) => {
        const body = (await keysetUpstream(rows)(request).json()) as {
          pagination: Record<string, unknown>;
        };
        body.pagination.is_count_exact = false;
        return Response.json(body);
      },
    });

    const result = await runToolContract(searchContributions, {
      committee_id: 'C00703975',
      cycle: 2024,
      per_page: MAX_PER_PAGE,
    });

    expect(rowsOf(result)).toHaveLength(MAX_PER_PAGE);
    expect(sc(result).notice).toBe(APPROXIMATE_COUNT_NOTICE);
    expect(text(result)).toContain(APPROXIMATE_COUNT_NOTICE);
    expectNoBound(result);
  });
});

/* ------------------------------------------------------------------ */
/*  Committee records once per page                                   */
/* ------------------------------------------------------------------ */

/** `committeeRecord(id)` as both surfaces carry it: every populated field, no null or empty one. */
const populatedCommittee = (id: string): Row => ({
  committee_id: id,
  name: `COMMITTEE ${id}`,
  committee_type_full: 'Super PAC (Independent Expenditure-Only)',
  designation_full: 'Unauthorized',
  state: 'DC',
  treasurer_name: 'ROE, RICHARD',
  cycles: [2022, 2024],
  is_active: true,
});

/** Assert `rendered` carries every field of `record` once, in full, under its `**NAME (ID)**` title. */
const expectRenderedOnce = (rendered: string, record: Row) => {
  const title = `**${String(record.name)} (${String(record.committee_id)})**`;
  expect(rendered.split(title)).toHaveLength(2);
  const block = rendered.slice(rendered.indexOf(title)).split('\n\n')[0]!;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'name' || key === 'committee_id') continue;
    expect(block).toContain(`  ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
};

const memoSentence = (n: number, m: number) =>
  `${n} of ${m} rows on this page are memo entries (memo_code "X"): each itemizes another row, named by back_reference_transaction_id when filed, or restates earlier activity, and FEC leaves memo entries out of report totals. Do not add them to the other rows.`;

describe('committee records once per page', () => {
  it('carries each coordinated spender once in committees, in full on both surfaces', async () => {
    const rows = coordinatedRows(MAX_PER_PAGE);
    http.route({ match: endpoint('/schedules/schedule_f/'), respond: pagedUpstream(rows) });

    const result = await runToolContract(searchCoordinatedExpenditures, {
      candidate_id: 'P80000722',
      cycle: 2024,
      per_page: MAX_PER_PAGE,
    });

    const structured = sc(result);
    expect(structured).not.toHaveProperty('committee');
    expect(structured.committees).toEqual({
      C00003418: populatedCommittee('C00003418'),
      C00010603: populatedCommittee('C00010603'),
    });
    for (const row of rowsOf(result)) expect(row).not.toHaveProperty('committee');
    expect(rowsOf(result).map((r) => r.sub_id)).toEqual(rows.map((r) => r.sub_id));

    const rendered = text(result);
    expect(rendered).not.toContain('{"');
    expectRenderedOnce(rendered, populatedCommittee('C00003418'));
    expectRenderedOnce(rendered, populatedCommittee('C00010603'));
    expect(rendered.split('  committee_id: C00003418 (COMMITTEE C00003418)')).toHaveLength(51);
    expect(rendered.split('  committee_id: C00010603 (COMMITTEE C00010603)')).toHaveLength(51);
  });

  it('keeps the single-committee hoist on a coordinated page scoped to one committee', async () => {
    const rows = coordinatedRows(3).map((r) => ({
      ...r,
      committee_id: 'C00003418',
      committee: committeeRecord('C00003418'),
    }));
    http.route({ match: endpoint('/schedules/schedule_f/'), respond: pagedUpstream(rows) });

    const result = await runToolContract(searchCoordinatedExpenditures, {
      committee_id: 'C00003418',
    });

    expect(sc(result).committee).toEqual(populatedCommittee('C00003418'));
    expect(sc(result)).not.toHaveProperty('committees');
    const rendered = text(result);
    expect(rendered).toContain(
      '**Committee (applies to every row below):** COMMITTEE C00003418 (C00003418)\n  committee_type_full: Super PAC (Independent Expenditure-Only)',
    );
    expect(rendered).toContain('  cycles: 2022, 2024');
  });

  it('carries each transfer recipient once in recipient_committees, in full on both surfaces', async () => {
    const rows = disbursementRows(30).map((r, i) =>
      i % 10 === 0
        ? {
            ...r,
            recipient_committee_id: 'C00114439',
            recipient_committee: committeeRecord('C00114439'),
          }
        : r,
    );
    http.route({ match: endpoint('/schedules/schedule_b/'), respond: keysetUpstream(rows) });

    const result = await runToolContract(searchDisbursements, {
      committee_id: 'C00703975',
      cycle: 2024,
      per_page: 30,
    });

    const structured = sc(result);
    expect(structured.committee).toEqual(populatedCommittee('C00703975'));
    expect(structured.recipient_committees).toEqual({ C00114439: populatedCommittee('C00114439') });
    expect(emptyPaths(structured.recipient_committees)).toEqual([]);
    for (const row of rowsOf(result)) expect(row).not.toHaveProperty('recipient_committee');

    const rendered = text(result);
    expect(rendered).not.toContain('{"');
    expectRenderedOnce(rendered, populatedCommittee('C00114439'));
    expect(
      rendered.split('  recipient_committee_id: C00114439 (COMMITTEE C00114439)'),
    ).toHaveLength(4);
  });

  it('omits recipient_committees from a page with no committee payee', async () => {
    http.route({
      match: endpoint('/schedules/schedule_b/'),
      respond: keysetUpstream(disbursementRows(5)),
    });

    const result = await runToolContract(searchDisbursements, {
      committee_id: 'C00703975',
      cycle: 2024,
    });

    expect(sc(result)).not.toHaveProperty('recipient_committees');
    expect(text(result)).not.toContain('referenced above');
  });
});

describe('memo entries among other rows', () => {
  it('labels the memo rows of a coordinated page on both surfaces without dropping one', async () => {
    const rows = coordinatedRows(25).map((r, i) => (i < 12 ? { ...r, memo_code: 'X' } : r));
    http.route({ match: endpoint('/schedules/schedule_f/'), respond: pagedUpstream(rows) });

    const result = await runToolContract(searchCoordinatedExpenditures, {
      cycle: 2024,
      max_amount: 100,
      per_page: 25,
    });

    expect(rowsOf(result)).toHaveLength(25);
    expect(sc(result).notice).toBe(memoSentence(12, 25));
    const rendered = text(result);
    expect(rendered).toContain(memoSentence(12, 25));
    expect(rendered.split(' · memo entry\n')).toHaveLength(13);
  });

  it('joins the estimate and memo sentences into one notice on a disbursement page', async () => {
    const rows = disbursementRows(30).map((r, i) =>
      i === 16 || i === 22 ? { ...r, memo_code: 'X', memoed_subtotal: true } : r,
    );
    http.route({
      match: endpoint('/schedules/schedule_b/'),
      respond: async (request) => {
        const body = (await keysetUpstream(rows)(request).json()) as {
          pagination: Record<string, unknown>;
        };
        body.pagination.is_count_exact = false;
        return Response.json(body);
      },
    });

    const result = await runToolContract(searchDisbursements, {
      committee_id: 'C00706747',
      cycle: 2026,
      per_page: 30,
    });

    const notice = `${APPROXIMATE_COUNT_NOTICE} ${memoSentence(2, 30)}`;
    expect(sc(result).notice).toBe(notice);
    expect(text(result)).toContain(notice);
    expect(text(result)).toContain('**VENDOR 16** · memo entry\n');
    expect(text(result)).toContain('**VENDOR 17**\n');
  });
});

/* ------------------------------------------------------------------ */
/*  Candidate totals across every cycle                               */
/* ------------------------------------------------------------------ */

/**
 * `/candidates/totals/` ordered as OpenFEC orders it: one row per requested
 * candidate per cycle, sorted on `sort` — by candidate ID, newest cycle first
 * within one, when the request asks for `candidate_id`; newest cycle first
 * otherwise — then paged.
 */
const totalsAcrossCycles = (cycles: readonly number[]) => (request: Request) => {
  const query = new URL(request.url).searchParams;
  const ids = query.getAll('candidate_id');
  const rows =
    query.get('sort') === 'candidate_id'
      ? ids
          .toSorted()
          .flatMap((id) => cycles.map((cycle) => ({ candidate_id: id, cycle, receipts: cycle })))
      : cycles.flatMap((cycle) => ids.map((id) => ({ candidate_id: id, cycle, receipts: cycle })));
  return pagedUpstream(rows)(request);
};

describe('candidate totals across every cycle', () => {
  it('reads every totals row for a full page of candidates, past the first five requests', async () => {
    const cycles = [2026, 2024, 2022, 2020, 2018, 2016, 2014];
    const candidates = candidateRows(MAX_PER_PAGE);
    http.route(
      { match: endpoint('/candidates/totals/'), respond: totalsAcrossCycles(cycles) },
      { match: endpoint('/candidates/'), respond: pagedUpstream(candidates) },
    );

    const result = await runToolContract(searchCandidates, {
      state: 'CA',
      office: 'H',
      include_totals: true,
      per_page: MAX_PER_PAGE,
    });

    const ids = candidates.map((c) => c.candidate_id as string);
    const calls = upstreamCalls('/candidates/totals/');
    /** Ordered by candidate, a page of 100 holds 14 candidates' 7 rows whole; each request starts at the 15th. */
    expect(calls.map((u) => u.searchParams.getAll('candidate_id'))).toEqual(
      range(8).map((i) => ids.slice(14 * i)),
    );
    for (const call of calls) {
      expect(call.searchParams.get('page')).toBe('1');
      expect(call.searchParams.get('per_page')).toBe('100');
      expect(call.searchParams.get('sort')).toBe('candidate_id');
    }

    const totals = sc(result).totals as Row[];
    expect(totals).toHaveLength(ids.length * cycles.length);
    for (const id of ids) {
      expect(totals.filter((t) => t.candidate_id === id).map((t) => t.cycle)).toEqual(cycles);
    }
    expect(sc(result)).not.toHaveProperty('missing_totals');
    expect(sc(result).notice).toBeUndefined();
    const rendered = text(result);
    expect(rendered.split('— Financial Totals (cycle 2014) —')).toHaveLength(ids.length + 1);
    expect(rendered).not.toContain('not retrieved');
  });
});

/* ------------------------------------------------------------------ */
/*  Advertised output                                                 */
/* ------------------------------------------------------------------ */

describe('advertised output', () => {
  it.each([
    ['openfec_search_contributions', searchContributions],
    ['openfec_search_disbursements', searchDisbursements],
    ['openfec_search_expenditures', searchExpenditures],
    ['openfec_search_coordinated_expenditures', searchCoordinatedExpenditures],
    ['openfec_search_filings', searchFilings],
    ['openfec_search_candidates', searchCandidates],
  ] as const)('%s declares no page-bound field and no trailer for one', (_name, definition) => {
    const { output, enrichment, enrichmentTrailer } = definition as unknown as {
      enrichment?: Record<string, unknown>;
      enrichmentTrailer?: Record<string, unknown>;
      output: { shape: Record<string, unknown> };
    };
    const advertised = Object.keys({ ...output.shape, ...enrichment });
    for (const field of BOUND_FIELDS) {
      expect(advertised).not.toContain(field);
      expect(Object.keys(enrichmentTrailer ?? {})).not.toContain(field);
    }
  });
});
