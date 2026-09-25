/**
 * @fileoverview Shared formatting utilities for tool definition format() functions.
 * Centralizes USD formatting, safe record field access, and the pagination schema
 * reused across multiple tools.
 * @module src/mcp-server/tools/definitions/format-helpers
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { PageResult } from '@/services/openfec/types.js';

/**
 * Pagination params excluded from the search criteria echo — they address a
 * page, they don't narrow the result set. Everything else the caller sent is a
 * filter and belongs in the echo, including query-shaping booleans such as
 * `most_recent` and `election_full`.
 */
const PAGINATION_KEYS = new Set([
  'page',
  'per_page',
  'cursor',
  'from_hit',
  'hits_returned',
  'offset',
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
 * Render a zero-result block: a headline, the resolved mode for multi-mode
 * tools, the echoed criteria, and a closing line.
 */
function formatNoRows(
  headline: string,
  criteria: Record<string, unknown> | undefined,
  closing: string,
  mode?: string,
): { type: 'text'; text: string }[] {
  const lines: string[] = [headline];

  if (mode) lines.push('', `**Mode:** ${mode}`);

  if (criteria && Object.keys(criteria).length > 0) {
    lines.push('', '**Search criteria used:**');
    for (const [key, value] of Object.entries(criteria)) {
      const display = typeof value === 'object' ? JSON.stringify(value) : String(value);
      lines.push(`  ${key}: ${display}`);
    }
  }

  lines.push('', closing);
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Render an empty-result format block with echoed search criteria and a
 * domain-specific suggestion, for a query that genuinely matched nothing. A
 * request that landed past the end of a nonzero result set uses
 * `formatExhaustedResult` instead. `mode` is the resolved query mode for
 * multi-mode tools; omit it elsewhere.
 */
export function formatEmptyResult(
  criteria: Record<string, unknown> | undefined,
  hint: string,
  mode?: string,
): { type: 'text'; text: string }[] {
  return formatNoRows('No results found.', criteria, hint, mode);
}

/**
 * A requested position that lies past the end of a result set which did match
 * rows. One variant per pagination model: page-based, keyset cursor, and the
 * `from_hit` offset legal search exposes.
 */
export type ExhaustedPosition =
  | { kind: 'page'; page: number; pages: number; count: number }
  | { kind: 'cursor'; count: number }
  | { kind: 'offset'; total_count: number };

/**
 * State an exhausted position in one line: which position ran out, the total
 * that still matched, and how to get back to readable rows. Both surfaces use
 * it — `structuredContent.notice` and the `content[]` block — so a caller
 * never sees one of them describe a zero match the other contradicts.
 */
export function describeExhaustedPosition(position: ExhaustedPosition): string {
  switch (position.kind) {
    case 'page':
      return `Page ${position.page} is past the last page of this result set — ${position.count} total across ${position.pages} page(s). Request page ${position.pages} or lower to read them.`;
    case 'cursor':
      return `This pagination cursor resumed past the last matching row — ${position.count} total matched. Omit cursor to read the result set from its first page.`;
    case 'offset':
      return `from_hit is past the end of the matching documents — ${position.total_count} total matched across the document types searched. Lower from_hit: it offsets within each document type's own list, while the total sums across types.`;
  }
}

/**
 * Decide whether a page-based response is an exhausted position rather than a
 * zero match: upstream answers 200 with an empty array, echoes the requested
 * page, and keeps `pages` and `count` correct. Returns null for a query that
 * genuinely matched nothing.
 */
export function exhaustedPage(
  pagination: { page: number; pages: number; count: number },
  rows: number,
): Extract<ExhaustedPosition, { kind: 'page' }> | null {
  if (rows > 0 || pagination.count === 0 || pagination.page <= pagination.pages) return null;
  const { page, pages, count } = pagination;
  return { kind: 'page', page, pages, count };
}

/**
 * Exhausted-position test for a schedule tool's empty output, whose itemized
 * branch paginates by keyset — a bare `count`, no page number — while its
 * aggregate branches paginate by page. A nonzero total with no rows is past the
 * end of the result set under either model: a cursor only exists once a page
 * carried rows, so the cursor that produced this page is what ran out.
 */
export function exhaustedSchedule(result: {
  count?: number | undefined;
  pagination?: { page: number; pages: number; count: number } | undefined;
}): ExhaustedPosition | null {
  if (result.pagination) return exhaustedPage(result.pagination, 0);
  if (!result.count) return null;
  return { kind: 'cursor', count: result.count };
}

/**
 * Notice for a response whose upstream count is an estimate. The framework's
 * `total` enrichment renders `**N total**` from the bare number, so this is
 * what tells the reader of `content[]` that the figure is not a tally.
 */
export const APPROXIMATE_COUNT_NOTICE =
  'The total is an upstream estimate, not a tally — treat it as an order of magnitude, not a figure to quote.';

/**
 * Render a block for a request that landed past the end of a nonzero result
 * set. Mirrors `formatEmptyResult`'s layout but names the exhausted position
 * and preserves the total instead of suggesting the search be broadened.
 */
export function formatExhaustedResult(
  criteria: Record<string, unknown> | undefined,
  position: ExhaustedPosition,
  mode?: string,
): { type: 'text'; text: string }[] {
  return formatNoRows(
    'No results at this position.',
    criteria,
    describeExhaustedPosition(position),
    mode,
  );
}

/**
 * Render the criteria echo as one compact line for non-empty responses, so the
 * markdown surface carries the same applied-filter record as structuredContent.
 * Returns null when there is nothing to echo.
 */
export function formatSearchCriteria(criteria: Record<string, unknown> | undefined): string | null {
  if (!criteria) return null;
  const parts = Object.entries(criteria).map(
    ([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
  );
  return parts.length > 0 ? `_Search criteria: ${parts.join(' · ')}_` : null;
}

/** Reusable search_criteria output field schema — always populated. */
export const SearchCriteriaSchema = z
  .looseObject({})
  .describe(
    'Echo of the search filters this call applied, as the server parsed them, minus paging arguments. Always present — compare it against what you sent to confirm every filter was honoured.',
  );

/** Format a number as USD or return 'N/A' for non-numeric values. */
export const fmt$ = (n: unknown): string =>
  typeof n === 'number' ? `$${n.toLocaleString()}` : 'N/A';

/** Safely read a string field from an untyped record. */
export const str = (rec: Record<string, unknown>, key: string): string =>
  typeof rec[key] === 'string' ? (rec[key] as string) : '';

/**
 * Reusable page-based pagination output schema.
 *
 * `count_is_approximate` is positive-polarity and present only when OpenFEC
 * declared the count inexact, so an exact count — and one whose exactness
 * upstream never declared — renders identically on both surfaces.
 */
export const PaginationSchema = z
  .object({
    page: z.number().describe('Current page number (1-indexed).'),
    pages: z.number().describe('Total number of pages.'),
    count: z.number().describe('Total result count.'),
    per_page: z.number().describe('Results per page.'),
    count_is_approximate: z
      .boolean()
      .optional()
      .describe(
        'True when OpenFEC reports this count as an estimate rather than a tally, which it does on its highest-volume datasets. Absent means the count is a tally. An estimated count — and the pages derived from it — can be off by a wide margin; treat it as an order of magnitude, not a figure to quote.',
      ),
  })
  .describe('Page-based pagination metadata.');

/**
 * The `count_is_approximate` fragment for a normalized pagination block. Only
 * an explicit upstream `is_count_exact: false` sets it: OpenFEC declares the
 * flag optional, and reading an absent one as `false` would label a tallied
 * count an estimate.
 */
export function approximateCount(pagination: { is_count_exact?: boolean }): {
  count_is_approximate?: true;
} {
  return pagination.is_count_exact === false ? { count_is_approximate: true } : {};
}

/** Map a service pagination block onto the page-based tool output shape. */
export function toPagination(
  pagination: PageResult['pagination'],
): z.infer<typeof PaginationSchema> {
  const { page, pages, count, per_page } = pagination;
  return { page, pages, count, per_page, ...approximateCount(pagination) };
}

/**
 * Render a result total. An approximate count is marked as one so it is not
 * read as a tally; an exact or undeclared count renders bare.
 */
export function fmtTotal(count: number, approximate?: boolean, unit = 'total'): string {
  return approximate ? `≈${count} ${unit} (approximate)` : `${count} ${unit}`;
}

/**
 * Renders one field with a known nested shape in place of the generic JSON
 * fallback. Returns null when the value is not the shape it knows, which hands
 * the field back to the generic rendering. A result opening with a newline is
 * a block: it starts on the line after the key rather than beside it.
 */
export type RecordFieldRenderer = (value: unknown) => string | null;

/**
 * Render all non-empty fields from a record as indented `key: value` lines.
 * Pass `skip` to exclude fields already rendered in a header line, and
 * `renderers` to give a field with a known nested shape its own rendering —
 * a renderer that declines the value leaves it on the generic path.
 */
export function renderRecord(
  rec: Record<string, unknown>,
  skip?: ReadonlySet<string>,
  renderers?: Readonly<Record<string, RecordFieldRenderer>>,
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(rec)) {
    if (skip?.has(key)) continue;
    const text = renderers?.[key]?.(value) ?? renderValue(value);
    if (text !== null) lines.push(text.startsWith('\n') ? `  ${key}:${text}` : `  ${key}: ${text}`);
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
