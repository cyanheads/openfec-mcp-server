/**
 * @fileoverview Payload shaping for the high-volume page tools. OpenFEC embeds
 * a full committee record (26–38 fields) in itemized Schedule A/B/E/F rows —
 * the filing committee on every row, and on some rows a donor or recipient
 * that is itself a committee. Each record is carried once per page instead of
 * once per row: the committee a single-committee query is scoped to is hoisted
 * to the top level, and the rest move into page-level maps keyed by the flat ID
 * the row already carries. Both surfaces carry every record whole. Every
 * itemized and filing row also sheds its null and empty fields. Shaping changes
 * what a row carries, never how many rows a page holds: the caller's
 * `per_page` is the page.
 * @module src/mcp-server/tools/definitions/utils/trim-schedule-row
 */

import { z } from '@cyanheads/mcp-ts-core';
import { isRecord } from '@cyanheads/mcp-ts-core/utils';
import { type RecordFieldRenderer, renderRecord } from './format-helpers.js';

type Row = Record<string, unknown>;

/** Output key of a page-level committee map. */
export type CommitteeMapKey = 'committees' | 'contributor_committees' | 'recipient_committees';

/**
 * A page's committee maps: each referenced ID → the one record rows with that
 * ID share. Accepts `undefined` members so a tool's parsed output passes as is.
 */
export type CommitteeMaps = { [K in CommitteeMapKey]?: Record<string, Row> | undefined };

/** A nested committee record rows may carry, the flat ID naming it, and the map it moves into. */
export interface CommitteeMapSpec {
  /** Row key of the nested record. */
  readonly field: string;
  /** Row key of the flat ID that names the record. */
  readonly idKey: string;
  /** Heading the map renders under in `content[]`. */
  readonly label: string;
  /** Output key of the page-level map. */
  readonly mapKey: CommitteeMapKey;
}

/** The filing committee — Schedule E/F spenders, or Schedule A recipients on a donor-scoped page. */
export const COMMITTEES = {
  field: 'committee',
  idKey: 'committee_id',
  label: 'Committees',
  mapKey: 'committees',
} as const satisfies CommitteeMapSpec;

/** Schedule A: a donor that is itself a registered committee. */
export const CONTRIBUTOR_COMMITTEES = {
  field: 'contributor',
  idKey: 'contributor_id',
  label: 'Contributor committees',
  mapKey: 'contributor_committees',
} as const satisfies CommitteeMapSpec;

/** Schedule B: a payee that is itself a registered committee. */
export const RECIPIENT_COMMITTEES = {
  field: 'recipient_committee',
  idKey: 'recipient_committee_id',
  label: 'Recipient committees',
  mapKey: 'recipient_committees',
} as const satisfies CommitteeMapSpec;

/** Every map, in the order `content[]` renders them. */
const MAP_SPECS: readonly CommitteeMapSpec[] = [
  CONTRIBUTOR_COMMITTEES,
  RECIPIENT_COMMITTEES,
  COMMITTEES,
];

export interface TrimScheduleRowsOptions {
  /**
   * Nested committee records to move off the rows into page-level maps. The
   * filing committee's spec is skipped on a page whose committee was hoisted.
   */
  collect?: readonly CommitteeMapSpec[];
  /** Row keys to delete outright — sub-objects fully covered by a flat field. */
  drop?: readonly string[];
  /**
   * Whether the caller scoped the query to one committee_id. Hoisting is only
   * correct then — an unscoped Schedule E query spans several committees, and
   * lifting one of them to the top level would misattribute the other rows.
   */
  hoistCommittee: boolean;
}

export interface TrimmedSchedulePage extends CommitteeMaps {
  /** The shared committee, present only when it was hoisted out of the rows. */
  committee?: Row;
  results: Row[];
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
 * Lift the record most of `rows` carry under `field` — the first seen on a
 * tie — off every row carrying an identical copy, and return it. One committee
 * ID can carry different records on a page that spans cycles, each that
 * committee's filing history for the row's own cycle; rows carrying a record
 * other than the one lifted keep theirs. Records from one upstream response
 * serialize their keys in one order, so equal JSON is equal content.
 */
function liftPrevailing(rows: readonly Row[], field: string): Row {
  const counts = new Map<string, number>();
  const serialized = rows.map((row) => {
    const json = JSON.stringify(row[field]);
    counts.set(json, (counts.get(json) ?? 0) + 1);
    return json;
  });
  let prevailing = serialized[0] as string;
  for (const [json, n] of counts) if (n > (counts.get(prevailing) ?? 0)) prevailing = json;
  const record = rows[serialized.indexOf(prevailing)]?.[field] as Row;
  rows.forEach((row, i) => {
    if (serialized[i] === prevailing) delete row[field];
  });
  return record;
}

/** Whether every row carries a committee record naming one shared committee ID. */
function namesOneCommittee(rows: readonly Row[]): boolean {
  const first = rows[0]?.committee;
  if (!isRecord(first) || first.committee_id == null) return false;
  return rows.every(
    (row) => isRecord(row.committee) && row.committee.committee_id === first.committee_id,
  );
}

/**
 * Move each row's `spec.field` record into a map keyed by the row's own
 * `spec.idKey`, when that ID names the record: each ID's entry is the record
 * most of its rows carry. A record that differs from its ID's entry, or whose
 * row carries no matching ID, stays on its row. Returns undefined when nothing
 * moved.
 */
function collectRecords(
  rows: readonly Row[],
  spec: CommitteeMapSpec,
): Record<string, Row> | undefined {
  const byId = new Map<string, Row[]>();
  for (const row of rows) {
    const record = row[spec.field];
    const id = row[spec.idKey];
    if (!isRecord(record) || typeof id !== 'string' || record.committee_id !== id) continue;
    const group = byId.get(id);
    if (group) group.push(row);
    else byId.set(id, [row]);
  }
  if (byId.size === 0) return undefined;
  const map: Record<string, Row> = Object.create(null);
  for (const [id, group] of byId) map[id] = liftPrevailing(group, spec.field);
  return map;
}

/**
 * Drop empty fields at every depth and duplicated sub-objects, hoist the
 * shared committee, and move the remaining nested committee records into
 * page-level maps. The hoist requires both a single-committee query scope and
 * one committee ID across the returned rows; it lifts the record most rows
 * carry, and a row whose record differs keeps its own. Never mutates its
 * input.
 */
export function trimScheduleRows(
  sourceRows: readonly Record<string, unknown>[],
  options: TrimScheduleRowsOptions,
): TrimmedSchedulePage {
  const results = sourceRows.map(dropEmptyFields);
  for (const row of results) for (const key of options.drop ?? []) delete row[key];

  const page: TrimmedSchedulePage = { results };
  const hoisted = options.hoistCommittee && namesOneCommittee(results);
  if (hoisted) page.committee = liftPrevailing(results, COMMITTEES.field);

  for (const spec of options.collect ?? []) {
    if (hoisted && spec.field === COMMITTEES.field) continue;
    const map = collectRecords(results, spec);
    if (map) page[spec.mapKey] = map;
  }
  return page;
}

/** Reusable output field for the hoisted committee. */
export const HoistedCommitteeSchema = z
  .looseObject({})
  .optional()
  .describe(
    "The committee every row in this response belongs to, carried once in full instead of repeated in each row. Present only when the query was scoped to a single committee_id. A row whose committee record differs from this one — the same committee's record for another cycle — keeps its own.",
  );

/**
 * Reusable output field for a page-level committee map. Each tool overrides the
 * description to name the row field and ID it collects.
 */
export const CommitteeMapSchema = z
  .record(
    z.string().describe('The committee ID the rows carry.'),
    z
      .looseObject({})
      .describe(
        'The committee record as OpenFEC files it for the cycle: name, type, designation, party, address, treasurer, filing frequency, file dates, and the cycles it was active.',
      ),
  )
  .optional()
  .describe(
    "Committee records the rows reference, keyed by the ID each row carries: every distinct committee once, in full, instead of a copy on each row. A row whose record differs from its ID's entry (another cycle's record for the same committee) keeps its own. Absent when no row carries one.",
  );

/** Keys a committee title already shows. */
const TITLE_KEYS: ReadonlySet<string> = new Set(['name', 'committee_id']);

/** `NAME (ID)`, or whichever of the two the record has. */
function committeeTitle(committee: Row): string {
  const name = committee.name == null ? undefined : String(committee.name);
  const id = committee.committee_id == null ? undefined : String(committee.committee_id);
  if (name !== undefined && id !== undefined) return `${name} (${id})`;
  return name ?? id ?? 'Unknown';
}

/** A title line followed by every other non-empty field of the record. */
function committeeBlock(title: string, committee: Row): string {
  const fields = renderRecord(committee, TITLE_KEYS);
  return fields ? `${title}\n${fields}` : title;
}

/** Render the hoisted committee in full — its name and ID, then every other field — for format(). */
export function formatHoistedCommittee(committee: Row | undefined): string[] {
  if (!committee) return [];
  return [
    committeeBlock(
      `**Committee (applies to every row below):** ${committeeTitle(committee)}`,
      committee,
    ),
  ];
}

/**
 * Render each committee map the page carries: a heading naming the ID that
 * points into it, then every entry once, in full. Rendered after the rows that
 * reference them.
 */
export function formatCommitteeMaps(page: CommitteeMaps): string[] {
  return MAP_SPECS.flatMap((spec) => {
    const map = page[spec.mapKey];
    if (!map) return [];
    return [
      `**${spec.label} referenced above** — each row's ${spec.idKey} names its entry:`,
      ...Object.values(map).map((record) =>
        committeeBlock(`**${committeeTitle(record)}**`, record),
      ),
    ];
  });
}

/**
 * A committee record left on its row renders in full as a block under its key,
 * never as a JSON dump. A value that is not a record is declined, so it takes
 * the generic rendering.
 */
const renderRowCommittee: RecordFieldRenderer = (value) => {
  if (!isRecord(value)) return null;
  const fields = renderRecord(value, TITLE_KEYS);
  const nested = fields
    ? `\n${fields
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')}`
    : '';
  return `\n    ${committeeTitle(value)}${nested}`;
};

/**
 * `renderRecord` field renderers for a schedule row: each flat ID with a map
 * entry names the committee it points to (`C00003418 (NAME)`), so the row says
 * whose it is without repeating the record, and a committee record still on the
 * row renders in full.
 */
export function committeeRenderers(page: CommitteeMaps): Record<string, RecordFieldRenderer> {
  const renderers: Record<string, RecordFieldRenderer> = {};
  for (const spec of MAP_SPECS) {
    renderers[spec.field] = renderRowCommittee;
    const map = page[spec.mapKey];
    if (!map) continue;
    renderers[spec.idKey] = (id) => {
      if (typeof id !== 'string' || !Object.hasOwn(map, id)) return null;
      const name = map[id]?.name;
      return name == null ? null : `${id} (${String(name)})`;
    };
  }
  return renderers;
}
