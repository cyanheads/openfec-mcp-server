/**
 * @fileoverview Resource for fetching a candidate profile by FEC candidate ID.
 * URI: openfec://candidate/{candidate_id}
 * @module src/mcp-server/resources/definitions/candidate.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { validateCandidateId } from '@/mcp-server/tools/definitions/utils/id-validators.js';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';

export const candidateResource = resource('openfec://candidate/{candidate_id}', {
  name: 'FEC Candidate Profile',
  description:
    'Fetch a federal candidate profile with current financial totals. Candidate IDs start with H (House), S (Senate), or P (President) followed by digits.',
  mimeType: 'application/json',
  params: z.object({
    candidate_id: z.string().describe('FEC candidate ID (e.g., P00003392, H2CO07170, S4AZ00345)'),
  }),

  async handler(params, ctx) {
    validateCandidateId(params.candidate_id);

    const fec = getOpenFecService();
    const candidateResult = await fec.getCandidate(params.candidate_id, ctx);
    const candidate = candidateResult.results[0];
    if (!candidate) throw new Error(`Candidate ${params.candidate_id} not found`);

    const totalsResult = await fec.getCandidateTotals({ candidate_id: params.candidate_id }, ctx);
    const totals = totalsResult.results[0];

    ctx.log.info('Candidate resource fetched', { candidate_id: params.candidate_id });
    return { ...candidate, ...(totals ?? {}) };
  },
});
