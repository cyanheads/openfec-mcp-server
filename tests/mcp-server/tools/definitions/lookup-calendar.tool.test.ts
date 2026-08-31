/**
 * @fileoverview Tests for the lookup-calendar tool — mode routing, param
 * mapping, date filtering, and format rendering.
 * @module tests/mcp-server/tools/definitions/lookup-calendar.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import type { McpError } from '@cyanheads/mcp-ts-core/errors';
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

import { lookupCalendar as lookupCalendarTool } from '@/mcp-server/tools/definitions/lookup-calendar.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

/** Narrows the first `format()` block to its text payload. */
const formatText = (blocks: ContentBlock[]): string => {
  const [block] = blocks;
  if (block?.type !== 'text') throw new Error('format() did not return a text block');
  return block.text;
};

const makeCtx = () => createMockContext({ errors: lookupCalendarTool.errors });

describe('lookupCalendarTool', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('events mode calls getCalendarDates', async () => {
      const events = [
        { summary: 'FEC Open Meeting', start_date: '2024-07-15', category: 'FEC Meetings' },
      ];
      mockService.getCalendarDates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: events,
      });

      const input = lookupCalendarTool.input.parse({
        description: 'meeting',
      });
      const result = await lookupCalendarTool.handler(input, ctx);

      expect(result.results).toEqual(events);
      expect(mockService.getCalendarDates).toHaveBeenCalledOnce();
      expect(mockService.getReportingDates).not.toHaveBeenCalled();
      expect(mockService.getElectionDates).not.toHaveBeenCalled();

      const callArgs = mockService.getCalendarDates.mock.calls[0]![0];
      expect(callArgs.description).toBe('meeting');
      expect(result.mode).toBe('events');
      expect(result.search_criteria).toMatchObject({ mode: 'events', description: 'meeting' });
    });

    it('filing deadlines mode calls getReportingDates', async () => {
      const deadlines = [{ report_type: 'Q1', due_date: '2024-04-15', report_year: 2024 }];
      mockService.getReportingDates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: deadlines,
      });

      const input = lookupCalendarTool.input.parse({
        mode: 'filing_deadlines',
        report_type: 'Q1',
        report_year: 2024,
      });
      const result = await lookupCalendarTool.handler(input, ctx);

      expect(result.results).toEqual(deadlines);
      expect(mockService.getReportingDates).toHaveBeenCalledOnce();

      const callArgs = mockService.getReportingDates.mock.calls[0]![0];
      expect(callArgs.report_type).toBe('Q1');
      expect(callArgs.report_year).toBe(2024);
      expect(result.mode).toBe('filing_deadlines');
      expect(result.search_criteria).toMatchObject({ report_type: 'Q1', report_year: 2024 });
    });

    it('rejects inputs the mode cannot apply instead of dropping them', async () => {
      // report_type belongs to filing_deadlines and state to election_dates.
      const input = lookupCalendarTool.input.parse({
        mode: 'events',
        description: 'meeting',
        report_type: 'Q1',
        state: 'AZ',
      });

      await expect(lookupCalendarTool.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'inputs_not_applicable_to_mode',
          mode: 'events',
          inapplicable_inputs: expect.arrayContaining(['report_type', 'state']),
        },
      });
      expect(mockService.getCalendarDates).not.toHaveBeenCalled();
    });

    it('names the offending input and the accepted set in the rejection', async () => {
      const input = lookupCalendarTool.input.parse({
        mode: 'filing_deadlines',
        category: '21',
        report_year: 2024,
      });

      await expect(lookupCalendarTool.handler(input, ctx)).rejects.toThrow(
        /cannot apply category[\s\S]*accepts only[\s\S]*report_type, report_year/,
      );
    });

    it('accepts date bounds in every mode', async () => {
      mockService.getElectionDates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: [{ election_date: '2024-11-05' }],
      });

      const input = lookupCalendarTool.input.parse({
        mode: 'election_dates',
        min_date: '2024-01-01',
        max_date: '2024-12-31',
      });
      const result = await lookupCalendarTool.handler(input, ctx);

      expect(result.search_criteria).toMatchObject({
        mode: 'election_dates',
        min_date: '2024-01-01',
        max_date: '2024-12-31',
      });
    });

    it('election dates mode calls getElectionDates with mapped param names', async () => {
      const dates = [{ election_date: '2024-11-05', election_state: 'AZ', office_sought: 'S' }];
      mockService.getElectionDates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 1 },
        results: dates,
      });

      const input = lookupCalendarTool.input.parse({
        mode: 'election_dates',
        state: 'AZ',
        office: 'S',
        election_year: 2024,
      });
      const result = await lookupCalendarTool.handler(input, ctx);

      expect(result.results).toEqual(dates);
      expect(mockService.getElectionDates).toHaveBeenCalledOnce();

      const callArgs = mockService.getElectionDates.mock.calls[0]![0];
      expect(callArgs.election_state).toBe('AZ');
      expect(callArgs.office_sought).toBe('S');
      expect(callArgs.election_year).toBe(2024);
    });

    it('passes date range filters', async () => {
      mockService.getCalendarDates.mockResolvedValueOnce({
        pagination: PAGE,
        results: [],
      });

      const input = lookupCalendarTool.input.parse({
        min_date: '2024-01-01',
        max_date: '2024-12-31',
      });
      await lookupCalendarTool.handler(input, ctx);

      const callArgs = mockService.getCalendarDates.mock.calls[0]![0];
      expect(callArgs.min_start_date).toBe('2024-01-01');
      expect(callArgs.max_start_date).toBe('2024-12-31');
    });

    it.each(['events', 'filing_deadlines', 'election_dates'] as const)(
      'rejects inverted dates in %s mode before dispatch',
      async (mode) => {
        const service =
          mode === 'events'
            ? mockService.getCalendarDates
            : mode === 'filing_deadlines'
              ? mockService.getReportingDates
              : mockService.getElectionDates;
        const input = lookupCalendarTool.input.parse({
          mode,
          min_date: '2026-12-31',
          max_date: '2026-01-01',
        });
        const err = (await Promise.resolve(lookupCalendarTool.handler(input, ctx)).catch(
          (e: unknown) => e,
        )) as McpError;

        expect(err.data).toMatchObject({
          reason: 'invalid_range',
          min_field: 'min_date',
          min_value: '2026-12-31',
          max_field: 'max_date',
          max_value: '2026-01-01',
        });
        expect(service).not.toHaveBeenCalled();
      },
    );

    it('rejects malformed dates before dispatch', async () => {
      const input = lookupCalendarTool.input.parse({ min_date: '2026-02-30' });
      const err = (await Promise.resolve(lookupCalendarTool.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.data).toMatchObject({
        reason: 'invalid_date',
        field: 'min_date',
        value: '2026-02-30',
      });
      expect(mockService.getCalendarDates).not.toHaveBeenCalled();
    });

    it('sets enrichment totalCount from pagination', async () => {
      mockService.getCalendarDates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 5 },
        results: [{ summary: 'FEC Open Meeting', start_date: '2024-07-15' }],
      });

      const input = lookupCalendarTool.input.parse({});
      await lookupCalendarTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(5);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('sets enrichment notice when events mode returns empty results', async () => {
      mockService.getCalendarDates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 0 },
        results: [],
      });

      const input = lookupCalendarTool.input.parse({
        description: 'nonexistent event',
        min_date: '2024-01-01',
        max_date: '2024-12-31',
      });
      await lookupCalendarTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeDefined();
    });

    it('sets enrichment notice when filing_deadlines mode returns empty results', async () => {
      mockService.getReportingDates.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 0 },
        results: [],
      });

      const input = lookupCalendarTool.input.parse({
        mode: 'filing_deadlines',
        report_type: 'NONEXISTENT',
      });
      await lookupCalendarTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeDefined();
    });
  });

  describe('format', () => {
    it('renders calendar entries', () => {
      const blocks = lookupCalendarTool.format!({
        results: [
          {
            summary: 'FEC Open Meeting',
            description: 'Monthly public meeting of the Commission',
            start_date: '2024-07-15',
            end_date: '2024-07-15',
            category: 'FEC Meetings',
            location: 'Washington, DC',
          },
          {
            report_type: 'Q2',
            due_date: '2024-07-15',
            report_year: 2024,
            coverage_start_date: '2024-04-01',
            coverage_end_date: '2024-06-30',
          },
          {
            election_type_full: 'General Election',
            election_date: '2024-11-05',
            election_state: 'AZ',
            office_sought: 'S',
            election_year: 2024,
          },
        ],
        mode: 'events',
        pagination: { ...PAGE, count: 3 },
        search_criteria: { mode: 'events', description: 'meeting' },
      });

      const text = formatText(blocks);
      expect(text).toContain('**Mode:** events');
      expect(text).toContain('_Search criteria: mode=events · description=meeting_');
      expect(text).toContain('**FEC Open Meeting**');
      expect(text).toContain('Monthly public meeting');
      expect(text).toContain('FEC Meetings');
      expect(text).toContain('Washington, DC');
      expect(text).toContain('**Q2**');
      expect(text).toContain('coverage_start_date: 2024-04-01');
      expect(text).toContain('coverage_end_date: 2024-06-30');
      expect(text).toContain('**General Election**');
      expect(text).toContain('election_state: AZ');
      expect(text).toContain('3 result(s)');
    });

    it('renders empty state', () => {
      const blocks = lookupCalendarTool.format!({
        results: [],
        mode: 'filing_deadlines',
        pagination: PAGE,
        search_criteria: { report_type: 'Q2', report_year: 2024 },
      });

      const text = formatText(blocks);
      expect(text).toContain('No results found');
      expect(text).toContain('**Mode:** filing_deadlines');
      expect(text).toContain('report_type: Q2');
    });
  });
});
