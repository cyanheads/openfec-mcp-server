/**
 * @fileoverview Tests for the itemized schedule row trimmer — committee hoist
 * scope rules, dropped sub-objects, and the hoisted-committee renderer.
 * @module tests/mcp-server/tools/definitions/utils/trim-schedule-row.test
 */

import { describe, expect, it } from 'vitest';
import {
  formatHoistedCommittee,
  trimScheduleRows,
} from '@/mcp-server/tools/definitions/utils/trim-schedule-row.js';

const committee = (id: string) => ({
  committee_id: id,
  name: `COMMITTEE ${id}`,
  committee_type_full: 'Super PAC',
  treasurer_name: 'DOE, JANE',
  party_full: null,
});

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

    expect(hoisted).toEqual(committee('C001'));
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
    expect(results[0]!.committee).toEqual(committee('C001'));
    expect(results[1]!.committee).toEqual(committee('C002'));
  });

  it('refuses to hoist when the rows disagree on the committee, even if asked to', () => {
    const { results, committee: hoisted } = trimScheduleRows([row('C001'), row('C002')], {
      hoistCommittee: true,
    });

    expect(hoisted).toBeUndefined();
    expect(results[0]!.committee).toEqual(committee('C001'));
    expect(results[1]!.committee).toEqual(committee('C002'));
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
