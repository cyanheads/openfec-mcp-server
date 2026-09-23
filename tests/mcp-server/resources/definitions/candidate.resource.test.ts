/**
 * @fileoverview Tests for the candidate resource — fetches a candidate profile
 * with financial totals by FEC candidate ID.
 * @module tests/mcp-server/resources/definitions/candidate.resource.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
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

import { candidateResource } from '@/mcp-server/resources/definitions/candidate.resource.js';

const paramsSchema = candidateResource.params!;

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

  it('returns merged candidate + totals + principal committees', async () => {
    const candidate = { candidate_id: 'P00003392', name: 'BIDEN, JOSEPH R JR', party: 'DEM' };
    const totals = { receipts: 500000, disbursements: 400000, cash_on_hand: 100000 };
    const committees = [
      { committee_id: 'C00703975', name: 'BIDEN FOR PRESIDENT', designation: 'P' },
    ];

    mockService.getCandidate.mockResolvedValueOnce(pageResult([candidate]));
    mockService.getCandidateTotals.mockResolvedValueOnce(pageResult([totals]));
    mockService.getCandidateCommittees.mockResolvedValueOnce(pageResult(committees));

    const ctx = createMockContext({ errors: candidateResource.errors });
    const params = paramsSchema.parse({ candidate_id: 'P00003392' });
    const result = await candidateResource.handler(params, ctx);

    expect(result).toEqual({ ...candidate, ...totals, principal_committees: committees });
    expect(mockService.getCandidate).toHaveBeenCalledWith('P00003392', ctx);
    expect(mockService.getCandidateTotals).toHaveBeenCalledWith({ candidate_id: 'P00003392' }, ctx);
    expect(mockService.getCandidateCommittees).toHaveBeenCalledWith(
      'P00003392',
      { designation: 'P' },
      ctx,
    );
  });

  it('returns candidate without totals when totals result is empty', async () => {
    const candidate = { candidate_id: 'H2CO07170', name: 'DOE, JANE', party: 'REP' };

    mockService.getCandidate.mockResolvedValueOnce(pageResult([candidate]));
    mockService.getCandidateTotals.mockResolvedValueOnce(pageResult([]));
    mockService.getCandidateCommittees.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext({ errors: candidateResource.errors });
    const params = paramsSchema.parse({ candidate_id: 'H2CO07170' });
    const result = await candidateResource.handler(params, ctx);

    expect(result).toEqual({ ...candidate, principal_committees: [] });
  });

  it('throws when candidate not found', async () => {
    mockService.getCandidate.mockResolvedValueOnce(pageResult([]));
    mockService.getCandidateTotals.mockResolvedValueOnce(pageResult([]));
    mockService.getCandidateCommittees.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext({ errors: candidateResource.errors });
    const params = paramsSchema.parse({ candidate_id: 'P99999999' });

    await expect(candidateResource.handler(params, ctx)).rejects.toThrow(
      'Candidate P99999999 not found',
    );
  });

  /**
   * principal_committees comes from a current-designation filter with no cycle,
   * so the description must say so and name the cycle-specific source.
   */
  it('describes principal_committees as current-designation and points at candidate_pcc_id', () => {
    const { description } = candidateResource;
    expect(description).toContain('principal_committees');
    expect(description).toContain('current designation');
    expect(description).toContain('openfec_lookup_elections');
    expect(description).toContain('candidate_pcc_id');
  });

  it('validates candidate_id param', () => {
    expect(() => paramsSchema.parse({})).toThrow();
    expect(() => paramsSchema.parse({ candidate_id: 123 })).toThrow();
    expect(paramsSchema.parse({ candidate_id: 'P00003392' })).toEqual({
      candidate_id: 'P00003392',
    });
  });

  it('rejects a malformed fixed-width ID before any service call', async () => {
    const ctx = createMockContext({ errors: candidateResource.errors });
    const params = paramsSchema.parse({ candidate_id: 'P000033920' });
    const err = await Promise.resolve(candidateResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_candidate_id' });
    expect(mockService.getCandidate).not.toHaveBeenCalled();
    expect(mockService.getCandidateTotals).not.toHaveBeenCalled();
    expect(mockService.getCandidateCommittees).not.toHaveBeenCalled();
  });
});
