/**
 * @fileoverview Security-focused tests across all tool definitions.
 * Verifies injection inputs are rejected at the Zod layer, oversized inputs
 * do not crash, and API keys never appear in any tool output or enrichment.
 * @module tests/mcp-server/tools/definitions/security.test
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

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { searchCandidates } from '@/mcp-server/tools/definitions/search-candidates.tool.js';
import { searchCommittees } from '@/mcp-server/tools/definitions/search-committees.tool.js';
import { searchContributions } from '@/mcp-server/tools/definitions/search-contributions.tool.js';
import { searchFilings } from '@/mcp-server/tools/definitions/search-filings.tool.js';

const PAGE = { page: 1, pages: 1, count: 0, per_page: 20 };

describe('input injection resistance', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  describe('searchCandidates', () => {
    it('handler rejects candidate_id starting with a non H/S/P letter with a friendly error', async () => {
      // .regex() removed from Zod schema — validation happens in handler via validateCandidateId
      const input = searchCandidates.input.parse({ candidate_id: "X'; DROP TABLE t; --" });
      const err = await searchCandidates
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_candidate_id' });
    });

    it('handler rejects candidate_id with special chars that would break URLs', async () => {
      const input = searchCandidates.input.parse({ candidate_id: 'P/../../../etc/passwd' });
      const err = await searchCandidates
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_candidate_id' });
    });

    it('accepts query containing SQL-like characters as text (passed to FEC as-is)', async () => {
      // query is an opaque string — FEC API handles it; we should not throw at the Zod layer
      const input = searchCandidates.input.parse({ query: "'; DROP TABLE candidates; --" });
      expect(input.query).toBe("'; DROP TABLE candidates; --");
    });
  });

  describe('searchCommittees', () => {
    it('handler rejects committee_id with non-C prefix with a friendly error', async () => {
      const input = searchCommittees.input.parse({ committee_id: '<script>alert(1)</script>' });
      const err = await searchCommittees
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_committee_id' });
    });

    it('handler rejects committee_id with slash traversal pattern', async () => {
      const input = searchCommittees.input.parse({ committee_id: 'C00000001/../secret' });
      const err = await searchCommittees
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_committee_id' });
    });
  });

  describe('searchContributions', () => {
    it('handler rejects committee_id injection with a friendly error', async () => {
      const input = searchContributions.input.parse({
        committee_id: "C'; DELETE FROM contributions; --",
      });
      const err = await searchContributions
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_committee_id' });
    });

    it('handler rejects candidate_id injection with a friendly error', async () => {
      const input = searchContributions.input.parse({
        candidate_id: 'P<img src=x onerror=alert(1)>',
        mode: 'by_state',
      });
      const err = await searchContributions
        .handler(input, ctx as unknown as Context)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_candidate_id' });
    });
  });
});

describe('oversized inputs do not crash', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  it('very long query string is accepted by Zod and passed through', async () => {
    const longQuery = 'A'.repeat(1000);
    mockService.searchCandidates.mockResolvedValueOnce({
      pagination: { ...PAGE, count: 0 },
      results: [],
    });

    const input = searchCandidates.input.parse({ query: longQuery });
    const result = await searchCandidates.handler(input, ctx as unknown as Context);
    expect(result.candidates).toHaveLength(0);
  });

  it('very long state string does not crash the schema', () => {
    // state has no max-length enforcement — just passes through
    const longState = 'X'.repeat(500);
    const input = searchCandidates.input.parse({ state: longState });
    expect(input.state).toBe(longState);
  });

  it('per_page at maximum (100) is accepted', () => {
    const input = searchCandidates.input.parse({ per_page: 100 });
    expect(input.per_page).toBe(100);
  });

  it('per_page above maximum is rejected', () => {
    expect(() => searchCandidates.input.parse({ per_page: 101 })).toThrow();
  });

  it('per_page below minimum is rejected', () => {
    expect(() => searchCandidates.input.parse({ per_page: 0 })).toThrow();
  });

  it('page below minimum is rejected', () => {
    expect(() => searchCandidates.input.parse({ page: 0 })).toThrow();
  });
});

describe('API key not present in tool output', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  it('error messages that propagate from the service do not carry api_key= literals', async () => {
    // Tool handlers throw; the framework propagates. Verify the error the
    // service raises (already sanitized by rethrowSanitized) has no raw key.
    const input = searchFilings.input.parse({});
    // Simulate a pre-sanitized error message as the service would produce
    mockService.searchFilings.mockRejectedValueOnce(
      new Error('FEC request failed (api_key=REDACTED) Status: 403'),
    );

    let caught: Error | undefined;
    try {
      await searchFilings.handler(input, ctx as unknown as Context);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    // The error may contain 'REDACTED' (that is the sanitized form) but not a real key value
    expect(caught!.message).toContain('REDACTED');
    expect(caught!.message).not.toMatch(/api_key=[A-Z0-9_]{10,}/i);
  });

  it('format output contains no api_key= URL query parameters', async () => {
    // Verify format output does not embed API URL construction artifacts
    mockService.searchCandidates.mockResolvedValueOnce({
      pagination: { ...PAGE, count: 1 },
      results: [
        { candidate_id: 'P00003392', name: 'BIDEN, JOSEPH R JR', office: 'P', state: 'DE' },
      ],
    });

    const input = searchCandidates.input.parse({ query: 'Biden' });
    const result = await searchCandidates.handler(input, ctx as unknown as Context);
    const formatted = searchCandidates.format!(result);
    const text = formatted[0]!.text;

    // Format output is plain text from upstream fields — no URL query params should appear
    expect(text).not.toContain('api_key=');
  });
});

describe('unicode and special character handling in format output', () => {
  it('renders unicode candidate names without corruption', () => {
    const blocks = searchCandidates.format!({
      candidates: [
        {
          candidate_id: 'H2TX00001',
          name: 'ÑOÑO-GARCÍA, JOSÉ',
          party_full: 'Partido Demócrata',
          office: 'H',
          state: 'TX',
        },
      ],
      pagination: { ...PAGE, count: 1 },
    });

    const text = blocks[0]!.text;
    expect(text).toContain('ÑOÑO-GARCÍA, JOSÉ');
    expect(text).toContain('Partido Demócrata');
  });

  it('renders unicode committee names without corruption', () => {
    const blocks = searchCommittees.format!({
      committees: [
        {
          committee_id: 'C00000001',
          name: 'AMIGOS DE JOSÉ HERNÁNDEZ COMMITTEE',
          committee_type_full: 'Presidential',
        },
      ],
      pagination: { ...PAGE, count: 1 },
    });

    const text = blocks[0]!.text;
    expect(text).toContain('AMIGOS DE JOSÉ HERNÁNDEZ COMMITTEE');
  });
});
