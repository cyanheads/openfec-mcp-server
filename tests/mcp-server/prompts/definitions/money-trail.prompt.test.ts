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
      'openfec_lookup_elections',
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

  /** Text of one `## Step N:` section, up to the next step heading. */
  const section = (text: string, step: number) => {
    const start = text.indexOf(`## Step ${step}:`);
    if (start === -1) throw new Error(`step ${step} missing`);
    const end = text.indexOf(`## Step ${step + 1}:`, start);
    return text.slice(start, end === -1 ? undefined : end);
  };

  describe.each([
    ['candidate_id', { candidate_id: 'P80000722', cycle: '2024' }],
    ['candidate_name', { candidate_name: 'Joe Biden', cycle: '2024' }],
  ] as const)('principal committee resolution (by %s)', (_, args) => {
    const text = firstMessage(args).content.text;

    it('has step 1 carry the race scope forward from the candidate record', () => {
      expect(section(text, 1)).toContain("candidate record's office, state, and district");
    });

    it('resolves the cycle principal committee via openfec_lookup_elections candidate_pcc_id', () => {
      const step2 = section(text, 2);
      expect(step2).toContain('openfec_lookup_elections (mode: search)');
      expect(step2).toContain('candidate_pcc_id');
      expect(step2).toContain(
        'state for a Senate race and both state and district for a House race',
      );
      expect(step2).toContain('from the candidate record in step 1');
    });

    it('calls openfec_lookup_elections before any committee-financial call', () => {
      const lookup = text.indexOf('openfec_lookup_elections');
      expect(lookup).toBeGreaterThan(-1);
      for (const financial of [
        'openfec_get_committee_totals',
        'openfec_search_contributions',
        'openfec_search_disbursements',
      ]) {
        expect(lookup).toBeLessThan(text.indexOf(financial));
      }
    });

    it("never reads search_committees' designation as the cycle's principal committee", () => {
      const step2 = section(text, 2);
      expect(step2).toContain('current designation');
      expect(step2).not.toMatch(
        /openfec_search_committees[^\n]*\n-\s*Principal campaign committee/,
      );
    });

    it('keeps openfec_search_committees for related committees', () => {
      const step2 = section(text, 2);
      const related = step2.slice(step2.indexOf('openfec_search_committees'));
      expect(related).toContain('Leadership PACs');
      expect(related).toContain('Joint fundraising committees');
    });
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
