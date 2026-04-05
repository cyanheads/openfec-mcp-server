/**
 * @fileoverview Tests for the candidate resource — fetches a candidate profile
 * with financial totals by FEC candidate ID.
 * @module tests/mcp-server/resources/definitions/candidate.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

import { candidateResource } from '@/mcp-server/resources/definitions/candidate.resource.js';

describe('candidateResource', () => {
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

  it('returns merged candidate + totals data', async () => {
    const candidate = { candidate_id: 'P00003392', name: 'BIDEN, JOSEPH R JR', party: 'DEM' };
    const totals = { receipts: 500000, disbursements: 400000, cash_on_hand: 100000 };

    mockService.getCandidate.mockResolvedValueOnce(pageResult([candidate]));
    mockService.getCandidateTotals.mockResolvedValueOnce(pageResult([totals]));

    const ctx = createMockContext();
    const params = candidateResource.params.parse({ candidate_id: 'P00003392' });
    const result = await candidateResource.handler(params, ctx);

    expect(result).toEqual({ ...candidate, ...totals });
    expect(mockService.getCandidate).toHaveBeenCalledWith('P00003392', ctx);
    expect(mockService.getCandidateTotals).toHaveBeenCalledWith({ candidate_id: 'P00003392' }, ctx);
  });

  it('returns candidate without totals when totals result is empty', async () => {
    const candidate = { candidate_id: 'H2CO07170', name: 'DOE, JANE', party: 'REP' };

    mockService.getCandidate.mockResolvedValueOnce(pageResult([candidate]));
    mockService.getCandidateTotals.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext();
    const params = candidateResource.params.parse({ candidate_id: 'H2CO07170' });
    const result = await candidateResource.handler(params, ctx);

    expect(result).toEqual(candidate);
  });

  it('throws when candidate not found', async () => {
    mockService.getCandidate.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext();
    const params = candidateResource.params.parse({ candidate_id: 'P99999999' });

    await expect(candidateResource.handler(params, ctx)).rejects.toThrow(
      'Candidate P99999999 not found',
    );
  });

  it('validates candidate_id param', () => {
    expect(() => candidateResource.params.parse({})).toThrow();
    expect(() => candidateResource.params.parse({ candidate_id: 123 })).toThrow();
    expect(candidateResource.params.parse({ candidate_id: 'P00003392' })).toEqual({
      candidate_id: 'P00003392',
    });
  });
});
