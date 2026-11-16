/**
 * @fileoverview Tests for the legal-record helpers both legal tools share —
 * each nested shape `/legal/search/` and `/legal/docs/` return, rendered
 * through `renderRecord` the way the tools call it, the fallback to the
 * generic JSON rendering for a shape the renderers do not know, and the
 * absolute form of every link a record carries.
 * @module tests/mcp-server/tools/definitions/utils/legal-field-renderers.test
 */

import { describe, expect, it } from 'vitest';
import { renderRecord } from '@/mcp-server/tools/definitions/utils/format-helpers.js';
import {
  LEGAL_FIELD_RENDERERS,
  legalDocumentTitle,
  resolveLegalLinks,
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
  it('renders disposition citations with their title prefix, linked to their URL', () => {
    expect(
      field('citations', [
        {
          text: '30104(g)',
          title: '52',
          type: 'statute',
          url: 'https://www.govinfo.gov/link/uscode/52/30104',
        },
        {
          text: '100.26',
          title: '11',
          type: 'regulation',
          url: 'https://www.fec.gov/regulations/100-26/CURRENT',
        },
        { text: '114.2(b), (d)', title: '11', type: 'regulation' },
      ]),
    ).toBe(
      '  citations: [52 U.S.C. 30104(g)](<https://www.govinfo.gov/link/uscode/52/30104>); [11 CFR 100.26](<https://www.fec.gov/regulations/100-26/CURRENT>); 11 CFR 114.2(b), (d)',
    );
  });

  it('renders archived citations by their text, linked to their URL', () => {
    expect(
      field('citations', {
        regulations: [
          { text: '11 C.F.R. 100.5(g)', url: 'https://www.fec.gov/regulations/100-5/CURRENT' },
        ],
        us_code: [
          {
            text: '52 U.S.C. 30103(b)(2)',
            url: 'https://www.govinfo.gov/link/uscode/52/30103',
          },
        ],
      }),
    ).toBe(
      '  citations: [11 C.F.R. 100.5(g)](<https://www.fec.gov/regulations/100-5/CURRENT>); [52 U.S.C. 30103(b)(2)](<https://www.govinfo.gov/link/uscode/52/30103>)',
    );
  });

  it('keeps a citation URL that is not http(s) visible beside its label as text', () => {
    expect(
      field('citations', [
        { text: '100.26', title: '11', type: 'regulation', url: '/regulations/100-26/CURRENT' },
      ]),
    ).toBe('  citations: 11 CFR 100.26 (/regulations/100-26/CURRENT)');
  });

  it('escapes a label so its brackets cannot close the link early', () => {
    expect(
      field('citations', { regulations: [{ text: '11 CFR [x]', url: 'https://www.fec.gov/r' }] }),
    ).toBe('  citations: [11 CFR \\[x\\]](<https://www.fec.gov/r>)');
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
      '  commission_votes:\n  - 2004-10-18T00:00:00 — Mason, David M. (Affirmed) — Approve.\n  - (no date or action recorded)\n',
    );
  });

  /**
   * MUR 8309's votes as the search trims them. Each vote is a list item that
   * opens inside the record's run of field lines; its blank lines stay blank,
   * a paragraph break inside the item, so the line after one sits at the
   * item's content column rather than deep enough to read as code. A blank
   * line closes the list before the next field.
   */
  it('keeps a multi-line action inside its own list item, every line break kept', () => {
    expect(
      field('commission_votes', [
        {
          vote_date: '2025-04-29T00:00:00',
          action:
            'The Commission decided by a vote of 4-0 to take the following actions in MUR 8309:\n\n1. Accept the signed Conciliation Agreement, as recommended in the Memorandum to the Commission dated April 3, 2025.',
        },
        {
          vote_date: '2024-08-27T00:00:00',
          action:
            'The Commission failed by a vote of 3-3 to:\n\na. Open a MUR.\n\nb. Find reason to believe that Oklahoma Leadership Council and John Elliott in his official capacity as treasurer violated 52 U.S.C. § 30104',
        },
      ]),
    ).toBe(
      '  commission_votes:\n  - 2025-04-29T00:00:00 — The Commission decided by a vote of 4-0 to take the following actions in MUR 8309:\n\n    1. Accept the signed Conciliation Agreement, as recommended in the Memorandum to the Commission dated April 3, 2025.\n  - 2024-08-27T00:00:00 — The Commission failed by a vote of 3-3 to:\n\n    a. Open a MUR.\n\n    b. Find reason to believe that Oklahoma Leadership Council and John Elliott in his official capacity as treasurer violated 52 U.S.C. § 30104\n',
    );
  });

  it('renders a single vote that spans lines as a one-item list', () => {
    expect(
      field('commission_votes', [
        { vote_date: '2024-05-14T00:00:00', action: 'The Commission voted to:\n\na. Open a MUR' },
      ]),
    ).toBe(
      '  commission_votes:\n  - 2024-05-14T00:00:00 — The Commission voted to:\n\n    a. Open a MUR\n',
    );
  });

  /** MUR 8262 writes some actions with CRLF line ends and trailing blank lines. */
  it('reads CRLF and a lone CR as line breaks, keeping trailing blank lines', () => {
    expect(
      field('commission_votes', [
        {
          vote_date: '2024-05-14T00:00:00',
          action:
            'The Commission failed by a vote of 3-3 to:\r\n\r\nRefer to the matter to the Office of Alternative Dispute Resolution.\r\n\r\n',
        },
        { vote_date: '2024-05-14T00:00:00', action: 'a\rb' },
      ]),
    ).toBe(
      '  commission_votes:\n  - 2024-05-14T00:00:00 — The Commission failed by a vote of 3-3 to:\n\n    Refer to the matter to the Office of Alternative Dispute Resolution.\n\n\n  - 2024-05-14T00:00:00 — a\n    b\n',
    );
  });
});

describe('highlights', () => {
  it('puts each snippet on its own line, text unchanged', () => {
    expect(field('highlights', ['a, b', 'c'])).toBe('  highlights:\n  - a, b\n  - c\n');
  });

  it('indents a snippet line break under its own list item', () => {
    expect(field('highlights', ['a\nb', 'c'])).toBe('  highlights:\n  - a\n    b\n  - c\n');
  });

  it('keeps a snippet blank line as a blank line inside its list item', () => {
    expect(field('highlights', ['a\n\nb', 'c'])).toBe('  highlights:\n  - a\n\n    b\n  - c\n');
  });

  it('keeps a single snippet without a line break on the key line', () => {
    expect(field('highlights', ['only one'])).toBe('  highlights: only one');
  });

  it('leaves a list holding a non-string entry to the generic rendering', () => {
    expect(field('highlights', [42, 'x'])).toBe('  highlights: 42, x');
  });
});

describe('url', () => {
  it.each([
    [
      'https://www.fec.gov/files/legal/murs/8112/8112_11.pdf',
      '  url: [8112_11.pdf](<https://www.fec.gov/files/legal/murs/8112/8112_11.pdf>)',
    ],
    [
      'https://www.fec.gov/data/legal/matter-under-review/8112/',
      '  url: [8112](<https://www.fec.gov/data/legal/matter-under-review/8112/>)',
    ],
    [
      'https://www.govinfo.gov/link/uscode/26/9001',
      '  url: [9001](<https://www.govinfo.gov/link/uscode/26/9001>)',
    ],
    ['http://www.fec.gov/', '  url: [www.fec.gov](<http://www.fec.gov/>)'],
  ])('renders %s as a link labeled by its last path segment', (url, expected) => {
    expect(field('url', url)).toBe(expected);
  });

  it.each([
    ['a site-relative path', '/files/legal/murs/8112/8112_11.pdf'],
    ['a masked value', 'XXXXXXXXXXXX'],
    ['a non-web scheme', 'javascript:alert(1)'],
  ])('leaves %s on the generic rendering, as sent', (_kind, value) => {
    expect(field('url', value)).toBe(`  url: ${value}`);
  });

  it('omits an empty url, as the generic rendering does', () => {
    expect(field('url', '')).toBe('');
  });
});

describe('resolveLegalLinks', () => {
  it.each([
    [
      '/legal/matter-under-review/8112/',
      'https://www.fec.gov/data/legal/matter-under-review/8112/',
    ],
    [
      '/legal/alternative-dispute-resolution/1203/',
      'https://www.fec.gov/data/legal/alternative-dispute-resolution/1203/',
    ],
    [
      '/legal/administrative-fine/4855/',
      'https://www.fec.gov/data/legal/administrative-fine/4855/',
    ],
    ['/files/legal/murs/8112/8112_11.pdf', 'https://www.fec.gov/files/legal/murs/8112/8112_11.pdf'],
    ['/regulations/100-26/CURRENT', 'https://www.fec.gov/regulations/100-26/CURRENT'],
    ['https://www.govinfo.gov/link/uscode/26/9001', 'https://www.govinfo.gov/link/uscode/26/9001'],
    ['//cdn.example/x.pdf', '//cdn.example/x.pdf'],
    ['XXXXXXXX', 'XXXXXXXX'],
    ['', ''],
  ])('resolves a record url %s to %s', (url, expected) => {
    expect(resolveLegalLinks({ no: '1', url }, 'murs').url).toBe(expected);
  });

  it('resolves url keys at every depth: documents, disposition citations, archived groups', () => {
    const record = {
      no: '8112',
      url: '/legal/matter-under-review/8112/',
      documents: [{ category: 'GCR', url: '/files/legal/murs/8112/8112_11.pdf' }],
      dispositions: [
        {
          disposition: 'Dismissed',
          citations: [
            { title: '11', type: 'regulation', text: '100.26', url: '/regulations/100-26/CURRENT' },
            { title: '52', type: 'statute', text: '30104', url: 'https://www.govinfo.gov/x' },
          ],
        },
      ],
      citations: { regulations: [{ text: '11 C.F.R. 110.3', url: '/regulations/110-3/CURRENT' }] },
    };

    expect(resolveLegalLinks(record, 'murs')).toEqual({
      no: '8112',
      url: 'https://www.fec.gov/data/legal/matter-under-review/8112/',
      documents: [
        { category: 'GCR', url: 'https://www.fec.gov/files/legal/murs/8112/8112_11.pdf' },
      ],
      dispositions: [
        {
          disposition: 'Dismissed',
          citations: [
            {
              title: '11',
              type: 'regulation',
              text: '100.26',
              url: 'https://www.fec.gov/regulations/100-26/CURRENT',
            },
            { title: '52', type: 'statute', text: '30104', url: 'https://www.govinfo.gov/x' },
          ],
        },
      ],
      citations: {
        regulations: [
          { text: '11 C.F.R. 110.3', url: 'https://www.fec.gov/regulations/110-3/CURRENT' },
        ],
      },
    });
  });

  it('touches only url keys: a path in any other field stays as sent', () => {
    const record = { no: '1', filename: '/files/a.pdf', documents: [{ description: '/legal/x' }] };
    expect(resolveLegalLinks(record, 'murs')).toEqual(record);
  });

  it('copies rather than mutating the record it is given', () => {
    const record = { no: '1', url: '/legal/x/1/', documents: [{ url: '/files/a.pdf' }] };
    const before = structuredClone(record);
    const resolved = resolveLegalLinks(record, 'murs');
    expect(record).toEqual(before);
    expect(resolved.documents).not.toBe(record.documents);
  });

  it.each([
    ['absent', {}],
    ['null', { url: null }],
    ['empty', { url: '' }],
  ])('gives an advisory opinion whose url is %s its fec.gov page', (_kind, url) => {
    expect(
      resolveLegalLinks({ no: '2024-01', ao_no: '2024-01', ...url }, 'advisory_opinions').url,
    ).toBe('https://www.fec.gov/data/legal/advisory-opinions/2024-01/');
  });

  it('builds the advisory opinion page from no when ao_no is absent, and keeps a url it has', () => {
    expect(resolveLegalLinks({ no: '2003-37' }, 'advisory_opinions').url).toBe(
      'https://www.fec.gov/data/legal/advisory-opinions/2003-37/',
    );
    expect(
      resolveLegalLinks({ no: '2003-37', url: 'https://example.gov/ao' }, 'advisory_opinions').url,
    ).toBe('https://example.gov/ao');
  });

  it('percent-encodes the advisory opinion number it builds the page from', () => {
    expect(resolveLegalLinks({ ao_no: '2024-01 A/B?x' }, 'advisory_opinions').url).toBe(
      'https://www.fec.gov/data/legal/advisory-opinions/2024-01%20A%2FB%3Fx/',
    );
  });

  it.each(['murs', 'adrs', 'admin_fines', 'statutes'] as const)(
    'fabricates no page for a %s record without a url',
    (docType) => {
      expect(resolveLegalLinks({ no: '1' }, docType)).not.toHaveProperty('url');
      expect(resolveLegalLinks({ no: '1', url: null }, docType).url).toBeNull();
    },
  );
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
