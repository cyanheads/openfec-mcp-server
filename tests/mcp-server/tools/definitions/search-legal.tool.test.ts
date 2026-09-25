/**
 * @fileoverview Tests for the search-legal tool — validation, param mapping,
 * grouped format rendering, and penalty display.
 * @module tests/mcp-server/tools/definitions/search-legal.tool.test
 */

import { readFileSync } from 'node:fs';
import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = {
  searchCandidates: vi.fn(),
  getCandidate: vi.fn(),
  getCandidateTotals: vi.fn(),
  searchCommittees: vi.fn(),
  getCommittee: vi.fn(),
  searchContributions: vi.fn(),
  getContributionAggregates: vi.fn(),
  searchDisbursements: vi.fn(),
  getDisbursementAggregates: vi.fn(),
  searchExpenditures: vi.fn(),
  getExpendituresByCandidate: vi.fn(),
  searchFilings: vi.fn(),
  searchElections: vi.fn(),
  getElectionSummary: vi.fn(),
  searchLegal: vi.fn(),
  getCalendarDates: vi.fn(),
  getReportingDates: vi.fn(),
  getElectionDates: vi.fn(),
};

vi.mock('@/services/openfec/openfec-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/openfec/openfec-service.js')>()),
  getOpenFecService: () => mockService,
}));

import { searchLegal as searchLegalTool } from '@/mcp-server/tools/definitions/search-legal.tool.js';

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

const makeCtx = () => createMockContext({ errors: searchLegalTool.errors });

type LiveKey = 'mur_8343' | 'mur_1704' | 'adr_172' | 'ao_2003_37' | 'af_4229';

/** Live legal records (arrays shortened), one per nested shape family. */
const LIVE = JSON.parse(
  readFileSync(new URL('../../../fixtures/legal-records.json', import.meta.url), 'utf8'),
) as Record<LiveKey, Record<string, unknown>> & {
  mur_highlight_search: { highlights: string[] };
};

/** A live record as the service hands it to the tool: tagged with its singular document_type. */
const asResult = (key: LiveKey, documentType: string) => ({
  ...structuredClone(LIVE[key]),
  document_type: documentType,
});

/** Plural `type` value → the singular `document_type` the service tags each row with. */
const DISCRIMINATOR = {
  advisory_opinions: 'advisory_opinion',
  murs: 'mur',
  adrs: 'adr',
  admin_fines: 'admin_fine',
  statutes: 'statute',
} as const;

/**
 * A service result for an untyped search: one row for every type with matches,
 * in the service's type order, and the per-type totals upstream reports.
 */
const untypedPage = (typeTotals: Partial<Record<keyof typeof DISCRIMINATOR, number>>) => {
  const order = Object.keys(DISCRIMINATOR) as Array<keyof typeof DISCRIMINATOR>;
  return {
    results: order
      .filter((t) => (typeTotals[t] ?? 0) > 0)
      .map((t) => ({ document_type: DISCRIMINATOR[t], no: `${t}-1` })),
    totalCount: Object.values(typeTotals).reduce((sum, n) => sum + n, 0),
    typeTotals,
  };
};

/** A service result for a search scoped to one type: upstream sends only that type's pair. */
const typedPage = (type: keyof typeof DISCRIMINATOR, total: number) => ({
  results: total > 0 ? [{ document_type: DISCRIMINATOR[type], no: `${type}-1` }] : [],
  totalCount: total,
  typeTotals: { [type]: total },
});

/** The document_type of each returned row, in order. */
const documentTypes = (result: { results: Array<Record<string, unknown>> }) =>
  result.results.map((r) => r.document_type);

/** Text of the assembled CallToolResult's first content block. */
const contentText = (result: { content: unknown }): string =>
  formatText(result.content as ContentBlock[]);

describe('searchLegalTool', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('searches legal docs by query', async () => {
      const results = [{ document_type: 'advisory_opinion', ao_no: '2024-01', name: 'Test AO' }];
      mockService.searchLegal.mockResolvedValueOnce({
        results,
        totalCount: 1,
      });

      const input = searchLegalTool.input.parse({ query: 'contribution limits' });
      const result = await searchLegalTool.handler(input, ctx);

      expect(result.results).toEqual(results);
      expect(result.total_count).toBe(1);
      expect(mockService.searchLegal).toHaveBeenCalledOnce();
      expect(getEnrichment(ctx).notice).toBeUndefined();
      expect(result.search_criteria).toMatchObject({ query: 'contribution limits' });
    });

    it('sets enrichment totalCount from service result', async () => {
      const results = [{ document_type: 'advisory_opinion', ao_no: '2024-01', name: 'Test AO' }];
      mockService.searchLegal.mockResolvedValueOnce({
        results,
        totalCount: 42,
      });

      const input = searchLegalTool.input.parse({ query: 'contribution limits' });
      await searchLegalTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(42);
    });

    it('sets enrichment totalCount to 0 when no results', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [],
        totalCount: 0,
      });

      const input = searchLegalTool.input.parse({ query: 'no match query' });
      await searchLegalTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
    });

    it('sets enrichment notice when legal search returns no results', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [],
        totalCount: 0,
      });

      const input = searchLegalTool.input.parse({ query: 'no match query' });
      await searchLegalTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBeDefined();
      expect(getEnrichment(ctx).notice).toContain('No legal documents matched');
      expect(getEnrichment(ctx).retrievalHint).toBeUndefined();
    });

    it('routes every non-empty result to the detail tool, since all results are trimmed', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [
          {
            document_type: 'mur',
            no: '7226',
            documents: [{ category: 'Conciliation Agreement' }],
          },
        ],
        totalCount: 1,
        typeTotals: { advisory_opinions: 0, murs: 1, adrs: 0, admin_fines: 0, statutes: 0 },
      });

      const input = searchLegalTool.input.parse({ case_number: '7226' });
      await searchLegalTool.handler(input, ctx);

      const hint = getEnrichment(ctx).retrievalHint as string;
      expect(hint).toContain('openfec_get_legal_document');
      expect(hint).toContain('mur to murs');
      expect(hint).toContain("the result's no field");
      expect(hint).toContain('disposition_count and disposition_categories');
      expect(hint).toContain('untrimmed documents, dispositions, and commission_votes');
    });

    it('throws when no filter provided', async () => {
      const input = searchLegalTool.input.parse({});

      await expect(searchLegalTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('accepts respondent as a standalone filter', async () => {
      mockService.searchLegal.mockResolvedValueOnce(
        untypedPage({ murs: 12, adrs: 3, admin_fines: 4469, statutes: 57 }),
      );

      const input = searchLegalTool.input.parse({ respondent: 'Acme Corporation' });
      const result = await searchLegalTool.handler(input, ctx);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.case_respondents).toBe('Acme Corporation');
      expect(callArgs).not.toHaveProperty('type');
      expect(documentTypes(result)).toEqual(['mur', 'adr']);
      expect(result.total_count).toBe(15);
      expect(getEnrichment(ctx).totalCount).toBe(15);
    });

    it('accepts regulatory_citation as a standalone filter', async () => {
      mockService.searchLegal.mockResolvedValueOnce(
        untypedPage({ advisory_opinions: 234, murs: 95, adrs: 67, admin_fines: 0, statutes: 57 }),
      );

      const input = searchLegalTool.input.parse({ regulatory_citation: '11 CFR 110.1' });
      const result = await searchLegalTool.handler(input, ctx);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.ao_regulatory_citation).toBe('11 CFR 110.1');
      expect(callArgs.case_regulatory_citation).toBe('11 CFR 110.1');
      expect(documentTypes(result)).toEqual(['advisory_opinion', 'mur', 'adr']);
      expect(result.total_count).toBe(234 + 95 + 67);
    });

    it('accepts statutory_citation as a standalone filter', async () => {
      mockService.searchLegal.mockResolvedValueOnce(
        untypedPage({ advisory_opinions: 117, murs: 346, adrs: 20, admin_fines: 0, statutes: 57 }),
      );

      const input = searchLegalTool.input.parse({ statutory_citation: '52 U.S.C. 30118' });
      const result = await searchLegalTool.handler(input, ctx);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.ao_statutory_citation).toBe('52 U.S.C. 30118');
      expect(callArgs.case_statutory_citation).toBe('52 U.S.C. 30118');
      expect(documentTypes(result)).not.toContain('statute');
      expect(result.total_count).toBe(117 + 346 + 20);
    });

    it('passes ao_number as ao_no', async () => {
      mockService.searchLegal.mockResolvedValueOnce(typedPage('advisory_opinions', 1));

      const input = searchLegalTool.input.parse({ ao_number: '2024-01' });
      const result = await searchLegalTool.handler(input, ctx);

      expect(mockService.searchLegal).toHaveBeenCalledOnce();
      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.ao_no).toBe('2024-01');
      expect(callArgs.type).toBe('advisory_opinions');
      expect(callArgs).not.toHaveProperty('ao_number');
      expect(documentTypes(result)).toEqual(['advisory_opinion']);
      expect(result.total_count).toBe(1);
    });

    it('maps penalty bounds to the case_* names the endpoint accepts', async () => {
      mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 0 });

      const input = searchLegalTool.input.parse({
        type: 'murs',
        min_penalty_amount: 1_000_000,
        max_penalty_amount: 5_000_000,
      });
      await searchLegalTool.handler(input, ctx);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.case_min_penalty_amount).toBe(1_000_000);
      expect(callArgs.case_max_penalty_amount).toBe(5_000_000);
      expect(callArgs).not.toHaveProperty('min_penalty_amount');
      expect(callArgs).not.toHaveProperty('max_penalty_amount');
    });

    it('accepts a penalty bound as a standalone filter', async () => {
      mockService.searchLegal.mockResolvedValueOnce(
        untypedPage({ advisory_opinions: 2095, murs: 2, adrs: 0, admin_fines: 5, statutes: 57 }),
      );

      const input = searchLegalTool.input.parse({ min_penalty_amount: 1_000_000 });
      const result = await searchLegalTool.handler(input, ctx);

      expect(mockService.searchLegal).toHaveBeenCalledOnce();
      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.case_min_penalty_amount).toBe(1_000_000);
      expect(documentTypes(result)).toEqual(['mur', 'admin_fine']);
      expect(result.total_count).toBe(7);
    });

    it('rejects an inverted penalty range before dispatch', async () => {
      const input = searchLegalTool.input.parse({
        min_penalty_amount: 5_000_000,
        max_penalty_amount: 1_000_000,
      });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_range' });
      expect(mockService.searchLegal).not.toHaveBeenCalled();
    });

    it('rejects an inverted resolved date range before dispatch', async () => {
      const input = searchLegalTool.input.parse({
        type: 'murs',
        date_kind: 'open_date',
        min_date: '2024-12-31',
        max_date: '2024-01-01',
      });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_range' });
      expect(mockService.searchLegal).not.toHaveBeenCalled();
    });

    it('rejects a malformed resolved date before dispatch', async () => {
      const input = searchLegalTool.input.parse({
        type: 'murs',
        date_kind: 'open_date',
        min_date: 'not-a-date',
      });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'invalid_date', field: 'min_date' });
      expect(mockService.searchLegal).not.toHaveBeenCalled();
    });

    it('keeps date_filter_incomplete ahead of malformed-date validation', async () => {
      const input = searchLegalTool.input.parse({ min_date: 'not-a-date' });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'date_filter_incomplete' });
    });

    it('keeps invalid date_kind ahead of malformed-date validation', async () => {
      const input = searchLegalTool.input.parse({
        type: 'murs',
        date_kind: 'issue_date',
        min_date: 'not-a-date',
      });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'date_kind_not_valid_for_type' });
    });

    it.each([
      ['murs', 'open_date', 'case_min_open_date', 'case_max_open_date'],
      ['murs', 'close_date', 'case_min_close_date', 'case_max_close_date'],
      ['murs', 'document_date', 'case_min_document_date', 'case_max_document_date'],
      ['adrs', 'open_date', 'case_min_open_date', 'case_max_open_date'],
      ['advisory_opinions', 'issue_date', 'ao_min_issue_date', 'ao_max_issue_date'],
      ['advisory_opinions', 'request_date', 'ao_min_request_date', 'ao_max_request_date'],
      ['advisory_opinions', 'document_date', 'ao_min_document_date', 'ao_max_document_date'],
      ['admin_fines', 'rtb_date', 'af_min_rtb_date', 'af_max_rtb_date'],
      ['admin_fines', 'fd_date', 'af_min_fd_date', 'af_max_fd_date'],
    ])('maps type=%s date_kind=%s onto %s/%s', async (type, kind, minParam, maxParam) => {
      mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 0 });

      const input = searchLegalTool.input.parse({
        type,
        date_kind: kind,
        min_date: '2024-01-01',
        max_date: '2024-12-31',
      });
      await searchLegalTool.handler(input, ctx);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs[minParam]).toBe('2024-01-01');
      expect(callArgs[maxParam]).toBe('2024-12-31');
      expect(callArgs).not.toHaveProperty('min_date');
      expect(callArgs).not.toHaveProperty('max_date');
      expect(callArgs).not.toHaveProperty('date_kind');
    });

    it('sends only the bound that was given', async () => {
      mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 0 });

      const input = searchLegalTool.input.parse({
        type: 'murs',
        date_kind: 'open_date',
        min_date: '2024-01-01',
      });
      await searchLegalTool.handler(input, ctx);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.case_min_open_date).toBe('2024-01-01');
      expect(callArgs).not.toHaveProperty('case_max_open_date');
    });

    it('rejects a date_kind the document type does not record, naming the valid ones', async () => {
      const input = searchLegalTool.input.parse({
        type: 'murs',
        date_kind: 'issue_date',
        min_date: '2024-01-01',
      });

      const err = await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      const data = (err as McpError).data as { reason: string; valid_date_kinds: string[] };
      expect(data.reason).toBe('date_kind_not_valid_for_type');
      expect(data.valid_date_kinds).toEqual(['open_date', 'close_date', 'document_date']);
      expect(mockService.searchLegal).not.toHaveBeenCalled();
    });

    it('rejects any date filter on statutes, which carry no filterable date', async () => {
      const input = searchLegalTool.input.parse({
        type: 'statutes',
        date_kind: 'document_date',
        min_date: '2024-01-01',
      });

      const err = await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      const data = (err as McpError).data as { reason: string; valid_date_kinds: string[] };
      expect(data.reason).toBe('date_kind_not_valid_for_type');
      expect(data.valid_date_kinds).toEqual([]);
    });

    it.each([
      ['a bound without type or date_kind', { min_date: '2024-01-01' }],
      ['a bound without date_kind', { type: 'murs', min_date: '2024-01-01' }],
      ['a bound without type', { date_kind: 'open_date', min_date: '2024-01-01' }],
      ['a date_kind with no bound', { type: 'murs', date_kind: 'open_date' }],
    ])('rejects %s instead of dropping it', async (_label, args) => {
      const input = searchLegalTool.input.parse(args);

      const err = await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as McpError).data).toMatchObject({ reason: 'date_filter_incomplete' });
      expect(mockService.searchLegal).not.toHaveBeenCalled();
    });

    it('passes case_number as case_no', async () => {
      mockService.searchLegal.mockResolvedValueOnce(
        untypedPage({ advisory_opinions: 2095, murs: 1, adrs: 0, admin_fines: 1, statutes: 57 }),
      );

      const input = searchLegalTool.input.parse({ case_number: '4229' });
      const result = await searchLegalTool.handler(input, ctx);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.case_no).toBe('4229');
      expect(callArgs).not.toHaveProperty('case_number');
      expect(documentTypes(result)).toEqual(['mur', 'admin_fine']);
      expect(result.total_count).toBe(2);
    });
  });

  describe('type-specific filter routing', () => {
    /** Every upstream name a type-specific filter can be sent under. */
    const FILTER_PARAM_NAMES = [
      'ao_regulatory_citation',
      'case_regulatory_citation',
      'ao_statutory_citation',
      'case_statutory_citation',
      'case_min_penalty_amount',
      'case_max_penalty_amount',
      'case_respondents',
      'ao_no',
      'case_no',
    ];

    const filterParams = (callArgs: Record<string, unknown>) =>
      Object.keys(callArgs)
        .filter((k) => FILTER_PARAM_NAMES.includes(k))
        .sort();

    it.each([
      ['advisory_opinions', 'regulatory_citation', '11 CFR 110.1', 'ao_regulatory_citation'],
      ['murs', 'regulatory_citation', '11 CFR 110.1', 'case_regulatory_citation'],
      ['adrs', 'regulatory_citation', '11 CFR 110.1', 'case_regulatory_citation'],
      ['advisory_opinions', 'statutory_citation', '52 U.S.C. 30118', 'ao_statutory_citation'],
      ['murs', 'statutory_citation', '52 U.S.C. 30118', 'case_statutory_citation'],
      ['adrs', 'statutory_citation', '52 U.S.C. 30118', 'case_statutory_citation'],
      ['murs', 'min_penalty_amount', 1000, 'case_min_penalty_amount'],
      ['adrs', 'min_penalty_amount', 1000, 'case_min_penalty_amount'],
      ['admin_fines', 'min_penalty_amount', 1000, 'case_min_penalty_amount'],
      ['murs', 'max_penalty_amount', 1000, 'case_max_penalty_amount'],
      ['adrs', 'max_penalty_amount', 1000, 'case_max_penalty_amount'],
      ['admin_fines', 'max_penalty_amount', 1000, 'case_max_penalty_amount'],
      ['murs', 'respondent', 'Acme', 'case_respondents'],
      ['adrs', 'respondent', 'Acme', 'case_respondents'],
      ['advisory_opinions', 'ao_number', '2024-01', 'ao_no'],
      ['murs', 'case_number', '8343', 'case_no'],
      ['adrs', 'case_number', '172', 'case_no'],
      ['admin_fines', 'case_number', '4229', 'case_no'],
    ])('type=%s sends %s only as %s', async (type, filter, value, param) => {
      mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 0 });

      const input = searchLegalTool.input.parse({ type, [filter]: value });
      await searchLegalTool.handler(input, ctx);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.type).toBe(type);
      expect(filterParams(callArgs)).toEqual([param]);
      expect(callArgs[param]).toBe(value);
    });

    it.each([
      ['admin_fines', 'regulatory_citation', '11 CFR 104.5', ['advisory_opinions', 'murs', 'adrs']],
      ['statutes', 'regulatory_citation', '11 CFR 110.1', ['advisory_opinions', 'murs', 'adrs']],
      [
        'admin_fines',
        'statutory_citation',
        '52 U.S.C. 30104',
        ['advisory_opinions', 'murs', 'adrs'],
      ],
      ['statutes', 'statutory_citation', '52 U.S.C. 30104', ['advisory_opinions', 'murs', 'adrs']],
      ['advisory_opinions', 'min_penalty_amount', 1_000_000, ['murs', 'adrs', 'admin_fines']],
      ['statutes', 'min_penalty_amount', 1_000_000, ['murs', 'adrs', 'admin_fines']],
      ['advisory_opinions', 'max_penalty_amount', 1_000_000, ['murs', 'adrs', 'admin_fines']],
      ['statutes', 'max_penalty_amount', 1_000_000, ['murs', 'adrs', 'admin_fines']],
      ['advisory_opinions', 'respondent', 'Committee', ['murs', 'adrs']],
      ['admin_fines', 'respondent', 'Committee', ['murs', 'adrs']],
      ['statutes', 'respondent', 'Committee', ['murs', 'adrs']],
      ['murs', 'ao_number', '2024-01', ['advisory_opinions']],
      ['adrs', 'ao_number', '2024-01', ['advisory_opinions']],
      ['admin_fines', 'ao_number', '2024-01', ['advisory_opinions']],
      ['statutes', 'ao_number', '2024-01', ['advisory_opinions']],
      ['advisory_opinions', 'case_number', '4229', ['murs', 'adrs', 'admin_fines']],
      ['statutes', 'case_number', '4229', ['murs', 'adrs', 'admin_fines']],
    ])(
      'rejects type=%s with %s before dispatch, naming the types that accept it',
      async (type, filter, value, acceptedBy) => {
        const input = searchLegalTool.input.parse({ type, [filter]: value });
        const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
          (e: unknown) => e,
        )) as McpError;

        expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(err.data).toMatchObject({
          reason: 'filter_not_valid_for_type',
          type,
          accepted_by: { [filter]: acceptedBy },
        });
        expect(err.message).toContain(filter);
        expect((err.data as { recovery: { hint: string } }).recovery.hint).toBeTruthy();
        expect(mockService.searchLegal).not.toHaveBeenCalled();
      },
    );

    it('names every filter the type ignores in one rejection', async () => {
      const input = searchLegalTool.input.parse({
        type: 'statutes',
        respondent: 'Committee',
        ao_number: '2024-01',
      });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({
        reason: 'filter_not_valid_for_type',
        accepted_by: { respondent: ['murs', 'adrs'], ao_number: ['advisory_opinions'] },
      });
    });

    it.each([
      [{ ao_number: '2024-01', respondent: 'Committee' }],
      [{ ao_number: '2024-01', case_number: '4229' }],
      [{ ao_number: '2024-01', min_penalty_amount: 1000 }],
      [{ regulatory_citation: '11 CFR 110.1', case_number: '4229', ao_number: '2024-01' }],
    ])('rejects untyped filters no single type accepts together: %o', async (args) => {
      const input = searchLegalTool.input.parse(args);
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'filter_not_valid_for_type' });
      const acceptedBy = (err.data as { accepted_by: Record<string, string[]> }).accepted_by;
      expect(Object.keys(acceptedBy).sort()).toEqual(Object.keys(args).sort());
      expect(err.data).not.toHaveProperty('type');
      expect(mockService.searchLegal).not.toHaveBeenCalled();
    });

    it('sends only the case_* family when the untyped filters leave just murs and adrs', async () => {
      mockService.searchLegal.mockResolvedValueOnce(
        untypedPage({ advisory_opinions: 2095, murs: 40, adrs: 2, admin_fines: 0, statutes: 57 }),
      );

      const input = searchLegalTool.input.parse({ query: 'earmark', respondent: 'Committee' });
      const result = await searchLegalTool.handler(input, ctx);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(filterParams(callArgs)).toEqual(['case_respondents']);
      expect(documentTypes(result)).toEqual(['mur', 'adr']);
      expect(result.total_count).toBe(42);
    });

    /**
     * Measured live: with a citation on murs or adrs, `/legal/search/` answers
     * with the citation (and any query and document_date bound) applied and
     * case_no, case_respondents, the penalty bounds, and the open and close
     * date bounds dropped — `case_regulatory_citation=11 CFR 110.1` alone and
     * with `case_respondents=Obama`, `case_no=6916`,
     * `case_min_penalty_amount=1000000`, or `case_min_open_date=2020-01-01`
     * all return the same 95 MURs.
     */
    it.each<[string | undefined, Record<string, unknown>, string[]]>([
      ['murs', { regulatory_citation: '11 CFR 110.1', respondent: 'Obama' }, ['respondent']],
      ['adrs', { statutory_citation: '52 U.S.C. 30104', case_number: '1198' }, ['case_number']],
      [
        'murs',
        { regulatory_citation: '11 CFR 110.1', min_penalty_amount: 1_000_000 },
        ['min_penalty_amount'],
      ],
      [
        'murs',
        { statutory_citation: '52 U.S.C. 30104', max_penalty_amount: 10 },
        ['max_penalty_amount'],
      ],
      [
        'murs',
        { regulatory_citation: '11 CFR 110.1', date_kind: 'open_date', min_date: '2020-01-01' },
        ['min_date'],
      ],
      [
        'adrs',
        {
          statutory_citation: '52 U.S.C. 30104',
          date_kind: 'close_date',
          min_date: '2020-01-01',
          max_date: '2024-01-01',
        },
        ['max_date', 'min_date'],
      ],
      [undefined, { regulatory_citation: '11 CFR 110.1', respondent: 'Committee' }, ['respondent']],
      [undefined, { statutory_citation: '52 U.S.C. 30104', case_number: '4229' }, ['case_number']],
      [
        undefined,
        {
          regulatory_citation: '11 CFR 110.1',
          respondent: 'Committee',
          min_penalty_amount: 10,
        },
        ['min_penalty_amount', 'respondent'],
      ],
    ])(
      'rejects a citation on type=%s combined with %o, whose other filters the search index drops',
      async (type, args, dropped) => {
        const input = searchLegalTool.input.parse(type ? { type, ...args } : args);
        const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
          (e: unknown) => e,
        )) as McpError;

        expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(err.data).toMatchObject({ reason: 'filter_not_valid_for_type' });
        expect(
          [...(err.data as { ignored_with_citation: string[] }).ignored_with_citation].sort(),
        ).toEqual(dropped);
        expect(err.message).toContain('citation');
        for (const field of dropped) expect(err.message).toContain(field);
        expect((err.data as { recovery: { hint: string } }).recovery.hint).toContain(
          'citation on its own',
        );
        expect(mockService.searchLegal).not.toHaveBeenCalled();
      },
    );

    it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
      [
        'murs',
        { regulatory_citation: '11 CFR 110.1', query: 'earmark' },
        { case_regulatory_citation: '11 CFR 110.1', q: 'earmark' },
      ],
      [
        'murs',
        { regulatory_citation: '11 CFR 110.1', date_kind: 'document_date', min_date: '2020-01-01' },
        { case_regulatory_citation: '11 CFR 110.1', case_min_document_date: '2020-01-01' },
      ],
      [
        'advisory_opinions',
        { regulatory_citation: '11 CFR 110.1', date_kind: 'issue_date', min_date: '2020-01-01' },
        { ao_regulatory_citation: '11 CFR 110.1', ao_min_issue_date: '2020-01-01' },
      ],
    ])(
      'keeps a citation on type=%s combined with %o, which the search index applies together',
      async (type, args, sent) => {
        mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 0 });

        const input = searchLegalTool.input.parse({ type, ...args });
        await searchLegalTool.handler(input, ctx);

        expect(mockService.searchLegal.mock.calls[0]![0]).toMatchObject({ type, ...sent });
      },
    );

    it('accepts combined untyped filters that share a type, scoping the one call to it', async () => {
      mockService.searchLegal.mockResolvedValueOnce(typedPage('advisory_opinions', 3));

      const input = searchLegalTool.input.parse({
        ao_number: '2024-01',
        regulatory_citation: '11 CFR 110.1',
      });
      const result = await searchLegalTool.handler(input, ctx);

      expect(mockService.searchLegal).toHaveBeenCalledOnce();
      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.type).toBe('advisory_opinions');
      expect(filterParams(callArgs)).toEqual(['ao_no', 'ao_regulatory_citation']);
      expect(documentTypes(result)).toEqual(['advisory_opinion']);
      expect(result.total_count).toBe(3);
    });

    it('fails loudly when an untyped response omits a per-type total it narrows over', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [{ document_type: 'mur', no: '1' }],
        totalCount: 13281,
        typeTotals: { advisory_opinions: 1, murs: 7670, admin_fines: 4469, statutes: 57 },
      });

      const input = searchLegalTool.input.parse({ respondent: 'Committee' });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toContain('total_adrs');
    });

    it('keeps every document type and the upstream total when no type-specific filter is given', async () => {
      mockService.searchLegal.mockResolvedValueOnce(
        untypedPage({
          advisory_opinions: 1520,
          murs: 4861,
          adrs: 448,
          admin_fines: 387,
          statutes: 1,
        }),
      );

      const input = searchLegalTool.input.parse({ query: 'contribution' });
      const result = await searchLegalTool.handler(input, ctx);

      expect(documentTypes(result)).toEqual([
        'advisory_opinion',
        'mur',
        'adr',
        'admin_fine',
        'statute',
      ]);
      expect(result.total_count).toBe(7217);
    });

    it('reports an untyped offset past the end of the retained types as exhausted', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [{ document_type: 'statute', no: '9001' }],
        totalCount: 291,
        typeTotals: { advisory_opinions: 234, murs: 0, adrs: 0, admin_fines: 0, statutes: 57 },
      });
      mockService.searchLegal.mockResolvedValueOnce({
        results: [],
        totalCount: 1,
        typeTotals: { advisory_opinions: 1 },
      });

      const multi = await runToolContract(searchLegalTool, {
        regulatory_citation: '11 CFR 110.1',
        from_hit: 5,
      });
      const multiOut = multi.structuredContent as { results: unknown[]; total_count: number };
      expect(multiOut.results).toEqual([]);
      expect(multiOut.total_count).toBe(234);
      expect(contentText(multi)).toContain('No results at this position.');

      const result = await runToolContract(searchLegalTool, {
        ao_number: '2024-01',
        from_hit: 5,
      });

      const structured = result.structuredContent as { results: unknown[]; total_count: number };
      expect(structured.results).toEqual([]);
      expect(structured.total_count).toBe(1);
      const text = contentText(result);
      expect(text).toContain('No results at this position.');
      expect(text).toContain('1 total');
    });

    it('renders the retained-type total on both surfaces of the assembled result', async () => {
      mockService.searchLegal.mockResolvedValueOnce(typedPage('advisory_opinions', 1));

      const result = await runToolContract(searchLegalTool, { ao_number: '2024-01' });

      expect(mockService.searchLegal).toHaveBeenCalledOnce();
      expect(mockService.searchLegal.mock.calls[0]![0].type).toBe('advisory_opinions');

      const structured = result.structuredContent as {
        results: Array<{ document_type: string }>;
        total_count: number;
        totalCount: number;
        search_criteria: Record<string, unknown>;
      };
      expect(structured.results.map((r) => r.document_type)).toEqual(['advisory_opinion']);
      expect(structured.total_count).toBe(1);
      expect(structured.totalCount).toBe(1);
      expect(structured.search_criteria).toEqual({ ao_number: '2024-01' });
      const text = contentText(result);
      expect(text).toContain('_1 total matching document(s)_');
      expect(text).not.toContain('13281');
      expect(text).not.toContain('### Matter Under Review');
    });
  });

  describe('citation form', () => {
    /**
     * Forms `/legal/search/` parses, each measured live against the unfiltered
     * MUR total (7670) as the control: every one narrowed the result.
     */
    const PARSED_STATUTORY = [
      '52 U.S.C. 30104',
      '52 USC 30104',
      '52 U.S.C. 30104(g)',
      '52 U.S.C. 30104(b)(3)',
      '52 u.s.c. 30104',
      '52 usc 30104',
      '52  U.S.C.  30104',
      '52 U.S.C 30104',
      '52 USC. 30104',
      '52 U.S.C. §30104',
      '52 U.S.C. § 30104',
      '52 U.S.C. §§30104',
      '52 U.S.C.  §  30104',
      '52\tU.S.C.\t30104',
      '52 U.S.C. 30104 ',
      '52 U.S.C. 30104zz',
      '52 U.S.C. 30104 extra words',
      '2 U.S.C. 441b',
      '2 U.S.C. 441B',
      '2 U.S.C. 441a(a)',
      '2 U.S.C. 441a-1',
      '26 U.S.C. 527',
      '52 U.S.C. 30104(a), (b)',
      '52 U.S.C. 30104(b) and (c)',
      '52 U.S.C. 30104 et seq.',
    ];
    const PARSED_REGULATORY = [
      '11 CFR 110.1',
      '11 C.F.R. 110.1',
      '11 C.F.R 110.1',
      '11 cfr 110.1',
      '11 c.f.r. 110.1',
      '11 CFR 110.1(b)',
      '11 CFR 100.5(g)',
      '11  CFR  110.1',
      '11 CFR §110.1',
      '11 CFR § 110.1',
      '11 CFR 9003.1',
      '11 CFR 110.1a',
      '11 CFR 110.1.2',
      '11 CFR 110.1 ',
      '11 CFR 110.1 extra words',
      '11 CFR 110.1(b), (c)',
    ];
    /**
     * Values holding a second citation. Upstream applies only the first and
     * ignores the rest — measured live, `52 U.S.C. 30104, 52 U.S.C. 30118`
     * returns exactly the 783 MURs `52 U.S.C. 30104` alone does (30118 alone
     * returns 346), and the reversed order returns 346.
     */
    const MULTIPLE_STATUTORY = [
      '52 U.S.C. 30104, 52 U.S.C. 30118',
      '52 U.S.C. 30104; 52 U.S.C. 30118',
      '52 U.S.C. 30104 and 52 U.S.C. 30118',
      '52 U.S.C. 30104 52 U.S.C. 30118',
      '52 U.S.C. 30104, 30118',
      '52 U.S.C. §§ 30104, 30118',
      '52 U.S.C. 30104 and 30118',
      '52 U.S.C. 30104 or 30118',
      '52 U.S.C. 30104 & 30118',
      '52 U.S.C. 30104/30118',
      '52 U.S.C. 30104 30118',
      '52 U.S.C. 30104-30118',
      '52 U.S.C. 30104 – 30118',
      '52 U.S.C. 30104 through 30118',
      '52 U.S.C. 30104(g), 30118',
      '52 U.S.C. 30104(g) 30118',
      '52 U.S.C. 30118, 11 CFR 114.2',
    ];
    const MULTIPLE_REGULATORY = [
      '11 CFR 110.1; 11 CFR 110.2',
      '11 CFR 110.1, 11 CFR 110.2',
      '11 CFR 110.1, 110.2',
      '11 CFR 110.1 and 110.2',
      '11 CFR 110.1-110.3',
      '11 CFR 110.1(b), 110.2',
      '11 CFR 110.1, 52 U.S.C. 30116',
    ];
    /** Forms upstream silently ignores, returning all 7670 MURs. */
    const IGNORED_STATUTORY = [
      '30106',
      'zzzz',
      '52 U.S.C. zz',
      'U.S.C. 30104',
      '52 30104',
      '52U.S.C. 30104',
      '52 U.S.C.30104',
      '52 U.S.C.§30104',
      '52 U.S. C. 30104',
      '52 U S C 30104',
      '52 U.S.Code 30104',
      ' 52 U.S.C. 30104',
      'see 52 U.S.C. 30104',
      '52 U.S.C. (g)',
    ];
    const IGNORED_REGULATORY = [
      '110.1',
      '11 CFR zz',
      '11 CFR 110',
      '11 CFR 110.',
      '11 CFR 110.zz',
      '11CFR 110.1',
      '11 CFR110.1',
      '11 C F R 110.1',
      '11 CFR 110 .1',
      '11 CFR 110. 1',
      '11 CFR.110.1',
      '11 CFR 110-1',
      '11 CFR Part 110',
      'CFR 110.1',
      ' 11 CFR 110.1',
      'see 11 CFR 110.1',
    ];

    it.each(PARSED_STATUTORY)(
      'passes statutory_citation %j through byte-identical',
      async (value) => {
        mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 0 });

        const input = searchLegalTool.input.parse({ type: 'murs', statutory_citation: value });
        await searchLegalTool.handler(input, ctx);

        expect(mockService.searchLegal.mock.calls[0]![0].case_statutory_citation).toBe(value);
      },
    );

    it.each(PARSED_REGULATORY)(
      'passes regulatory_citation %j through byte-identical',
      async (value) => {
        mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 0 });

        const input = searchLegalTool.input.parse({
          type: 'advisory_opinions',
          regulatory_citation: value,
        });
        await searchLegalTool.handler(input, ctx);

        expect(mockService.searchLegal.mock.calls[0]![0].ao_regulatory_citation).toBe(value);
      },
    );

    it.each([
      ...IGNORED_STATUTORY.map((value) => ['statutory_citation', value] as const),
      ...IGNORED_REGULATORY.map((value) => ['regulatory_citation', value] as const),
    ])('rejects %s %j before dispatch as invalid_citation', async (field, value) => {
      const input = searchLegalTool.input.parse({ type: 'murs', [field]: value });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({
        reason: 'invalid_citation',
        invalid_citations: { [field]: value },
      });
      const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
      expect(hint).toContain('52 U.S.C. 30104');
      expect(hint).toContain('11 CFR 110.1');
      expect(mockService.searchLegal).not.toHaveBeenCalled();
    });

    it('rejects an unparseable citation on an untyped search too, naming every bad field', async () => {
      const input = searchLegalTool.input.parse({
        statutory_citation: '30106',
        regulatory_citation: '110.1',
      });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({
        reason: 'invalid_citation',
        invalid_citations: { statutory_citation: '30106', regulatory_citation: '110.1' },
      });
      expect(mockService.searchLegal).not.toHaveBeenCalled();
    });

    it.each([
      ...MULTIPLE_STATUTORY.map((value) => ['statutory_citation', value] as const),
      ...MULTIPLE_REGULATORY.map((value) => ['regulatory_citation', value] as const),
    ])('rejects %s %j, which carries a second citation, before dispatch', async (field, value) => {
      const input = searchLegalTool.input.parse({ type: 'murs', [field]: value });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({
        reason: 'invalid_citation',
        invalid_citations: { [field]: value },
      });
      expect(err.message).toContain('more than one citation');
      const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
      expect(hint).toContain('one citation per field');
      expect(mockService.searchLegal).not.toHaveBeenCalled();
    });

    it('names each bad field with its own problem when one is unparseable and one carries two citations', async () => {
      const input = searchLegalTool.input.parse({
        statutory_citation: '30106',
        regulatory_citation: '11 CFR 110.1; 11 CFR 110.2',
      });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({
        reason: 'invalid_citation',
        invalid_citations: {
          statutory_citation: '30106',
          regulatory_citation: '11 CFR 110.1; 11 CFR 110.2',
        },
      });
      expect(err.message).toContain('statutory_citation "30106" is not a citation');
      expect(err.message).toContain(
        'regulatory_citation "11 CFR 110.1; 11 CFR 110.2" holds more than one citation',
      );
      expect(mockService.searchLegal).not.toHaveBeenCalled();
    });

    it('checks a long run of separators and spaces after a citation in linear time', async () => {
      const value = `52 U.S.C. 30104${', '.repeat(20_000)}${' '.repeat(40_000)}x`;
      const input = searchLegalTool.input.parse({ type: 'murs', statutory_citation: value });
      mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 0 });

      const started = performance.now();
      await searchLegalTool.handler(input, ctx);

      expect(performance.now() - started).toBeLessThan(500);
      expect(mockService.searchLegal.mock.calls[0]![0].case_statutory_citation).toBe(value);
    });

    it('states the required form, and one citation per field, in both citation field descriptions', () => {
      const shape = searchLegalTool.input.shape;
      expect(shape.statutory_citation.description).toContain('<title> U.S.C. <section>');
      expect(shape.regulatory_citation.description).toContain('<title> CFR <part>.<section>');
      expect(shape.statutory_citation.description).toContain('One citation per value');
      expect(shape.regulatory_citation.description).toContain('One citation per value');
    });

    /**
     * Measured live: `11 CFR 110.1` matches 95 MURs and `52 U.S.C. 30104` 783;
     * both together match 833, so the two fields combine as either-or.
     */
    it('states in both citation field descriptions that the two citations combine as either-or', () => {
      const shape = searchLegalTool.input.shape;
      for (const field of ['statutory_citation', 'regulatory_citation'] as const) {
        expect(shape[field].description).toContain('cites either one');
      }
    });
  });

  describe('result trimming', () => {
    it('caps highlights at three, drops document_highlights, and summarizes documents', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [
          {
            document_type: 'mur',
            no: '8363',
            highlights: ['one', 'two', 'three', 'four', 'five'],
            document_highlights: { '1': ['per-document'] },
            documents: [{ category: 'Complaint' }, { category: 'Complaint' }, { category: 'GCR' }],
          },
        ],
        totalCount: 1,
      });

      const input = searchLegalTool.input.parse({ type: 'murs', query: 'contribution' });
      const result = await searchLegalTool.handler(input, ctx);

      const [doc] = result.results;
      expect(doc?.highlights).toEqual(['one', 'two', 'three']);
      expect(doc).not.toHaveProperty('document_highlights');
      expect(doc).not.toHaveProperty('documents');
      expect(doc?.document_count).toBe(3);
      expect(doc?.document_categories).toEqual(['Complaint', 'GCR']);
    });

    it('summarizes case dispositions as a count and their distinct outcomes, in first-seen order', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [
          {
            document_type: 'mur',
            no: '8343',
            dispositions: [
              { disposition: 'Dismissed-Other', respondent: 'A', citations: [] },
              { disposition: 'Settlement Agreement', respondent: 'B', penalty: 5000 },
              { disposition: 'Dismissed-Other', respondent: 'C' },
            ],
          },
        ],
        totalCount: 1,
      });

      const input = searchLegalTool.input.parse({ type: 'murs', query: 'contribution' });
      const result = await searchLegalTool.handler(input, ctx);

      const [doc] = result.results;
      expect(doc).not.toHaveProperty('dispositions');
      expect(doc?.disposition_count).toBe(3);
      expect(doc?.disposition_categories).toEqual(['Dismissed-Other', 'Settlement Agreement']);
    });

    it('summarizes administrative-fine dispositions by their description', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [asResult('af_4229', 'admin_fine')],
        totalCount: 1,
      });

      const input = searchLegalTool.input.parse({ type: 'admin_fines', case_number: '4229' });
      const result = await searchLegalTool.handler(input, ctx);

      const [doc] = result.results;
      expect(doc?.disposition_count).toBe(2);
      expect(doc?.disposition_categories).toEqual([
        'Initial finding and penalty assessed',
        'Initial finding upheld but no penalty assessed',
      ]);
    });

    it('cuts each commission vote to its date and a 200-character action', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [
          {
            document_type: 'mur',
            no: '8343',
            commission_votes: [
              {
                vote_date: '2025-02-24',
                action: 'A'.repeat(250),
                commissioner_name: 'X',
                vote_type: 'Affirmed',
              },
            ],
          },
        ],
        totalCount: 1,
      });

      const input = searchLegalTool.input.parse({ type: 'murs', query: 'contribution' });
      const result = await searchLegalTool.handler(input, ctx);

      expect(result.results[0]?.commission_votes).toEqual([
        { vote_date: '2025-02-24', action: 'A'.repeat(200) },
      ]);
    });

    it('keeps hits_returned at its schema maximum of 200', () => {
      expect(searchLegalTool.input.parse({ type: 'murs', hits_returned: 200 }).hits_returned).toBe(
        200,
      );
      expect(() => searchLegalTool.input.parse({ type: 'murs', hits_returned: 201 })).toThrow();
    });

    it('leaves a highlights list of three or fewer at its length', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [{ document_type: 'mur', no: '8363', highlights: ['only one'] }],
        totalCount: 1,
      });

      const input = searchLegalTool.input.parse({ type: 'murs', query: 'contribution' });
      const result = await searchLegalTool.handler(input, ctx);

      expect(result.results[0]?.highlights).toEqual(['only one']);
    });
  });

  describe('highlight markup', () => {
    /** Run one highlight list through the full contract and return both surfaces. */
    const runHighlights = async (highlights: string[]) => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [{ document_type: 'mur', no: '8363', name: 'Example', highlights }],
        totalCount: 1,
      });
      const result = await runToolContract(searchLegalTool, {
        type: 'murs',
        query: 'contribution',
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { results: Array<{ highlights: string[] }> };
      return { highlights: structured.results[0]!.highlights, text: contentText(result) };
    };

    it('removes the emphasis tags upstream wraps each match in, keeping the words', async () => {
      const [live] = LIVE.mur_highlight_search.highlights;
      const { highlights, text } = await runHighlights([live!]);

      const expected =
        'The  reimbursement process used for that New York State contribution is identical to the one used for';
      expect(highlights).toEqual([expected]);
      expect(text).toContain(expected);
      expect(text).not.toContain('<em>');
      expect(text).not.toContain('</em>');
    });

    it('joins adjacent emphasized words with the space between them', async () => {
      const { highlights } = await runHighlights(['raised <em>soft</em> <em>money</em> for']);
      expect(highlights).toEqual(['raised soft money for']);
    });

    it('leaves literal angle brackets and ampersands exactly as sent', async () => {
      const source = [
        'contact Robert Knop <rknop@fec.gov> about the <em>contribution</em>',
        'We > would <em>not</em> accept AT&T or &amp; as written',
      ];
      const { highlights, text } = await runHighlights(source);

      expect(highlights).toEqual([
        'contact Robert Knop <rknop@fec.gov> about the contribution',
        'We > would not accept AT&T or &amp; as written',
      ]);
      for (const h of highlights) expect(text).toContain(h);
    });

    it('normalizes every highlight it keeps and still stops at three', async () => {
      const { highlights, text } = await runHighlights(LIVE.mur_highlight_search.highlights);

      expect(LIVE.mur_highlight_search.highlights.length).toBeGreaterThan(3);
      expect(highlights).toHaveLength(3);
      for (const h of highlights) {
        expect(h).not.toMatch(/<\/?em>/);
        expect(text).toContain(h);
      }
    });

    it('renders each highlight on its own line in content[], not comma-joined', async () => {
      const { highlights, text } = await runHighlights([
        'first, with a comma',
        'second <em>match</em>, also with one',
        'third',
      ]);

      expect(highlights).toEqual(['first, with a comma', 'second match, also with one', 'third']);
      expect(text).toContain(
        '  highlights:\n    - first, with a comma\n    - second match, also with one\n    - third\n',
      );
    });

    it('renders a single highlight on the key line', async () => {
      const { text } = await runHighlights(['only <em>one</em>, here']);
      expect(text).toContain('  highlights: only one, here\n');
    });

    /**
     * Live snippets carry line breaks of their own (a MUR's bulleted list,
     * a wrapped advisory-opinion paragraph), so a continuation line is indented
     * under its item — otherwise it reads as a highlight, or a field, of its own.
     */
    it('keeps a snippet that spans lines inside its own list item', async () => {
      const { highlights, text } = await runHighlights([
        'under reported 10,000\n• <em>Contribution</em> reported but did not clear bank',
        'If a committee receives a <em>contribution</em> that \nappears to be prohibited',
      ]);

      expect(highlights).toEqual([
        'under reported 10,000\n• Contribution reported but did not clear bank',
        'If a committee receives a contribution that \nappears to be prohibited',
      ]);
      expect(text).toContain(
        '  highlights:\n    - under reported 10,000\n      • Contribution reported but did not clear bank\n    - If a committee receives a contribution that \n      appears to be prohibited\n',
      );
    });

    it('indents the continuation of a single highlight that spans lines', async () => {
      const { text } = await runHighlights(['one <em>match</em>\nwrapped']);
      expect(text).toContain('  highlights: one match\n      wrapped\n');
    });

    it('leaves a non-string highlight entry untouched', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [{ document_type: 'mur', no: '8363', highlights: [42, '<em>x</em>'] }],
        totalCount: 1,
      });
      const input = searchLegalTool.input.parse({ type: 'murs', query: 'x' });
      const result = await searchLegalTool.handler(input, ctx);
      expect(result.results[0]?.highlights).toEqual([42, 'x']);
    });
  });

  describe('nested field rendering', () => {
    const LIVE_SEARCHES = [
      ['murs', '8343', 'mur_8343', 'mur'],
      ['murs', '1704', 'mur_1704', 'mur'],
      ['adrs', '172', 'adr_172', 'adr'],
      ['advisory_opinions', '2003-37', 'ao_2003_37', 'advisory_opinion'],
      ['admin_fines', '4229', 'af_4229', 'admin_fine'],
    ] as const;

    it.each(LIVE_SEARCHES)(
      'renders no JSON object literal for any nested field of %s %s, structuredContent untouched',
      async (type, no, key, documentType) => {
        const record = asResult(key, documentType);
        mockService.searchLegal.mockResolvedValueOnce({ results: [record], totalCount: 1 });

        const args =
          type === 'advisory_opinions' ? { type, ao_number: no } : { type, case_number: no };
        const result = await runToolContract(searchLegalTool, args);

        expect(result.isError).toBeFalsy();
        expect(contentText(result)).not.toContain('{"');
      },
    );

    it('renders a page of administrative fines without JSON', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [asResult('af_4229', 'admin_fine'), asResult('af_4229', 'admin_fine')],
        totalCount: 4469,
      });

      const result = await runToolContract(searchLegalTool, { type: 'admin_fines' });

      const text = contentText(result);
      expect(text).not.toContain('{"');
      expect(text).toContain('disposition_count: 2');
      expect(text).toContain(
        'disposition_categories: Initial finding and penalty assessed, Initial finding upheld but no penalty assessed',
      );
      expect(text).toContain('commission_votes: (no date or action recorded)');
    });

    it('renders a current MUR search result compactly', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [asResult('mur_8343', 'mur')],
        totalCount: 1,
      });

      const result = await runToolContract(searchLegalTool, {
        type: 'murs',
        case_number: '8343',
      });

      const text = contentText(result);
      expect(text).toContain('**8343** — The Washington Post');
      expect(text).toContain('subjects: Contributions-Prohibited; Reporting');
      expect(text).toContain('disposition_count: 2');
      expect(text).toContain(
        'disposition_categories: Dismiss Pursuant to Prosecutorial Discretion',
      );
      expect(text).not.toContain('citations:');
      expect(text).toMatch(/commission_votes: 2025-02-24T00:00:00 — The Commission decided/);
    });

    it('heads an archived MUR by mur_name', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [asResult('mur_1704', 'mur')],
        totalCount: 1,
      });

      const result = await runToolContract(searchLegalTool, {
        type: 'murs',
        case_number: '1704',
      });

      const text = contentText(result);
      expect(text).toContain('**1704** — MONDALE DELEGATE COMMITTEES');
      expect(text).not.toContain('mur_name:');
    });

    it('leaves the nested fields byte-identical on structuredContent', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [asResult('ao_2003_37', 'advisory_opinion')],
        totalCount: 1,
      });

      const result = await runToolContract(searchLegalTool, {
        type: 'advisory_opinions',
        ao_number: '2003-37',
      });

      const [doc] = (result.structuredContent as { results: Array<Record<string, unknown>> })
        .results;
      for (const key of [
        'entities',
        'ao_citations',
        'aos_cited_by',
        'regulatory_citations',
        'statutory_citations',
      ]) {
        expect(JSON.stringify(doc?.[key])).toBe(JSON.stringify(LIVE.ao_2003_37[key]));
      }
    });
  });

  describe('format', () => {
    it('renders the criteria echo on a non-empty response', () => {
      const blocks = searchLegalTool.format!({
        results: [{ document_type: 'mur', case_no: 'MUR-7890' }],
        total_count: 1,
        search_criteria: { query: 'contribution limits', type: 'murs' },
      });

      expect(formatText(blocks)).toContain(
        '_Search criteria: query=contribution limits · type=murs_',
      );
    });

    it('groups by document_type with labels', () => {
      const blocks = searchLegalTool.format!({
        results: [
          { document_type: 'advisory_opinion', ao_no: '2024-01', name: 'Test AO' },
          { document_type: 'mur', case_no: 'MUR-7890', name: 'MUR Case' },
          { document_type: 'advisory_opinion', ao_no: '2024-02', name: 'Another AO' },
        ],
        total_count: 3,
        search_criteria: { query: 'contribution limits' },
      });

      const text = formatText(blocks);
      expect(text).toContain('### Advisory Opinion');
      expect(text).toContain('### Matter Under Review (MUR)');
      expect(text).toContain('**2024-01**');
      expect(text).toContain('**2024-02**');
      expect(text).toContain('**MUR-7890**');
      expect(text).toContain('3 total matching document(s)');
    });

    it('renders penalty amounts', () => {
      const blocks = searchLegalTool.format!({
        results: [
          {
            document_type: 'admin_fine',
            no: 'AF-1234',
            name: 'Fine Case',
            penalty_amount: 25_000,
          },
        ],
        total_count: 1,
        search_criteria: { type: 'admin_fines' },
      });

      const text = formatText(blocks);
      expect(text).toContain('### Administrative Fine');
      expect(text).toContain('penalty_amount: 25000');
    });

    it('renders empty state', () => {
      const blocks = searchLegalTool.format!({
        results: [],
        total_count: 0,
        search_criteria: { query: 'nonexistent statute' },
      });

      expect(formatText(blocks)).toContain('No results found');
    });
  });

  describe('result window', () => {
    it('declares a legal_window_exceeded contract entry', () => {
      const reasons = searchLegalTool.errors?.map((entry) => entry.reason);
      expect(reasons).toContain('legal_window_exceeded');
    });

    it.each([
      [9999, 1],
      [9998, 2],
      [9995, 5],
      [9980, 20],
    ])(
      'dispatches from_hit %i with hits_returned %i, summing to the window',
      async (from, hits) => {
        mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 0 });

        const input = searchLegalTool.input.parse({
          type: 'murs',
          from_hit: from,
          hits_returned: hits,
        });
        await searchLegalTool.handler(input, ctx);

        expect(mockService.searchLegal).toHaveBeenCalledOnce();
        const callArgs = mockService.searchLegal.mock.calls[0]![0];
        expect(callArgs.from_hit).toBe(from);
        expect(callArgs.hits_returned).toBe(hits);
      },
    );

    it.each([
      [9999, 2],
      [9996, 5],
      [9981, 20],
    ])('rejects from_hit %i with hits_returned %i before dispatch', async (from, hits) => {
      const input = searchLegalTool.input.parse({
        type: 'murs',
        from_hit: from,
        hits_returned: hits,
      });
      const err = (await Promise.resolve(searchLegalTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({ reason: 'legal_window_exceeded' });
      expect(err.message).toContain('10,000');
      expect((err.data as { recovery: { hint: string } }).recovery.hint).toContain(
        String(10_000 - hits),
      );
      expect(mockService.searchLegal).not.toHaveBeenCalled();
    });

    it('rejects a from_hit above the advertised ceiling at the schema', () => {
      expect(() => searchLegalTool.input.parse({ type: 'murs', from_hit: 10_000 })).toThrow();
      expect(searchLegalTool.input.parse({ type: 'murs', from_hit: 9999 }).from_hit).toBe(9999);
    });
  });

  describe('exhausted offset', () => {
    it('reports an offset past the end as exhausted on both surfaces', async () => {
      mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 7670 });

      const input = searchLegalTool.input.parse({
        type: 'murs',
        from_hit: 7670,
        hits_returned: 5,
      });
      const result = await searchLegalTool.handler(input, ctx);

      expect(result.total_count).toBe(7670);
      expect(getEnrichment(ctx).totalCount).toBe(7670);
      expect(getEnrichment(ctx).notice).toContain('from_hit is past the end');
      expect(getEnrichment(ctx).notice).not.toContain('No legal documents matched');

      const text = formatText(searchLegalTool.format!(result));
      expect(text).toContain('No results at this position.');
      expect(text).toContain('7670 total');
      expect(text).not.toContain('No results found');
    });

    it('keeps zero-match guidance when nothing matched at all', async () => {
      mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 0 });

      const input = searchLegalTool.input.parse({ query: 'nonexistent statute', from_hit: 40 });
      const result = await searchLegalTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('No legal documents matched');

      const text = formatText(searchLegalTool.format!(result));
      expect(text).toContain('No results found.');
      expect(text).not.toContain('No results at this position');
    });
  });
});
