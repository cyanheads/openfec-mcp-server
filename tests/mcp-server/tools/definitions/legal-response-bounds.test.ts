/**
 * @fileoverview End-to-end response-size tests for the two legal tools: each
 * runs through its public contract (handler, format, enrichment) against the
 * real OpenFEC service, with only the upstream HTTP boundary faked.
 * `openfec_search_legal` returns every result upstream sent, whatever the
 * page weighs; `openfec_get_legal_document` holds one record to the response
 * budget, measured the way it is defined — UTF-8 bytes of the assembled
 * `structuredContent` and of the joined `content[]` text, enrichment trailer
 * included. The heavy records are the three heaviest MURs measured live.
 * @module tests/mcp-server/tools/definitions/legal-response-bounds.test
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

import {
  getLegalDocument,
  RESPONSE_BUDGET_BYTES,
} from '@/mcp-server/tools/definitions/get-legal-document.tool.js';
import { searchLegal } from '@/mcp-server/tools/definitions/search-legal.tool.js';
import { initOpenFecService } from '@/services/openfec/openfec-service.js';

type Row = Record<string, unknown>;

const TYPES = ['advisory_opinions', 'murs', 'adrs', 'admin_fines', 'statutes'] as const;
type LegalType = (typeof TYPES)[number];

/** Plural `type` value → the singular `document_type` each result is tagged with. */
const DISCRIMINATOR: Record<LegalType, string> = {
  advisory_opinions: 'advisory_opinion',
  murs: 'mur',
  adrs: 'adr',
  admin_fines: 'admin_fine',
  statutes: 'statute',
};

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;

/* ------------------------------------------------------------------ */
/*  Heaviest live records                                             */
/* ------------------------------------------------------------------ */

type ArraySpec =
  | { $strings: number[] }
  | { $entries: { template: Row; pad: string; sizes: number[] } };

/**
 * The three heaviest MURs measured live (`/legal/docs/murs/{6916,7594,8123}`).
 * Scalars are masked to X runs of equal JSON byte length; each array of
 * records keeps one masked entry as a template plus the JSON byte size of every
 * live entry, and expands to that many entries of exactly those sizes, the
 * template's `pad` field extended with X runs. Links keep their live shape at
 * their live length — the record page under `/legal/`, document files under
 * `/files/`, regulation citations under `/regulations/`, statute citations on
 * govinfo.gov — so the tool resolves them as it does live before it measures
 * the record. The expanded record weighs exactly what the live one did
 * (`bytes`), before resolution.
 */
const HEAVY_SPEC = JSON.parse(
  readFileSync(new URL('../../../fixtures/heaviest-legal-records.json', import.meta.url), 'utf8'),
) as Record<'mur_6916' | 'mur_7594' | 'mur_8123', { bytes: number; record: Row }>;

const expandArray = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const spec = value as ArraySpec;
  if ('$strings' in spec) return spec.$strings.map((n) => 'X'.repeat(n));
  if ('$entries' in spec) {
    const { template, pad, sizes } = spec.$entries;
    const base = bytes(JSON.stringify(template));
    return sizes.map((size) => ({
      ...template,
      [pad]: `${String(template[pad])}${'X'.repeat(size - base)}`,
    }));
  }
  return value;
};

/**
 * `value` as JSON with every site-relative link in the absolute form the tool
 * returns: a record page under `https://www.fec.gov/data`, anything else under
 * `https://www.fec.gov`.
 */
const withAbsoluteLinks = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll('"url":"/legal/', '"url":"https://www.fec.gov/data/legal/')
    .replaceAll('"url":"/', '"url":"https://www.fec.gov/');

const heavy = (key: keyof typeof HEAVY_SPEC): Row =>
  Object.fromEntries(
    Object.entries(HEAVY_SPEC[key].record).map(([field, value]) => [field, expandArray(value)]),
  );

/* ------------------------------------------------------------------ */
/*  Fake upstream                                                     */
/* ------------------------------------------------------------------ */

/**
 * `/legal/search/` over per-type record lists, honouring `type`, `from_hit`,
 * and `hits_returned` the way upstream does: a typed request carries only its
 * own array and `total_<type>`, an untyped one all five and `total_all`.
 */
const searchUpstream = (lists: Partial<Record<LegalType, Row[]>>) => (request: Request) => {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') as LegalType | null;
  const from = Number(url.searchParams.get('from_hit') ?? 0);
  const hits = Number(url.searchParams.get('hits_returned') ?? 20);
  const body: Record<string, unknown> = {};
  let all = 0;
  for (const t of type ? [type] : TYPES) {
    const list = lists[t] ?? [];
    body[t] = list.slice(from, from + hits);
    body[`total_${t}`] = list.length;
    all += list.length;
  }
  body.total_all = all;
  return Response.json(body);
};

/** `/legal/docs/{type}/{no}` answering with the live `docs`-array envelope. */
const docsUpstream = (record: Row) => () => Response.json({ docs: [record] });

let http: FetchMockHarness;

beforeEach(() => {
  initOpenFecService();
  http = createFetchMock();
  http.install();
});

afterEach(() => {
  http.restore();
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const sc = (result: CallToolResult) => result.structuredContent as Row;

const text = (result: CallToolResult) =>
  result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

/** Both surfaces, in UTF-8 bytes, as the budget measures them. */
const surfaces = (result: CallToolResult) => ({
  structured: bytes(JSON.stringify(result.structuredContent)),
  content: bytes(text(result)),
});

const expectWithinBudget = (result: CallToolResult) => {
  const size = surfaces(result);
  expect(size.structured).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(size.content).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
};

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** A search record of about `size` bytes, numbered within its type. */
const padded = (prefix: string, i: number, size: number): Row => ({
  no: `${prefix}-${i}`,
  name: `${prefix.toUpperCase()} RECORD ${i}`,
  summary: 'X'.repeat(size),
  highlights: ['one <em>match</em>', 'two', 'three', 'four'],
});

/** Heavy MUR search records cycling through the three live heaviest, each renumbered. */
const heavyMurs = (n: number): Row[] => {
  const keys = ['mur_8123', 'mur_7594', 'mur_6916'] as const;
  return range(n).map((i) => ({ ...heavy(keys[i % 3]!), no: String(9000 + i), highlights: [] }));
};

const numbers = (result: CallToolResult) =>
  (sc(result).results as Row[]).map((r) => [r.document_type, r.no]);

const searchCalls = () =>
  http.calls
    .map((c) => new URL(c.request.url))
    .filter((u) => u.pathname.endsWith('/legal/search/'));

/* ------------------------------------------------------------------ */
/*  openfec_search_legal                                              */
/* ------------------------------------------------------------------ */

/** No response field or `content[]` line discloses a page bound. */
const expectNoBound = (result: CallToolResult) => {
  const out = sc(result);
  for (const field of ['truncated', 'shown', 'nextFromHit', 'cap']) {
    expect(out).not.toHaveProperty(field);
  }
  const content = text(result);
  for (const phrase of [
    'Bounded by the response budget',
    'Results in this response',
    'Next from_hit per type',
    '100,000-byte',
  ]) {
    expect(content).not.toContain(phrase);
  }
};

describe('openfec_search_legal page size', () => {
  it('fails loudly on a request the fake upstream does not route', async () => {
    const result = await runToolContract(searchLegal, { query: 'contribution' });
    expect(result.isError).toBe(true);
  });

  it('advertises no bound field: its enrichment is the total, the notice, and the retrieval hint', () => {
    expect(Object.keys(searchLegal.enrichment ?? {}).sort()).toEqual([
      'notice',
      'retrievalHint',
      'totalCount',
    ]);
    expect(Object.keys(searchLegal.enrichmentTrailer ?? {})).toEqual(['retrievalHint']);
    const shape = searchLegal.input.shape;
    const output = searchLegal.output.shape;
    const prose = [
      searchLegal.description,
      shape.from_hit.description,
      shape.hits_returned.description,
      output.results.description,
      searchLegal.enrichment?.notice.description,
    ].join('\n');
    for (const stale of ['100,000', 'nextFromHit', 'truncated', 'held back']) {
      expect(prose).not.toContain(stale);
    }
    expect(prose).toContain('from_hit + hits_returned');
  });

  it('carries every record of a page, in upstream order, disclosing no bound', async () => {
    http.route({
      match: /\/legal\/search\/\?/,
      respond: searchUpstream(
        Object.fromEntries(TYPES.map((t) => [t, range(3).map((i) => padded(t, i, 200))])),
      ),
    });

    const result = await runToolContract(searchLegal, { query: 'contribution' });

    expect(result.isError).toBeFalsy();
    expect(numbers(result)).toEqual(
      TYPES.flatMap((t) => range(3).map((i) => [DISCRIMINATOR[t], `${t}-${i}`])),
    );
    const out = sc(result);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('shown');
    expect(out).not.toHaveProperty('nextFromHit');
    expect(out.totalCount).toBe(15);
  });

  it('returns all 200 records of a heavy 200-record MUR page on both surfaces, each trimmed', async () => {
    const murs = heavyMurs(200);
    http.route({ match: /\/legal\/search\/\?/, respond: searchUpstream({ murs }) });

    const result = await runToolContract(searchLegal, { type: 'murs', hits_returned: 200 });

    expect(result.isError).toBeFalsy();
    expectNoBound(result);
    const out = sc(result);
    const results = out.results as Row[];
    expect(results.map((r) => r.no)).toEqual(murs.map((r) => r.no));
    expect(out.totalCount).toBe(200);
    expect(out.total_count).toBe(200);
    expect(out).not.toHaveProperty('notice');
    for (const r of results) {
      expect(r).not.toHaveProperty('documents');
      expect(r).not.toHaveProperty('dispositions');
    }
    const content = text(result);
    for (const r of murs) expect(content).toContain(`**${r.no}**`);
    expect(content).toContain('_200 total matching document(s)_');
  });

  it('fits MUR 6916 as a single search result, its dispositions summarized', async () => {
    const record = { ...heavy('mur_6916'), highlights: [] };
    http.route({ match: /\/legal\/search\/\?/, respond: searchUpstream({ murs: [record] }) });

    const result = await runToolContract(searchLegal, {
      type: 'murs',
      case_number: '6916',
      hits_returned: 1,
    });

    expect(result.isError).toBeFalsy();
    const [doc] = sc(result).results as Row[];
    expect(doc).not.toHaveProperty('dispositions');
    expect(doc!.disposition_count).toBe(763);
    expect(doc!.disposition_categories).toEqual(expect.any(Array));
    expect(doc!.document_count).toBe(264);
    expect(sc(result)).not.toHaveProperty('truncated');
    expect(text(result)).toContain('disposition_count: 763');
  });

  it('returns every result of an untyped 200-per-type page, each type in full and in order', async () => {
    const lists: Record<LegalType, Row[]> = {
      advisory_opinions: range(200).map((i) => padded('ao', i, 3_000)),
      murs: heavyMurs(200),
      adrs: range(200).map((i) => padded('adr', i, 4_000)),
      admin_fines: range(200).map((i) => padded('af', i, 1_200)),
      statutes: range(57).map((i) => padded('statute', i, 300)),
    };
    http.route({ match: /\/legal\/search\/\?/, respond: searchUpstream(lists) });

    const result = await runToolContract(searchLegal, {
      query: 'contribution',
      hits_returned: 200,
    });

    expect(result.isError).toBeFalsy();
    expectNoBound(result);
    expect(numbers(result)).toEqual(
      TYPES.flatMap((t) => lists[t].map((r) => [DISCRIMINATOR[t], r.no])),
    );
    expect(sc(result).results).toHaveLength(857);
    expect(sc(result).totalCount).toBe(857);
  });

  it('continues each type at from_hit + hits_returned, every record exactly once', async () => {
    const lists: Record<LegalType, Row[]> = {
      advisory_opinions: range(130).map((i) => padded('ao', i, 2_500)),
      murs: heavyMurs(45),
      adrs: range(10).map((i) => padded('adr', i, 500)),
      admin_fines: [],
      statutes: [],
    };
    http.route({ match: /\/legal\/search\/\?/, respond: searchUpstream(lists) });

    const first = await runToolContract(searchLegal, { query: 'contribution', hits_returned: 60 });
    expectNoBound(first);
    const counts = Object.fromEntries(
      TYPES.map((t) => [
        t,
        (sc(first).results as Row[]).filter((r) => r.document_type === DISCRIMINATOR[t]).length,
      ]),
    );
    expect(counts).toEqual({
      advisory_opinions: 60,
      murs: 45,
      adrs: 10,
      admin_fines: 0,
      statutes: 0,
    });

    const seen: unknown[] = (sc(first).results as Row[])
      .filter((r) => r.document_type === 'advisory_opinion')
      .map((r) => r.no);
    const fromHits: number[] = [];
    for (let fromHit = 60; fromHits.length < 10; fromHit += 60) {
      fromHits.push(fromHit);
      const page = await runToolContract(searchLegal, {
        query: 'contribution',
        type: 'advisory_opinions',
        from_hit: fromHit,
        hits_returned: 60,
      });
      expectNoBound(page);
      const rows = sc(page).results as Row[];
      seen.push(...rows.map((r) => r.no));
      if (rows.length < 60) break;
    }
    expect(fromHits).toEqual([60, 120]);
    expect(seen).toEqual(lists.advisory_opinions.map((r) => r.no));
    expect(searchCalls().map((u) => u.searchParams.get('from_hit'))).toEqual(['0', '60', '120']);
  });

  it('never reports truncated on a naturally short page', async () => {
    http.route({
      match: /\/legal\/search\/\?/,
      respond: searchUpstream({ murs: range(5).map((i) => padded('mur', i, 1_000)) }),
    });

    const result = await runToolContract(searchLegal, { type: 'murs', hits_returned: 200 });

    expect(sc(result).results).toHaveLength(5);
    expect(sc(result)).not.toHaveProperty('truncated');
    expect(text(result)).not.toContain('Results in this response');
  });

  it('keeps the exhausted-offset notice and total, and reports no truncation', async () => {
    http.route({
      match: /\/legal\/search\/\?/,
      respond: searchUpstream({ murs: range(5).map((i) => padded('mur', i, 100)) }),
    });

    const result = await runToolContract(searchLegal, { type: 'murs', from_hit: 50 });

    const out = sc(result);
    expect(out.results).toEqual([]);
    expect(out.totalCount).toBe(5);
    expect(out.notice).toContain('from_hit is past the end');
    expect(out).not.toHaveProperty('truncated');
  });

  it('returns a page whose results together pass 100,000 bytes whole, on both surfaces', async () => {
    const murs = [padded('mur', 0, 60_000), padded('mur', 1, 60_000)];
    http.route({ match: /\/legal\/search\/\?/, respond: searchUpstream({ murs }) });

    const result = await runToolContract(searchLegal, { type: 'murs', hits_returned: 2 });

    expect(result.isError).toBeFalsy();
    expectNoBound(result);
    expect(numbers(result)).toEqual([
      ['mur', 'mur-0'],
      ['mur', 'mur-1'],
    ]);
    const size = surfaces(result);
    expect(size.structured).toBeGreaterThan(120_000);
    expect(size.content).toBeGreaterThan(120_000);
    expect(text(result)).toContain('**mur-1**');
  });

  it('sends the caller hits_returned upstream unchanged', async () => {
    http.route({ match: /\/legal\/search\/\?/, respond: searchUpstream({ murs: heavyMurs(10) }) });

    await runToolContract(searchLegal, { type: 'murs', hits_returned: 200 });

    expect(searchCalls()[0]!.searchParams.get('hits_returned')).toBe('200');
  });
});

/* ------------------------------------------------------------------ */
/*  openfec_get_legal_document                                        */
/* ------------------------------------------------------------------ */

const docRoute = (record: Row) =>
  http.route({ match: /\/legal\/docs\/[^/]+\/[^/?]+\?/, respond: docsUpstream(record) });

type Slice = { array: string; offset: number; total: number; next_offset?: number; entries: Row[] };

describe('openfec_get_legal_document response budget', () => {
  it('returns a record within the budget whole, byte-identical, with no withheld list or slice', async () => {
    const record = {
      no: '4229',
      name: 'SMALL FINE',
      documents: [{ category: 'A', url: 'https://www.fec.gov/files/x.pdf' }],
    };
    docRoute(record);

    const result = await runToolContract(getLegalDocument, { doc_type: 'admin_fines', no: '4229' });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(sc(result).document)).toBe(JSON.stringify(record));
    expect(sc(result)).not.toHaveProperty('withheld');
    expect(sc(result)).not.toHaveProperty('slice');
    expect(sc(result).attachedDocumentCount).toBe(1);
  });

  it('expands each heavy fixture to the live record weight', () => {
    for (const key of ['mur_6916', 'mur_7594', 'mur_8123'] as const) {
      expect(bytes(JSON.stringify(heavy(key)))).toBe(HEAVY_SPEC[key].bytes);
    }
  });

  it.each(['mur_8123', 'mur_7594', 'mur_6916'] as const)(
    'bounds %s to its scalars, the arrays that fit, and a withheld list',
    async (key) => {
      const record = heavy(key);
      docRoute(record);

      const result = await runToolContract(getLegalDocument, {
        doc_type: 'murs',
        no: key.slice(4),
      });

      expect(result.isError).toBeFalsy();
      expectWithinBudget(result);
      const out = sc(result);
      const document = out.document as Row;
      const withheld = out.withheld as Array<{ array: string; count: number; bytes: number }>;
      expect(withheld.length).toBeGreaterThan(0);
      for (const { array, count, bytes: size } of withheld) {
        expect(document).not.toHaveProperty(array);
        expect(count).toBe((record[array] as unknown[]).length);
        expect(size).toBe(bytes(withAbsoluteLinks(record[array])));
      }
      for (const [field, value] of Object.entries(record)) {
        if (withheld.some((w) => w.array === field)) continue;
        expect(JSON.stringify({ [field]: document[field] })).toBe(
          withAbsoluteLinks({ [field]: value }),
        );
      }
      expect(out.attachedDocumentCount).toBe((record.documents as unknown[]).length);
      const content = text(result);
      for (const { array, count } of withheld)
        expect(content).toContain(`${array} — ${count} entries`);
    },
  );

  it('withholds MUR 8123 dispositions and inlines its documents', async () => {
    docRoute(heavy('mur_8123'));

    const result = await runToolContract(getLegalDocument, { doc_type: 'murs', no: '8123' });

    expect((sc(result).withheld as Array<{ array: string }>).map((w) => w.array)).toEqual([
      'dispositions',
    ]);
    expect((sc(result).document as Row).documents).toHaveLength(154);
  });

  it.each([
    ['mur_7594', 'documents'],
    ['mur_6916', 'dispositions'],
  ] as const)('walks %s %s by offset to the end, every entry exactly once', async (key, array) => {
    const record = heavy(key);
    docRoute(record);
    const all = record[array] as Row[];

    const seen: Row[] = [];
    let offset = 0;
    let calls = 0;
    for (; calls < 50; calls++) {
      const result = await runToolContract(getLegalDocument, {
        doc_type: 'murs',
        no: key.slice(4),
        array,
        offset,
      });
      expect(result.isError).toBeFalsy();
      expectWithinBudget(result);
      const slice = sc(result).slice as Slice;
      expect(slice).toMatchObject({ array, offset, total: all.length });
      expect(slice.entries.length).toBeGreaterThan(0);
      seen.push(...slice.entries);
      expect(text(result)).toContain(`${offset + 1}.`);
      expect(sc(result).document).not.toHaveProperty(array);
      if (slice.next_offset === undefined) break;
      expect(slice.next_offset).toBe(offset + slice.entries.length);
      expect(text(result)).toContain(`offset ${slice.next_offset}`);
      offset = slice.next_offset;
    }

    expect(calls + 1).toBeGreaterThanOrEqual(3);
    expect(seen).toHaveLength(all.length);
    expect(JSON.stringify(seen)).toBe(withAbsoluteLinks(all));
  });

  /**
   * Links are made absolute before the record is measured, so the budget
   * counts what is sent: here each document link gains 19 bytes, enough that
   * a documents array measured as upstream sent it would fit when the one
   * returned does not. Swept across record sizes from well inside the budget
   * to well past it.
   */
  it('holds a record of relative document links to the budget measured after resolving them', async () => {
    for (let n = 1_000; n <= 2_400; n += 100) {
      http.reset();
      docRoute({
        no: '1',
        name: 'LINKS',
        url: '/legal/matter-under-review/1/',
        documents: range(n).map((i) => ({ category: 'C', url: `/files/legal/murs/1/${i}.pdf` })),
      });

      const result = await runToolContract(getLegalDocument, { doc_type: 'murs', no: '1' });

      expect(result.isError).toBeFalsy();
      expectWithinBudget(result);
      const document = sc(result).document as Row;
      expect(document.url).toBe('https://www.fec.gov/data/legal/matter-under-review/1/');
      if (Array.isArray(document.documents)) {
        expect((document.documents as Row[])[0]?.url).toBe(
          'https://www.fec.gov/files/legal/murs/1/0.pdf',
        );
      }
    }
  });

  it('returns one entry larger than the budget alone, and still advances', async () => {
    const huge = range(3).map((i) => ({ description: 'X'.repeat(150_000), document_id: i }));
    docRoute({ no: '1', name: 'HUGE', documents: huge });

    const offsets: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined && offsets.length < 5) {
      const result = await runToolContract(getLegalDocument, {
        doc_type: 'murs',
        no: '1',
        array: 'documents',
        offset,
      });
      const slice: Slice = sc(result).slice as Slice;
      expect(slice.entries).toHaveLength(1);
      offsets.push(offset);
      offset = slice.next_offset;
    }
    expect(offsets).toEqual([0, 1, 2]);
  });

  it('reports an offset past the end as a position, keeping the total visible', async () => {
    docRoute(heavy('mur_8123'));

    const result = await runToolContract(getLegalDocument, {
      doc_type: 'murs',
      no: '8123',
      array: 'dispositions',
      offset: 53,
    });

    expect(result.isError).toBeFalsy();
    expect(sc(result).slice).toMatchObject({
      array: 'dispositions',
      offset: 53,
      total: 53,
      entries: [],
    });
    expect(sc(result).notice).toContain('past the end');
    expect(text(result)).toContain('past the end');
    expect(text(result)).toContain('53');
  });

  it('rejects an array name the record does not carry, naming the arrays it does', async () => {
    docRoute(heavy('mur_8123'));

    const result = await runToolContract(getLegalDocument, {
      doc_type: 'murs',
      no: '8123',
      array: 'name',
    });

    expect(result.isError).toBe(true);
    const data = (sc(result).error as { data: Row }).data;
    expect(data.reason).toBe('array_not_in_record');
    expect(data.arrays).toEqual(expect.arrayContaining(['dispositions', 'documents']));
  });

  it('rejects an offset without an array before any upstream call', async () => {
    const result = await runToolContract(getLegalDocument, {
      doc_type: 'murs',
      no: '8123',
      offset: 5,
    });

    expect(result.isError).toBe(true);
    expect((sc(result).error as { data: Row }).data.reason).toBe('offset_without_array');
    expect(http.calls).toHaveLength(0);
  });

  it('fills a slice exactly to the budget, and holds the next entry back one byte later', async () => {
    const at = async (size: number) => {
      http.reset();
      docRoute({
        no: '1',
        name: 'EDGE',
        documents: [
          { category: 'A', description: 'X'.repeat(40_000) },
          { category: 'B', description: 'X'.repeat(size) },
          { category: 'C', description: 'tail' },
        ],
      });
      return runToolContract(getLegalDocument, {
        doc_type: 'murs',
        no: '1',
        array: 'documents',
      });
    };
    let lo = 1_000;
    let hi = 90_000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((sc(await at(mid)).slice as Slice).entries.length >= 2) lo = mid;
      else hi = mid;
    }

    const fits = await at(lo);
    expect((sc(fits).slice as Slice).entries).toHaveLength(2);
    expect((sc(fits).slice as Slice).next_offset).toBe(2);
    expectWithinBudget(fits);
    expect(Math.max(...Object.values(surfaces(fits)))).toBeGreaterThan(
      RESPONSE_BUDGET_BYTES - 2_000,
    );

    const over = await at(hi);
    expect((sc(over).slice as Slice).entries).toHaveLength(1);
    expect((sc(over).slice as Slice).next_offset).toBe(1);
  });

  it('returns a record whose response lands exactly on the budget whole, and bounds it one byte later', async () => {
    const at = async (size: number) => {
      http.reset();
      docRoute({
        no: '1',
        name: 'EDGE',
        documents: [{ description: 'X'.repeat(size) }],
        dispositions: [{ disposition: 'Dismissed', respondent: 'X'.repeat(30_000) }],
      });
      return runToolContract(getLegalDocument, { doc_type: 'murs', no: '1' });
    };
    let lo = 10_000;
    let hi = 90_000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (sc(await at(mid)).withheld === undefined) lo = mid;
      else hi = mid;
    }

    const fits = await at(lo);
    expect(sc(fits)).not.toHaveProperty('withheld');
    expectWithinBudget(fits);
    expect(Math.max(...Object.values(surfaces(fits)))).toBeGreaterThan(
      RESPONSE_BUDGET_BYTES - 2_000,
    );

    const over = await at(hi);
    expect((sc(over).withheld as Array<{ array: string }>).map((w) => w.array)).toEqual([
      'documents',
    ]);
    expectWithinBudget(over);
  });
});
