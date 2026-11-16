/**
 * @fileoverview Tests for the lookup-elections tool — validation guards,
 * search/summary mode routing, and format rendering.
 * @module tests/mcp-server/tools/definitions/lookup-elections.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
  searchElectionsByZip: vi.fn(),
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

import { lookupElections as lookupElectionsTool } from '@/mcp-server/tools/definitions/lookup-elections.tool.js';
import { contractFailure, declaredRecovery } from './contract-failure.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

const makeCtx = () => createMockContext({ errors: lookupElectionsTool.errors });

describe('lookupElectionsTool', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('search mode returns election data', async () => {
      const elections = [
        {
          candidate_name: 'BIDEN, JOSEPH R JR',
          candidate_id: 'P00003392',
          party: 'DEM',
          total_receipts: 150_000_000,
          total_disbursements: 120_000_000,
        },
      ];
      mockService.searchElections.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: elections,
      });

      const input = lookupElectionsTool.input.parse({
        office: 'P',
        cycle: 2024,
      });
      const result = await lookupElectionsTool.handler(input, ctx);

      expect(result.results).toEqual(elections);
      expect(mockService.searchElections).toHaveBeenCalledOnce();
      expect(result.mode).toBe('search');
      expect(result.search_criteria).toMatchObject({
        mode: 'search',
        office: 'P',
        cycle: 2024,
        election_full: true,
      });
    });

    it('summary mode calls getElectionSummary', async () => {
      const summary = {
        count: 50,
        receipts: 500_000_000,
        disbursements: 400_000_000,
        independent_expenditures: 100_000_000,
      };
      mockService.getElectionSummary.mockResolvedValueOnce(summary);

      const input = lookupElectionsTool.input.parse({
        mode: 'summary',
        office: 'P',
        cycle: 2024,
      });
      const result = await lookupElectionsTool.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ count: 50, receipts: 500_000_000 });
      expect(mockService.getElectionSummary).toHaveBeenCalledOnce();
      expect(mockService.searchElections).not.toHaveBeenCalled();
      // The summary branch used to omit the echo entirely.
      expect(result.mode).toBe('summary');
      expect(result.search_criteria).toMatchObject({ mode: 'summary', office: 'P', cycle: 2024 });
    });

    it('omits election_full from a ZIP search it cannot apply', async () => {
      mockService.searchElectionsByZip.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [{ candidate_name: 'SMITH, JANE' }],
      });

      const input = lookupElectionsTool.input.parse({ office: 'H', cycle: 2024, zip: '98101' });
      const result = await lookupElectionsTool.handler(input, ctx);

      expect(mockService.searchElectionsByZip.mock.calls[0]![0]).not.toHaveProperty(
        'election_full',
      );
      expect(result.search_criteria).toMatchObject({ zip: '98101' });
      expect(result.search_criteria).not.toHaveProperty('election_full');
    });

    it('rejects an explicit election_full on a ZIP search instead of dropping it', async () => {
      const input = lookupElectionsTool.input.parse({
        office: 'H',
        cycle: 2024,
        zip: '98101',
        election_full: false,
      });

      await expect(lookupElectionsTool.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'inputs_not_applicable_to_mode',
          inapplicable_inputs: ['election_full'],
        },
      });
      expect(mockService.searchElectionsByZip).not.toHaveBeenCalled();
    });

    it('echoes the election_full default it applied on a non-ZIP search', async () => {
      mockService.searchElections.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [{ candidate_name: 'SMITH, JANE' }],
      });

      const input = lookupElectionsTool.input.parse({ office: 'P', cycle: 2024 });
      const result = await lookupElectionsTool.handler(input, ctx);

      expect(mockService.searchElections.mock.calls[0]![0]!.election_full).toBe(true);
      expect(result.search_criteria).toMatchObject({ election_full: true });
    });

    it('summary mode adds independent_expenditures caveat note to result', async () => {
      const summary = {
        count: 50,
        receipts: 100_000_000,
        disbursements: 99_000_000,
        independent_expenditures: 2_695_716_328_841.73,
      };
      mockService.getElectionSummary.mockResolvedValueOnce(summary);

      const input = lookupElectionsTool.input.parse({
        mode: 'summary',
        office: 'S',
        state: 'PA',
        cycle: 2024,
      });
      const result = await lookupElectionsTool.handler(input, ctx);
      const row = result.results[0];

      expect(row).toHaveProperty('independent_expenditures', 2_695_716_328_841.73);
      expect(row).toHaveProperty('_independent_expenditures_note');
      expect(String(row!._independent_expenditures_note)).toContain('Unreconciled');
    });

    it('forwards page and per_page in search mode', async () => {
      mockService.searchElections.mockResolvedValueOnce({
        pagination: { page: 3, pages: 44, count: 869, per_page: 20 },
        results: [{ candidate_name: 'SMITH, JANE', candidate_id: 'P00001234' }],
      });

      const input = lookupElectionsTool.input.parse({
        office: 'P',
        cycle: 2024,
        page: 3,
        per_page: 20,
      });
      const result = await lookupElectionsTool.handler(input, ctx);

      expect(mockService.searchElections).toHaveBeenCalledWith(
        expect.objectContaining({ page: 3, per_page: 20 }),
        ctx,
      );
      expect(result.pagination.page).toBe(3);
    });

    it('forwards page and per_page on the ZIP search path', async () => {
      mockService.searchElectionsByZip.mockResolvedValueOnce({
        pagination: { page: 2, pages: 3, count: 45, per_page: 20 },
        results: [{ candidate_name: 'SMITH, JANE' }],
      });

      const input = lookupElectionsTool.input.parse({
        office: 'H',
        cycle: 2024,
        zip: '98101',
        page: 2,
      });
      await lookupElectionsTool.handler(input, ctx);

      expect(mockService.searchElectionsByZip).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, per_page: 20 }),
        ctx,
      );
    });

    it.each([
      ['page', 4],
      ['per_page', 50],
    ] as const)('rejects explicit %s in summary mode', async (field, value) => {
      const err = await contractFailure(lookupElectionsTool, {
        mode: 'summary',
        office: 'P',
        cycle: 2024,
        [field]: value,
      });

      expect(err.data).toMatchObject({
        reason: 'inputs_not_applicable_to_mode',
        inapplicable_inputs: [field],
        supported_inputs: ['mode', 'office', 'cycle', 'state', 'district', 'election_full'],
        recovery: {
          hint: declaredRecovery(lookupElectionsTool, 'inputs_not_applicable_to_mode'),
        },
      });
      expect(mockService.getElectionSummary).not.toHaveBeenCalled();
    });

    it('throws on odd cycle year', async () => {
      const input = lookupElectionsTool.input.parse({
        office: 'P',
        cycle: 2025,
      });

      await expect(lookupElectionsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('throws when senate lookup missing state', async () => {
      const input = lookupElectionsTool.input.parse({
        office: 'S',
        cycle: 2024,
      });

      await expect(lookupElectionsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('throws when house lookup missing district', async () => {
      const input = lookupElectionsTool.input.parse({
        office: 'H',
        cycle: 2024,
        state: 'CA',
      });

      await expect(lookupElectionsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
    });

    it('president lookup does not require state or district', async () => {
      mockService.searchElections.mockResolvedValueOnce({
        pagination: PAGE,
        results: [],
      });

      const input = lookupElectionsTool.input.parse({
        office: 'P',
        cycle: 2024,
      });

      await expect(lookupElectionsTool.handler(input, ctx)).resolves.toBeDefined();
    });

    it('sets enrichment totalCount from pagination count', async () => {
      const elections = [
        { candidate_name: 'BIDEN, JOSEPH R JR', candidate_id: 'P00003392', party: 'DEM' },
      ];
      mockService.searchElections.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: elections,
      });

      const input = lookupElectionsTool.input.parse({ office: 'P', cycle: 2024 });
      await lookupElectionsTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('sets enrichment notice when search returns empty results', async () => {
      mockService.searchElections.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 0 },
        results: [],
      });

      const input = lookupElectionsTool.input.parse({ office: 'P', cycle: 2024 });
      await lookupElectionsTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeDefined();
    });
  });

  describe('format', () => {
    it('renders candidate financial info', () => {
      const blocks = lookupElectionsTool.format!({
        results: [
          {
            candidate_name: 'SMITH, JANE',
            party_full: 'Democratic Party',
            incumbent_challenge_full: 'Incumbent',
            total_receipts: 5_000_000,
            total_disbursements: 4_000_000,
            cash_on_hand_end_period: 1_000_000,
            coverage_end_date: '2024-06-30',
          },
        ],
        mode: 'search',
        pagination: { ...PAGE, count: 1 },
        search_criteria: { mode: 'search', office: 'S', cycle: 2024, state: 'AZ' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**SMITH, JANE**');
      expect(text).toContain('Democratic Party');
      expect(text).toContain('Incumbent');
      expect(text).toContain('total_receipts:');
      expect(text).toContain('total_disbursements:');
      expect(text).toContain('cash_on_hand_end_period:');
      expect(text).toContain('coverage_end_date: 2024-06-30');
    });

    it('renders election summary mode with caveat for independent_expenditures', () => {
      const blocks = lookupElectionsTool.format!({
        results: [
          {
            count: 50,
            receipts: 100_000_000,
            disbursements: 99_000_000,
            independent_expenditures: 2_695_716_328_841.73,
            _independent_expenditures_note:
              'Unreconciled upstream aggregate — may be inflated due to double-counting across reporting periods. Use openfec_search_expenditures mode by_candidate for verified per-committee totals.',
          },
        ],
        mode: 'summary',
        pagination: { ...PAGE, count: 1 },
        search_criteria: { mode: 'summary', office: 'P', cycle: 2024 },
      });

      const text = formatText(blocks);
      expect(text).toContain('**Election Summary**');
      expect(text).toContain('independent_expenditures');
      expect(text).toContain('Note on independent_expenditures');
      expect(text).toContain('Unreconciled');
      // The raw note key should NOT appear as a separate field line
      expect(text).not.toContain('_independent_expenditures_note:');
    });

    it('renders the pagination trailer in summary mode, matching search mode', () => {
      const blocks = lookupElectionsTool.format!({
        results: [
          {
            count: 50,
            receipts: 100_000_000,
            disbursements: 99_000_000,
            independent_expenditures: 1_000,
          },
        ],
        mode: 'summary',
        pagination: { page: 1, pages: 1, count: 1, per_page: 1 },
        search_criteria: {},
      });

      expect(formatText(blocks)).toContain('1 result(s) · page 1/1 · 1 per page');
    });

    it('renders empty state', () => {
      const blocks = lookupElectionsTool.format!({
        results: [],
        mode: 'search',
        pagination: PAGE,
        search_criteria: { office: 'H', cycle: 2024, state: 'AZ', district: '07' },
      });

      const text = formatText(blocks);
      expect(text).toContain('No results found');
      expect(text).toContain('**Mode:** search');
      expect(text).toContain('district: 07');
    });

    it('renders the mode and criteria echo on a non-empty search response', () => {
      const blocks = lookupElectionsTool.format!({
        results: [{ candidate_name: 'SMITH, JANE', candidate_id: 'S4AZ00123' }],
        mode: 'search',
        pagination: { ...PAGE, count: 1 },
        search_criteria: { office: 'S', cycle: 2024 },
      });

      const text = formatText(blocks);
      expect(text).toContain('**Mode:** search');
      expect(text).toContain('_Search criteria: office=S · cycle=2024_');
    });
  });

  describe('exhausted position', () => {
    it('reports a page past the end as exhausted on both surfaces', async () => {
      mockService.searchElections.mockResolvedValueOnce({
        pagination: { page: 4, pages: 2, count: 31, per_page: 20 },
        results: [],
      });

      const input = lookupElectionsTool.input.parse({ office: 'P', cycle: 2024, page: 4 });
      const result = await lookupElectionsTool.handler(input, ctx);

      expect(result.pagination).toMatchObject({ page: 4, pages: 2, count: 31 });
      expect(getEnrichment(ctx).notice).toContain('Page 4 is past the last page');
      expect(getEnrichment(ctx).notice).not.toContain('No election races matched');

      const text = formatText(lookupElectionsTool.format!(result));
      expect(text).toContain('No results at this position.');
      expect(text).toContain('31 total');
      expect(text).not.toContain('No results found');
    });

    it('keeps zero-match guidance when nothing matched at all', async () => {
      mockService.searchElections.mockResolvedValueOnce({
        pagination: { page: 1, pages: 0, count: 0, per_page: 20 },
        results: [],
      });

      const input = lookupElectionsTool.input.parse({ office: 'P', cycle: 2024 });
      const result = await lookupElectionsTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('No election races matched');

      const text = formatText(lookupElectionsTool.format!(result));
      expect(text).toContain('No results found.');
      expect(text).not.toContain('No results at this position');
    });
  });

  /**
   * OpenFEC files presidential races under state US and presidential and Senate
   * races under district 00, so any other value matches nothing without a ZIP
   * and is ignored by the ZIP search.
   */
  describe('inputs a presidential or Senate race is never filed under', () => {
    const noRequestSent = () => {
      expect(mockService.searchElections).not.toHaveBeenCalled();
      expect(mockService.searchElectionsByZip).not.toHaveBeenCalled();
      expect(mockService.getElectionSummary).not.toHaveBeenCalled();
    };

    it.each([
      ['a presidential search with a state', { office: 'P', cycle: 2024, state: 'CA' }, ['state']],
      [
        'a presidential summary with a state',
        { mode: 'summary', office: 'P', cycle: 2024, state: 'CA' },
        ['state'],
      ],
      [
        'a presidential ZIP search with a state',
        { office: 'P', cycle: 2024, zip: '30303', state: 'CA' },
        ['state'],
      ],
      [
        'a presidential search with a district',
        { office: 'P', cycle: 2024, district: '05' },
        ['district'],
      ],
      [
        'a presidential search with both',
        { office: 'P', cycle: 2024, state: 'ca', district: '05' },
        ['state', 'district'],
      ],
      [
        'a Senate search with a district',
        { office: 'S', cycle: 2026, state: 'GA', district: '05' },
        ['district'],
      ],
      [
        'a Senate summary with a district',
        { mode: 'summary', office: 'S', cycle: 2026, state: 'GA', district: '05' },
        ['district'],
      ],
      [
        'a Senate ZIP search with a district',
        { office: 'S', cycle: 2026, zip: '30303', district: '05' },
        ['district'],
      ],
      [
        'a Senate search with district 000, which OpenFEC does not pad to 00',
        { office: 'S', cycle: 2026, state: 'GA', district: '000' },
        ['district'],
      ],
      [
        'a presidential search with district 000',
        { office: 'P', cycle: 2024, district: '000' },
        ['district'],
      ],
    ] as const)('rejects %s before any request', async (_case, raw, fields) => {
      const err = await contractFailure(lookupElectionsTool, raw);

      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({
        reason: 'inputs_not_applicable_to_office',
        office: raw.office,
        inapplicable_inputs: [...fields],
        recovery: {
          hint: declaredRecovery(lookupElectionsTool, 'inputs_not_applicable_to_office'),
        },
      });
      if (fields.includes('state' as never)) expect(err.message).toContain('state US');
      if (fields.includes('district' as never)) expect(err.message).toContain('district 00');
      noRequestSent();
    });

    it.each([
      [
        'a presidential search with a state',
        { office: 'P', cycle: 2024, state: 'CA' },
        { state: 'US' },
      ],
      [
        'a Senate search with a district',
        { office: 'S', cycle: 2026, state: 'GA', district: '05' },
        { district: '00' },
      ],
      [
        'a presidential search with both',
        { office: 'P', cycle: 2024, state: 'ca', district: '05' },
        { state: 'US', district: '00' },
      ],
    ] as const)(
      'names the value each rejected input is filed under for %s',
      async (_case, raw, filed) => {
        const err = await contractFailure(lookupElectionsTool, raw);

        expect(err.data.reason).toBe('inputs_not_applicable_to_office');
        expect(err.data.filed_values).toEqual(filed);
        noRequestSent();
      },
    );

    it('names the values those races carry in the declared recovery', () => {
      const recovery = declaredRecovery(lookupElectionsTool, 'inputs_not_applicable_to_office');
      expect(recovery).toContain('US');
      expect(recovery).toContain('00');
    });

    it.each([
      ['state US', { office: 'P', cycle: 2024, state: 'US' }, { state: 'US' }],
      ['lowercase us, sent as given', { office: 'P', cycle: 2024, state: 'us' }, { state: 'us' }],
      ['district 00', { office: 'P', cycle: 2024, district: '00' }, { district: '00' }],
      [
        'a Senate race under district 00',
        { office: 'S', cycle: 2026, state: 'GA', district: '00' },
        { state: 'GA', district: '00' },
      ],
      /** OpenFEC's `District` arg zero-pads a lone digit, so `0` selects the race filed under 00. */
      ['district 0, sent as given', { office: 'P', cycle: 2024, district: '0' }, { district: '0' }],
      [
        'a Senate race under district 0',
        { office: 'S', cycle: 2026, state: 'GA', district: '0' },
        { state: 'GA', district: '0' },
      ],
    ] as const)('passes a presidential or Senate search with %s', async (_case, raw, sent) => {
      mockService.searchElections.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [{ candidate_name: 'SMITH, JANE', candidate_id: 'P00001234' }],
      });

      const result = await lookupElectionsTool.handler(lookupElectionsTool.input.parse(raw), ctx);

      expect(mockService.searchElections.mock.calls[0]![0]).toMatchObject(sent);
      expect(result.search_criteria).toMatchObject(sent);
    });

    it('passes a Senate summary under district 0, sent as given', async () => {
      mockService.getElectionSummary.mockResolvedValueOnce({
        count: 12,
        receipts: 1,
        disbursements: 1,
        independent_expenditures: 1,
      });

      const input = lookupElectionsTool.input.parse({
        mode: 'summary',
        office: 'S',
        cycle: 2026,
        state: 'GA',
        district: '0',
      });
      await lookupElectionsTool.handler(input, ctx);

      expect(mockService.getElectionSummary.mock.calls[0]![0]).toMatchObject({
        office: 'senate',
        state: 'GA',
        district: '0',
      });
    });

    it('passes a presidential summary under state US and district 00', async () => {
      mockService.getElectionSummary.mockResolvedValueOnce({
        count: 874,
        receipts: 1,
        disbursements: 1,
        independent_expenditures: 1,
      });

      const input = lookupElectionsTool.input.parse({
        mode: 'summary',
        office: 'P',
        cycle: 2024,
        state: 'US',
        district: '00',
      });
      await lookupElectionsTool.handler(input, ctx);

      expect(mockService.getElectionSummary.mock.calls[0]![0]).toMatchObject({
        office: 'president',
        state: 'US',
        district: '00',
      });
    });

    it('passes a ZIP locator handed back as state and district', async () => {
      mockService.searchElectionsByZip.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [{ cycle: 2024, district: '00', office: 'P', state: 'US' }],
      });

      const input = lookupElectionsTool.input.parse({
        office: 'P',
        cycle: 2024,
        zip: '30303',
        state: 'US',
        district: '00',
      });
      await lookupElectionsTool.handler(input, ctx);

      expect(mockService.searchElectionsByZip.mock.calls[0]![0]).toMatchObject({
        state: 'US',
        district: '00',
      });
    });
  });

  describe('state code width', () => {
    it('rejects a spelled-out state before any request', async () => {
      const err = await contractFailure(lookupElectionsTool, {
        office: 'S',
        cycle: 2026,
        state: 'Georgia',
      });

      expect(err.data).toMatchObject({
        reason: 'invalid_state_code',
        field: 'state',
        value: 'Georgia',
      });
      expect(err.data.recovery?.hint).toContain('GA');
      expect(mockService.searchElections).not.toHaveBeenCalled();
    });

    /** `/elections/` matches the state exactly: neither exclusion nor `other` selects a race. */
    it.each(['-GA', 'other'])('rejects state %s before any request', async (state) => {
      const err = await contractFailure(lookupElectionsTool, { office: 'S', cycle: 2026, state });

      expect(err.data).toMatchObject({
        reason: 'invalid_state_code',
        field: 'state',
        value: state,
      });
      expect(mockService.searchElections).not.toHaveBeenCalled();
    });

    it('sends a state code in any case as given', async () => {
      mockService.searchElections.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [{ candidate_name: 'SMITH, JANE', candidate_id: 'S6GA00119' }],
      });

      const input = lookupElectionsTool.input.parse({ office: 'S', cycle: 2026, state: 'ga' });
      await lookupElectionsTool.handler(input, ctx);

      expect(mockService.searchElections.mock.calls[0]![0]).toMatchObject({ state: 'ga' });
    });
  });

  describe('at-large House seats', () => {
    it('names district 00 in the missing-district recovery on the wire', async () => {
      const err = await contractFailure(lookupElectionsTool, {
        office: 'H',
        cycle: 2026,
        state: 'WY',
      });

      expect(err.data.reason).toBe('missing_district_for_house');
      expect(err.data.recovery?.hint).toBe(
        declaredRecovery(lookupElectionsTool, 'missing_district_for_house'),
      );
      expect(err.data.recovery?.hint).toMatch(/00.*at-large/);
    });

    it('describes 00 as the at-large district', () => {
      expect(lookupElectionsTool.input.shape.district.description).toMatch(/00.*at-large/);
    });
  });

  describe('ZIP race locators', () => {
    const ZIP_CRITERIA = { mode: 'search', office: 'H', cycle: 2026, zip: '30303' };
    const locators = [
      { cycle: 2026, district: '05', office: 'H', state: 'GA' },
      { cycle: 2026, district: '00', office: 'H', state: 'WY' },
      { cycle: 2026, district: '00', office: 'S', state: 'GA' },
      { cycle: 2024, district: '00', office: 'P', state: 'US' },
    ];

    it('describes a ZIP search as returning race locators to pass back', () => {
      const { shape } = lookupElectionsTool.input;
      expect(shape.zip.description).toContain('locator');
      expect(shape.zip.description).toMatch(/state.*district/);
      expect(shape.mode.description).toContain('locator');
      expect(lookupElectionsTool.output.shape.results.description).toContain('locator');
    });

    it('heads each locator with its race', () => {
      const text = formatText(
        lookupElectionsTool.format!({
          results: locators,
          mode: 'search',
          pagination: { ...PAGE, count: 4 },
          search_criteria: ZIP_CRITERIA,
        }),
      );

      expect(text).toContain('**GA-05 House 2026**');
      expect(text).toContain('**WY-00 House 2026**');
      expect(text).toContain('**GA Senate 2026**');
      expect(text).toContain('**President 2024**');
      expect(text).not.toContain('Unknown');
    });

    it('keeps the values a locator is passed back with that its heading does not carry', () => {
      const [senate, president] = [locators[2]!, locators[3]!];
      const text = formatText(
        lookupElectionsTool.format!({
          results: [senate, president],
          mode: 'search',
          pagination: { ...PAGE, count: 2 },
          search_criteria: { ...ZIP_CRITERIA, office: 'S' },
        }),
      );

      expect(text).toContain('**GA Senate 2026**\n  district: 00');
      expect(text).toContain('**President 2024**\n  district: 00\n  state: US');
    });

    it('drops a part the locator lacks rather than inventing it', () => {
      const text = formatText(
        lookupElectionsTool.format!({
          results: [{ cycle: 2026, office: 'H', state: 'GA' }],
          mode: 'search',
          pagination: { ...PAGE, count: 1 },
          search_criteria: ZIP_CRITERIA,
        }),
      );

      expect(text).toContain('**GA House 2026**');
      expect(text).not.toContain('undefined');
    });

    it('heads a locator naming no office, state, or cycle as a race locator, never an empty heading', () => {
      const text = formatText(
        lookupElectionsTool.format!({
          results: [{ district: '05' }, {}],
          mode: 'search',
          pagination: { ...PAGE, count: 2 },
          search_criteria: ZIP_CRITERIA,
        }),
      );

      expect(text).toContain('**Race locator**\n  district: 05');
      expect(text.match(/\*\*Race locator\*\*/g)).toHaveLength(2);
      expect(text).not.toContain('****');
    });

    it('returns the upstream rows unchanged and heads them on content[]', async () => {
      const row = { ...locators[0]! };
      mockService.searchElectionsByZip.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [row],
      });

      const result = await runToolContract(lookupElectionsTool, {
        office: 'H',
        cycle: 2026,
        zip: '30303',
      });

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { results: unknown[] }).results).toEqual([
        { cycle: 2026, district: '05', office: 'H', state: 'GA' },
      ]);
      const text = (result.content as ContentBlock[])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('**GA-05 House 2026**');
      expect(text).not.toContain('Unknown');
    });

    it('keeps the ZIP zero-match guidance when no race covers the ZIP', async () => {
      mockService.searchElectionsByZip.mockResolvedValueOnce({
        pagination: { page: 1, pages: 0, count: 0, per_page: 20 },
        results: [],
      });

      const result = await runToolContract(lookupElectionsTool, {
        office: 'H',
        cycle: 2026,
        zip: '00000',
      });

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { notice?: string }).notice).toContain(
        'No election races found for this ZIP',
      );
      const text = (result.content as ContentBlock[])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('No results found');
    });
  });

  describe('independent expenditures note', () => {
    it('says by_candidate leaves out current-cycle spending reported only on notices', async () => {
      mockService.getElectionSummary.mockResolvedValueOnce({
        count: 12,
        receipts: 1,
        disbursements: 1,
        independent_expenditures: 1,
      });

      const input = lookupElectionsTool.input.parse({
        mode: 'summary',
        office: 'S',
        cycle: 2026,
        state: 'GA',
      });
      const result = await lookupElectionsTool.handler(input, ctx);
      const note = String(result.results[0]!._independent_expenditures_note);

      expect(note).toContain('Unreconciled');
      expect(note).toContain('periodic reports');
      expect(note).toContain('current cycle');
      expect(note).toContain('24/48-hour notices');
      expect(note).toContain('is_notice: true');
      expect(note).not.toContain('verified');
      expect(formatText(lookupElectionsTool.format!(result))).toContain(note);
    });
  });
});
