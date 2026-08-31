/**
 * @fileoverview Tests for shared date-shape and ordered-range validation.
 * @module tests/mcp-server/tools/definitions/utils/range-validators.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { validateRange } from '@/mcp-server/tools/definitions/utils/range-validators.js';

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

describe('validateRange', () => {
  it.each([
    ['date', '2024-06-30', '2024-06-30'],
    ['number', 100, 100],
  ] as const)('accepts equal %s bounds', (valueType, minValue, maxValue) => {
    expect(() =>
      validateRange({
        minField: 'minimum',
        minValue,
        maxField: 'maximum',
        maxValue,
        valueType,
      }),
    ).not.toThrow();
  });

  it.each([
    ['date', '2024-01-01', undefined],
    ['date', undefined, '2024-12-31'],
    ['number', 0, undefined],
    ['number', undefined, 0],
  ] as const)('accepts a one-sided %s range', (valueType, minValue, maxValue) => {
    expect(() =>
      validateRange({
        minField: 'minimum',
        minValue,
        maxField: 'maximum',
        maxValue,
        valueType,
      }),
    ).not.toThrow();
  });

  it.each(['06/30/2024', '2024-02-30'])('rejects malformed date %s with recovery', (value) => {
    const error = capture(() =>
      validateRange({
        minField: 'min_date',
        minValue: value,
        maxField: 'max_date',
        maxValue: undefined,
        valueType: 'date',
      }),
    );

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_date',
      field: 'min_date',
      value,
      recovery: { hint: expect.any(String) },
    });
  });

  it.each([
    ['date', '2024-12-31', '2024-01-01'],
    ['number', 101, 100],
  ] as const)('rejects an inverted %s range with both bounds', (valueType, minValue, maxValue) => {
    const error = capture(() =>
      validateRange({
        minField: 'minimum',
        minValue,
        maxField: 'maximum',
        maxValue,
        valueType,
      }),
    );

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_range',
      min_field: 'minimum',
      min_value: minValue,
      max_field: 'maximum',
      max_value: maxValue,
      recovery: { hint: expect.any(String) },
    });
  });
});
