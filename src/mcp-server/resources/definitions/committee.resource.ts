/**
 * @fileoverview Resource for fetching a committee profile by FEC committee ID.
 * URI: openfec://committee/{committee_id}
 * @module src/mcp-server/resources/definitions/committee.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';

export const committeeResource = resource('openfec://committee/{committee_id}', {
  name: 'FEC Committee Profile',
  description:
    'Fetch a political committee profile with type, designation, and financial summary. ' +
    'Committee IDs start with C followed by digits (e.g., C00358796).',
  mimeType: 'application/json',
  params: z.object({
    committee_id: z.string().describe('FEC committee ID (e.g., C00358796)'),
  }),

  async handler(params, ctx) {
    const fec = getOpenFecService();
    const result = await fec.getCommittee(params.committee_id, ctx);
    const committee = result.results[0];
    if (!committee) throw new Error(`Committee ${params.committee_id} not found`);

    ctx.log.info('Committee resource fetched', { committee_id: params.committee_id });
    return committee;
  },
});
