/**
 * @fileoverview Barrel export for all tool definitions.
 * @module src/mcp-server/tools/definitions/index
 */

export { lookupCalendar } from './lookup-calendar.tool.js';
export { lookupElections } from './lookup-elections.tool.js';
export { searchCandidates } from './search-candidates.tool.js';
export { searchCommittees } from './search-committees.tool.js';
export { searchContributions } from './search-contributions.tool.js';
export { searchDisbursements } from './search-disbursements.tool.js';
export { searchExpenditures } from './search-expenditures.tool.js';
export { searchFilings } from './search-filings.tool.js';
export { searchLegal } from './search-legal.tool.js';

import { lookupCalendar } from './lookup-calendar.tool.js';
import { lookupElections } from './lookup-elections.tool.js';
import { searchCandidates } from './search-candidates.tool.js';
import { searchCommittees } from './search-committees.tool.js';
import { searchContributions } from './search-contributions.tool.js';
import { searchDisbursements } from './search-disbursements.tool.js';
import { searchExpenditures } from './search-expenditures.tool.js';
import { searchFilings } from './search-filings.tool.js';
import { searchLegal } from './search-legal.tool.js';

export const allToolDefinitions = [
  searchCandidates,
  searchCommittees,
  searchContributions,
  searchDisbursements,
  searchExpenditures,
  searchFilings,
  lookupElections,
  searchLegal,
  lookupCalendar,
];
