/**
 * @fileoverview openfec_search_legal run through its public contract against
 * the real OpenFEC service, with only the HTTP boundary faked. The fake
 * `/legal/search/` answers the way upstream does — a typed search carries only
 * its own type's array and `total_<type>`, an untyped one carries all five — so
 * the outbound parameter names, the service's per-type totals, and the tool's
 * type narrowing are exercised together.
 * @module tests/mcp-server/tools/definitions/search-legal.upstream.test
 */

import type { ContentBlock, z } from '@cyanheads/mcp-ts-core';
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

import { searchLegal } from '@/mcp-server/tools/definitions/search-legal.tool.js';
import { initOpenFecService } from '@/services/openfec/openfec-service.js';

const TYPES = ['advisory_opinions', 'murs', 'adrs', 'admin_fines', 'statutes'] as const;
type LegalType = (typeof TYPES)[number];

/**
 * A `/legal/search/` fake: one record per type with matches, numbered after
 * the type. Typed requests get only that type's pair, as upstream answers.
 */
const legalUpstream = (totals: Record<LegalType, number>) => (request: Request) => {
  const type = new URL(request.url).searchParams.get('type') as LegalType | null;
  const served = type ? [type] : TYPES;
  const body: Record<string, unknown> = {};
  let all = 0;
  for (const t of served) {
    body[t] = totals[t] > 0 ? [{ no: `${t}-1`, name: `${t} record`, highlights: [] }] : [];
    body[`total_${t}`] = totals[t];
    all += totals[t];
  }
  body.total_all = all;
  return Response.json(body);
};

const LIVE_TOTALS = {
  /** `ao_no=2024-01`, untyped: only advisory opinions honour it. */
  aoNumber: { advisory_opinions: 1, murs: 7670, adrs: 1084, admin_fines: 4469, statutes: 57 },
  /** Both regulatory-citation families, untyped: admin fines match none, statutes ignore it. */
  regulatoryCitation: { advisory_opinions: 234, murs: 95, adrs: 67, admin_fines: 0, statutes: 57 },
  /** `q=contribution`, untyped. */
  query: { advisory_opinions: 1520, murs: 4861, adrs: 448, admin_fines: 387, statutes: 1 },
} satisfies Record<string, Record<LegalType, number>>;

let http: FetchMockHarness;

beforeEach(() => {
  initOpenFecService();
  http = createFetchMock();
  http.install();
});

afterEach(() => {
  http.restore();
});

/** Query parameters of every `/legal/search/` request made, minus the API key. */
const sentParams = () =>
  http.calls.map((call) => {
    const params = Object.fromEntries(new URL(call.request.url).searchParams);
    delete params.api_key;
    return params;
  });

const text = (result: { content: unknown }): string => {
  const [block] = result.content as ContentBlock[];
  if (block?.type !== 'text') throw new Error('no text block');
  return block.text;
};

const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as {
    results: Array<{ document_type: string }>;
    total_count: number;
    totalCount: number;
  };

describe('openfec_search_legal against the upstream boundary', () => {
  it('fails loudly on a request the fake does not route', async () => {
    const result = await runToolContract(searchLegal, { query: 'contribution' });
    expect(result.isError).toBe(true);
  });

  it.each<[LegalType, z.input<typeof searchLegal.input>, Record<string, string>]>([
    ['murs', { regulatory_citation: '11 CFR 110.1' }, { case_regulatory_citation: '11 CFR 110.1' }],
    [
      'adrs',
      { statutory_citation: '52 U.S.C. 30118' },
      { case_statutory_citation: '52 U.S.C. 30118' },
    ],
    [
      'advisory_opinions',
      { regulatory_citation: '11 CFR 110.1', statutory_citation: '52 U.S.C. 30118' },
      { ao_regulatory_citation: '11 CFR 110.1', ao_statutory_citation: '52 U.S.C. 30118' },
    ],
    [
      'admin_fines',
      { min_penalty_amount: 10000, case_number: '4229' },
      { case_min_penalty_amount: '10000', case_no: '4229' },
    ],
    ['murs', { respondent: 'Committee' }, { case_respondents: 'Committee' }],
    ['advisory_opinions', { ao_number: '2024-01' }, { ao_no: '2024-01' }],
  ])(
    'type=%s sends exactly the upstream names that type reads',
    async (type, filters, expected) => {
      http.route({ match: /\/legal\/search\/\?/, respond: legalUpstream(LIVE_TOTALS.query) });

      const result = await runToolContract(searchLegal, { type, ...filters, hits_returned: 5 });

      expect(result.isError).toBeFalsy();
      expect(sentParams()).toEqual([{ from_hit: '0', hits_returned: '5', type, ...expected }]);
    },
  );

  it('never dispatches a filter the type ignores', async () => {
    const result = await runToolContract(searchLegal, {
      type: 'murs',
      ao_number: '2024-01',
    });

    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('filter_not_valid_for_type');
    expect(http.calls).toHaveLength(0);
    expect(text(result)).toContain('ao_number');
    expect(text(result)).toContain('advisory_opinions');
  });

  it('untyped ao_number scopes its one upstream call to advisory opinions', async () => {
    http.route({ match: /\/legal\/search\/\?/, respond: legalUpstream(LIVE_TOTALS.aoNumber) });

    const result = await runToolContract(searchLegal, { ao_number: '2024-01', hits_returned: 1 });

    expect(sentParams()).toEqual([
      { from_hit: '0', hits_returned: '1', type: 'advisory_opinions', ao_no: '2024-01' },
    ]);
    const out = structured(result);
    expect(out.results.map((r) => r.document_type)).toEqual(['advisory_opinion']);
    expect(out.total_count).toBe(1);
    expect(out.totalCount).toBe(1);
    expect(text(result)).toContain('_1 total matching document(s)_');
    expect(text(result)).not.toContain('13281');
  });

  it('untyped regulatory_citation sends both families and excludes statutes from rows and total', async () => {
    http.route({
      match: /\/legal\/search\/\?/,
      respond: legalUpstream(LIVE_TOTALS.regulatoryCitation),
    });

    const result = await runToolContract(searchLegal, { regulatory_citation: '11 CFR 110.1' });

    expect(sentParams()).toEqual([
      {
        from_hit: '0',
        hits_returned: '20',
        ao_regulatory_citation: '11 CFR 110.1',
        case_regulatory_citation: '11 CFR 110.1',
      },
    ]);
    const out = structured(result);
    expect(out.results.map((r) => r.document_type)).toEqual(['advisory_opinion', 'mur', 'adr']);
    expect(out.total_count).toBe(234 + 95 + 67);
    expect(text(result)).toContain(`_${234 + 95 + 67} total matching document(s)_`);
    expect(text(result)).not.toContain('### Statute');
  });

  it('never dispatches a citation upstream cannot parse', async () => {
    const result = await runToolContract(searchLegal, { statutory_citation: '30106' });

    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('invalid_citation');
    expect(http.calls).toHaveLength(0);
    expect(text(result)).toContain('52 U.S.C. 30104');
  });

  it('never dispatches a case citation with a filter the search index drops alongside it', async () => {
    const result = await runToolContract(searchLegal, {
      type: 'murs',
      regulatory_citation: '11 CFR 110.1',
      respondent: 'Obama',
    });

    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('filter_not_valid_for_type');
    expect(http.calls).toHaveLength(0);
    expect(text(result)).toContain('respondent');
    expect(text(result)).toContain('citation on its own');
  });

  it.each([
    ['statutory_citation', '52 U.S.C. 30104, 52 U.S.C. 30118'],
    ['regulatory_citation', '11 CFR 110.1; 11 CFR 110.2'],
  ] as const)('never dispatches a %s holding a second citation: %j', async (field, value) => {
    const result = await runToolContract(searchLegal, { type: 'murs', [field]: value });

    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('invalid_citation');
    expect(http.calls).toHaveLength(0);
    expect(text(result)).toContain('more than one citation');
    expect(text(result)).toContain('one citation per field');
  });

  it.each([
    ['statutory_citation', '52 USC 30104', 'case_statutory_citation'],
    ['statutory_citation', '2 U.S.C. 441a-1', 'case_statutory_citation'],
    ['statutory_citation', '52 U.S.C. 30104(a), (b)', 'case_statutory_citation'],
    ['statutory_citation', '52 U.S.C. §30104(g)', 'case_statutory_citation'],
    ['regulatory_citation', '11 C.F.R. 110.1(b)', 'case_regulatory_citation'],
  ] as const)('sends a parseable %s %j upstream byte-identical', async (field, value, param) => {
    http.route({ match: /\/legal\/search\/\?/, respond: legalUpstream(LIVE_TOTALS.query) });

    await runToolContract(searchLegal, { type: 'murs', [field]: value });

    expect(http.calls).toHaveLength(1);
    expect(sentParams()[0]?.[param]).toBe(value);
  });

  it('an untyped search with no type-specific filter keeps every type and total_all', async () => {
    http.route({ match: /\/legal\/search\/\?/, respond: legalUpstream(LIVE_TOTALS.query) });

    const result = await runToolContract(searchLegal, { query: 'contribution' });

    const out = structured(result);
    expect(out.results).toHaveLength(5);
    expect(out.total_count).toBe(7217);
  });

  it('a typed search totals from total_all, which upstream scopes to the type', async () => {
    http.route({
      match: /\/legal\/search\/\?/,
      respond: legalUpstream(LIVE_TOTALS.regulatoryCitation),
    });

    const result = await runToolContract(searchLegal, {
      type: 'murs',
      regulatory_citation: '11 CFR 110.1',
    });

    const out = structured(result);
    expect(out.results.map((r) => r.document_type)).toEqual(['mur']);
    expect(out.total_count).toBe(95);
  });
});
