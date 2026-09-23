/**
 * @fileoverview Tests for the campaign analysis prompt — generates structured
 * financial analysis instructions for a candidate.
 * @module tests/mcp-server/prompts/definitions/campaign-analysis.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { campaignAnalysisPrompt } from '@/mcp-server/prompts/definitions/campaign-analysis.prompt.js';

type PromptMessage = { role: string; content: { type: string; text: string } };
const argsSchema = campaignAnalysisPrompt.args!;
const generate = (args: Parameters<typeof campaignAnalysisPrompt.generate>[0]) =>
  campaignAnalysisPrompt.generate(args) as PromptMessage[];
const firstMessage = (
  args: Parameters<typeof campaignAnalysisPrompt.generate>[0],
): PromptMessage => {
  const [msg] = generate(args);
  if (!msg) throw new Error('generate() returned no messages');
  return msg;
};

describe('campaignAnalysisPrompt', () => {
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
      candidate_id: 'P00003392',
      cycle: '2024',
    }).content.text;
    expect(text).toContain('for the 2024 cycle');
  });

  it('uses fallback "the specified candidate" when neither name nor id given', () => {
    const text = firstMessage({}).content.text;
    expect(text).toContain('the specified candidate');
    expect(text).not.toContain('candidate ID');
    expect(text).not.toMatch(/"[^"]*"/); // no quoted name
  });

  it('returns exactly 1 message with role=user', () => {
    const messages = generate({ candidate_id: 'P00003392' });
    expect(messages).toHaveLength(1);
    expect(firstMessage({ candidate_id: 'P00003392' }).role).toBe('user');
  });

  it('message text contains all analysis sections', () => {
    const text = firstMessage({ candidate_id: 'P00003392' }).content.text;

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
    const text = firstMessage({ candidate_id: 'P00003392' }).content.text;

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

  /** Text of one `## N.` section, up to the next numbered heading. */
  const section = (text: string, n: number) => {
    const start = text.indexOf(`## ${n}. `);
    if (start === -1) throw new Error(`section ${n} missing`);
    const end = text.indexOf(`## ${n + 1}. `, start);
    return text.slice(start, end === -1 ? undefined : end);
  };

  /**
   * openfec_lookup_elections requires office and cycle, plus state/district
   * below the presidency — so both the committee-discovery step and the
   * competitive-position step must source them from the step 1 record.
   */
  it('sources the required openfec_lookup_elections scope from the candidate record', () => {
    const text = firstMessage({ candidate_id: 'P00003392' }).content.text;

    expect(section(text, 1)).toContain(
      "The candidate record's office, state, and district — steps 2 and 5 need all three",
    );
    for (const n of [2, 5]) {
      const step = section(text, n);
      expect(step).toContain('openfec_lookup_elections');
      expect(step).toContain('It requires office and cycle');
      expect(step).toContain('take them from the candidate record in step 1');
    }
  });

  describe.each([
    ['candidate_id', { candidate_id: 'P80000722', cycle: '2024' }],
    ['candidate_name', { candidate_name: 'Joe Biden' }],
  ] as const)('principal committee resolution (by %s)', (_, args) => {
    const text = firstMessage(args).content.text;

    it('resolves the cycle principal committee via openfec_lookup_elections candidate_pcc_id', () => {
      const step2 = section(text, 2);
      expect(step2).toContain('openfec_lookup_elections (mode: search)');
      expect(step2).toContain('candidate_pcc_id');
      expect(step2).toContain('current designation');
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

    it('keeps openfec_search_committees for related committees only', () => {
      const step2 = section(text, 2);
      const related = step2.slice(step2.indexOf('openfec_search_committees'));
      expect(related).toContain('leadership PACs');
      expect(related).toContain('joint fundraising committees');
      expect(related).not.toContain('identify the principal campaign committee');
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
    expect(() => argsSchema.parse({ candidate_name: 123 })).toThrow();
  });
});
