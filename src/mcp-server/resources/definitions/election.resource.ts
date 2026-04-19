/**
 * @fileoverview Resources for fetching election race summaries.
 * Three URI templates for presidential, state (senate), and district (house) races.
 * @module src/mcp-server/resources/definitions/election.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';

/** Shared handler logic for all election resource URI variants. */
async function fetchElection(
  params: { cycle: string; office: string; state?: string; district?: string },
  ctx: Parameters<Parameters<typeof resource>[1]['handler']>[1],
) {
  const fec = getOpenFecService();
  const apiParams: FecParams = {
    cycle: params.cycle,
    office: params.office,
    election_full: true,
  };
  if (params.state) apiParams.state = params.state;
  if (params.district) apiParams.district = params.district;

  const result = await fec.searchElections(apiParams, ctx);

  ctx.log.info('Election resource fetched', {
    cycle: params.cycle,
    office: params.office,
    state: params.state,
    district: params.district,
  });
  return {
    cycle: params.cycle,
    office: params.office,
    state: params.state,
    district: params.district,
    candidates: result.results,
  };
}

/** Presidential and at-large races: openfec://election/2024/president */
export const electionResource = resource('openfec://election/{cycle}/{office}', {
  name: 'FEC Election Race',
  description:
    'Fetch an election race with candidate financial totals. For senate races use openfec://election/{cycle}/senate/{state}. For house races use openfec://election/{cycle}/house/{state}/{district}.',
  mimeType: 'application/json',
  params: z.object({
    cycle: z.string().describe('Election cycle year (e.g., 2024)'),
    office: z.string().describe('Office: president, senate, or house'),
  }),
  handler: (params, ctx) => fetchElection(params, ctx),
});

/** Senate races: openfec://election/2024/senate/AZ */
export const electionStateResource = resource('openfec://election/{cycle}/{office}/{state}', {
  name: 'FEC Election Race (State)',
  description: 'Fetch a senate or at-large election race with candidate financial totals.',
  mimeType: 'application/json',
  params: z.object({
    cycle: z.string().describe('Election cycle year (e.g., 2024)'),
    office: z.string().describe('Office: senate (or president)'),
    state: z.string().describe('Two-letter US state code (e.g., AZ)'),
  }),
  handler: (params, ctx) => fetchElection(params, ctx),
});

/** House races: openfec://election/2024/house/CA/12 */
export const electionDistrictResource = resource(
  'openfec://election/{cycle}/{office}/{state}/{district}',
  {
    name: 'FEC Election Race (District)',
    description: 'Fetch a house election race with candidate financial totals.',
    mimeType: 'application/json',
    params: z.object({
      cycle: z.string().describe('Election cycle year (e.g., 2024)'),
      office: z.string().describe('Office: house'),
      state: z.string().describe('Two-letter US state code (e.g., CA)'),
      district: z.string().describe('Two-digit district number (e.g., 12)'),
    }),
    handler: (params, ctx) => fetchElection(params, ctx),
  },
);
