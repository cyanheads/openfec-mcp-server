/**
 * @fileoverview `renderRecord` field renderers for the nested shapes FEC legal
 * records carry — participants, subjects, the archived-MUR subject tree, the
 * two citation shapes, advisory-opinion citation lists, commission votes, and
 * search highlights — so `content[]` reads as text instead of inline JSON. Every
 * renderer checks the whole value against the shape it knows and declines
 * (null) anything else, leaving that value on the generic rendering.
 * `structuredContent` is never touched.
 * @module src/mcp-server/tools/definitions/utils/legal-field-renderers
 */

import { isRecord } from '@cyanheads/mcp-ts-core/utils';
import type { RecordFieldRenderer } from './format-helpers.js';

type Entry = Record<string, unknown>;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** A citation part upstream sends as either a number or a numeric string. */
const isPart = (value: unknown): value is string | number =>
  typeof value === 'number' || isText(value);

/**
 * Render every entry of a non-empty array of records, or decline the whole
 * value when it is not one or any entry is not the shape `renderEntry` knows.
 * An empty array is declined too; the generic path omits it.
 */
function renderEntries(
  value: unknown,
  renderEntry: (entry: Entry) => string | null,
): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rendered: string[] = [];
  for (const entry of value) {
    const text = isRecord(entry) ? renderEntry(entry) : null;
    if (text === null) return null;
    rendered.push(text);
  }
  return rendered;
}

/** Short entries on one line, separated so names that carry commas stay distinct. */
const inline = (entries: string[] | null): string | null => entries?.join('; ') ?? null;

/**
 * Long entries: one inline, several as a list opening on the line after the
 * key. An entry's own line breaks are indented past the list marker, so its
 * continuation lines stay inside it rather than reading as entries or fields.
 */
const block = (entries: string[] | null): string | null => {
  if (!entries) return null;
  const indented = entries.map((entry) => entry.replaceAll('\n', '\n      '));
  return indented.length === 1
    ? (indented[0] as string)
    : indented.map((entry) => `\n    - ${entry}`).join('');
};

const withUrl = (label: string, url: unknown): string =>
  isText(url) ? `${label} (${url})` : label;

/** `name (role)`, `name (role, type)` — whichever descriptors the entry carries. */
const namedEntry =
  (...descriptors: string[]) =>
  (entry: Entry): string | null => {
    if (!isText(entry.name)) return null;
    const detail = descriptors.map((key) => entry[key]).filter(isText);
    return detail.length > 0 ? `${entry.name} (${detail.join(', ')})` : entry.name;
  };

/** Current-MUR and ADR disposition citation: `52 U.S.C. 30104(g)` / `11 CFR 100.26`, with its URL. */
function caseCitation(entry: Entry): string | null {
  const code = entry.type === 'statute' ? 'U.S.C.' : entry.type === 'regulation' ? 'CFR' : null;
  if (!code || !isPart(entry.title) || !isText(entry.text)) return null;
  return withUrl(`${entry.title} ${code} ${entry.text}`, entry.url);
}

/** Archived-MUR citation: its own text already carries the title prefix. */
const archivedCitation = (entry: Entry): string | null =>
  isText(entry.text) ? withUrl(entry.text, entry.url) : null;

const ARCHIVED_CITATION_GROUPS = new Set(['regulations', 'us_code']);

/**
 * `citations` arrives in two shapes: a flat array on each current-MUR and ADR
 * disposition, and an object of `regulations` / `us_code` arrays on an
 * archived MUR.
 */
const renderCitations: RecordFieldRenderer = (value) => {
  if (Array.isArray(value)) return inline(renderEntries(value, caseCitation));
  if (!isRecord(value)) return null;
  const groups = Object.entries(value);
  if (groups.some(([key]) => !ARCHIVED_CITATION_GROUPS.has(key))) return null;
  const rendered: string[] = [];
  for (const [, group] of groups) {
    if (!Array.isArray(group)) return null;
    if (group.length === 0) continue;
    const entries = renderEntries(group, archivedCitation);
    if (!entries) return null;
    rendered.push(...entries);
  }
  return rendered.length > 0 ? rendered.join('; ') : null;
};

/**
 * Each leaf of an archived-MUR subject tree as its `>`-joined path from the
 * root, or null when any node lacks its text or holds malformed children.
 */
function subjectPaths(nodes: unknown, ancestors: readonly string[]): string[] | null {
  if (!Array.isArray(nodes)) return null;
  const paths: string[] = [];
  for (const node of nodes) {
    if (!isRecord(node) || !isText(node.text)) return null;
    const path = [...ancestors, node.text];
    const { children } = node;
    if (children == null || (Array.isArray(children) && children.length === 0)) {
      paths.push(path.join(' > '));
      continue;
    }
    const nested = subjectPaths(children, path);
    if (!nested) return null;
    paths.push(...nested);
  }
  return paths;
}

/** One commission vote: date, commissioner and vote type when recorded, and the action. */
function commissionVote(entry: Entry): string | null {
  const { vote_date: date, action, commissioner_name: who, vote_type: how } = entry;
  const optionalText = (v: unknown) => v == null || typeof v === 'string';
  if (![date, action, who, how].every(optionalText)) return null;
  const voter = isText(who) && isText(how) ? `${who} (${how})` : [who, how].find(isText);
  const parts = [isText(date) ? date : undefined, voter, isText(action) ? action : undefined];
  if (!parts.some(Boolean)) return '(no date or action recorded)';
  if (!isText(date)) parts[0] = '(undated)';
  return parts.filter(Boolean).join(' — ');
}

/**
 * Renderers for every known nested legal field, keyed by field name. Pass to
 * `renderRecord` for a record's own fields and for each entry of a section
 * rendered from one of its arrays.
 */
export const LEGAL_FIELD_RENDERERS: Readonly<Record<string, RecordFieldRenderer>> = {
  participants: (value) => inline(renderEntries(value, namedEntry('role'))),
  entities: (value) => inline(renderEntries(value, namedEntry('role', 'type'))),
  subjects: (value) =>
    inline(renderEntries(value, (entry) => (isText(entry.subject) ? entry.subject : null))),
  subject: (value) => {
    const paths = subjectPaths(value, []);
    return paths && paths.length > 0 ? paths.join('; ') : null;
  },
  citations: renderCitations,
  regulatory_citations: (value) =>
    inline(
      renderEntries(value, ({ title, part, section }) =>
        isPart(title) && isPart(part) && isPart(section) ? `${title} CFR ${part}.${section}` : null,
      ),
    ),
  statutory_citations: (value) =>
    inline(
      renderEntries(value, ({ title, section }) =>
        isPart(title) && isPart(section) ? `${title} U.S.C. ${section}` : null,
      ),
    ),
  ao_citations: (value) => inline(renderEntries(value, advisoryOpinionReference)),
  aos_cited_by: (value) => inline(renderEntries(value, advisoryOpinionReference)),
  commission_votes: (value) => block(renderEntries(value, commissionVote)),
  /** Search snippets carry commas of their own, so each goes on its own list line. */
  highlights: (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((snippet) => typeof snippet === 'string')
      ? block(value)
      : null,
};

/** `AO 2000-25 (Minnesota House DFL Caucus)`. */
function advisoryOpinionReference(entry: Entry): string | null {
  if (!isText(entry.no)) return null;
  return isText(entry.name) ? `AO ${entry.no} (${entry.name})` : `AO ${entry.no}`;
}

/**
 * The identifier a legal record is headed by, whichever field its document
 * type carries it in, so both legal tools head the same record the same way.
 */
export function legalDocumentNumber(doc: Record<string, unknown>): string {
  const value = doc.ao_no ?? doc.case_no ?? doc.no;
  return value == null ? '' : String(value);
}

/**
 * The name a legal record is headed by. An archived MUR carries its case name
 * in `mur_name` with `name` null, so that is the fallback.
 */
export function legalDocumentTitle(doc: Record<string, unknown>): string {
  if (isText(doc.name)) return doc.name;
  return isText(doc.mur_name) ? doc.mur_name : '';
}
