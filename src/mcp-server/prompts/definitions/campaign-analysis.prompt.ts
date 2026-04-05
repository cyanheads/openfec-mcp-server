/**
 * @fileoverview Prompt template for structured analysis of a candidate's financial position.
 * Covers fundraising trajectory, burn rate, cash reserves, donor composition,
 * and opponent comparison.
 * @module src/mcp-server/prompts/definitions/campaign-analysis.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const campaignAnalysisPrompt = prompt('openfec_campaign_analysis', {
  description:
    "Structured analysis of a candidate's financial position — fundraising trajectory, " +
    'burn rate, cash reserves, donor composition, and opponent comparison.',
  args: z.object({
    candidate_name: z
      .string()
      .optional()
      .describe('Candidate name to analyze. Provide this or candidate_id.'),
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
          text: `Perform a structured campaign finance analysis of ${target}${cycleNote}. Use OpenFEC tools to build a complete financial picture.

## 1. Candidate Overview
Use openfec_search_candidates with include_totals=true to get:
- Total receipts, disbursements, cash on hand, debt
- Coverage period dates

## 2. Fundraising Analysis
Use openfec_search_contributions with the candidate's principal committee:
- **Size breakdown** (mode: by_size): What share comes from small vs. large donors?
- **Geographic reach** (mode: by_state): Where is financial support concentrated?
- **Industry patterns** (mode: by_employer): Which employers/industries are top sources?

## 3. Burn Rate & Spending
Use openfec_search_disbursements with the principal committee:
- **Purpose breakdown** (mode: by_purpose): Media buys, consulting, payroll, fundraising, travel
- **Top recipients** (mode: by_recipient): Where is the money going?
- Calculate burn rate: disbursements / receipts

## 4. Competitive Position
Use openfec_lookup_elections to find all candidates in the race:
- Compare total raised, cash on hand, and burn rates
- Identify financial advantages and gaps

## 5. Outside Money Context
Use openfec_search_expenditures with candidate_id:
- Total independent expenditure support vs. opposition
- Key outside groups involved

## 6. Assessment
Synthesize into a financial health assessment:
- **Fundraising trajectory**: Growing, flat, or declining?
- **Donor base health**: Broad grassroots vs. maxed-out large donors?
- **Cash position**: Sufficient for the remaining campaign period?
- **Spending efficiency**: Appropriate allocation across categories?
- **Competitive standing**: Financial position relative to opponents?
- **Key risks**: Debt levels, donor concentration, spending sustainability`,
        },
      },
    ];
  },
});
