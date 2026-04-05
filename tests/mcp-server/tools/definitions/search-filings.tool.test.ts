/**
 * @fileoverview Tests for the search-filings tool — handler passthrough,
 * default values, and format rendering.
 * @module tests/mcp-server/tools/definitions/search-filings.tool.test
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

import { searchFilings } from '@/mcp-server/tools/definitions/search-filings.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

describe('searchFilings', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  describe('handler', () => {
    it('returns filings with pagination', async () => {
      const filings = [
        { form_type: 'F3', committee_name: 'FRIENDS OF TEST', committee_id: 'C00000001' },
        { form_type: 'F3X', committee_name: 'PAC FOR GOOD', committee_id: 'C00000002' },
      ];
      mockService.searchFilings.mockResolvedValueOnce({
        pagination: { ...PAGE, count: 2 },
        results: filings,
      });

      const input = searchFilings.input.parse({});
      const result = await searchFilings.handler(input, ctx as unknown as Context);

      expect(result.filings).toEqual(filings);
      expect(result.pagination.count).toBe(2);
    });

    it('passes all filter params correctly', async () => {
      mockService.searchFilings.mockResolvedValueOnce({
        pagination: PAGE,
        results: [],
      });

      const input = searchFilings.input.parse({
        committee_id: 'C00000001',
        candidate_id: 'P00003392',
        filer_name: 'BIDEN',
        form_type: 'F3P',
        report_type: 'Q1',
        report_year: 2024,
        cycle: 2024,
        is_amended: false,
        most_recent: false,
        min_receipt_date: '2024-01-01',
        max_receipt_date: '2024-06-30',
        page: 2,
        per_page: 50,
      });

      await searchFilings.handler(input, ctx as unknown as Context);

      const callArgs = mockService.searchFilings.mock.calls[0]![0];
      expect(callArgs).toMatchObject({
        committee_id: 'C00000001',
        candidate_id: 'P00003392',
        q_filer: 'BIDEN',
        form_type: 'F3P',
        report_type: 'Q1',
        report_year: 2024,
        cycle: 2024,
        is_amended: false,
        most_recent: false,
        min_receipt_date: '2024-01-01',
        max_receipt_date: '2024-06-30',
        page: 2,
        per_page: 50,
      });
    });

    it('defaults most_recent to true', async () => {
      mockService.searchFilings.mockResolvedValueOnce({
        pagination: PAGE,
        results: [],
      });

      const input = searchFilings.input.parse({});
      await searchFilings.handler(input, ctx as unknown as Context);

      const callArgs = mockService.searchFilings.mock.calls[0]![0];
      expect(callArgs.most_recent).toBe(true);
    });
  });

  describe('format', () => {
    it('renders filing info with form type, committee, report, and financials', () => {
      const blocks = searchFilings.format!({
        filings: [
          {
            form_type: 'F3P',
            committee_name: 'BIDEN FOR PRESIDENT',
            committee_id: 'C00703975',
            report_type_full: 'YEAR-END',
            report_year: 2024,
            receipt_date: '2024-02-01',
            candidate_name: 'BIDEN, JOSEPH R JR',
            total_receipts: 150_000_000,
            total_disbursements: 120_000_000,
            cash_on_hand_end_period: 30_000_000,
            debts_owed_by_committee: 500_000,
            coverage_start_date: '2024-01-01',
            coverage_end_date: '2024-06-30',
          },
        ],
        pagination: { ...PAGE, count: 1 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('**F3P**');
      expect(text).toContain('BIDEN FOR PRESIDENT');
      expect(text).toContain('C00703975');
      expect(text).toContain('YEAR-END');
      expect(text).toContain('total_receipts:');
      expect(text).toContain('total_disbursements:');
      expect(text).toContain('cash_on_hand_end_period:');
      expect(text).toContain('debts_owed_by_committee:');
      expect(text).toContain('BIDEN, JOSEPH R JR');
      expect(text).toContain('coverage_start_date: 2024-01-01');
      expect(text).toContain('coverage_end_date: 2024-06-30');
    });

    it('renders amended indicator and PDF link', () => {
      const blocks = searchFilings.format!({
        filings: [
          {
            form_type: 'F3',
            committee_name: 'TEST COMMITTEE',
            committee_id: 'C00000001',
            is_amended: true,
            pdf_url: 'https://docquery.fec.gov/pdf/123/202401019999.pdf',
          },
        ],
        pagination: { ...PAGE, count: 1 },
      });

      const text = blocks[0]!.text;
      expect(text).toContain('is_amended: true');
      expect(text).toContain('pdf_url: https://docquery.fec.gov/pdf/123/202401019999.pdf');
    });

    it('renders empty state', () => {
      const blocks = searchFilings.format!({
        filings: [],
        pagination: PAGE,
      });

      expect(blocks[0]!.text).toContain('No filings found');
    });
  });
});
