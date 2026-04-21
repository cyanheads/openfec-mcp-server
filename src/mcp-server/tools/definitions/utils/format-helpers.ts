/**
 * @fileoverview Shared formatting utilities for tool definition format() functions.
 * Centralizes USD formatting, safe record field access, and the pagination schema
 * reused across multiple tools.
 * @module src/mcp-server/tools/definitions/format-helpers
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Pagination and internal params excluded from search criteria echo. */
const PAGINATION_KEYS = new Set([
  'page',
  'per_page',
  'cursor',
  'from_hit',
  'hits_returned',
  'most_recent',
  'election_full',
]);

/**
 * Build a search criteria summary from tool input.
 * Strips undefined/null, empty strings, and pagination params so only
 * meaningful search filters remain.
 */
export function buildSearchCriteria(input: Record<string, unknown>): Record<string, unknown> {
  const criteria: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    if (PAGINATION_KEYS.has(key)) continue;
    criteria[key] = value;
  }
  return criteria;
}

/**
 * Render an empty-result format block with echoed search criteria and a
 * domain-specific suggestion. Used by all tool format() functions.
 */
export function formatEmptyResult(
  criteria: Record<string, unknown> | undefined,
  hint: string,
): { type: 'text'; text: string }[] {
  const lines: string[] = ['No results found.'];

  if (criteria && Object.keys(criteria).length > 0) {
    lines.push('', '**Search criteria used:**');
    for (const [key, value] of Object.entries(criteria)) {
      const display = typeof value === 'object' ? JSON.stringify(value) : String(value);
      lines.push(`  ${key}: ${display}`);
    }
  }

  lines.push('', hint);
  return [{ type: 'text', text: lines.join('\n') }];
}

/** Reusable optional search_criteria output field schema. */
export const SearchCriteriaSchema = z
  .looseObject({})
  .optional()
  .describe(
    'Echo of the search filters that produced this result set. Populated when results are empty to help diagnose why nothing matched.',
  );

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
