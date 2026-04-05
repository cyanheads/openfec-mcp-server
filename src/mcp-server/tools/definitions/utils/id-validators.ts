/**
 * @fileoverview Shared FEC ID format validators for tool handlers.
 * Validates candidate_id and committee_id formats before hitting the API,
 * producing clear error messages instead of silent empty results.
 * @module src/mcp-server/tools/definitions/id-validators
 */

import { invalidParams } from '@cyanheads/mcp-ts-core/errors';

const CANDIDATE_ID_RE = /^[HSP][0-9A-Z]+$/i;
const COMMITTEE_ID_RE = /^C\d+$/i;

/** Throw invalidParams if `candidateId` doesn't match the FEC candidate ID pattern. */
export function validateCandidateId(candidateId: string): void {
  if (!CANDIDATE_ID_RE.test(candidateId)) {
    throw invalidParams(
      "Invalid candidate ID format. FEC candidate IDs start with H (House), S (Senate), or P (President) followed by digits (e.g., 'P00003392').",
      { candidate_id: candidateId },
    );
  }
}

/** Throw invalidParams if `committeeId` doesn't match the FEC committee ID pattern. */
export function validateCommitteeId(committeeId: string): void {
  if (!COMMITTEE_ID_RE.test(committeeId)) {
    throw invalidParams(
      "Invalid committee ID format. FEC committee IDs start with 'C' followed by digits (e.g., 'C00358796').",
      { committee_id: committeeId },
    );
  }
}
