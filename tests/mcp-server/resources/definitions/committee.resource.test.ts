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

  it('returns committee data', async () => {
    const committee = {
      committee_id: 'C00703975',
      name: 'ACTBLUE',
      committee_type: 'N',
      designation: 'U',
    };

    mockService.getCommittee.mockResolvedValueOnce(pageResult([committee]));

    const ctx = createMockContext();
    const params = committeeResource.params.parse({ committee_id: 'C00703975' });
    const result = await committeeResource.handler(params, ctx);

    expect(result).toEqual(committee);
    expect(mockService.getCommittee).toHaveBeenCalledWith('C00703975', ctx);
  });

  it('throws when committee not found', async () => {
    mockService.getCommittee.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext();
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
