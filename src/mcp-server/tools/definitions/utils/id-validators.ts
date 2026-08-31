/**
 * @fileoverview Shared FEC ID format validators for tool handlers.
 * Validates candidate_id and committee_id formats before hitting the API,
 * producing clear error messages instead of silent empty results.
 * @module src/mcp-server/tools/definitions/id-validators
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

const CANDIDATE_ID_RE = /^[HSP][0-9A-Z]{8}$/i;
const COMMITTEE_ID_RE = /^C[0-9]{8}$/i;

/** Throw validationError if `candidateId` doesn't match the FEC candidate ID pattern. */
export function validateCandidateId(candidateId: string): void {
  if (!CANDIDATE_ID_RE.test(candidateId)) {
    throw validationError(
      "Invalid candidate ID format. FEC candidate IDs start with H (House), S (Senate), or P (President) followed by exactly eight letters or digits (e.g., 'P00003392' or 'H2CO07170').",
      { candidate_id: candidateId, reason: 'invalid_candidate_id' },
    );
  }
}

/** Throw validationError if `committeeId` doesn't match the FEC committee ID pattern. */
export function validateCommitteeId(committeeId: string): void {
  if (!COMMITTEE_ID_RE.test(committeeId)) {
    throw validationError(
      "Invalid committee ID format. FEC committee IDs start with 'C' followed by exactly eight digits (e.g., 'C00358796').",
      { committee_id: committeeId, reason: 'invalid_committee_id' },
    );
  }
}
