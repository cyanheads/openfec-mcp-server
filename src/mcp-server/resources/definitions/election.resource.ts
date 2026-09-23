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

/** Same guidance `openfec_lookup_elections` gives when a race search matches nothing. */
const EMPTY_RESULT_NOTICE =
  'No election races matched. Verify the cycle is an even year, the state code is correct for senate/house races, and the district exists for the given state.';

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

  /**
   * An empty list is indistinguishable from a race nobody entered unless it
   * says why it may be empty — an odd cycle, a wrong state code, or a district
   * the state does not have. The URI carries no page argument, so a race with
   * more candidates than one upstream page always truncates here; return the
   * pagination block and name the tool that can walk the remaining pages
   * rather than hiding the gap.
   */
  const notice =
    result.results.length === 0
      ? { empty_result_notice: EMPTY_RESULT_NOTICE }
      : result.pagination.pages > 1
        ? {
            truncation_notice: `Showing page 1 of ${result.pagination.pages} (${result.pagination.count} candidates total). This resource returns only the first page — use the openfec_lookup_elections tool with mode "search" and a page argument to retrieve the rest.`,
          }
        : {};

  return {
    cycle: params.cycle,
    office: params.office,
    state: params.state,
    district: params.district,
    candidates: result.results,
    pagination: result.pagination,
    ...notice,
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
    office: z
      .enum(['P'], {
        error:
          'This template serves presidential races only (office P). For a senate race use openfec://election/{cycle}/S/{state}; for a house race use openfec://election/{cycle}/H/{state}/{district}, or openfec://election/{cycle}/H/{state} for an at-large state.',
      })
      .describe('Office code: P=President.'),
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
    office: z
      .enum(['S', 'H'], {
        error:
          'This template serves senate races (office S) and at-large house races (office H). For a presidential race use openfec://election/{cycle}/P; for a house district race use openfec://election/{cycle}/H/{state}/{district}.',
      })
      .describe('Office code: S=Senate, H=House (at-large).'),
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
      office: z
        .enum(['H'], {
          error:
            'This template serves house district races only (office H). For a presidential race use openfec://election/{cycle}/P; for a senate race use openfec://election/{cycle}/S/{state}.',
        })
        .describe('Office code: H=House.'),
      state: z.string().describe('Two-letter US state code (e.g., CA)'),
      district: z.string().describe('Two-digit district number (e.g., 12)'),
    }),
    handler: (params, ctx) => fetchElection(params, ctx),
  },
);
