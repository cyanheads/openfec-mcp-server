/**
 * @fileoverview Tests for the election resource — fetches an election race summary
 * with optional state and district parsed from the URI path.
 * @module tests/mcp-server/resources/definitions/election.resource.test
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

import {
  electionDistrictResource,
  electionResource,
  electionStateResource,
} from '@/mcp-server/resources/definitions/election.resource.js';

describe('electionResource', () => {
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

  it('returns election data for presidential race', async () => {
    const candidates = [
      { candidate_id: 'P00003392', total_receipts: 500000 },
      { candidate_id: 'P80001571', total_receipts: 600000 },
    ];
    mockService.searchElections.mockResolvedValueOnce(pageResult(candidates));

    const ctx = createMockContext({ uri: new URL('openfec:///election/2024/president') });
    const params = electionResource.params.parse({ cycle: '2024', office: 'president' });
    const result = await electionResource.handler(params, ctx);

    expect(result).toEqual({
      cycle: '2024',
      office: 'president',
      state: undefined,
      district: undefined,
      candidates,
    });
    expect(mockService.searchElections).toHaveBeenCalledWith(
      { cycle: '2024', office: 'president', election_full: true },
      ctx,
    );
  });

  it('passes state via electionStateResource', async () => {
    mockService.searchElections.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext({ uri: new URL('openfec:///election/2024/senate/AZ') });
    const params = electionStateResource.params.parse({
      cycle: '2024',
      office: 'senate',
      state: 'AZ',
    });
    await electionStateResource.handler(params, ctx);

    expect(mockService.searchElections).toHaveBeenCalledWith(
      { cycle: '2024', office: 'senate', state: 'AZ', election_full: true },
      ctx,
    );
  });

  it('passes district via electionDistrictResource', async () => {
    mockService.searchElections.mockResolvedValueOnce(pageResult([]));

    const ctx = createMockContext({ uri: new URL('openfec:///election/2024/house/CA/12') });
    const params = electionDistrictResource.params.parse({
      cycle: '2024',
      office: 'house',
      state: 'CA',
      district: '12',
    });
    const result = await electionDistrictResource.handler(params, ctx);

    expect(mockService.searchElections).toHaveBeenCalledWith(
      { cycle: '2024', office: 'house', state: 'CA', district: '12', election_full: true },
      ctx,
    );
    expect(result.state).toBe('CA');
    expect(result.district).toBe('12');
  });

  it('validates cycle and office params', () => {
    expect(() => electionResource.params.parse({})).toThrow();
    expect(() => electionResource.params.parse({ cycle: '2024' })).toThrow();
    expect(() => electionResource.params.parse({ office: 'president' })).toThrow();
    expect(electionResource.params.parse({ cycle: '2024', office: 'senate' })).toEqual({
      cycle: '2024',
      office: 'senate',
    });
  });
});
