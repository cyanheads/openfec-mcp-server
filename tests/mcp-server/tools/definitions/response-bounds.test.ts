/**
 * @fileoverview End-to-end page-bound tests for the high-volume search tools:
 * each tool runs through its public contract (handler, format, enrichment)
 * against the real OpenFEC service, with only the upstream HTTP boundary faked.
 * The fake upstream honors `per_page`, `page`, and `last_index` the way OpenFEC
 * does, so pagination walks exercise the same cursor and page arithmetic a live
 * call would.
 * @module tests/mcp-server/tools/definitions/response-bounds.test
 */

import { readFileSync } from 'node:fs';
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
import {
  PER_PAGE_CAPS,
  RESPONSE_BUDGET_BYTES,
} from '@/mcp-server/tools/definitions/utils/trim-schedule-row.js';
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
/*  Characterization — behavior the page bound must not change        */
/* ------------------------------------------------------------------ */

describe('per_page within the page budget', () => {
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
    expect(row!.committee).toMatchObject({ is_active: true });
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
/*  Effective per_page cap                                            */
/* ------------------------------------------------------------------ */

type Definition = typeof searchFilings;

interface KeysetScope {
  args: Record<string, unknown>;
  cap: number;
  definition: Definition;
  label: string;
  make: (n: number) => Row[];
  path: string;
}

const KEYSET_SCOPES: KeysetScope[] = [
  {
    label: 'contributions',
    definition: searchContributions as unknown as Definition,
    args: { committee_id: 'C00703975', cycle: 2024 },
    path: '/schedules/schedule_a/',
    make: contributionRows,
    cap: PER_PAGE_CAPS.contributions,
  },
  {
    label: 'disbursements',
    definition: searchDisbursements as unknown as Definition,
    args: { committee_id: 'C00703975', cycle: 2024 },
    path: '/schedules/schedule_b/',
    make: disbursementRows,
    cap: PER_PAGE_CAPS.disbursements,
  },
  {
    label: 'expenditures scoped by candidate (per-row committee)',
    definition: searchExpenditures as unknown as Definition,
    args: { candidate_id: 'P80000722', cycle: 2024 },
    path: '/schedules/schedule_e/',
    make: expenditureRows,
    cap: PER_PAGE_CAPS.expenditures.perRowCommittee,
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
    cap: PER_PAGE_CAPS.expenditures.committeeScoped,
  },
];

interface PagedScope {
  args: Record<string, unknown>;
  cap: number;
  definition: Definition;
  label: string;
  make: (n: number) => Row[];
  path: string;
  routes?: () => void;
}

const PAGED_SCOPES: PagedScope[] = [
  {
    label: 'coordinated expenditures scoped by candidate (per-row committee)',
    definition: searchCoordinatedExpenditures as unknown as Definition,
    args: { candidate_id: 'P80000722', cycle: 2024 },
    path: '/schedules/schedule_f/',
    make: coordinatedRows,
    cap: PER_PAGE_CAPS.coordinatedExpenditures.perRowCommittee,
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
    cap: PER_PAGE_CAPS.coordinatedExpenditures.committeeScoped,
  },
  {
    label: 'filings',
    definition: searchFilings,
    args: { form_type: 'F3P' },
    path: '/filings/',
    make: filingRows,
    cap: PER_PAGE_CAPS.filings,
  },
  {
    label: 'candidates with totals for one cycle',
    definition: searchCandidates as unknown as Definition,
    args: { state: 'CA', office: 'H', cycle: 2024, include_totals: true },
    path: '/candidates/',
    make: candidateRows,
    cap: PER_PAGE_CAPS.candidatesWithTotals.oneCycle,
    routes: () => http.route({ match: /\/candidates\/totals\/\?/, respond: totalsUpstream }),
  },
  {
    label: 'candidates with totals for one election year',
    definition: searchCandidates as unknown as Definition,
    args: { office: 'S', election_year: 2024, include_totals: true },
    path: '/candidates/',
    make: candidateRows,
    cap: PER_PAGE_CAPS.candidatesWithTotals.oneCycle,
    routes: () => http.route({ match: /\/candidates\/totals\/\?/, respond: totalsUpstream }),
  },
  {
    label: 'candidates with totals across every cycle',
    definition: searchCandidates as unknown as Definition,
    args: { state: 'CA', office: 'H', include_totals: true },
    path: '/candidates/',
    make: candidateRows,
    cap: PER_PAGE_CAPS.candidatesWithTotals.allCycles,
    routes: () => http.route({ match: /\/candidates\/totals\/\?/, respond: totalsUpstream }),
  },
];

/** The path regex for an endpoint's query URL, so `/candidates/` never matches `/candidates/totals/`. */
const endpoint = (path: string) => new RegExp(`${path.replaceAll('/', '\\/')}\\?`);

const enrichmentOf = (result: CallToolResult) => {
  const { truncated, shown, cap, totalCount, notice } = sc(result);
  return { truncated, shown, cap, totalCount, notice };
};

describe.each(KEYSET_SCOPES)('keyset cap — $label', ({ definition, args, path, make, cap }) => {
  it('requests the capped page size upstream and discloses the bound on both surfaces', async () => {
    const rows = make(cap * 3 + 7);
    http.route({ match: endpoint(path), respond: keysetUpstream(rows) });

    const result = await runToolContract(definition, { ...args, per_page: 100 } as never);

    expect(result.isError).toBeFalsy();
    expect(upstreamCalls(path)[0]!.searchParams.get('per_page')).toBe(String(cap));
    expect(rowsOf(result)).toHaveLength(cap);
    expect(sc(result).count).toBe(rows.length);
    expect(sc(result).next_cursor).toEqual(expect.any(String));
    expect(enrichmentOf(result)).toMatchObject({
      truncated: true,
      shown: cap,
      cap,
      totalCount: rows.length,
      notice: expect.stringContaining('100,000-byte'),
    });
    expect(enrichmentOf(result).notice).toContain('next_cursor');
    const rendered = text(result);
    expect(rendered).toContain('100,000-byte');
    expect(rendered).toContain(`**per_page applied:** ${cap}`);
    expect(rendered).toContain(`**Rows in this page:** ${cap}`);
    expect(rendered).toContain(`next_cursor: \``);
    expect(rendered).toContain(String(rows.length));
  });

  it('retrieves every row exactly once by following next_cursor with the original per_page', async () => {
    const rows = make(cap * 2 + 3);
    http.route({ match: endpoint(path), respond: keysetUpstream(rows) });

    const seen: unknown[] = [];
    const truncatedFlags: unknown[] = [];
    let cursor: string | undefined;
    for (let call = 0; call < 10; call++) {
      const result = await runToolContract(definition, {
        ...args,
        per_page: 100,
        ...(cursor ? { cursor } : {}),
      } as never);
      seen.push(...rowsOf(result).map((r) => r.sub_id));
      truncatedFlags.push(sc(result).truncated);
      cursor = (sc(result).next_cursor as string | null) ?? undefined;
      if (!cursor) break;
    }

    expect(seen).toEqual(rows.map((r) => r.sub_id));
    // Bounded pages say so; the naturally short last page does not.
    expect(truncatedFlags).toEqual([true, true, undefined]);
  });

  it('does not report truncation for a naturally short page', async () => {
    http.route({ match: endpoint(path), respond: keysetUpstream(make(cap - 1)) });

    const result = await runToolContract(definition, { ...args, per_page: 100 } as never);

    expect(rowsOf(result)).toHaveLength(cap - 1);
    expect(sc(result).next_cursor).toBeNull();
    expect(sc(result).truncated).toBeUndefined();
    expect(text(result)).not.toContain('100,000-byte');
  });

  it('does not report truncation when nothing matched', async () => {
    http.route({ match: endpoint(path), respond: keysetUpstream([]) });

    const result = await runToolContract(definition, { ...args, per_page: 100 } as never);

    expect(rowsOf(result)).toEqual([]);
    expect(sc(result).truncated).toBeUndefined();
    expect(text(result)).toContain('No results found.');
    expect(text(result)).not.toContain('100,000-byte');
  });

  it('does not report truncation for a page exactly at the cap with nothing after it', async () => {
    http.route({ match: endpoint(path), respond: keysetUpstream(make(cap)) });

    const result = await runToolContract(definition, { ...args, per_page: 100 } as never);

    expect(rowsOf(result)).toHaveLength(cap);
    expect(sc(result).next_cursor).toBeNull();
    expect(sc(result).truncated).toBeUndefined();
  });

  it('does not report truncation for a full page that ends exactly at the last row', async () => {
    const rows = make(cap * 2);
    http.route({ match: endpoint(path), respond: keysetUpstream(rows) });

    const first = await runToolContract(definition, { ...args, per_page: 100 } as never);
    expect(sc(first).truncated).toBe(true);

    const second = await runToolContract(definition, {
      ...args,
      per_page: 100,
      cursor: sc(first).next_cursor,
    } as never);

    expect(rowsOf(second)).toHaveLength(cap);
    expect(sc(second).next_cursor).toBeNull();
    expect(sc(second).truncated).toBeUndefined();
    expect(text(second)).not.toContain('100,000-byte');
  });

  it('does not report truncation for a cursor that resumes past the last row', async () => {
    const rows = make(cap);
    http.route({
      match: endpoint(path),
      respond: (request) => {
        const url = new URL(request.url);
        url.searchParams.set('last_index', String(rows.length - 1));
        return keysetUpstream(rows)(new Request(url));
      },
    });
    const first = await runToolContract(definition, { ...args, per_page: 100 } as never);
    expect(sc(first).results ?? []).toEqual([]);

    expect(sc(first).truncated).toBeUndefined();
    expect(sc(first).notice).toContain('past the last matching row');
  });

  it('leaves a per_page at or below the cap untouched, even with more rows upstream', async () => {
    http.route({ match: endpoint(path), respond: keysetUpstream(make(cap * 2)) });

    const result = await runToolContract(definition, { ...args, per_page: cap } as never);

    expect(upstreamCalls(path)[0]!.searchParams.get('per_page')).toBe(String(cap));
    expect(sc(result).next_cursor).toEqual(expect.any(String));
    expect(sc(result).truncated).toBeUndefined();
  });
});

describe.each(PAGED_SCOPES)(
  'page-based cap — $label',
  ({ definition, args, path, make, cap, routes }) => {
    it('requests and echoes the capped per_page, disclosing the bound on both surfaces', async () => {
      const rows = make(cap * 3 + 7);
      routes?.();
      http.route({ match: endpoint(path), respond: pagedUpstream(rows) });

      const result = await runToolContract(definition, { ...args, per_page: 100 } as never);
      const pages = Math.ceil(rows.length / cap);

      expect(result.isError).toBeFalsy();
      expect(upstreamCalls(path)[0]!.searchParams.get('per_page')).toBe(String(cap));
      expect(rowsOf(result)).toHaveLength(cap);
      expect(sc(result).pagination).toMatchObject({
        page: 1,
        pages,
        count: rows.length,
        per_page: cap,
      });
      expect(enrichmentOf(result)).toMatchObject({
        truncated: true,
        shown: cap,
        cap,
        totalCount: rows.length,
        notice: expect.stringContaining('page 2'),
      });
      const rendered = text(result);
      expect(rendered).toContain('100,000-byte');
      expect(rendered).toContain(`**per_page applied:** ${cap}`);
      expect(rendered).toContain(`Page 1 of ${pages} · ${rows.length} total · ${cap} per page`);
    });

    it('retrieves every row exactly once by walking pages at the echoed per_page', async () => {
      const rows = make(cap * 2 + 3);
      routes?.();
      http.route({ match: endpoint(path), respond: pagedUpstream(rows) });

      const key = path === '/candidates/' ? 'candidate_id' : Object.keys(rows[0]!).at(-1)!;
      const seen: unknown[] = [];
      const truncatedFlags: unknown[] = [];
      for (let page = 1; page <= 10; page++) {
        const result = await runToolContract(definition, { ...args, per_page: 100, page } as never);
        const pagination = sc(result).pagination as { pages: number; per_page: number };
        expect(pagination.per_page).toBe(cap);
        seen.push(...rowsOf(result).map((r) => r[key]));
        truncatedFlags.push(sc(result).truncated);
        if (page >= pagination.pages) break;
      }

      expect(seen).toEqual(rows.map((r) => r[key]));
      expect(truncatedFlags).toEqual([true, true, undefined]);
    });

    it('does not report truncation for a naturally short page', async () => {
      routes?.();
      http.route({ match: endpoint(path), respond: pagedUpstream(make(cap - 1)) });

      const result = await runToolContract(definition, { ...args, per_page: 100 } as never);

      expect(rowsOf(result)).toHaveLength(cap - 1);
      expect(sc(result).truncated).toBeUndefined();
      expect(text(result)).not.toContain('100,000-byte');
    });

    it('does not report truncation when nothing matched', async () => {
      routes?.();
      http.route({ match: endpoint(path), respond: pagedUpstream([]) });

      const result = await runToolContract(definition, { ...args, per_page: 100 } as never);

      expect(rowsOf(result)).toEqual([]);
      expect(sc(result).truncated).toBeUndefined();
      expect(text(result)).toContain('No results found.');
      expect(text(result)).not.toContain('100,000-byte');
    });

    it('does not report truncation for a page past the end', async () => {
      routes?.();
      http.route({ match: endpoint(path), respond: pagedUpstream(make(cap * 2)) });

      const result = await runToolContract(definition, {
        ...args,
        per_page: 100,
        page: 9,
      } as never);

      expect(rowsOf(result)).toEqual([]);
      expect(sc(result).truncated).toBeUndefined();
      expect(sc(result).notice).toContain('past the last page');
    });

    it('leaves a per_page at or below the cap untouched, even with more pages upstream', async () => {
      routes?.();
      http.route({ match: endpoint(path), respond: pagedUpstream(make(cap * 2)) });

      const result = await runToolContract(definition, { ...args, per_page: cap } as never);

      expect(upstreamCalls(path)[0]!.searchParams.get('per_page')).toBe(String(cap));
      expect(sc(result).pagination).toMatchObject({ page: 1, pages: 2, per_page: cap });
      expect(sc(result).truncated).toBeUndefined();
    });
  },
);

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

describe('scopes the cap does not apply to', () => {
  it('does not cap a candidate search without totals', async () => {
    http.route({ match: endpoint('/candidates/'), respond: pagedUpstream(candidateRows(150)) });

    const result = await runToolContract(searchCandidates, { state: 'CA', per_page: 100 });

    expect(upstreamCalls('/candidates/')[0]!.searchParams.get('per_page')).toBe('100');
    expect(rowsOf(result)).toHaveLength(100);
    expect(sc(result).truncated).toBeUndefined();
  });

  it('does not cap an aggregate mode', async () => {
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
    expect(sc(result).truncated).toBeUndefined();
  });

  it('marks an estimated total alongside the bound rather than replacing either notice', async () => {
    const rows = contributionRows(PER_PAGE_CAPS.contributions * 2);
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
      per_page: 100,
    });

    expect(sc(result).truncated).toBe(true);
    expect(sc(result).notice).toContain('100,000-byte');
    expect(sc(result).notice).toContain('upstream estimate');
  });
});

/* ------------------------------------------------------------------ */
/*  Byte budget at the cap, from the heaviest live rows               */
/* ------------------------------------------------------------------ */

/**
 * The heaviest row observed live for each tool and scope, with every string
 * replaced by an equal-length placeholder: the byte weight is real, the
 * contents are not. A page of `cap` copies is the worst page each scope has
 * produced — a regression here means a cap or a renderer outgrew the budget.
 */
const HEAVIEST = JSON.parse(
  readFileSync(new URL('../../../fixtures/heaviest-rows.json', import.meta.url), 'utf8'),
) as Record<string, { row: Row; committee?: Row; candidate: Row; totals: Row[] }>;

const bytes = (value: string) => new TextEncoder().encode(value).length;

const copies = (row: Row, n: number, committee?: Row): Row[] =>
  range(n).map((i) => ({ ...row, sub_id: String(i), ...(committee ? { committee } : {}) }));

describe('byte budget at the cap', () => {
  it.each([
    [
      'contributions',
      searchContributions,
      { committee_id: 'C00703975', cycle: 2024 },
      '/schedules/schedule_a/',
      'contributions',
    ],
    [
      'disbursements',
      searchDisbursements,
      { committee_id: 'C00703975', cycle: 2024 },
      '/schedules/schedule_b/',
      'disbursements',
    ],
    [
      'expenditures, per-row committee',
      searchExpenditures,
      { candidate_id: 'P80000722', cycle: 2024 },
      '/schedules/schedule_e/',
      'expendituresPerRow',
    ],
    [
      'expenditures, hoisted committee',
      searchExpenditures,
      { committee_id: 'C00825851', cycle: 2024 },
      '/schedules/schedule_e/',
      'expendituresCommittee',
    ],
  ] as const)(
    '%s stays under the budget per surface',
    async (_label, definition, args, path, key) => {
      const { row, committee } = HEAVIEST[key]!;
      http.route({ match: endpoint(path), respond: keysetUpstream(copies(row, 200, committee)) });

      const result = await runToolContract(
        definition as unknown as Definition,
        {
          ...args,
          per_page: 100,
        } as never,
      );

      expect(result.isError).toBeFalsy();
      expect(sc(result).truncated).toBe(true);
      expect(bytes(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(
        RESPONSE_BUDGET_BYTES,
      );
      expect(bytes(text(result))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    },
  );

  it.each([
    [
      'coordinated expenditures, per-row committee',
      searchCoordinatedExpenditures,
      { candidate_id: 'P80000722', cycle: 2024 },
      '/schedules/schedule_f/',
      'coordinatedPerRow',
    ],
    [
      'coordinated expenditures, hoisted committee',
      searchCoordinatedExpenditures,
      { committee_id: 'C00003418' },
      '/schedules/schedule_f/',
      'coordinatedCommittee',
    ],
    ['filings', searchFilings, { form_type: 'F3X' }, '/filings/', 'filings'],
  ] as const)(
    '%s stays under the budget per surface',
    async (_label, definition, args, path, key) => {
      const { row, committee } = HEAVIEST[key]!;
      http.route({ match: endpoint(path), respond: pagedUpstream(copies(row, 200, committee)) });

      const result = await runToolContract(
        definition as unknown as Definition,
        {
          ...args,
          per_page: 100,
        } as never,
      );

      expect(result.isError).toBeFalsy();
      expect(sc(result).truncated).toBe(true);
      expect(bytes(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(
        RESPONSE_BUDGET_BYTES,
      );
      expect(bytes(text(result))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    },
  );

  it.each([
    ['one cycle', { state: 'CA', office: 'H', cycle: 2024 }, 'candidatesOneCycle'],
    ['every cycle', { state: 'CA', office: 'H' }, 'candidatesAllCycles'],
  ] as const)(
    'candidates with totals for %s stay under the budget per surface',
    async (_label, args, key) => {
      const { candidate, totals } = HEAVIEST[key]!;
      const candidates = range(200).map((i) => ({
        ...candidate,
        candidate_id: `H4CA${String(i).padStart(5, '0')}`,
      }));
      http.route(
        {
          match: endpoint('/candidates/totals/'),
          respond: (request) => {
            const ids = new URL(request.url).searchParams.getAll('candidate_id');
            const results = ids.flatMap((id) => totals.map((t) => ({ ...t, candidate_id: id })));
            return Response.json({
              api_version: '1.0',
              pagination: { count: results.length, page: 1, pages: 1, per_page: 100 },
              results,
            });
          },
        },
        { match: endpoint('/candidates/'), respond: pagedUpstream(candidates) },
      );

      const result = await runToolContract(searchCandidates, {
        ...args,
        include_totals: true,
        per_page: 100,
      });

      expect(result.isError).toBeFalsy();
      expect(sc(result).truncated).toBe(true);
      expect(bytes(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(
        RESPONSE_BUDGET_BYTES,
      );
      expect(bytes(text(result))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    },
  );
});
