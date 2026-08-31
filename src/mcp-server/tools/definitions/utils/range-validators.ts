/**
 * @fileoverview Shared validation for OpenFEC date and numeric range inputs.
 * @module src/mcp-server/tools/definitions/utils/range-validators
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

interface RangeValidationInput {
  maxField: string;
  maxValue: string | number | undefined;
  minField: string;
  minValue: string | number | undefined;
  valueType: 'date' | 'number';
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate each supplied bound and reject an ordered range whose minimum exceeds its maximum. */
export function validateRange({
  minField,
  minValue,
  maxField,
  maxValue,
  valueType,
}: RangeValidationInput): void {
  if (valueType === 'date') {
    for (const [field, value] of [
      [minField, minValue],
      [maxField, maxValue],
    ] as const) {
      if (value === undefined) continue;
      if (typeof value !== 'string' || !isCalendarDate(value)) {
        throw validationError(`${field} must be a valid calendar date in YYYY-MM-DD format.`, {
          reason: 'invalid_date',
          field,
          value,
          recovery: {
            hint: `Use a real calendar date for ${field} in YYYY-MM-DD format, such as 2024-06-30.`,
          },
        });
      }
    }
  }

  if (minValue !== undefined && maxValue !== undefined && minValue > maxValue) {
    throw validationError(`${minField} must be less than or equal to ${maxField}.`, {
      reason: 'invalid_range',
      min_field: minField,
      min_value: minValue,
      max_field: maxField,
      max_value: maxValue,
      recovery: {
        hint: `Use ${minField} less than or equal to ${maxField}, or omit either bound for a one-sided range.`,
      },
    });
  }
}

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
