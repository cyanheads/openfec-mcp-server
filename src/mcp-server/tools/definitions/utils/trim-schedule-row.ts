/**
 * @fileoverview Payload shaping for the high-volume page tools. OpenFEC embeds
 * a full ~40-field committee object in every itemized Schedule A/B/E/F row;
 * when the query is scoped to a single committee that object is identical
 * across the page, so it is hoisted out once instead of being shipped per row.
 * Every itemized and filing row also sheds its null and empty fields, and each
 * tool caps the page size it requests upstream so a full page stays inside the
 * per-surface response budget.
 * @module src/mcp-server/tools/definitions/utils/trim-schedule-row
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { isRecord } from '@cyanheads/mcp-ts-core/utils';
import { APPROXIMATE_COUNT_NOTICE } from './format-helpers.js';

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

/** A value that carries no information: null, undefined, '', [], or {}. */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

/** Clean one value: records recursively, records inside arrays in place, scalars as-is. */
function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (isRecord(item) ? dropEmptyFields(item) : item));
  }
  return isRecord(value) ? dropEmptyFields(value) : value;
}

/**
 * Drop every field that carries no information — null, undefined, '', [], and
 * a nested record left with nothing once its own empties are gone — at every
 * depth. Lossless: an absent field and a null one say the same thing, and
 * `false` and `0` are kept as the facts they are. Array elements are never
 * removed, since their positions can carry meaning. Returns a new record.
 */
export function dropEmptyFields(record: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const next = cleanValue(value);
    if (!isEmptyValue(next)) cleaned[key] = next;
  }
  return cleaned;
}

/**
 * Hoist the shared committee object out of itemized schedule rows, drop
 * duplicated sub-objects, and drop empty fields at every depth. The hoist
 * requires both a single-committee query scope and agreement across the
 * returned rows; when either fails the rows are returned with their own
 * committee object intact.
 */
export function trimScheduleRows(
  sourceRows: readonly Record<string, unknown>[],
  options: TrimScheduleRowsOptions,
): TrimmedSchedulePage {
  const drop = options.drop ?? [];
  const rows = sourceRows.map(dropEmptyFields);
  const committees = rows.map((row) => (isRecord(row.committee) ? row.committee : undefined));
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

/**
 * The two parts every committee rendering shares: a `NAME (ID)` title and one
 * attribute line (type, designation, party, state, treasurer), empty when
 * upstream recorded none of them.
 */
function summarizeCommittee(committee: Record<string, unknown>): { title: string; detail: string } {
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
  return { title: `${String(name)}${id}`, detail };
}

/** Render the hoisted committee as a short header block for format(). */
export function formatHoistedCommittee(committee: Record<string, unknown> | undefined): string[] {
  if (!committee) return [];
  const { title, detail } = summarizeCommittee(committee);
  const header = `**Committee (applies to every row below):** ${title}`;
  return detail ? [`${header}\n  ${detail}`] : [header];
}

/**
 * Render a committee record left nested in a row — the spender on a page that
 * spans several committees, or a donor or recipient that is itself a
 * committee — as its title plus one attribute line, a `renderRecord` field
 * renderer. The full
 * record stays on `structuredContent`; the text surface carries what tells the
 * rows apart.
 */
export function formatRowCommittee(committee: Record<string, unknown>): string {
  const { title, detail } = summarizeCommittee(committee);
  return detail ? `${title}\n    ${detail}` : title;
}

/* ------------------------------------------------------------------ */
/*  Page-size budget                                                  */
/* ------------------------------------------------------------------ */

/**
 * Bytes each response surface — `structuredContent` and `content[]`,
 * independently — is sized to stay under at a tool's largest effective page.
 */
export const RESPONSE_BUDGET_BYTES = 100_000;

/**
 * The largest `per_page` each high-volume tool sends upstream, per scope. Each
 * is the largest multiple of 5 for which a page of the heaviest row measured
 * live in that scope stays within {@link RESPONSE_BUDGET_BYTES} on both
 * surfaces, and a page at the heaviest measured per-row average stays within
 * 90% of it. The schema-declared `per_page` maximum stays 100 — the cap lowers
 * only what is requested upstream, so no fetched row is ever discarded.
 * Measurements and method: docs/design.md, decision 16.
 */
export const PER_PAGE_CAPS = {
  /** Always one receiving committee; donor-as-committee rows carry a ~1KB contributor record. */
  contributions: 30,
  /** Always one spending committee; transfer rows carry a ~1KB recipient_committee record. */
  disbursements: 30,
  expenditures: { committeeScoped: 60, perRowCommittee: 30 },
  coordinatedExpenditures: { committeeScoped: 80, perRowCommittee: 25 },
  filings: 65,
  /**
   * With totals, one candidate brings one totals row per cycle it filed in —
   * one row when the totals are scoped to a cycle or election year, up to
   * twenty across every cycle for a long-serving incumbent.
   */
  candidatesWithTotals: { oneCycle: 35, allCycles: 5 },
} as const;

/**
 * Enrichment fields that disclose a page the cap bounded below the caller's
 * `per_page`. Spread into a tool's `enrichment` block; populated by
 * {@link disclosePageBound}.
 */
export const PageBoundEnrichment = {
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True when this page holds fewer rows than the per_page requested because a full page would exceed the 100,000-byte response budget, and more rows remain. Absent on a complete page, including a naturally short last page.',
    ),
  shown: z.number().optional().describe('Rows in this page. Present only when truncated is true.'),
  cap: z
    .number()
    .optional()
    .describe(
      'The per_page this call applied in place of the one requested — the page-size ceiling for this tool and scope. Present only when truncated is true.',
    ),
};

/** `content[]` trailer labels for {@link PageBoundEnrichment} — `enrichmentTrailer` on each tool. */
export const PageBoundTrailer = {
  truncated: { label: 'Page bounded below per_page requested' },
  shown: { label: 'Rows in this page' },
  cap: { label: 'per_page applied' },
};

/** How the tool paginates, carrying the upstream state that says whether rows remain. */
export type PageContinuation =
  | { kind: 'cursor'; nextCursor: string | null }
  | { kind: 'page'; pagination: { page: number; pages: number } };

/**
 * Disclose a page the `per_page` cap bounded below the caller's request —
 * `truncated`, `shown`, `cap`, and a notice naming the continuation — when rows
 * remain past it. A page the cap did not bound, and a last page, disclose
 * nothing: those are complete. Call it after any other notice the response
 * sets; an estimated total is restated here since notices are last-wins.
 */
export function disclosePageBound(
  ctx: Context,
  bound: {
    /** The per_page the caller asked for. */
    requested: number;
    /** The per_page sent upstream. */
    applied: number;
    /** Rows in the page. */
    shown: number;
    continuation: PageContinuation;
    /** Whether upstream reported the total as an estimate. */
    approximate?: boolean;
  },
): void {
  const { continuation } = bound;
  const hasMore =
    continuation.kind === 'cursor'
      ? continuation.nextCursor !== null
      : continuation.pagination.page < continuation.pagination.pages;
  if (bound.applied >= bound.requested || !hasMore) return;
  const next =
    continuation.kind === 'cursor'
      ? 'Pass next_cursor to continue.'
      : `Pages are counted at per_page ${bound.applied}, as pagination.per_page reports: request page ${continuation.pagination.page + 1} to continue.`;
  const guidance = [
    `Page bounded to ${bound.applied} rows, below the ${bound.requested} requested: a full page from this tool and scope would exceed the 100,000-byte response budget. ${next} Nothing is skipped.`,
    ...(bound.approximate ? [APPROXIMATE_COUNT_NOTICE] : []),
  ].join(' ');
  ctx.enrich.truncated({ shown: bound.shown, cap: bound.applied, guidance });
}
