/**
 * @fileoverview Tests for the committee resource — fetches a committee profile
 * by FEC committee ID.
 * @module tests/mcp-server/resources/definitions/committee.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = {
  searchCandidates: vi.fn(),
  getCandidate: vi.fn(),
  getCandidateTotals: vi.fn(),
  getCandidateCommittees: vi.fn(),
  searchCommittees: vi.fn(),
  getCommittee: vi.fn(),
  getCommitteeTotals: vi.fn(),
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
}));

import { committeeResource } from '@/mcp-server/resources/definitions/committee.resource.js';

describe('committeeResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const pageResult = <T>(results: T[], count?: number) => ({
    pagination: { page: 1, pages: 1, count: count ?? results.length, per_page: 20 },
    results,
  });

  it('returns merged committee + totals data', async () => {
    const committee = {
      committee_id: 'C00703975',
      name: 'ACTBLUE',
      committee_type: 'N',
      designation: 'U',
    };
    const totals = {
      receipts: 12_000_000,
      disbursements: 11_500_000,
      last_cash_on_hand_end_period: 500_000,
      coverage_end_date: '2024-12-31',
    };

    mockService.getCommittee.mockResolvedValueOnce(pageResult([committee]));
    mockService.getCommitteeTotals.mockResolvedValueOnce(pageResult([totals]));

    const ctx = createMockContext();
    const params = committeeResource.params.parse({ committee_id: 'C00703975' });
    const result = await committeeResource.handler(params, ctx);

    expect(result).toEqual({ ...committee, ...totals });
    expect(mockService.getCommittee).toHaveBeenCalledWith('C00703975', ctx);
    expect(mockService.getCommitteeTotals).toHaveBeenCalledWith('C00703975', { per_page: 1 }, ctx);
  });

  it('returns committee without totals when totals result is empty', async () => {
    const committee = { committee_id: 'C00000001', name: 'NEW PAC', committee_type: 'N' };

    mockService.getCommittee.mockResolvedValueOnce(pageResult([committee]));
    mockService.getCommitteeTotals.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext();
    const params = committeeResource.params.parse({ committee_id: 'C00000001' });
    const result = await committeeResource.handler(params, ctx);

    expect(result).toEqual(committee);
  });

  it('throws when committee not found', async () => {
    mockService.getCommittee.mockResolvedValueOnce(pageResult([]));
    mockService.getCommitteeTotals.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext({ errors: committeeResource.errors });
    const params = committeeResource.params.parse({ committee_id: 'C99999999' });

    await expect(committeeResource.handler(params, ctx)).rejects.toThrow(
      'Committee C99999999 not found',
    );
  });

  it('validates committee_id param', () => {
    expect(() => committeeResource.params.parse({})).toThrow();
    expect(() => committeeResource.params.parse({ committee_id: 42 })).toThrow();
    expect(committeeResource.params.parse({ committee_id: 'C00358796' })).toEqual({
      committee_id: 'C00358796',
    });
  });
});
