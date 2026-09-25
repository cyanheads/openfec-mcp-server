/**
 * @fileoverview Tests for the legal-record field renderers — each nested shape
 * `/legal/search/` and `/legal/docs/` return, rendered through `renderRecord`
 * the way both legal tools call it, plus the fallback to the generic JSON
 * rendering for a shape the renderers do not know.
 * @module tests/mcp-server/tools/definitions/utils/legal-field-renderers.test
 */

import { describe, expect, it } from 'vitest';
import { renderRecord } from '@/mcp-server/tools/definitions/utils/format-helpers.js';
import {
  LEGAL_FIELD_RENDERERS,
  legalDocumentTitle,
} from '@/mcp-server/tools/definitions/utils/legal-field-renderers.js';

/** Render one field of a record the way the legal tools do. */
const field = (key: string, value: unknown): string =>
  renderRecord({ [key]: value }, undefined, LEGAL_FIELD_RENDERERS);

describe('participants / entities / subjects', () => {
  it('renders participants as name (role)', () => {
    expect(
      field('participants', [
        { name: 'Washington Post, The', role: 'Primary Respondent' },
        { name: 'Crate, Bradley T.', role: 'Complainant' },
      ]),
    ).toBe(
      '  participants: Washington Post, The (Primary Respondent); Crate, Bradley T. (Complainant)',
    );
  });

  it('renders a participant without a role by name alone', () => {
    expect(field('participants', [{ name: 'Doe, Jane' }])).toBe('  participants: Doe, Jane');
  });

  it('renders entities as name (role, type)', () => {
    expect(
      field('entities', [
        { name: 'Mr. Charles Spies Esq.', role: 'Commenter', type: 'Individual' },
        { name: 'ABC', role: 'Requestor' },
      ]),
    ).toBe('  entities: Mr. Charles Spies Esq. (Commenter, Individual); ABC (Requestor)');
  });

  it('renders subjects by their subject text', () => {
    expect(
      field('subjects', [
        {
          primary_subject_id: '3',
          secondary_subject_id: '15',
          subject: 'Contributions-Prohibited',
        },
        { primary_subject_id: '18', subject: 'Reporting' },
      ]),
    ).toBe('  subjects: Contributions-Prohibited; Reporting');
  });
});

describe('archived subject tree', () => {
  it('renders every leaf as a >-joined path, recursing past the third level', () => {
    const tree = [
      { text: 'Affiliation' },
      {
        text: 'Contributions',
        children: [
          { text: 'Acceptance', children: [{ text: 'of prohibited contribution' }] },
          {
            text: 'Limitations',
            children: [
              { text: 'annual limit for individuals' },
              { text: 'Deeper', children: [{ text: 'Deepest', children: [{ text: 'leaf' }] }] },
            ],
          },
        ],
      },
      { text: 'Empty branch', children: [] },
    ];
    expect(field('subject', tree)).toBe(
      '  subject: Affiliation; Contributions > Acceptance > of prohibited contribution; Contributions > Limitations > annual limit for individuals; Contributions > Limitations > Deeper > Deepest > leaf; Empty branch',
    );
  });

  it('falls back to the generic rendering when a node deep in the tree is malformed', () => {
    const tree = [{ text: 'Contributions', children: [{ children: [{ text: 'x' }] }] }];
    expect(field('subject', tree)).toBe(
      '  subject: {"text":"Contributions","children":[{"children":[{"text":"x"}]}]}',
    );
  });
});

describe('citations', () => {
  it('renders disposition citations with their title prefix and URL', () => {
    expect(
      field('citations', [
        {
          text: '30104(g)',
          title: '52',
          type: 'statute',
          url: 'https://www.govinfo.gov/link/uscode/52/30104',
        },
        { text: '100.26', title: '11', type: 'regulation', url: '/regulations/100-26/CURRENT' },
        { text: '114.2(b), (d)', title: '11', type: 'regulation' },
      ]),
    ).toBe(
      '  citations: 52 U.S.C. 30104(g) (https://www.govinfo.gov/link/uscode/52/30104); 11 CFR 100.26 (/regulations/100-26/CURRENT); 11 CFR 114.2(b), (d)',
    );
  });

  it('renders archived citations by their text with the URL', () => {
    expect(
      field('citations', {
        regulations: [{ text: '11 C.F.R. 100.5(g)', url: '/regulations/100-5/CURRENT' }],
        us_code: [
          {
            text: '52 U.S.C. 30103(b)(2)',
            url: 'https://www.govinfo.gov/link/uscode/52/30103',
          },
        ],
      }),
    ).toBe(
      '  citations: 11 C.F.R. 100.5(g) (/regulations/100-5/CURRENT); 52 U.S.C. 30103(b)(2) (https://www.govinfo.gov/link/uscode/52/30103)',
    );
  });

  it('falls back when a citation carries a type it does not know', () => {
    expect(field('citations', [{ text: '1', title: '2', type: 'treaty' }])).toBe(
      '  citations: {"text":"1","title":"2","type":"treaty"}',
    );
  });

  it('falls back when an archived citation object carries an unknown group', () => {
    expect(field('citations', { regulations: [], treaties: [{ text: 'x' }] })).toBe(
      '  citations: {"regulations":[],"treaties":[{"text":"x"}]}',
    );
  });

  it('renders advisory-opinion regulatory and statutory citations', () => {
    const text = renderRecord(
      {
        regulatory_citations: [
          { part: 100, section: 4, title: 11 },
          { part: 100, section: 16, title: 11 },
        ],
        statutory_citations: [
          { section: '527', title: 26 },
          { section: '30101', title: 52 },
        ],
      },
      undefined,
      LEGAL_FIELD_RENDERERS,
    );
    expect(text).toBe(
      '  regulatory_citations: 11 CFR 100.4; 11 CFR 100.16\n  statutory_citations: 26 U.S.C. 527; 52 U.S.C. 30101',
    );
  });

  it('renders ao_citations and aos_cited_by as AO number (name)', () => {
    const text = renderRecord(
      {
        ao_citations: [
          { name: 'Minnesota House DFL Caucus', no: '2000-25' },
          { name: 'Cantor', no: '2003-03' },
        ],
        aos_cited_by: [{ no: '2010-11' }],
      },
      undefined,
      LEGAL_FIELD_RENDERERS,
    );
    expect(text).toBe(
      '  ao_citations: AO 2000-25 (Minnesota House DFL Caucus); AO 2003-03 (Cantor)\n  aos_cited_by: AO 2010-11',
    );
  });

  it('skips an empty citation list rather than rendering an empty line', () => {
    expect(field('aos_cited_by', [])).toBe('');
  });
});

describe('commission_votes', () => {
  it('renders a single vote inline as date and action', () => {
    expect(
      field('commission_votes', [{ vote_date: '2025-03-27T00:00:00', action: 'Dismissed.' }]),
    ).toBe('  commission_votes: 2025-03-27T00:00:00 — Dismissed.');
  });

  it('renders several votes as a list under the key, keeping commissioner and vote type', () => {
    expect(
      field('commission_votes', [
        {
          vote_date: '2004-10-18T00:00:00',
          action: 'Approve.',
          commissioner_name: 'Mason, David M.',
          vote_type: 'Affirmed',
        },
        { vote_date: null, action: '' },
      ]),
    ).toBe(
      '  commission_votes:\n    - 2004-10-18T00:00:00 — Mason, David M. (Affirmed) — Approve.\n    - (no date or action recorded)',
    );
  });
});

describe('highlights', () => {
  it('puts each snippet on its own line, text unchanged', () => {
    expect(field('highlights', ['a, b', 'c'])).toBe('  highlights:\n    - a, b\n    - c');
  });

  it('indents a snippet line break under its own list item', () => {
    expect(field('highlights', ['a\nb', 'c'])).toBe('  highlights:\n    - a\n      b\n    - c');
  });

  it('leaves a list holding a non-string entry to the generic rendering', () => {
    expect(field('highlights', [42, 'x'])).toBe('  highlights: 42, x');
  });
});

describe('fallback and title', () => {
  it('leaves a field with no renderer on the generic path', () => {
    expect(field('source', [{ a: 1 }])).toBe('  source: {"a":1}');
  });

  it('renders a known field holding a scalar through the generic path', () => {
    expect(field('participants', 'free text')).toBe('  participants: free text');
  });

  it('heads a record by name, falling back to mur_name when name is absent', () => {
    expect(legalDocumentTitle({ name: 'The Washington Post' })).toBe('The Washington Post');
    expect(legalDocumentTitle({ name: null, mur_name: 'MONDALE DELEGATE COMMITTEES' })).toBe(
      'MONDALE DELEGATE COMMITTEES',
    );
    expect(legalDocumentTitle({ no: '1' })).toBe('');
  });
});
