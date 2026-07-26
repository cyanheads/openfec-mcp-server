/**
 * @fileoverview Tests for the campaign analysis prompt — generates structured
 * financial analysis instructions for a candidate.
 * @module tests/mcp-server/prompts/definitions/campaign-analysis.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { campaignAnalysisPrompt } from '@/mcp-server/prompts/definitions/campaign-analysis.prompt.js';

describe('campaignAnalysisPrompt', () => {
  it('generates message with candidate_id when provided', () => {
    const messages = campaignAnalysisPrompt.generate({ candidate_id: 'P00003392' });
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('candidate ID P00003392');
  });

  it('generates message with candidate_name when provided', () => {
    const messages = campaignAnalysisPrompt.generate({ candidate_name: 'Joe Biden' });
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('"Joe Biden"');
  });

  it('generates message with cycle note when cycle provided', () => {
    const messages = campaignAnalysisPrompt.generate({
      candidate_id: 'P00003392',
      cycle: '2024',
    });
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('for the 2024 cycle');
  });

  it('uses fallback "the specified candidate" when neither name nor id given', () => {
    const messages = campaignAnalysisPrompt.generate({});
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('the specified candidate');
    expect(text).not.toContain('candidate ID');
    expect(text).not.toMatch(/"[^"]*"/); // no quoted name
  });

  it('returns exactly 1 message with role=user', () => {
    const messages = campaignAnalysisPrompt.generate({ candidate_id: 'P00003392' });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('message text contains all analysis sections', () => {
    const messages = campaignAnalysisPrompt.generate({ candidate_id: 'P00003392' });
    const text = (messages[0].content as { text: string }).text;

    const sections = [
      'Candidate Overview',
      'Fundraising Analysis',
      'Burn Rate',
      'Competitive Position',
      'Outside Money',
      'Assessment',
    ];
    for (const section of sections) {
      expect(text).toContain(section);
    }
  });

  /**
   * The sequence is executed verbatim by clients, so every tool it names must
   * exist under that exact name — a tool the server gained but the sequence
   * never mentions is unreachable through this prompt.
   */
  it('names every tool the analysis sequence chains', () => {
    const messages = campaignAnalysisPrompt.generate({ candidate_id: 'P00003392' });
    const text = (messages[0].content as { text: string }).text;

    const tools = [
      'openfec_search_candidates',
      'openfec_search_committees',
      'openfec_get_committee_totals',
      'openfec_search_contributions',
      'openfec_search_disbursements',
      'openfec_lookup_elections',
      'openfec_search_expenditures',
      'openfec_search_coordinated_expenditures',
    ];
    for (const name of tools) {
      expect(text).toContain(name);
    }
  });

  /** openfec_lookup_elections requires office and cycle, so step 5 must source them. */
  it('sources the required openfec_lookup_elections scope from the candidate record', () => {
    const messages = campaignAnalysisPrompt.generate({ candidate_id: 'P00003392' });
    const text = (messages[0].content as { text: string }).text;

    expect(text).toContain('office, state, and district');
    expect(text).toContain('It requires office and cycle');
  });

  it('pins the cycle on every call when one was supplied', () => {
    const withCycle = campaignAnalysisPrompt.generate({ candidate_id: 'P00003392', cycle: '2020' });
    expect((withCycle[0].content as { text: string }).text).toContain('Pass cycle=2020');

    const withoutCycle = campaignAnalysisPrompt.generate({ candidate_id: 'P00003392' });
    expect((withoutCycle[0].content as { text: string }).text).not.toContain('Pass cycle=');
  });

  it('args parsing validates schema', () => {
    expect(() => campaignAnalysisPrompt.args.parse({})).toThrow(/candidate_id or candidate_name/);
    expect(campaignAnalysisPrompt.args.parse({ candidate_id: 'P00003392' })).toEqual({
      candidate_id: 'P00003392',
    });
    expect(campaignAnalysisPrompt.args.parse({ candidate_name: 'Test' })).toEqual({
      candidate_name: 'Test',
    });
    expect(
      campaignAnalysisPrompt.args.parse({
        candidate_name: 'Test',
        candidate_id: 'P00003392',
        cycle: '2024',
      }),
    ).toEqual({
      candidate_name: 'Test',
      candidate_id: 'P00003392',
      cycle: '2024',
    });
    expect(() => campaignAnalysisPrompt.args.parse({ candidate_name: 123 })).toThrow();
  });
});
