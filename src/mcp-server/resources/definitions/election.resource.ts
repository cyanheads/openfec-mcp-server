/**
 * @fileoverview Resources for fetching election race summaries.
 * Three URI templates for presidential, state (senate), and district (house) races.
 * @module src/mcp-server/resources/definitions/election.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams } from '@/services/openfec/types.js';

const OFFICE_API_FORM = { H: 'house', S: 'senate', P: 'president' } as const;
type OfficeCode = keyof typeof OFFICE_API_FORM;

/** Shared handler logic for all election resource URI variants. */
async function fetchElection(
  params: { cycle: string; office: OfficeCode; state?: string; district?: string },
  ctx: Parameters<Parameters<typeof resource>[1]['handler']>[1],
) {
  const fec = getOpenFecService();
  const apiParams: FecParams = {
    cycle: params.cycle,
    office: OFFICE_API_FORM[params.office],
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

/** Presidential races: openfec://election/2024/P */
export const electionResource = resource('openfec://election/{cycle}/{office}', {
  name: 'FEC Election Race',
  description:
    'Fetch a presidential election race with candidate financial totals. For senate races use openfec://election/{cycle}/S/{state}. For house races use openfec://election/{cycle}/H/{state}/{district}.',
  mimeType: 'application/json',
  params: z.object({
    cycle: z.string().describe('Election cycle year (e.g., 2024)'),
    office: z.enum(['P']).describe('Office code: P=President.'),
  }),
  handler: (params, ctx) => fetchElection(params, ctx),
});

/** Senate or at-large house races: openfec://election/2024/S/AZ */
export const electionStateResource = resource('openfec://election/{cycle}/{office}/{state}', {
  name: 'FEC Election Race (State)',
  description:
    'Fetch a senate race, or a house at-large race in a single-district state, with candidate financial totals.',
  mimeType: 'application/json',
  params: z.object({
    cycle: z.string().describe('Election cycle year (e.g., 2024)'),
    office: z.enum(['S', 'H']).describe('Office code: S=Senate, H=House (at-large).'),
    state: z.string().describe('Two-letter US state code (e.g., AZ)'),
  }),
  handler: (params, ctx) => fetchElection(params, ctx),
});

/** House district races: openfec://election/2024/H/CA/12 */
export const electionDistrictResource = resource(
  'openfec://election/{cycle}/{office}/{state}/{district}',
  {
    name: 'FEC Election Race (District)',
    description: 'Fetch a house election race with candidate financial totals.',
    mimeType: 'application/json',
    params: z.object({
      cycle: z.string().describe('Election cycle year (e.g., 2024)'),
      office: z.enum(['H']).describe('Office code: H=House.'),
      state: z.string().describe('Two-letter US state code (e.g., CA)'),
      district: z.string().describe('Two-digit district number (e.g., 12)'),
    }),
    handler: (params, ctx) => fetchElection(params, ctx),
  },
);
