/**
 * @fileoverview Resource for fetching a candidate profile by FEC candidate ID.
 * URI: openfec://candidate/{candidate_id}
 * @module src/mcp-server/resources/definitions/candidate.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

  errors: [
    {
      reason: 'candidate_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No candidate exists for the supplied candidate_id',
      recovery:
        'Verify the candidate_id format (H/S/P + digits) or look up the candidate by name via openfec_search_candidates.',
    },
  ],

  async handler(params, ctx) {
    validateCandidateId(params.candidate_id);

    const fec = getOpenFecService();
    const [candidateResult, totalsResult, committeesResult] = await Promise.all([
      fec.getCandidate(params.candidate_id, ctx),
      fec.getCandidateTotals({ candidate_id: params.candidate_id }, ctx),
      fec.getCandidateCommittees(params.candidate_id, { designation: 'P' }, ctx),
    ]);

    const candidate = candidateResult.results[0];
    if (!candidate) {
      throw ctx.fail('candidate_not_found', `Candidate ${params.candidate_id} not found.`, {
        candidate_id: params.candidate_id,
        ...ctx.recoveryFor('candidate_not_found'),
      });
    }

    const totals = totalsResult.results[0];
    const principal_committees = committeesResult.results;

    ctx.log.info('Candidate resource fetched', { candidate_id: params.candidate_id });
    return { ...candidate, ...(totals ?? {}), principal_committees };
  },
});
