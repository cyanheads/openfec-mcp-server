/**
 * @fileoverview Resource for fetching a committee profile by FEC committee ID.
 * URI: openfec://committee/{committee_id}
 * @module src/mcp-server/resources/definitions/committee.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { validateCommitteeId } from '@/mcp-server/tools/definitions/utils/id-validators.js';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';

export const committeeResource = resource('openfec://committee/{committee_id}', {
  name: 'FEC Committee Profile',
  description:
    'Fetch a political committee profile with type, designation, and financial summary. Committee IDs start with C followed by exactly eight digits (e.g., C00358796).',
  mimeType: 'application/json',
  params: z.object({
    committee_id: z
      .string()
      .describe("FEC committee ID: 'C' followed by exactly eight digits (e.g., C00358796)."),
  }),

  errors: [
    {
      reason: 'committee_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No committee exists for the supplied committee_id',
      recovery:
        'Verify the committee_id format (C + eight digits) or look up the committee by name via openfec_search_committees.',
    },
  ],

  async handler(params, ctx) {
    validateCommitteeId(params.committee_id);

    const fec = getOpenFecService();
    /**
     * A committee with no totals on file (one that never files Form 3/3X/3P)
     * comes back from the service as an empty page, so any rejection from the
     * totals leg is an operational failure and fails the read. The base fetch
     * alone decides committee_not_found.
     */
    const [committeeResult, totalsResult] = await Promise.all([
      fec.getCommittee(params.committee_id, ctx),
      fec.getCommitteeTotals(params.committee_id, { per_page: 1 }, ctx),
    ]);

    const committee = committeeResult.results[0];
    if (!committee) {
      throw ctx.fail('committee_not_found', `Committee ${params.committee_id} not found.`, {
        committee_id: params.committee_id,
        ...ctx.recoveryFor('committee_not_found'),
      });
    }

    const totals = totalsResult.results[0];

    ctx.log.info('Committee resource fetched', { committee_id: params.committee_id });
    return { ...committee, ...(totals ?? {}) };
  },
});
