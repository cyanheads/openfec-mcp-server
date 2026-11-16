/**
 * @fileoverview Width and membership checks for OpenFEC state, party, and
 * committee code inputs. OpenFEC matches these codes literally, so a
 * spelled-out name ("Georgia", "Democratic") returns an empty success; these
 * checks reject it before the request instead. The state and party checks are
 * width rules, not shape rules: OpenFEC files states such as `00`, `14`, and
 * `D` and parties such as `W` and `D/C`, so only a value too wide to match any
 * filed code is rejected. Two wider values OpenFEC acts on pass where their
 * endpoint reads them: a leading `-` (exclude the code) on fields it filters
 * through `filter_multi`, and `other` (foreign, invalid, or missing states) on
 * its STATE_OTHER fields. Advertised input schemas stay unchanged.
 * @module src/mcp-server/tools/definitions/utils/code-validators
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

/** Widest state code OpenFEC files under any endpoint. */
const MAX_STATE_WIDTH = 2;
/** Widest party code OpenFEC files under any endpoint. */
const MAX_PARTY_WIDTH = 3;

/** Committee type codes `/totals/{entity_type}/` accepts. */
const COMMITTEE_TYPES = new Set('CDEHINOPQSUVWXYZ');
/** Committee designation codes `/totals/{entity_type}/` accepts. */
const COMMITTEE_DESIGNATIONS = new Set('ABDJPU');

const width = (value: string): number => [...value].length;

/** The values wider than a code that the endpoint behind a field acts on. */
export interface WiderValues {
  /** OpenFEC filters the field through `filter_multi`, which reads a leading `-` as "every code but this one". */
  exclusion?: boolean;
  /** The field is one of OpenFEC's STATE_OTHER fields, where `other` (any case) selects foreign, invalid, and missing states. */
  other?: boolean;
}

/** `value` split into OpenFEC's exclusion prefix, when the field reads one, and the code after it. */
const splitExclusion = (value: string, exclusion = false): [prefix: '' | '-', code: string] =>
  exclusion && value.startsWith('-') ? ['-', value.slice(1)] : ['', value];

/**
 * The code a state or party value names, after any exclusion prefix, or `null`
 * when that prefix excludes nothing (`-` alone, or `--X`), which OpenFEC answers
 * with the unfiltered set.
 */
const namedCode = (value: string, exclusion?: boolean): string | null => {
  const [prefix, code] = splitExclusion(value, exclusion);
  return prefix === '-' && (code === '' || code.startsWith('-')) ? null : code;
};

/** Throw `invalid_state_code` when `value` is wider than any state code OpenFEC files, unless `wider` admits it. */
export function validateStateCode(field: string, value: string, wider: WiderValues = {}): void {
  if (wider.other && value.toLowerCase() === 'other') return;
  const code = namedCode(value, wider.exclusion);
  if (code !== null && width(code) <= MAX_STATE_WIDTH) return;
  throw validationError(
    `${field} must be a state or territory code of at most two characters, as OpenFEC files it — got "${value}".`,
    {
      reason: 'invalid_state_code',
      field,
      value,
      recovery: {
        hint: 'Use the postal code (GA for Georgia, PR for Puerto Rico); OpenFEC files presidential candidates under US and foreign addresses under ZZ.',
      },
    },
  );
}

/** Throw `invalid_party_code` when `value` is wider than any party code OpenFEC files, unless `wider` admits it. */
export function validatePartyCode(field: string, value: string, wider: WiderValues = {}): void {
  const code = namedCode(value, wider.exclusion);
  if (code !== null && width(code) <= MAX_PARTY_WIDTH) return;
  throw validationError(
    `${field} must be OpenFEC's party code of at most three characters — got "${value}".`,
    {
      reason: 'invalid_party_code',
      field,
      value,
      recovery: {
        hint: 'Use the code, not the party name: DEM, REP, LIB, GRE, IND, W (write-in).',
      },
    },
  );
}

/**
 * Upper-case a committee type code for `/totals/{entity_type}/`, which matches
 * case-sensitively, or throw `invalid_committee_type` for a code outside the set.
 * A leading `-` (exclude the code) is kept.
 */
export function normalizeCommitteeType(field: string, value: string): string {
  const [prefix, raw] = splitExclusion(value, true);
  const code = raw.toUpperCase();
  if (code.length === 1 && COMMITTEE_TYPES.has(code)) return `${prefix}${code}`;
  throw validationError(`${field} must be one OpenFEC committee type code — got "${value}".`, {
    reason: 'invalid_committee_type',
    field,
    value,
    recovery: {
      hint: `Use one of ${[...COMMITTEE_TYPES].join(', ')} (e.g., O for Super PAC, Q for qualified PAC, P for presidential).`,
    },
  });
}

/**
 * Upper-case a committee designation code for `/totals/{entity_type}/`, which
 * matches case-sensitively, or throw `invalid_committee_designation` for a code
 * outside the set. A leading `-` (exclude the code) is kept.
 */
export function normalizeCommitteeDesignation(field: string, value: string): string {
  const [prefix, raw] = splitExclusion(value, true);
  const code = raw.toUpperCase();
  if (code.length === 1 && COMMITTEE_DESIGNATIONS.has(code)) return `${prefix}${code}`;
  throw validationError(
    `${field} must be one OpenFEC committee designation code — got "${value}".`,
    {
      reason: 'invalid_committee_designation',
      field,
      value,
      recovery: {
        hint: `Use one of ${[...COMMITTEE_DESIGNATIONS].join(', ')} (e.g., P for principal campaign committee, U for unauthorized).`,
      },
    },
  );
}
