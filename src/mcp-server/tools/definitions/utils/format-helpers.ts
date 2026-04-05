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
