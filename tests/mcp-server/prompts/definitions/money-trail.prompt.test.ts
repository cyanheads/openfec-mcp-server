/**
 * @fileoverview Tests for the money trail prompt — generates a multi-step
 * investigation framework for tracing campaign finance flows.
 * @module tests/mcp-server/prompts/definitions/money-trail.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { moneyTrailPrompt } from '@/mcp-server/prompts/definitions/money-trail.prompt.js';

describe('moneyTrailPrompt', () => {
  it('generates message with candidate_id when provided', () => {
    const messages = moneyTrailPrompt.generate({ candidate_id: 'P00003392' });
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('candidate ID P00003392');
  });

  it('generates message with candidate_name when provided', () => {
    const messages = moneyTrailPrompt.generate({ candidate_name: 'Joe Biden' });
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('"Joe Biden"');
  });

  it('generates message with cycle note when cycle provided', () => {
    const messages = moneyTrailPrompt.generate({
      candidate_name: 'Joe Biden',
      cycle: '2024',
    });
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('for the 2024 cycle');
  });

  it('uses fallback "the specified candidate" when neither name nor id given', () => {
    const messages = moneyTrailPrompt.generate({});
    const text = (messages[0].content as { text: string }).text;
    const openingLine = text.split('\n')[0];
    expect(openingLine).toContain('the specified candidate');
    expect(openingLine).not.toContain('candidate ID');
  });

  it('returns exactly 1 message with role=user', () => {
    const messages = moneyTrailPrompt.generate({ candidate_id: 'P00003392' });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('message text contains all investigation steps', () => {
    const messages = moneyTrailPrompt.generate({ candidate_id: 'P00003392' });
    const text = (messages[0].content as { text: string }).text;

    const steps = [
      'Identify the candidate',
      'Map their committees',
      'Follow direct fundraising',
      'Track outside money',
      'Add party coordinated spending',
      'Examine spending',
      'Synthesize',
    ];
    for (const step of steps) {
      expect(text).toContain(step);
    }
  });

  /**
   * The sequence is executed verbatim by clients, so every tool it names must
   * exist under that exact name — a tool the server gained but the sequence
   * never mentions is unreachable through this prompt.
   */
  it('names every tool the money-trail sequence chains', () => {
    const messages = moneyTrailPrompt.generate({ candidate_id: 'P00003392' });
    const text = (messages[0].content as { text: string }).text;

    const tools = [
      'openfec_search_candidates',
      'openfec_search_committees',
      'openfec_get_committee_totals',
      'openfec_search_contributions',
      'openfec_search_expenditures',
      'openfec_search_coordinated_expenditures',
      'openfec_search_disbursements',
    ];
    for (const name of tools) {
      expect(text).toContain(name);
    }
  });

  it('pins the cycle on every call when one was supplied', () => {
    const withCycle = moneyTrailPrompt.generate({ candidate_id: 'P00003392', cycle: '2020' });
    expect((withCycle[0].content as { text: string }).text).toContain('Pass cycle=2020');

    const withoutCycle = moneyTrailPrompt.generate({ candidate_id: 'P00003392' });
    expect((withoutCycle[0].content as { text: string }).text).not.toContain('Pass cycle=');
  });

  it('args parsing validates schema', () => {
    expect(() => moneyTrailPrompt.args.parse({})).toThrow(/candidate_id or candidate_name/);
    expect(moneyTrailPrompt.args.parse({ candidate_id: 'P00003392' })).toEqual({
      candidate_id: 'P00003392',
    });
    expect(moneyTrailPrompt.args.parse({ candidate_name: 'Test' })).toEqual({
      candidate_name: 'Test',
    });
    expect(
      moneyTrailPrompt.args.parse({
        candidate_name: 'Test',
        candidate_id: 'P00003392',
        cycle: '2024',
      }),
    ).toEqual({
      candidate_name: 'Test',
      candidate_id: 'P00003392',
      cycle: '2024',
    });
    expect(() => moneyTrailPrompt.args.parse({ cycle: 123 })).toThrow();
  });
});
