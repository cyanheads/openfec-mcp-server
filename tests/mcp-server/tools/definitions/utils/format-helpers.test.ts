/**
 * @fileoverview Tests for format-helpers utilities — buildSearchCriteria,
 * formatEmptyResult, renderRecord, fmt$, and str edge cases.
 * @module tests/mcp-server/tools/definitions/utils/format-helpers.test
 */

import { describe, expect, it } from 'vitest';
import {
  buildSearchCriteria,
  describeExhaustedPosition,
  exhaustedPage,
  fmt$,
  fmtTotal,
  formatEmptyResult,
  formatExhaustedResult,
  formatSearchCriteria,
  renderRecord,
  str,
  toPagination,
} from '@/mcp-server/tools/definitions/utils/format-helpers.js';
import { formatRowCommittee } from '@/mcp-server/tools/definitions/utils/trim-schedule-row.js';

describe('buildSearchCriteria', () => {
  it('includes truthy non-pagination fields', () => {
    const result = buildSearchCriteria({ query: 'Biden', state: 'DE', office: 'P' });
    expect(result).toEqual({ query: 'Biden', state: 'DE', office: 'P' });
  });

  it('strips undefined values', () => {
    const result = buildSearchCriteria({ query: 'Biden', state: undefined });
    expect(result).toEqual({ query: 'Biden' });
    expect(Object.keys(result)).not.toContain('state');
  });

  it('strips null values', () => {
    const result = buildSearchCriteria({ query: 'Biden', cycle: null });
    expect(Object.keys(result)).not.toContain('cycle');
  });

  it('strips empty string values', () => {
    const result = buildSearchCriteria({ query: '', state: 'CA' });
    expect(Object.keys(result)).not.toContain('query');
    expect(result.state).toBe('CA');
  });

  it('strips pagination keys', () => {
    const result = buildSearchCriteria({
      query: 'test',
      page: 2,
      per_page: 20,
      cursor: 'abc',
      from_hit: 0,
      hits_returned: 20,
    });
    expect(Object.keys(result)).toEqual(['query']);
  });

  it('strips the legal detail entry offset but keeps the array it pages', () => {
    const result = buildSearchCriteria({
      doc_type: 'murs',
      no: '6916',
      array: 'dispositions',
      offset: 227,
    });
    expect(result).toEqual({ doc_type: 'murs', no: '6916', array: 'dispositions' });
  });

  it('keeps query-shaping booleans that narrow the result set', () => {
    const result = buildSearchCriteria({ most_recent: false, election_full: true, page: 2 });
    expect(result).toEqual({ most_recent: false, election_full: true });
  });

  it('keeps the requested mode so the echo records which query was asked for', () => {
    expect(buildSearchCriteria({ mode: 'by_state' }).mode).toBe('by_state');
  });

  it('returns empty object for all-stripped input', () => {
    const result = buildSearchCriteria({ page: 1, per_page: 20 });
    expect(result).toEqual({});
  });

  it('preserves boolean false values', () => {
    const result = buildSearchCriteria({ has_raised_funds: false });
    expect(result.has_raised_funds).toBe(false);
  });

  it('preserves numeric zero', () => {
    const result = buildSearchCriteria({ district_number: 0 });
    expect(result.district_number).toBe(0);
  });
});

describe('formatEmptyResult', () => {
  it('returns "No results found." when no criteria', () => {
    const blocks = formatEmptyResult(undefined, 'Try broadening your search.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.text).toContain('No results found.');
  });

  it('includes hint text', () => {
    const blocks = formatEmptyResult({}, 'Check the spelling of the name.');
    expect(blocks[0]!.text).toContain('Check the spelling of the name.');
  });

  it('includes search criteria when present', () => {
    const blocks = formatEmptyResult({ state: 'CA', office: 'P' }, 'Try a different state.');
    const text = blocks[0]!.text;
    expect(text).toContain('**Search criteria used:**');
    expect(text).toContain('state: CA');
    expect(text).toContain('office: P');
  });

  it('does not show Search criteria section for empty criteria object', () => {
    const blocks = formatEmptyResult({}, 'Hint.');
    expect(blocks[0]!.text).not.toContain('Search criteria used');
  });

  it('JSON-serializes object values in criteria', () => {
    const blocks = formatEmptyResult({ filters: { a: 1 } }, 'Hint.');
    expect(blocks[0]!.text).toContain('{"a":1}');
  });

  it('renders the resolved mode when one is supplied', () => {
    const blocks = formatEmptyResult({ state: 'CA' }, 'Hint.', 'by_state');
    expect(blocks[0]!.text).toContain('**Mode:** by_state');
  });

  it('omits the mode line for single-mode tools', () => {
    expect(formatEmptyResult({ state: 'CA' }, 'Hint.')[0]!.text).not.toContain('**Mode:**');
  });
});

describe('exhaustedPage', () => {
  it('reports a page past the last one when the total is nonzero', () => {
    expect(exhaustedPage({ page: 2, pages: 1, count: 1 }, 0)).toEqual({
      kind: 'page',
      page: 2,
      pages: 1,
      count: 1,
    });
  });

  it('returns null when the page carries rows', () => {
    expect(exhaustedPage({ page: 1, pages: 3, count: 50 }, 20)).toBeNull();
  });

  it('returns null for a genuine zero match, however high the page', () => {
    expect(exhaustedPage({ page: 99, pages: 0, count: 0 }, 0)).toBeNull();
  });

  it('returns null on the last page itself', () => {
    expect(exhaustedPage({ page: 3, pages: 3, count: 50 }, 0)).toBeNull();
  });
});

describe('describeExhaustedPosition', () => {
  it('names the page, the surviving total, and the last valid page', () => {
    const text = describeExhaustedPosition({ kind: 'page', page: 2, pages: 1, count: 1 });
    expect(text).toContain('Page 2');
    expect(text).toContain('1 total');
    expect(text).toContain('page 1');
  });

  it('reports a spent cursor and keeps the total', () => {
    const text = describeExhaustedPosition({ kind: 'cursor', count: 1 });
    expect(text).toContain('cursor');
    expect(text).toContain('1 total');
    expect(text).toContain('Omit cursor');
  });

  it('names from_hit and keeps the total for an offset past the end', () => {
    const text = describeExhaustedPosition({ kind: 'offset', total_count: 7670 });
    expect(text).toContain('from_hit');
    expect(text).toContain('7670 total');
  });

  it('never suggests broadening the search', () => {
    for (const position of [
      { kind: 'page', page: 2, pages: 1, count: 1 },
      { kind: 'cursor', count: 1 },
      { kind: 'offset', total_count: 9 },
    ] as const) {
      expect(describeExhaustedPosition(position).toLowerCase()).not.toContain('broaden');
    }
  });
});

describe('formatExhaustedResult', () => {
  it('states the position instead of reporting no match', () => {
    const text = formatExhaustedResult(
      { query: 'BIDEN' },
      {
        kind: 'page',
        page: 2,
        pages: 1,
        count: 1,
      },
    )[0]!.text;

    expect(text).toContain('No results at this position.');
    expect(text).not.toContain('No results found.');
    expect(text).toContain('1 total');
  });

  it('echoes the search criteria', () => {
    const text = formatExhaustedResult({ state: 'CA' }, { kind: 'cursor', count: 4 })[0]!.text;
    expect(text).toContain('**Search criteria used:**');
    expect(text).toContain('state: CA');
  });

  it('renders the resolved mode when one is supplied', () => {
    const text = formatExhaustedResult({}, { kind: 'cursor', count: 4 }, 'itemized')[0]!.text;
    expect(text).toContain('**Mode:** itemized');
  });

  it('omits the mode line for single-mode tools', () => {
    const text = formatExhaustedResult({}, { kind: 'offset', total_count: 4 })[0]!.text;
    expect(text).not.toContain('**Mode:**');
  });
});

describe('fmtTotal', () => {
  it('renders a bare total when the count is exact', () => {
    expect(fmtTotal(47, false)).toBe('47 total');
  });

  it('renders a bare total when exactness is unknown', () => {
    expect(fmtTotal(47)).toBe('47 total');
  });

  it('marks an approximate count', () => {
    expect(fmtTotal(2_623_224, true)).toBe('≈2623224 total (approximate)');
  });

  it('takes a caller-supplied unit', () => {
    expect(fmtTotal(9, false, 'result(s)')).toBe('9 result(s)');
    expect(fmtTotal(9, true, 'result(s)')).toBe('≈9 result(s) (approximate)');
  });
});

describe('toPagination', () => {
  it('flags an inexact count as approximate', () => {
    expect(
      toPagination({ page: 1, pages: 2, count: 2_623_224, per_page: 1, is_count_exact: false }),
    ).toEqual({
      page: 1,
      pages: 2,
      count: 2_623_224,
      per_page: 1,
      count_is_approximate: true,
    });
  });

  it('carries no flag for an exact count', () => {
    expect(
      toPagination({ page: 1, pages: 1, count: 3, per_page: 20, is_count_exact: true }),
    ).toStrictEqual({ page: 1, pages: 1, count: 3, per_page: 20 });
  });

  it('carries no flag when upstream declared no exactness', () => {
    expect(toPagination({ page: 1, pages: 1, count: 3, per_page: 20 })).toStrictEqual({
      page: 1,
      pages: 1,
      count: 3,
      per_page: 20,
    });
  });
});

describe('formatSearchCriteria', () => {
  it('renders one compact line of key=value pairs', () => {
    expect(formatSearchCriteria({ committee_id: 'C00703975', cycle: 2024 })).toBe(
      '_Search criteria: committee_id=C00703975 · cycle=2024_',
    );
  });

  it('returns null for an empty criteria object', () => {
    expect(formatSearchCriteria({})).toBeNull();
  });

  it('returns null when criteria are absent', () => {
    expect(formatSearchCriteria(undefined)).toBeNull();
  });

  it('JSON-serializes object values', () => {
    expect(formatSearchCriteria({ filters: { a: 1 } })).toContain('filters={"a":1}');
  });
});

describe('fmt$', () => {
  it('formats a positive integer', () => {
    expect(fmt$(1_000_000)).toBe('$1,000,000');
  });

  it('formats zero', () => {
    expect(fmt$(0)).toBe('$0');
  });

  it('returns N/A for undefined', () => {
    expect(fmt$(undefined)).toBe('N/A');
  });

  it('returns N/A for null', () => {
    expect(fmt$(null)).toBe('N/A');
  });

  it('returns N/A for a string', () => {
    expect(fmt$('100')).toBe('N/A');
  });

  it('formats NaN as $NaN (typeof NaN === "number" passes the type check)', () => {
    // NaN passes the `typeof n === 'number'` guard in fmt$, so it renders as '$NaN'.
    // Callers should not pass NaN; this documents the actual behavior.
    expect(fmt$(NaN)).toBe('$NaN');
  });

  it('formats a negative number', () => {
    const result = fmt$(-500);
    expect(result).toBe('$-500');
  });
});

describe('str', () => {
  it('returns the string value for a matching key', () => {
    expect(str({ name: 'Alice' }, 'name')).toBe('Alice');
  });

  it('returns empty string for missing key', () => {
    expect(str({}, 'name')).toBe('');
  });

  it('returns empty string for numeric value', () => {
    expect(str({ count: 42 }, 'count')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(str({ id: null }, 'id')).toBe('');
  });

  it('returns empty string for boolean', () => {
    expect(str({ flag: true }, 'flag')).toBe('');
  });
});

describe('renderRecord', () => {
  it('renders key-value pairs as indented lines', () => {
    const result = renderRecord({ state: 'CA', office: 'P' });
    expect(result).toContain('  state: CA');
    expect(result).toContain('  office: P');
  });

  it('skips keys in the skip set', () => {
    const result = renderRecord(
      { name: 'Alice', candidate_id: 'P00000001' },
      new Set(['candidate_id']),
    );
    expect(result).toContain('  name: Alice');
    expect(result).not.toContain('candidate_id');
  });

  it('skips null values', () => {
    const result = renderRecord({ name: 'Alice', party: null });
    expect(result).not.toContain('party');
    expect(result).toContain('  name: Alice');
  });

  it('skips undefined values', () => {
    const result = renderRecord({ name: 'Alice', office: undefined });
    expect(result).not.toContain('office');
  });

  it('skips empty string values', () => {
    const result = renderRecord({ name: 'Alice', district: '' });
    expect(result).not.toContain('district');
  });

  it('renders boolean values', () => {
    const result = renderRecord({ is_amended: false, is_current: true });
    expect(result).toContain('  is_amended: false');
    expect(result).toContain('  is_current: true');
  });

  it('renders numeric values', () => {
    const result = renderRecord({ receipts: 100000, count: 0 });
    expect(result).toContain('  receipts: 100000');
    expect(result).toContain('  count: 0');
  });

  it('renders arrays as comma-joined lists', () => {
    const result = renderRecord({ cycles: [2020, 2022, 2024] });
    expect(result).toContain('  cycles: 2020, 2022, 2024');
  });

  it('skips empty arrays', () => {
    const result = renderRecord({ cycles: [] });
    expect(result).not.toContain('cycles');
  });

  it('JSON-serializes array items that are objects', () => {
    const result = renderRecord({ items: [{ a: 1 }] });
    expect(result).toContain('{"a":1}');
  });

  it('JSON-serializes object values', () => {
    const result = renderRecord({ meta: { source: 'fec' } });
    expect(result).toContain('{"source":"fec"}');
  });

  it('returns empty string for all-skipped/empty record', () => {
    const result = renderRecord({ a: null, b: undefined, c: '' });
    expect(result).toBe('');
  });

  it('handles unicode in values', () => {
    const result = renderRecord({ name: 'Ñoño, José 💰' });
    expect(result).toContain('Ñoño, José 💰');
  });

  it('applies a field renderer to a plain-object value under its key', () => {
    const result = renderRecord({ committee: { name: 'PAC' } }, undefined, {
      committee: formatRowCommittee,
    });
    expect(result).toBe('  committee: PAC');
  });

  it('falls back to the generic rendering when the value is not the renderer shape', () => {
    const renderers = { committee: formatRowCommittee };
    expect(renderRecord({ committee: [{ name: 'PAC' }] }, undefined, renderers)).toBe(
      '  committee: {"name":"PAC"}',
    );
    expect(renderRecord({ committee: 'C00000001' }, undefined, renderers)).toBe(
      '  committee: C00000001',
    );
    expect(renderRecord({ committee: null }, undefined, renderers)).toBe('');
  });

  it('applies an array-valued renderer and falls back when it declines the value', () => {
    const renderers = {
      tags: (value: unknown) =>
        Array.isArray(value) && value.every((v) => typeof v === 'string')
          ? value.join(' | ')
          : null,
    };
    expect(renderRecord({ tags: ['a', 'b'] }, undefined, renderers)).toBe('  tags: a | b');
    expect(renderRecord({ tags: [{ a: 1 }] }, undefined, renderers)).toBe('  tags: {"a":1}');
  });

  it('opens a block value on the line after its key', () => {
    const renderers = { votes: () => '\n    - first\n    - second' };
    expect(renderRecord({ votes: [1] }, undefined, renderers)).toBe(
      '  votes:\n    - first\n    - second',
    );
  });
});
