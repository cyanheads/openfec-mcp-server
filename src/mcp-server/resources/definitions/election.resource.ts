/**
 * @fileoverview Resource for fetching an election race summary.
 * URI: openfec://election/{cycle}/{office} with optional state and district path segments.
 * Examples:
 *   openfec://election/2024/president
 *   openfec://election/2024/senate/AZ
 *   openfec://election/2024/house/CA/12
 * @module src/mcp-server/resources/definitions/election.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';

export const electionResource = resource('openfec://election/{cycle}/{office}', {
  name: 'FEC Election Race Summary',
  description:
    'Fetch an election race summary with candidate financial totals. ' +
    'URI format: openfec://election/{cycle}/{office}[/{state}[/{district}]]. ' +
    'Office is president, senate, or house.',
  mimeType: 'application/json',
  params: z.object({
    cycle: z.string().describe('Election cycle year (e.g., 2024)'),
    office: z.string().describe('Office: president, senate, or house'),
  }),

  async handler(params, ctx) {
    const fec = getOpenFecService();

    /** Parse state/district from the URI path if present. */
    const uri = ctx.uri;
    const pathParts = uri?.pathname?.split('/').filter(Boolean) ?? [];
    // Path: election / cycle / office / [state] / [district]
    const state = pathParts[3] as string | undefined;
    const district = pathParts[4] as string | undefined;

    const result = await fec.searchElections(
      {
        cycle: params.cycle,
        office: params.office,
        ...(state ? { state } : {}),
        ...(district ? { district } : {}),
        election_full: true,
      },
      ctx,
    );

    ctx.log.info('Election resource fetched', {
      cycle: params.cycle,
      office: params.office,
      state,
      district,
    });
    return {
      cycle: params.cycle,
      office: params.office,
      state,
      district,
      candidates: result.results,
    };
  },
});
