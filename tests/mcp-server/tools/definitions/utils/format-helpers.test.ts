/**
 * @fileoverview Tests for format-helpers utilities — buildSearchCriteria,
 * formatEmptyResult, renderRecord, fmt$, and str edge cases.
 * @module tests/mcp-server/tools/definitions/utils/format-helpers.test
 */

import { describe, expect, it } from 'vitest';
import {
  buildSearchCriteria,
  fmt$,
  formatEmptyResult,
  renderRecord,
  str,
} from '@/mcp-server/tools/definitions/utils/format-helpers.js';

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
      most_recent: true,
      election_full: true,
    });
    expect(Object.keys(result)).toEqual(['query']);
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
});
