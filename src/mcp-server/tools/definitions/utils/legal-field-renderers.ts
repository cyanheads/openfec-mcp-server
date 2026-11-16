/**
 * @fileoverview What the two legal tools share about a legal record: the
 * absolute fec.gov form of its links, applied to the record on both surfaces;
 * the `renderRecord` field renderers for the nested shapes it carries —
 * participants, subjects, the archived-MUR subject tree, the two citation
 * shapes, advisory-opinion citation lists, commission votes, search
 * highlights, and links — so `content[]` reads as text and Markdown links
 * instead of inline JSON; and the CommonMark list item those renderers and the
 * detail tool's array sections lay each entry out as. Every renderer checks
 * the whole value against the shape it knows and declines (null) anything
 * else, leaving that value on the generic rendering.
 * @module src/mcp-server/tools/definitions/utils/legal-field-renderers
 */

import { isRecord, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import type { LegalDocType } from '@/services/openfec/types.js';
import type { RecordFieldRenderer } from './format-helpers.js';

type Entry = Record<string, unknown>;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** A citation part upstream sends as either a number or a numeric string. */
const isPart = (value: unknown): value is string | number =>
  typeof value === 'number' || isText(value);

const FEC_SITE = 'https://www.fec.gov';

/**
 * A site-relative fec.gov path made absolute. Upstream writes a record's own
 * page as `/legal/<kind>/<no>/`, which fec.gov serves under `/data`
 * (`/legal/matter-under-review/8112/` is a 404 at the site root); document
 * files (`/files/…`) and regulation citations (`/regulations/…`) resolve at
 * the root.
 */
const absoluteFecUrl = (path: string): string =>
  path.startsWith('/legal/') ? `${FEC_SITE}/data${path}` : `${FEC_SITE}${path}`;

/** A path upstream wrote relative to fec.gov: one leading slash, not a `//host` reference. */
const isSiteRelative = (value: string): boolean => value.startsWith('/') && !value.startsWith('//');

/** Every `url` at any depth of `value` made absolute, in a copy; everything else as sent. */
function resolveUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveUrls);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      key === 'url' && typeof field === 'string' && isSiteRelative(field)
        ? absoluteFecUrl(field)
        : resolveUrls(field),
    ]),
  );
}

/**
 * A copy of a legal record with every link absolute: the record's own `url`,
 * each `documents[].url`, and the citation `url`s in its dispositions or
 * archived citation groups. An absolute URL is kept as sent. An advisory
 * opinion arrives with no `url` of its own, so it is given its fec.gov page;
 * any other record without one is left without one.
 */
export function resolveLegalLinks(record: Entry, docType: LegalDocType): Entry {
  const resolved = resolveUrls(record) as Entry;
  const aoNumber = record.ao_no ?? record.no;
  if (docType === 'advisory_opinions' && !isText(resolved.url) && aoNumber != null) {
    resolved.url = `${FEC_SITE}/data/legal/advisory-opinions/${encodeURIComponent(String(aoNumber))}/`;
  }
  return resolved;
}

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

/** An entry's lines, split where CommonMark ends one: at CRLF, CR, or LF. */
const linesOf = (entry: string): string[] => entry.split(/\r\n|\r|\n/);

/**
 * One CommonMark list item: `marker` (any indent before the list marker, the
 * marker, and the space after it), then the entry's first line. Its further
 * lines sit at the item's content column, the marker's width, and its blank
 * lines stay blank, which CommonMark reads as paragraph breaks inside the
 * item. Lines indented deeper would turn the line after a blank one into a
 * code block that swallows the entries below it.
 */
export const listItem = (marker: string, entry: string): string => {
  const indent = ' '.repeat(marker.length);
  return linesOf(entry)
    .map((line, index) => {
      if (index === 0) return `${marker}${line}`;
      return line.trim() === '' ? '' : `${indent}${line}`;
    })
    .join('\n');
};

/**
 * Long entries: a lone one-line entry inline beside the key, anything else a
 * CommonMark list on the lines after it, one {@link listItem} per entry. The
 * marker is indented two spaces, so the list opens inside the record's run of
 * field lines. A closing blank line ends the list, so the field line that
 * follows is not read into the last item.
 */
export const block = (entries: string[] | null): string | null => {
  if (!entries) return null;
  const [only] = entries;
  if (entries.length === 1 && only !== undefined && linesOf(only).length === 1) return only;
  return `\n${entries.map((entry) => listItem('  - ', entry)).join('\n')}\n`;
};

/** A citation linked to its URL; one that is not http(s) stays visible beside the label as text. */
const withUrl = (label: string, url: unknown): string =>
  isText(url) ? markdownLink(label, url) : label;

/**
 * A `url` field as a Markdown link labeled by the last segment of its path —
 * a document's file name, a record's number. A value that is not an http(s)
 * URL is declined, which keeps it on the generic rendering as sent.
 */
function renderLink(value: unknown): string | null {
  if (!isText(value)) return null;
  const parsed = URL.parse(value);
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return null;
  const label = parsed.pathname.split('/').filter(Boolean).at(-1) ?? parsed.hostname;
  return markdownLink(label, value);
}

/** `name (role)`, `name (role, type)` — whichever descriptors the entry carries. */
const namedEntry =
  (...descriptors: string[]) =>
  (entry: Entry): string | null => {
    if (!isText(entry.name)) return null;
    const detail = descriptors.map((key) => entry[key]).filter(isText);
    return detail.length > 0 ? `${entry.name} (${detail.join(', ')})` : entry.name;
  };

/** Current-MUR and ADR disposition citation: `52 U.S.C. 30104(g)` / `11 CFR 100.26`, linked to its URL. */
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
  url: renderLink,
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
