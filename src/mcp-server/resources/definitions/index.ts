/**
 * @fileoverview Barrel export for all resource definitions.
 * @module src/mcp-server/resources/definitions/index
 */

export { candidateResource } from './candidate.resource.js';
export { committeeResource } from './committee.resource.js';
export { electionResource } from './election.resource.js';

import { candidateResource } from './candidate.resource.js';
import { committeeResource } from './committee.resource.js';
import { electionResource } from './election.resource.js';

export const allResourceDefinitions = [candidateResource, committeeResource, electionResource];
