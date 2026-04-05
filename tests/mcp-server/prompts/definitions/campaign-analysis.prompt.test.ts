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

  it('args parsing validates schema', () => {
    expect(campaignAnalysisPrompt.args.parse({})).toEqual({});
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
