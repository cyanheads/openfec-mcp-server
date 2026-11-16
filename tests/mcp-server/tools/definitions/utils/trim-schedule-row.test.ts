/**
 * @fileoverview Tests for the itemized schedule row trimmer — committee hoist
 * scope rules, the page-level committee maps, dropped sub-objects, the
 * empty-field drop, and the committee renderers for both surfaces.
 * @module tests/mcp-server/tools/definitions/utils/trim-schedule-row.test
 */

import { describe, expect, it } from 'vitest';
import { renderRecord } from '@/mcp-server/tools/definitions/utils/format-helpers.js';
import {
  COMMITTEES,
  CONTRIBUTOR_COMMITTEES,
  committeeRenderers,
  dropEmptyFields,
  formatCommitteeMaps,
  formatHoistedCommittee,
  RECIPIENT_COMMITTEES,
  trimScheduleRows,
} from '@/mcp-server/tools/definitions/utils/trim-schedule-row.js';

type Row = Record<string, unknown>;

/** A committee record the way OpenFEC embeds it in a schedule row — 26 fields, nulls and blanks included. */
const fullCommittee = (id: string, overrides: Row = {}): Row => ({
  affiliated_committee_name: 'NONE',
  candidate_ids: [],
  city: 'WASHINGTON',
  committee_id: id,
  committee_type: 'O',
  committee_type_full: 'Super PAC (Independent Expenditure-Only)',
  cycle: 2026,
  cycles: [2024, 2026],
  cycles_has_activity: [2024, 2026],
  designation: 'U',
  designation_full: 'Unauthorized',
  filing_frequency: 'M',
  first_f1_date: '2023-12-06',
  first_file_date: '2023-12-06',
  is_active: true,
  last_cycle_has_activity: 2026,
  last_file_date: '2026-10-20',
  name: `COMMITTEE ${id}`,
  party_full: null,
  state: 'MN',
  state_full: 'Minnesota',
  street_1: '123 MAIN ST',
  street_2: '',
  treasurer_name: 'PHILIPCZYK, BRANDON',
  zip: '55401',
  ...overrides,
});

/** The record as trimming returns it — the same record minus its empty fields. */
const trimmedFull = (id: string, overrides: Row = {}) =>
  dropEmptyFields(fullCommittee(id, overrides));

/**
 * Assert `text` carries every key and value of `record` the way `renderRecord`
 * writes a field, with the name and ID read from the title.
 */
const expectEveryField = (text: string, record: Row) => {
  for (const [key, value] of Object.entries(record)) {
    if (key === 'name' || key === 'committee_id') {
      expect(text).toContain(String(value));
      continue;
    }
    expect(text).toContain(`${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
};

/** How many times `needle` occurs in `text`. */
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

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

  it('does not hoist records that name no committee_id, even identical ones', () => {
    const unnamed = { name: 'COMMITTEE WITH NO ID', treasurer_name: 'DOE, JANE' };
    const rows = [
      { committee_id: 'C001', committee: unnamed },
      { committee_id: 'C001', committee: { ...unnamed } },
    ];

    const page = trimScheduleRows(rows, { hoistCommittee: true, collect: [COMMITTEES] });

    expect(page).not.toHaveProperty('committee');
    expect(page).not.toHaveProperty('committees');
    for (const r of page.results) expect(r.committee).toEqual(unnamed);
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

  it('leaves donor and recipient records on the rows when the caller collects no map', () => {
    const contributor = fullCommittee('C00700001');
    const { results } = trimScheduleRows(
      [row('C001', { contributor_id: 'C00700001', contributor })],
      { hoistCommittee: true },
    );

    expect(results[0]!.contributor).toEqual(trimmedFull('C00700001'));
    expect(results[0]!.contributor_id).toBe('C00700001');
  });

  it("keeps a row's own committee record when it differs from the hoisted one — another cycle's record", () => {
    const cycle2016 = fullCommittee('C00010603', { cycle: 2016, treasurer_name: 'ANDREW TOBIAS' });
    const cycle2018 = fullCommittee('C00010603', {
      cycle: 2018,
      treasurer_name: 'WILLIAM Q. DERROUGH',
    });
    const rows = [
      { committee_id: 'C00010603', sub_id: '1', committee: cycle2016 },
      { committee_id: 'C00010603', sub_id: '2', committee: cycle2018 },
      { committee_id: 'C00010603', sub_id: '3', committee: cycle2016 },
    ];

    const page = trimScheduleRows(rows, { hoistCommittee: true, collect: [COMMITTEES] });

    expect(page.committee).toEqual(dropEmptyFields(cycle2016));
    expect(page.results[0]).not.toHaveProperty('committee');
    expect(page.results[1]!.committee).toEqual(dropEmptyFields(cycle2018));
    expect(page.results[2]).not.toHaveProperty('committee');
    // The hoisted record already holds the page's committee — no second copy in a map.
    expect(page).not.toHaveProperty('committees');
  });

  it('hoists the record most rows carry when the first row carries another', () => {
    const cycle2016 = fullCommittee('C00010603', { cycle: 2016 });
    const cycle2018 = fullCommittee('C00010603', { cycle: 2018 });
    const rows = [cycle2018, cycle2016, cycle2016].map((committee) => ({
      committee_id: 'C00010603',
      committee,
    }));

    const page = trimScheduleRows(rows, { hoistCommittee: true });

    expect(page.committee).toEqual(dropEmptyFields(cycle2016));
    expect(page.results[0]!.committee).toEqual(dropEmptyFields(cycle2018));
    expect(page.results[1]).not.toHaveProperty('committee');
    expect(page.results[2]).not.toHaveProperty('committee');
  });
});

describe('trimScheduleRows — page-level committee maps', () => {
  it('moves each Schedule A donor committee into contributor_committees, keyed by contributor_id', () => {
    const donor = fullCommittee('C00700001');
    const rows = [
      row('C001', { contributor_id: 'C00700001', contributor: donor, sub_id: '1' }),
      row('C001', { contributor_id: 'C00700001', contributor: donor, sub_id: '2' }),
      row('C001', { contributor: null, sub_id: '3' }),
    ];

    const page = trimScheduleRows(rows, {
      hoistCommittee: true,
      collect: [CONTRIBUTOR_COMMITTEES],
    });

    expect(page.committee).toEqual(trimmedCommittee('C001'));
    expect(page.contributor_committees).toEqual({ C00700001: trimmedFull('C00700001') });
    for (const r of page.results) expect(r).not.toHaveProperty('contributor');
    expect(page.results.map((r) => r.contributor_id)).toEqual([
      'C00700001',
      'C00700001',
      undefined,
    ]);
  });

  it('moves each Schedule B recipient committee into recipient_committees, one entry per ID', () => {
    const rows = [
      row('C001', {
        recipient_committee_id: 'C00114439',
        recipient_committee: fullCommittee('C00114439'),
      }),
      row('C001', {
        recipient_committee_id: 'C00010603',
        recipient_committee: fullCommittee('C00010603'),
      }),
      row('C001', {
        recipient_committee_id: 'C00114439',
        recipient_committee: fullCommittee('C00114439'),
      }),
      row('C001', { recipient_name: 'MEDIA STRATEGIES INC' }),
    ];

    const page = trimScheduleRows(rows, { hoistCommittee: true, collect: [RECIPIENT_COMMITTEES] });

    expect(page.recipient_committees).toEqual({
      C00114439: trimmedFull('C00114439'),
      C00010603: trimmedFull('C00010603'),
    });
    for (const r of page.results) expect(r).not.toHaveProperty('recipient_committee');
    expect(page.results[0]!.recipient_committee_id).toBe('C00114439');
  });

  it('moves each spender into committees on a page that spans committees', () => {
    const rows = [
      row('C001', { sub_id: '1' }),
      row('C002', { sub_id: '2' }),
      row('C001', { sub_id: '3' }),
    ];

    const page = trimScheduleRows(rows, { hoistCommittee: false, collect: [COMMITTEES] });

    expect(page).not.toHaveProperty('committee');
    expect(page.committees).toEqual({
      C001: trimmedCommittee('C001'),
      C002: trimmedCommittee('C002'),
    });
    for (const r of page.results) expect(r).not.toHaveProperty('committee');
    expect(page.results.map((r) => r.committee_id)).toEqual(['C001', 'C002', 'C001']);
  });

  it('collects recipients and donor committees side by side on a donor-scoped Schedule A page', () => {
    const rows = [
      row('C001', { contributor_id: 'C00700001', contributor: fullCommittee('C00700001') }),
      row('C002', { contributor_id: 'C00700001', contributor: fullCommittee('C00700001') }),
    ];

    const page = trimScheduleRows(rows, {
      hoistCommittee: false,
      collect: [CONTRIBUTOR_COMMITTEES, COMMITTEES],
    });

    expect(Object.keys(page.committees ?? {})).toEqual(['C001', 'C002']);
    expect(Object.keys(page.contributor_committees ?? {})).toEqual(['C00700001']);
    for (const r of page.results) {
      expect(r).not.toHaveProperty('committee');
      expect(r).not.toHaveProperty('contributor');
    }
  });

  it('falls back to the committees map when the hoist is asked for but the rows disagree', () => {
    const page = trimScheduleRows([row('C001'), row('C002')], {
      hoistCommittee: true,
      collect: [COMMITTEES],
    });

    expect(page).not.toHaveProperty('committee');
    expect(Object.keys(page.committees ?? {})).toEqual(['C001', 'C002']);
  });

  it('omits a map when no row carries a record for it', () => {
    const page = trimScheduleRows([row('C001', { contributor: null })], {
      hoistCommittee: true,
      collect: [CONTRIBUTOR_COMMITTEES, RECIPIENT_COMMITTEES],
    });

    expect(page).not.toHaveProperty('contributor_committees');
    expect(page).not.toHaveProperty('recipient_committees');
    expect(Object.keys(page)).toEqual(['results', 'committee']);
  });

  it('returns an empty page as just its empty rows', () => {
    expect(
      trimScheduleRows([], { hoistCommittee: false, collect: [COMMITTEES, RECIPIENT_COMMITTEES] }),
    ).toEqual({ results: [] });
  });

  it('leaves a value that is not a record on its row', () => {
    const rows = [
      row('C001', { contributor_id: 'C00700001', contributor: 'C00700001' }),
      row('C001', { contributor_id: 'C00700002', contributor: [fullCommittee('C00700002')] }),
    ];

    const page = trimScheduleRows(rows, {
      hoistCommittee: true,
      collect: [CONTRIBUTOR_COMMITTEES],
    });

    expect(page).not.toHaveProperty('contributor_committees');
    expect(page.results[0]!.contributor).toBe('C00700001');
    expect(page.results[1]!.contributor).toEqual([trimmedFull('C00700002')]);
  });

  it('leaves a record on its row when the row carries no ID naming it', () => {
    const rows = [
      row('C001', { contributor: fullCommittee('C00700001') }),
      row('C001', { contributor_id: 'C00799999', contributor: fullCommittee('C00700002') }),
      row('C001', { contributor_id: 'C00700003', contributor: { name: 'NO ID ON RECORD' } }),
    ];

    const page = trimScheduleRows(rows, {
      hoistCommittee: true,
      collect: [CONTRIBUTOR_COMMITTEES],
    });

    expect(page).not.toHaveProperty('contributor_committees');
    expect(page.results.map((r) => (r.contributor as Row).name)).toEqual([
      'COMMITTEE C00700001',
      'COMMITTEE C00700002',
      'NO ID ON RECORD',
    ]);
  });

  it('leaves a record on its row when neither the row nor the record carries a string ID', () => {
    const rows = [
      row('C001', { contributor: { name: 'NO ID ANYWHERE' } }),
      row('C001', {
        contributor_id: 700_001,
        contributor: { committee_id: 700_001, name: 'NUMERIC' },
      }),
    ];

    const page = trimScheduleRows(rows, {
      hoistCommittee: true,
      collect: [CONTRIBUTOR_COMMITTEES],
    });

    expect(page).not.toHaveProperty('contributor_committees');
    expect(page.results.map((r) => r.contributor)).toEqual([
      { name: 'NO ID ANYWHERE' },
      { committee_id: 700_001, name: 'NUMERIC' },
    ]);
  });

  it("keeps a record on its row when it differs from its ID's entry — another cycle's record", () => {
    const cycle2016 = fullCommittee('C00010603', { cycle: 2016, treasurer_name: 'ANDREW TOBIAS' });
    const cycle2018 = fullCommittee('C00010603', {
      cycle: 2018,
      treasurer_name: 'WILLIAM Q. DERROUGH',
    });
    const rows = [
      { committee_id: 'C00010603', sub_id: '1', committee: cycle2016 },
      { committee_id: 'C00010603', sub_id: '2', committee: cycle2018 },
      { committee_id: 'C00010603', sub_id: '3', committee: cycle2016 },
      { committee_id: 'C00350991', sub_id: '4', committee: fullCommittee('C00350991') },
    ];

    const page = trimScheduleRows(rows, { hoistCommittee: false, collect: [COMMITTEES] });

    expect(page.committees).toEqual({
      C00010603: dropEmptyFields(cycle2016),
      C00350991: trimmedFull('C00350991'),
    });
    expect(page.results[1]!.committee).toEqual(dropEmptyFields(cycle2018));
    for (const i of [0, 2, 3]) expect(page.results[i]).not.toHaveProperty('committee');
  });

  it('makes the record most rows carry the entry, wherever its first row sits', () => {
    const cycle2016 = fullCommittee('C00010603', { cycle: 2016, treasurer_name: 'ANDREW TOBIAS' });
    const cycle2018 = fullCommittee('C00010603', {
      cycle: 2018,
      treasurer_name: 'WILLIAM Q. DERROUGH',
    });
    // Newest first: the one 2018 row leads three 2016 rows.
    const rows = [cycle2018, cycle2016, cycle2016, cycle2016].map((committee, i) => ({
      committee_id: 'C00010603',
      sub_id: String(i),
      committee,
    }));

    const page = trimScheduleRows(rows, { hoistCommittee: false, collect: [COMMITTEES] });

    expect(page.committees).toEqual({ C00010603: dropEmptyFields(cycle2016) });
    expect(page.results[0]!.committee).toEqual(dropEmptyFields(cycle2018));
    for (const i of [1, 2, 3]) expect(page.results[i]).not.toHaveProperty('committee');
  });

  it('breaks a tie between records for one ID in favor of the first seen', () => {
    const a = fullCommittee('C001', { cycle: 2016 });
    const b = fullCommittee('C001', { cycle: 2018 });
    const rows = [b, a, a, b].map((committee) => ({ committee_id: 'C001', committee }));

    const page = trimScheduleRows(rows, { hoistCommittee: false, collect: [COMMITTEES] });

    expect(page.committees).toEqual({ C001: dropEmptyFields(b) });
    expect(page.results.map((r) => (r.committee as Row | undefined)?.cycle)).toEqual([
      undefined,
      2016,
      2016,
      undefined,
    ]);
  });

  it('drops empty fields inside the map entries', () => {
    const page = trimScheduleRows([row('C001'), row('C002')], {
      hoistCommittee: false,
      collect: [COMMITTEES],
    });

    for (const entry of Object.values(page.committees ?? {})) {
      expect(entry).not.toHaveProperty('party_full');
      expect(entry).toHaveProperty('treasurer_name', 'DOE, JANE');
    }
  });

  it('keys a hostile ID as an own entry, never through the prototype', () => {
    const page = trimScheduleRows(
      [row('C001', { contributor_id: '__proto__', contributor: { committee_id: '__proto__' } })],
      { hoistCommittee: true, collect: [CONTRIBUTOR_COMMITTEES] },
    );

    const map = page.contributor_committees!;
    expect(Object.hasOwn(map, '__proto__')).toBe(true);
    expect(Object.keys(map)).toEqual(['__proto__']);
    expect(({} as Row).committee_id).toBeUndefined();
  });

  it('does not mutate the input rows', () => {
    const donor = fullCommittee('C00700001');
    const rows = [row('C001', { contributor_id: 'C00700001', contributor: donor })];
    trimScheduleRows(rows, {
      hoistCommittee: false,
      collect: [COMMITTEES, CONTRIBUTOR_COMMITTEES],
    });

    expect(rows[0]!.committee).toBeDefined();
    expect(rows[0]).toHaveProperty('contributor', donor);
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

  it('renders the name and ID, then every other non-empty field of the record', () => {
    const record = trimmedFull('C00835959');
    const [block] = formatHoistedCommittee(record);

    expect(block!.split('\n')[0]).toBe(
      '**Committee (applies to every row below):** COMMITTEE C00835959 (C00835959)',
    );
    expectEveryField(block!, record);
    expect(block).toContain('  street_1: 123 MAIN ST');
    expect(block).toContain('  cycles: 2024, 2026');
    expect(block).toContain('  is_active: true');
    // Name and ID sit in the title only, not again as fields.
    expect(block).not.toContain('  name:');
    expect(block).not.toContain('  committee_id:');
  });

  it('renders an absent or empty field as absent, never as "null"', () => {
    const [block] = formatHoistedCommittee(fullCommittee('C001'));
    expect(block).not.toContain('null');
    expect(block).not.toContain('party_full');
    expect(block).not.toContain('street_2');
  });

  it('titles a record by whichever of name and ID it has', () => {
    expect(formatHoistedCommittee({ committee_id: 'C009' })).toEqual([
      '**Committee (applies to every row below):** C009',
    ]);
    expect(formatHoistedCommittee({ name: 'NO ID PAC', state: 'DC' })).toEqual([
      '**Committee (applies to every row below):** NO ID PAC\n  state: DC',
    ]);
  });
});

describe('formatCommitteeMaps', () => {
  it('renders nothing for a page without maps', () => {
    expect(formatCommitteeMaps({})).toEqual([]);
  });

  it('renders each map under a heading naming its ID, every entry once, in full', () => {
    const fairshake = trimmedFull('C00835959');
    const wa = trimmedFull('C00114439', { name: 'WA STATE DEMOCRATIC CENTRAL COMMITTEE' });
    const blocks = formatCommitteeMaps({
      recipient_committees: { C00835959: fairshake, C00114439: wa },
    });

    expect(blocks[0]).toBe(
      "**Recipient committees referenced above** — each row's recipient_committee_id names its entry:",
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[1]!.split('\n')[0]).toBe('**COMMITTEE C00835959 (C00835959)**');
    expect(blocks[2]!.split('\n')[0]).toBe('**WA STATE DEMOCRATIC CENTRAL COMMITTEE (C00114439)**');
    expectEveryField(blocks[1]!, fairshake);
    expectEveryField(blocks[2]!, wa);
    expect(occurrences(blocks.join('\n\n'), '(C00835959)')).toBe(1);
  });

  it('renders donor, recipient, then filing committees, each under its own heading', () => {
    const blocks = formatCommitteeMaps({
      committees: { C001: trimmedFull('C001') },
      recipient_committees: { C002: trimmedFull('C002') },
      contributor_committees: { C003: trimmedFull('C003') },
    });

    expect(blocks.filter((b) => b.includes('referenced above'))).toEqual([
      "**Contributor committees referenced above** — each row's contributor_id names its entry:",
      "**Recipient committees referenced above** — each row's recipient_committee_id names its entry:",
      "**Committees referenced above** — each row's committee_id names its entry:",
    ]);
  });
});

describe('committeeRenderers', () => {
  const page = { committees: { C001: trimmedFull('C001'), C002: { committee_id: 'C002' } } };

  it("names the committee in the row's ID field from its map entry", () => {
    const rendered = renderRecord(
      { committee_id: 'C001', amount: 5 },
      undefined,
      committeeRenderers(page),
    );
    expect(rendered).toBe('  committee_id: C001 (COMMITTEE C001)\n  amount: 5');
  });

  it('renders an ID with no map entry, or an entry with no name, as the bare ID', () => {
    const renderers = committeeRenderers(page);
    expect(renderRecord({ committee_id: 'C009' }, undefined, renderers)).toBe(
      '  committee_id: C009',
    );
    expect(renderRecord({ committee_id: 'C002' }, undefined, renderers)).toBe(
      '  committee_id: C002',
    );
    expect(renderRecord({ committee_id: 'constructor' }, undefined, renderers)).toBe(
      '  committee_id: constructor',
    );
  });

  it('leaves ID fields generic when the page carries no map for them', () => {
    const renderers = committeeRenderers({});
    expect(renderRecord({ recipient_committee_id: 'C001' }, undefined, renderers)).toBe(
      '  recipient_committee_id: C001',
    );
  });

  it('renders a committee record left on its row in full, as a block — never as JSON', () => {
    const record = trimmedFull('C00010603', { cycle: 2018, sponsor: { nested: 'VALUE' } });
    const rendered = renderRecord(
      { sub_id: '2', committee: record },
      undefined,
      committeeRenderers({}),
    );
    const lines = rendered.split('\n');

    expect(lines.slice(0, 3)).toEqual([
      '  sub_id: 2',
      '  committee:',
      '    COMMITTEE C00010603 (C00010603)',
    ]);
    expect(rendered).toContain('\n    cycle: 2018');
    expect(rendered).toContain('\n    treasurer_name: PHILIPCZYK, BRANDON');
    const { sponsor: _unknownShape, ...known } = record;
    expectEveryField(rendered, known);
    // A field with no known shape inside the record keeps the generic rendering.
    expect(rendered).toContain('\n    sponsor: {"nested":"VALUE"}');
    expect(rendered).not.toContain('{"committee_id"');
    expect(rendered).not.toContain('{"affiliated_committee_name"');
  });

  it.each([
    ['contributor', 'contributor_id'],
    ['recipient_committee', 'recipient_committee_id'],
    ['committee', 'committee_id'],
  ])('renders a %s record in full and declines a value that is not one', (field) => {
    const renderers = committeeRenderers({});
    expect(renderRecord({ [field]: trimmedFull('C001') }, undefined, renderers)).toContain(
      '    COMMITTEE C001 (C001)\n    affiliated_committee_name: NONE',
    );
    expect(renderRecord({ [field]: 'C00700001' }, undefined, renderers)).toBe(
      `  ${field}: C00700001`,
    );
    expect(renderRecord({ [field]: [{ name: 'PAC' }] }, undefined, renderers)).toBe(
      `  ${field}: {"name":"PAC"}`,
    );
  });

  it('titles a record carrying neither name nor ID as unknown rather than inventing one', () => {
    expect(renderRecord({ committee: { state: 'DC' } }, undefined, committeeRenderers({}))).toBe(
      '  committee:\n    Unknown\n    state: DC',
    );
  });
});
