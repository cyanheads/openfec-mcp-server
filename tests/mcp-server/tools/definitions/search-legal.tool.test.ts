/**
 * @fileoverview Tests for the search-legal tool — validation, param mapping,
 * grouped format rendering, and penalty display.
 * @module tests/mcp-server/tools/definitions/search-legal.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
      });

      const input = searchLegalTool.input.parse({ case_number: '7226' });
      await searchLegalTool.handler(input, ctx);

      const hint = getEnrichment(ctx).retrievalHint as string;
      expect(hint).toContain('openfec_get_legal_document');
      expect(hint).toContain('mur to murs');
      expect(hint).toContain("the result's no field");
    });

    it('throws when no filter provided', async () => {
      const input = searchLegalTool.input.parse({});

      await expect(searchLegalTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('accepts respondent as a standalone filter', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [{ document_type: 'mur', case_no: 'MUR-7890', name: 'Acme Corporation' }],
        totalCount: 1,
      });

      const input = searchLegalTool.input.parse({ respondent: 'Acme Corporation' });
      const result = await searchLegalTool.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.case_respondents).toBe('Acme Corporation');
    });

    it('accepts regulatory_citation as a standalone filter', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [
          { document_type: 'advisory_opinion', ao_no: '2022-05', name: 'AO on 11 CFR 112' },
        ],
        totalCount: 1,
      });

      const input = searchLegalTool.input.parse({ regulatory_citation: '11 CFR 112.4' });
      const result = await searchLegalTool.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.ao_regulatory_citation).toBe('11 CFR 112.4');
    });

    it('accepts statutory_citation as a standalone filter', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [{ document_type: 'statute', no: '30106', name: 'Statute on contributions' }],
        totalCount: 1,
      });

      const input = searchLegalTool.input.parse({ statutory_citation: '52 U.S.C. 30106' });
      const result = await searchLegalTool.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.ao_statutory_citation).toBe('52 U.S.C. 30106');
    });

    it('passes ao_number as ao_no', async () => {
      mockService.searchLegal.mockResolvedValueOnce({
        results: [],
        totalCount: 0,
      });

      const input = searchLegalTool.input.parse({ ao_number: '2024-01' });
      await searchLegalTool.handler(input, ctx);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.ao_no).toBe('2024-01');
      expect(callArgs).not.toHaveProperty('ao_number');
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
      mockService.searchLegal.mockResolvedValueOnce({ results: [], totalCount: 0 });

      const input = searchLegalTool.input.parse({ min_penalty_amount: 1_000_000 });
      await searchLegalTool.handler(input, ctx);

      expect(mockService.searchLegal).toHaveBeenCalledOnce();
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
      mockService.searchLegal.mockResolvedValueOnce({
        results: [],
        totalCount: 0,
      });

      const input = searchLegalTool.input.parse({ case_number: 'MUR-7890' });
      await searchLegalTool.handler(input, ctx);

      const callArgs = mockService.searchLegal.mock.calls[0]![0];
      expect(callArgs.case_no).toBe('MUR-7890');
      expect(callArgs).not.toHaveProperty('case_number');
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
});
