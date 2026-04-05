/**
 * @fileoverview Shared formatting utilities for tool definition format() functions.
 * Centralizes USD formatting, safe record field access, and the pagination schema
 * reused across multiple tools.
 * @module src/mcp-server/tools/definitions/format-helpers
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Format a number as USD or return 'N/A' for non-numeric values. */
export const fmt$ = (n: unknown): string =>
  typeof n === 'number' ? `$${n.toLocaleString()}` : 'N/A';

/** Safely read a string field from an untyped record. */
export const str = (rec: Record<string, unknown>, key: string): string =>
  typeof rec[key] === 'string' ? (rec[key] as string) : '';

/** Reusable page-based pagination output schema. */
export const PaginationSchema = z.object({
  page: z.number().describe('Current page number (1-indexed).'),
  pages: z.number().describe('Total number of pages.'),
  count: z.number().describe('Total result count.'),
  per_page: z.number().describe('Results per page.'),
});

/**
 * Render all non-empty fields from a record as indented `key: value` lines.
 * Pass `skip` to exclude fields already rendered in a header line.
 */
export function renderRecord(rec: Record<string, unknown>, skip?: ReadonlySet<string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(rec)) {
    if (skip?.has(key)) continue;
    const text = renderValue(value);
    if (text !== null) lines.push(`  ${key}: ${text}`);
  }
  return lines.join('\n');
}

/** Format a single value for display. Returns null for empty/null/undefined. */
function renderValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value
      .map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)))
      .join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
