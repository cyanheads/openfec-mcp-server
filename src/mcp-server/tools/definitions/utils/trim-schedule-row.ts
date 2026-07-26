/**
 * @fileoverview Payload shaping for itemized Schedule A/B/E rows. OpenFEC embeds
 * a full ~40-field committee object in every row; when the query is scoped to a
 * single committee that object is identical across the page, so it is hoisted
 * out once instead of being shipped per row.
 * @module src/mcp-server/tools/definitions/utils/trim-schedule-row
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Narrow an unknown row field to a plain object, or undefined when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface TrimScheduleRowsOptions {
  /** Row keys to delete outright — sub-objects fully covered by a flat field. */
  drop?: readonly string[];
  /**
   * Whether the caller scoped the query to one committee_id. Hoisting is only
   * correct then — an unscoped Schedule E query spans several committees, and
   * lifting one of them to the top level would misattribute the other rows.
   */
  hoistCommittee: boolean;
}

export interface TrimmedSchedulePage {
  /** The shared committee, present only when it was hoisted out of every row. */
  committee?: Record<string, unknown>;
  results: Record<string, unknown>[];
}

/**
 * Hoist the shared committee object out of itemized schedule rows and drop
 * duplicated sub-objects. The hoist requires both a single-committee query
 * scope and agreement across the returned rows; when either fails the rows are
 * returned with their own committee object intact.
 */
export function trimScheduleRows(
  rows: readonly Record<string, unknown>[],
  options: TrimScheduleRowsOptions,
): TrimmedSchedulePage {
  const drop = options.drop ?? [];
  const committees = rows.map((row) => asRecord(row.committee));
  const ids = new Set(committees.map((committee) => committee?.committee_id ?? null));
  const first = committees[0];
  const shared =
    options.hoistCommittee && first !== undefined && ids.size === 1 && !ids.has(null)
      ? first
      : undefined;

  const results = rows.map((row) => {
    const trimmed: Record<string, unknown> = { ...row };
    if (shared) delete trimmed.committee;
    for (const key of drop) delete trimmed[key];
    return trimmed;
  });

  return shared ? { results, committee: shared } : { results };
}

/** Reusable output field for the hoisted committee. */
export const HoistedCommitteeSchema = z
  .looseObject({})
  .optional()
  .describe(
    'The committee every row in this response belongs to, carried once instead of repeated in each row. Present only when the query was scoped to a single committee_id; otherwise each row keeps its own committee object.',
  );

/** Render the hoisted committee as a short header block for format(). */
export function formatHoistedCommittee(committee: Record<string, unknown> | undefined): string[] {
  if (!committee) return [];
  const name = committee.name ?? committee.committee_id ?? 'Unknown';
  const id = committee.committee_id ? ` (${String(committee.committee_id)})` : '';
  const detail = [
    committee.committee_type_full,
    committee.designation_full,
    committee.party_full,
    committee.state,
    committee.treasurer_name ? `Treasurer: ${String(committee.treasurer_name)}` : undefined,
  ]
    .filter((v) => typeof v === 'string' && v !== '')
    .join(' · ');
  const header = `**Committee (applies to every row below):** ${String(name)}${id}`;
  return detail ? [`${header}\n  ${detail}`] : [header];
}
