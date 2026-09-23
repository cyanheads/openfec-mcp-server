/**
 * @fileoverview Prompt template for tracing the flow of money around a candidate or race.
 * Guides the agent through a multi-tool investigation of direct fundraising,
 * PAC support, independent expenditures, and party spending.
 * @module src/mcp-server/prompts/definitions/money-trail.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const moneyTrailPrompt = prompt('openfec_money_trail', {
  description: `Multi-step framework for tracing the flow of money around a candidate or race — direct fundraising, PAC support, independent expenditures, and party spending.`,
  args: z
    .object({
      candidate_name: z
        .string()
        .optional()
        .describe('Candidate name to investigate. Provide this or candidate_id.'),
      candidate_id: z
        .string()
        .optional()
        .describe('FEC candidate ID (e.g., P00003392). Provide this or candidate_name.'),
      cycle: z
        .string()
        .optional()
        .describe('Election cycle year (e.g., 2024). Defaults to current cycle.'),
    })
    .refine((args) => Boolean(args.candidate_id || args.candidate_name), {
      message: 'Provide candidate_id or candidate_name to identify the candidate to investigate.',
      path: ['candidate_id'],
    }),
  generate: (args) => {
    const target = args.candidate_id
      ? `candidate ID ${args.candidate_id}`
      : args.candidate_name
        ? `"${args.candidate_name}"`
        : 'the specified candidate';
    const cycleNote = args.cycle ? ` for the ${args.cycle} cycle` : '';
    const cycleRule = args.cycle
      ? `\n\nPass cycle=${args.cycle} on every call that accepts it — itemized Schedule A/B/E queries fall back to the current cycle when it is omitted — and read search_criteria on each response to confirm the filters that were applied.`
      : '';

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Trace the full money trail for ${target}${cycleNote}. Use the OpenFEC tools to investigate each layer:${cycleRule}

## Step 1: Identify the candidate
${args.candidate_id ? `Look up candidate ${args.candidate_id} using openfec_search_candidates with include_totals=true.` : `Search for "${args.candidate_name}" using openfec_search_candidates. Once found, note the candidate_id and look up their financial totals.`} Note the candidate record's office, state, and district — step 2 needs them.

## Step 2: Map their committees
First resolve the principal campaign committee for the cycle with openfec_lookup_elections (mode: search), before any committee-financial call. It requires office and cycle, plus state for a Senate race and both state and district for a House race — take them from the candidate record in step 1. Find the candidate's row (a large race can span several pages) and use its candidate_pcc_id and candidate_pcc_name as the cycle's principal campaign committee. Do not treat openfec_search_committees' designation as that answer: it reflects each committee's current designation, so a principal committee since redesignated drops out of a designation=P filter.

Then use openfec_search_committees with the candidate_id to find related committees:
- Leadership PACs
- Joint fundraising committees

For the principal campaign committee and each related committee_id found, use openfec_get_committee_totals (mode: single) to get that committee's own per-cycle receipts, disbursements, and cash on hand. The step 1 totals are candidate-scoped and cover the campaign account only, not a leadership PAC or a joint fundraising committee.

## Step 3: Follow direct fundraising
Carry forward the receipt totals already retrieved in step 1. Use openfec_search_contributions with the principal campaign committee_id to break down where the money came from:
- Contribution size distribution (mode: by_size)
- Top donor states (mode: by_state)
- Top employer and occupation patterns (mode: by_employer, by_occupation)

## Step 4: Track outside money
Use openfec_search_expenditures with the candidate_id to find:
- Independent expenditures supporting this candidate (support_oppose: S)
- Independent expenditures opposing this candidate (support_oppose: O)
- Which Super PACs and groups are involved (mode: by_candidate for summary)

## Step 5: Add party coordinated spending
Use openfec_search_coordinated_expenditures with the candidate_id. Schedule F is money a party committee spends on the candidate's behalf in coordination with the campaign, under its own statutory limit — legally distinct from the independent expenditures in step 4 and absent from them, so a trail that stops at Schedule E understates party support. Each row names the spending party committee.

## Step 6: Examine spending
For the principal campaign committee, use openfec_search_disbursements to see:
- Spending by purpose category (mode: by_purpose)
- Top recipients (mode: by_recipient)

## Step 7: Synthesize
Summarize the complete money picture:
- Total raised vs. spent vs. cash on hand, per committee
- Donor composition (small vs. large donors, top industries)
- Outside money landscape (supporting vs. opposing)
- Party support: coordinated expenditures alongside independent spending
- Key financial strengths and vulnerabilities`,
        },
      },
    ];
  },
});
