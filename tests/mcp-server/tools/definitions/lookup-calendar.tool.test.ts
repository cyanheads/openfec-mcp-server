/**
 * @fileoverview Tests for the lookup-calendar tool — mode routing, param
 * mapping, date filtering, and format rendering.
 * @module tests/mcp-server/tools/definitions/lookup-calendar.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

vi.mock('@/services/openfec/openfec-service.js', () => ({
  getOpenFecService: () => mockService,
  encodeCursor: vi.fn((indexes: Record<string, string>) => btoa(JSON.stringify(indexes))),
  decodeCursor: vi.fn((cursor: string) => JSON.parse(atob(cursor))),
}));

import { lookupCalendar as lookupCalendarTool } from '@/mcp-server/tools/definitions/lookup-calendar.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

describe('lookupCalendarTool', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
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
      const result = await lookupCalendarTool.handler(input, ctx as unknown as Context);

      expect(result.results).toEqual(events);
      expect(mockService.getCalendarDates).toHaveBeenCalledOnce();
      expect(mockService.getReportingDates).not.toHaveBeenCalled();
      expect(mockService.getElectionDates).not.toHaveBeenCalled();

      const callArgs = mockService.getCalendarDates.mock.calls[0]![0];
      expect(callArgs.description).toBe('meeting');
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
      const result = await lookupCalendarTool.handler(input, ctx as unknown as Context);

      expect(result.results).toEqual(deadlines);
      expect(mockService.getReportingDates).toHaveBeenCalledOnce();

      const callArgs = mockService.getReportingDates.mock.calls[0]![0];
      expect(callArgs.report_type).toBe('Q1');
      expect(callArgs.report_year).toBe(2024);
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
      const result = await lookupCalendarTool.handler(input, ctx as unknown as Context);

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
      await lookupCalendarTool.handler(input, ctx as unknown as Context);

      const callArgs = mockService.getCalendarDates.mock.calls[0]![0];
      expect(callArgs.min_start_date).toBe('2024-01-01');
      expect(callArgs.max_start_date).toBe('2024-12-31');
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
        pagination: { ...PAGE, count: 3 },
      });

      const text = blocks[0]!.text;
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
        pagination: PAGE,
      });

      expect(blocks[0]!.text).toContain('No calendar entries found');
    });
  });
});
