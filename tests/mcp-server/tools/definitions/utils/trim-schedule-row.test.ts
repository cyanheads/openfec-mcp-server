/**
 * @fileoverview Tests for the itemized schedule row trimmer — committee hoist
 * scope rules, dropped sub-objects, the empty-field drop, the hoisted and
 * per-row committee renderers, and the shared response-budget measure.
 * @module tests/mcp-server/tools/definitions/utils/trim-schedule-row.test
 */

import { describe, expect, it } from 'vitest';
import {
  dropEmptyFields,
  enrichmentTrailerBytes,
  formatHoistedCommittee,
  formatRowCommittee,
  RESPONSE_BUDGET_BYTES,
  trimScheduleRows,
  utf8Bytes,
} from '@/mcp-server/tools/definitions/utils/trim-schedule-row.js';

const committee = (id: string) => ({
  committee_id: id,
  name: `COMMITTEE ${id}`,
  committee_type_full: 'Super PAC',
  treasurer_name: 'DOE, JANE',
  party_full: null,
});

/** The committee as trimming returns it — the same record minus its null field. */
const trimmedCommittee = (id: string) => {
  const { party_full: _null, ...populated } = committee(id);
  return populated;
};

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  committee_id: id,
  contribution_receipt_amount: 250,
  committee: committee(id),
  ...extra,
});

describe('trimScheduleRows', () => {
  it('hoists the shared committee out of every row', () => {
    const { results, committee: hoisted } = trimScheduleRows([row('C001'), row('C001')], {
      hoistCommittee: true,
    });

    expect(hoisted).toEqual(trimmedCommittee('C001'));
    expect(results).toHaveLength(2);
    for (const r of results) expect(r).not.toHaveProperty('committee');
    // Flat identity fields survive — only the nested duplicate is removed.
    expect(results[0]!.committee_id).toBe('C001');
    expect(results[0]!.contribution_receipt_amount).toBe(250);
  });

  it('leaves rows untouched when the query was not scoped to one committee', () => {
    const rows = [row('C001'), row('C002')];
    const { results, committee: hoisted } = trimScheduleRows(rows, { hoistCommittee: false });

    expect(hoisted).toBeUndefined();
    expect(results[0]!.committee).toEqual(trimmedCommittee('C001'));
    expect(results[1]!.committee).toEqual(trimmedCommittee('C002'));
  });

  it('refuses to hoist when the rows disagree on the committee, even if asked to', () => {
    const { results, committee: hoisted } = trimScheduleRows([row('C001'), row('C002')], {
      hoistCommittee: true,
    });

    expect(hoisted).toBeUndefined();
    expect(results[0]!.committee).toEqual(trimmedCommittee('C001'));
    expect(results[1]!.committee).toEqual(trimmedCommittee('C002'));
  });

  it('does not hoist when a row carries no committee object', () => {
    const bare = { committee_id: 'C001', contribution_receipt_amount: 10 };
    const { committee: hoisted, results } = trimScheduleRows([row('C001'), bare], {
      hoistCommittee: true,
    });

    expect(hoisted).toBeUndefined();
    expect(results[0]!.committee).toBeDefined();
  });

  it('drops named sub-objects regardless of the hoist outcome', () => {
    const rows = [
      row('C001', { candidate: { candidate_id: 'P80001571', idx: 1 } }),
      row('C002', { candidate: { candidate_id: 'P80001571', idx: 2 } }),
    ];
    const { results, committee: hoisted } = trimScheduleRows(rows, {
      hoistCommittee: true,
      drop: ['candidate'],
    });

    expect(hoisted).toBeUndefined();
    for (const r of results) {
      expect(r).not.toHaveProperty('candidate');
      expect(r.committee).toBeDefined();
    }
  });

  it('does not mutate the input rows', () => {
    const candidate = { candidate_id: 'P80001571' };
    const rows = [row('C001', { candidate })];
    trimScheduleRows(rows, { hoistCommittee: true, drop: ['candidate'] });

    expect(rows[0]!.committee).toBeDefined();
    expect(rows[0]).toHaveProperty('candidate', candidate);
  });

  it('returns an empty page unchanged', () => {
    expect(trimScheduleRows([], { hoistCommittee: true })).toEqual({ results: [] });
  });

  it('drops null and empty fields from the rows and from the hoisted committee', () => {
    const { results, committee: hoisted } = trimScheduleRows(
      [row('C001', { memo_text: null, image_number: '' }), row('C001', { memo_text: 'X' })],
      { hoistCommittee: true },
    );

    expect(results[0]).not.toHaveProperty('memo_text');
    expect(results[0]).not.toHaveProperty('image_number');
    expect(results[1]!.memo_text).toBe('X');
    // committee() carries party_full: null.
    expect(hoisted).not.toHaveProperty('party_full');
    expect(hoisted).toMatchObject({ committee_id: 'C001', treasurer_name: 'DOE, JANE' });
  });

  it('drops null fields inside a committee left on the row', () => {
    const { results } = trimScheduleRows([row('C001'), row('C002')], { hoistCommittee: false });
    for (const r of results) {
      expect(r.committee).not.toHaveProperty('party_full');
      expect(r.committee).toHaveProperty('treasurer_name', 'DOE, JANE');
    }
  });
});

describe('dropEmptyFields', () => {
  it('drops null, undefined, empty-string, empty-array, and empty-object fields', () => {
    expect(
      dropEmptyFields({
        a: null,
        b: undefined,
        c: '',
        d: [],
        e: {},
        keep: 'x',
      }),
    ).toEqual({ keep: 'x' });
  });

  it('keeps false, 0, and other non-empty values — they are facts, not gaps', () => {
    expect(dropEmptyFields({ flag: false, amount: 0, list: [0], name: 'N' })).toEqual({
      flag: false,
      amount: 0,
      list: [0],
      name: 'N',
    });
  });

  it('recurses through nested records at every depth', () => {
    expect(
      dropEmptyFields({
        committee: {
          name: 'PAC',
          party_full: null,
          sponsor: { street: '', address: { zip: null, city: 'DC', lines: [] } },
        },
      }),
    ).toEqual({ committee: { name: 'PAC', sponsor: { address: { city: 'DC' } } } });
  });

  it('drops a nested record that holds nothing once its own empties are gone', () => {
    expect(dropEmptyFields({ id: 1, conduit: { name: null, address: { city: '' } } })).toEqual({
      id: 1,
    });
  });

  it('cleans records inside arrays but never removes or reorders array elements', () => {
    expect(
      dropEmptyFields({
        election_districts: ['03', null, '07'],
        participants: [{ name: 'A', role: null }, { name: null }],
      }),
    ).toEqual({
      election_districts: ['03', null, '07'],
      participants: [{ name: 'A' }, {}],
    });
  });

  it('does not mutate its input', () => {
    const input = { a: null, nested: { b: null, c: 1 } };
    dropEmptyFields(input);
    expect(input).toEqual({ a: null, nested: { b: null, c: 1 } });
  });
});

describe('formatHoistedCommittee', () => {
  it('renders nothing when no committee was hoisted', () => {
    expect(formatHoistedCommittee(undefined)).toEqual([]);
  });

  it('renders the committee name, ID, and available detail', () => {
    const [block] = formatHoistedCommittee(committee('C001'));
    expect(block).toContain('COMMITTEE C001');
    expect(block).toContain('(C001)');
    expect(block).toContain('Super PAC');
    expect(block).toContain('Treasurer: DOE, JANE');
    // party_full is null upstream — rendered as absent, not as "null".
    expect(block).not.toContain('null');
  });

  it('falls back to the committee ID when there is no name', () => {
    const [block] = formatHoistedCommittee({ committee_id: 'C009' });
    expect(block).toContain('C009');
  });
});

describe('formatRowCommittee', () => {
  it('renders name, ID, and one attribute line — the hoisted header layout, per row', () => {
    expect(formatRowCommittee(committee('C001'))).toBe(
      'COMMITTEE C001 (C001)\n    Super PAC · Treasurer: DOE, JANE',
    );
  });

  it('shares its summary with the hoisted header', () => {
    const [hoisted] = formatHoistedCommittee(committee('C001'));
    expect(hoisted).toBe(
      '**Committee (applies to every row below):** COMMITTEE C001 (C001)\n  Super PAC · Treasurer: DOE, JANE',
    );
  });

  it('renders the title alone when no attribute is known', () => {
    expect(formatRowCommittee({ committee_id: 'C009', name: 'BARE PAC', party_full: null })).toBe(
      'BARE PAC (C009)',
    );
  });

  it('marks a record carrying neither name nor ID as unknown rather than inventing one', () => {
    expect(formatRowCommittee({ state: 'DC' })).toBe('Unknown\n    DC');
  });

  it('declines a value that is not a committee record, leaving it to the generic rendering', () => {
    expect(formatRowCommittee(null)).toBeNull();
    expect(formatRowCommittee('C00000001')).toBeNull();
    expect(formatRowCommittee([committee('C001')])).toBeNull();
  });
});

describe('response budget measure', () => {
  it('pins the budget at 100,000 bytes per surface', () => {
    expect(RESPONSE_BUDGET_BYTES).toBe(100_000);
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('§')).toBe(2);
    expect(utf8Bytes('—')).toBe(3);
    expect(utf8Bytes('😀')).toBe(4);
    expect('😀'.length).toBe(2);
  });

  it('bounds the trailer a framework join could produce for the given lines', () => {
    expect(enrichmentTrailerBytes([])).toBe(3);
    expect(enrichmentTrailerBytes(['**5 total**', '> note'])).toBe(3 + 13 + 8);
  });
});
