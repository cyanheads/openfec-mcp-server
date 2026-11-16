/**
 * @fileoverview Tests for the state, party, and committee code checks.
 * @module tests/mcp-server/tools/definitions/utils/code-validators.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  normalizeCommitteeDesignation,
  normalizeCommitteeType,
  validatePartyCode,
  validateStateCode,
} from '@/mcp-server/tools/definitions/utils/code-validators.js';

const capture = (fn: () => void): McpError => {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(McpError);
  return caught as McpError;
};

describe('validateStateCode', () => {
  /** Codes OpenFEC files, including the non-postal ones a letters-only rule would reject. */
  it.each(['GA', 'ga', 'US', 'ZZ', '00', '14', 'D', 'PR'])('accepts %s', (value) => {
    expect(() => validateStateCode('state', value)).not.toThrow();
  });

  it.each(['Georgia', 'GAA', 'New York', ' GA'])('rejects %j as invalid_state_code', (value) => {
    const error = capture(() => validateStateCode('contributor_state', value));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_state_code',
      field: 'contributor_state',
      value,
    });
    expect(error.message).toContain('contributor_state');
    expect(error.message).toContain(value);
    expect((error.data as { recovery: { hint: string } }).recovery.hint).toContain(
      'GA for Georgia',
    );
  });
});

describe('validatePartyCode', () => {
  it.each(['DEM', 'dem', 'REP', 'UN', 'W', 'D/C', 'N/A', 'N'])('accepts %s', (value) => {
    expect(() => validatePartyCode('party', value)).not.toThrow();
  });

  it.each(['Democratic', 'DEMO', 'Republican'])('rejects %j as invalid_party_code', (value) => {
    const error = capture(() => validatePartyCode('candidate_party', value));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_party_code',
      field: 'candidate_party',
      value,
    });
    expect(error.message).toContain('candidate_party');
    expect((error.data as { recovery: { hint: string } }).recovery.hint).toContain('DEM');
  });
});

/** Every committee type and designation code `/totals/{entity_type}/` takes. */
const COMMITTEE_TYPE_CODES = [...'CDEHINOPQSUVWXYZ'];
const COMMITTEE_DESIGNATION_CODES = [...'ABDJPU'];
const ALPHABET = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

describe('code width', () => {
  /** Mathematical bold capitals: one code point each, two UTF-16 units each. */
  it('counts a state code in characters, not UTF-16 units', () => {
    expect(() => validateStateCode('state', '𝐆𝐀')).not.toThrow();
    expect(capture(() => validateStateCode('state', '𝐆𝐀𝐀')).data).toMatchObject({
      reason: 'invalid_state_code',
    });
  });

  it('counts a party code in characters, not UTF-16 units', () => {
    expect(() => validatePartyCode('party', '𝐃𝐄𝐌')).not.toThrow();
    expect(capture(() => validatePartyCode('party', '𝐃𝐄𝐌𝐎')).data).toMatchObject({
      reason: 'invalid_party_code',
    });
  });
});

describe('committee code sets', () => {
  it.each(
    COMMITTEE_TYPE_CODES.flatMap((code) => [
      [code, code],
      [code.toLowerCase(), code],
    ]),
  )('accepts committee type %s as %s', (value, expected) => {
    expect(normalizeCommitteeType('committee_type', value)).toBe(expected);
  });

  it.each(
    COMMITTEE_DESIGNATION_CODES.flatMap((code) => [
      [code, code],
      [code.toLowerCase(), code],
    ]),
  )('accepts committee designation %s as %s', (value, expected) => {
    expect(normalizeCommitteeDesignation('committee_designation', value)).toBe(expected);
  });

  it.each(ALPHABET.filter((letter) => !COMMITTEE_TYPE_CODES.includes(letter)))(
    'rejects %s, outside the committee type set',
    (letter) => {
      const error = capture(() => normalizeCommitteeType('committee_type', letter));
      expect(error.data).toMatchObject({ reason: 'invalid_committee_type', value: letter });
    },
  );

  it.each(ALPHABET.filter((letter) => !COMMITTEE_DESIGNATION_CODES.includes(letter)))(
    'rejects %s, outside the committee designation set',
    (letter) => {
      const error = capture(() => normalizeCommitteeDesignation('committee_designation', letter));
      expect(error.data).toMatchObject({ reason: 'invalid_committee_designation', value: letter });
    },
  );

  it('names every code in each set in the recovery hint', () => {
    const hintOf = (fn: () => void) =>
      (capture(fn).data as { recovery: { hint: string } }).recovery.hint;
    const typeHint = hintOf(() => normalizeCommitteeType('committee_type', 'A'));
    const designationHint = hintOf(() =>
      normalizeCommitteeDesignation('committee_designation', 'C'),
    );

    expect(typeHint).toContain(`Use one of ${COMMITTEE_TYPE_CODES.join(', ')} `);
    expect(designationHint).toContain(`Use one of ${COMMITTEE_DESIGNATION_CODES.join(', ')} `);
  });
});

describe('normalizeCommitteeType', () => {
  it.each([
    ['o', 'O'],
    ['O', 'O'],
    ['q', 'Q'],
    ['Z', 'Z'],
  ])('upper-cases %s to %s', (value, expected) => {
    expect(normalizeCommitteeType('committee_type', value)).toBe(expected);
  });

  it.each(['ZZ', 'A', 'B', '', 'super pac'])('rejects %j as invalid_committee_type', (value) => {
    const error = capture(() => normalizeCommitteeType('committee_type', value));
    expect(error.data).toMatchObject({
      reason: 'invalid_committee_type',
      field: 'committee_type',
      value,
    });
    expect((error.data as { recovery: { hint: string } }).recovery.hint).toContain(
      'O for Super PAC',
    );
  });
});

describe('normalizeCommitteeDesignation', () => {
  it.each([
    ['b', 'B'],
    ['P', 'P'],
    ['u', 'U'],
  ])('upper-cases %s to %s', (value, expected) => {
    expect(normalizeCommitteeDesignation('committee_designation', value)).toBe(expected);
  });

  it.each(['C', 'PU', '', 'principal'])('rejects %j as invalid_committee_designation', (value) => {
    const error = capture(() => normalizeCommitteeDesignation('committee_designation', value));
    expect(error.data).toMatchObject({
      reason: 'invalid_committee_designation',
      field: 'committee_designation',
      value,
    });
  });
});

/**
 * Two values wider than any code that OpenFEC still acts on: `other` on its
 * STATE_OTHER fields (foreign, invalid, or missing states), and a leading `-`
 * on any field it filters through `filter_multi` (exclude that code).
 */
describe('OpenFEC values wider than a code', () => {
  it.each(['other', 'OTHER', 'Other'])('accepts state %j where the field reads other', (value) => {
    expect(() => validateStateCode('contributor_state', value, { other: true })).not.toThrow();
  });

  it.each([
    ['no wider values', {}],
    ['exclusion only', { exclusion: true }],
  ] as const)('rejects state other with %s', (_case, wider) => {
    const error = capture(() => validateStateCode('state', 'other', wider));
    expect(error.data).toMatchObject({ reason: 'invalid_state_code', value: 'other' });
  });

  it.each(['-GA', '-ga', '-ZZ', '-00', '-D'])('accepts the excluded state %j', (value) => {
    expect(() => validateStateCode('state', value, { exclusion: true })).not.toThrow();
  });

  it.each(['-GAA', '-Georgia', '-other', '--GA', '-', '--D'])(
    'still rejects the state %j',
    (value) => {
      const error = capture(() =>
        validateStateCode('state', value, { exclusion: true, other: true }),
      );
      expect(error.data).toMatchObject({ reason: 'invalid_state_code', value });
    },
  );

  it.each([
    ['no wider values', {}],
    ['other only', { other: true }],
  ] as const)('rejects an excluded state with %s', (_case, wider) => {
    const error = capture(() => validateStateCode('state', '-GA', wider));
    expect(error.data).toMatchObject({ reason: 'invalid_state_code', value: '-GA' });
  });

  it.each(['-DEM', '-dem', '-W', '-D/C'])('accepts the excluded party %j', (value) => {
    expect(() => validatePartyCode('party', value, { exclusion: true })).not.toThrow();
  });

  it.each(['-DEMO', '-Democratic', '--DEM', '-', '--W'])(
    'still rejects the excluded party %j',
    (value) => {
      const error = capture(() => validatePartyCode('party', value, { exclusion: true }));
      expect(error.data).toMatchObject({ reason: 'invalid_party_code', value });
    },
  );

  it('rejects an excluded party where the endpoint matches exactly', () => {
    const error = capture(() => validatePartyCode('party', '-DEM'));
    expect(error.data).toMatchObject({ reason: 'invalid_party_code', value: '-DEM' });
  });

  it.each([
    ['-o', '-O'],
    ['-Q', '-Q'],
  ])('upper-cases the excluded committee type %s to %s', (value, expected) => {
    expect(normalizeCommitteeType('committee_type', value)).toBe(expected);
  });

  it.each([
    ['-u', '-U'],
    ['-P', '-P'],
  ])('upper-cases the excluded committee designation %s to %s', (value, expected) => {
    expect(normalizeCommitteeDesignation('committee_designation', value)).toBe(expected);
  });

  it.each(['-ZZ', '-A', '-', '--O'])('rejects the excluded committee type %j', (value) => {
    const error = capture(() => normalizeCommitteeType('committee_type', value));
    expect(error.data).toMatchObject({ reason: 'invalid_committee_type', value });
  });

  it.each(['-C', '-', '--U'])('rejects the excluded committee designation %j', (value) => {
    const error = capture(() => normalizeCommitteeDesignation('committee_designation', value));
    expect(error.data).toMatchObject({ reason: 'invalid_committee_designation', value });
  });
});
