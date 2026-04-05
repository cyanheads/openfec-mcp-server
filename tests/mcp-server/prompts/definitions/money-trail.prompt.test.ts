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
      'Examine spending',
      'Synthesize',
    ];
    for (const step of steps) {
      expect(text).toContain(step);
    }
  });

  it('args parsing validates schema', () => {
    expect(moneyTrailPrompt.args.parse({})).toEqual({});
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
