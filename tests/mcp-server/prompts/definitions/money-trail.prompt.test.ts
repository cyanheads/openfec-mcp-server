/**
 * @fileoverview Tests for the money trail prompt — generates a multi-step
 * investigation framework for tracing campaign finance flows.
 * @module tests/mcp-server/prompts/definitions/money-trail.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { moneyTrailPrompt } from '@/mcp-server/prompts/definitions/money-trail.prompt.js';

type PromptMessage = { role: string; content: { type: string; text: string } };
const argsSchema = moneyTrailPrompt.args!;
const generate = (args: Parameters<typeof moneyTrailPrompt.generate>[0]) =>
  moneyTrailPrompt.generate(args) as PromptMessage[];
const firstMessage = (args: Parameters<typeof moneyTrailPrompt.generate>[0]): PromptMessage => {
  const [msg] = generate(args);
  if (!msg) throw new Error('generate() returned no messages');
  return msg;
};

describe('moneyTrailPrompt', () => {
  it('generates message with candidate_id when provided', () => {
    const text = firstMessage({ candidate_id: 'P00003392' }).content.text;
    expect(text).toContain('candidate ID P00003392');
  });

  it('generates message with candidate_name when provided', () => {
    const text = firstMessage({ candidate_name: 'Joe Biden' }).content.text;
    expect(text).toContain('"Joe Biden"');
  });

  it('generates message with cycle note when cycle provided', () => {
    const text = firstMessage({
      candidate_name: 'Joe Biden',
      cycle: '2024',
    }).content.text;
    expect(text).toContain('for the 2024 cycle');
  });

  it('uses fallback "the specified candidate" when neither name nor id given', () => {
    const text = firstMessage({}).content.text;
    const openingLine = text.split('\n')[0];
    expect(openingLine).toContain('the specified candidate');
    expect(openingLine).not.toContain('candidate ID');
  });

  it('returns exactly 1 message with role=user', () => {
    const messages = generate({ candidate_id: 'P00003392' });
    expect(messages).toHaveLength(1);
    expect(firstMessage({ candidate_id: 'P00003392' }).role).toBe('user');
  });

  it('message text contains all investigation steps', () => {
    const text = firstMessage({ candidate_id: 'P00003392' }).content.text;

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
    const text = firstMessage({ candidate_id: 'P00003392' }).content.text;

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
    expect(firstMessage({ candidate_id: 'P00003392', cycle: '2020' }).content.text).toContain(
      'Pass cycle=2020',
    );

    expect(firstMessage({ candidate_id: 'P00003392' }).content.text).not.toContain('Pass cycle=');
  });

  it('args parsing validates schema', () => {
    expect(() => argsSchema.parse({})).toThrow(/candidate_id or candidate_name/);
    expect(argsSchema.parse({ candidate_id: 'P00003392' })).toEqual({
      candidate_id: 'P00003392',
    });
    expect(argsSchema.parse({ candidate_name: 'Test' })).toEqual({
      candidate_name: 'Test',
    });
    expect(
      argsSchema.parse({
        candidate_name: 'Test',
        candidate_id: 'P00003392',
        cycle: '2024',
      }),
    ).toEqual({
      candidate_name: 'Test',
      candidate_id: 'P00003392',
      cycle: '2024',
    });
    expect(() => argsSchema.parse({ cycle: 123 })).toThrow();
  });
});
