/**
 * @fileoverview Prompt template for tracing the flow of money around a candidate or race.
 * Guides the agent through a multi-tool investigation of direct fundraising,
 * PAC support, independent expenditures, and party spending.
 * @module src/mcp-server/prompts/definitions/money-trail.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const moneyTrailPrompt = prompt('openfec_money_trail', {
  description: `Framework for tracing the flow of money around a candidate or race — direct fundraising, PAC support, independent expenditures, and party spending. Guides the agent through a multi-tool investigation.`,
  args: z.object({
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
  }),
  generate: (args) => {
    const target = args.candidate_id
      ? `candidate ID ${args.candidate_id}`
      : args.candidate_name
        ? `"${args.candidate_name}"`
        : 'the specified candidate';
    const cycleNote = args.cycle ? ` for the ${args.cycle} cycle` : '';

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Trace the full money trail for ${target}${cycleNote}. Use the OpenFEC tools to investigate each layer:

## Step 1: Identify the candidate
${args.candidate_id ? `Look up candidate ${args.candidate_id} using openfec_search_candidates with include_totals=true.` : `Search for "${args.candidate_name}" using openfec_search_candidates. Once found, note the candidate_id and look up their financial totals.`}

## Step 2: Map their committees
Use openfec_search_committees with the candidate_id to find:
- Principal campaign committee
- Leadership PACs
- Joint fundraising committees

## Step 3: Follow direct fundraising
For the principal campaign committee, use openfec_search_contributions to examine:
- Overall totals (include_totals from step 1)
- Contribution breakdown by size (mode: by_size)
- Top donor states (mode: by_state)
- Top employer/occupation patterns (mode: by_employer, by_occupation)

## Step 4: Track outside money
Use openfec_search_expenditures with the candidate_id to find:
- Independent expenditures supporting this candidate (support_oppose: S)
- Independent expenditures opposing this candidate (support_oppose: O)
- Which Super PACs and groups are involved (mode: by_candidate for summary)

## Step 5: Examine spending
For the principal campaign committee, use openfec_search_disbursements to see:
- Spending by purpose category (mode: by_purpose)
- Top recipients (mode: by_recipient)

## Step 6: Synthesize
Summarize the complete money picture:
- Total raised vs. spent vs. cash on hand
- Donor composition (small vs. large donors, top industries)
- Outside money landscape (supporting vs. opposing)
- Key financial strengths and vulnerabilities`,
        },
      },
    ];
  },
});
