/**
 * @fileoverview Election lookup tool — find federal election races and candidate
 * financial summaries by office, cycle, state, and district.
 * @module mcp-server/tools/definitions/lookup-elections.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import type { FecParams, PageResult } from '@/services/openfec/types.js';
import { validateStateCode } from './utils/code-validators.js';
import {
  buildSearchCriteria,
  describeExhaustedPosition,
  exhaustedPage,
  fmtTotal,
  formatEmptyResult,
  formatExhaustedResult,
  formatSearchCriteria,
  PaginationSchema,
  renderRecord,
  SearchCriteriaSchema,
  toPagination,
} from './utils/format-helpers.js';

const OFFICE_API_FORM = { H: 'house', S: 'senate', P: 'president' } as const;

/**
 * The geography OpenFEC files presidential and Senate races under: a
 * presidential race under state US, both under district 00. Any other value
 * matches nothing on /elections/ and /elections/summary/, and the ZIP search
 * ignores it for these races, so it is rejected rather than sent.
 */
const FILED_GEOGRAPHY: Partial<
  Record<keyof typeof OFFICE_API_FORM, Partial<Record<'state' | 'district', string>>>
> = {
  P: { state: 'US', district: '00' },
  S: { district: '00' },
};

/**
 * A geography value as OpenFEC reads it: its `District` arg zero-pads a lone
 * digit (`0` selects district 00) and its state arg upper-cases.
 */
const asFiled = (field: 'state' | 'district', value: string): string =>
  field === 'district' && /^\d$/.test(value) ? `0${value}` : value.toUpperCase();

const OFFICE_LABEL: Record<string, string> = { H: 'House', S: 'Senate', P: 'President' };

/**
 * Head a ZIP-search race locator with the race it names — `GA-05 House 2026`,
 * `GA Senate 2026`, `President 2024` — and return the fields that heading
 * carries verbatim. A presidential race's state and district and a Senate
 * race's district stay as fields: they are the values to pass back.
 */
function raceLocatorHeading(row: Record<string, unknown>): {
  heading: string;
  carried: Set<string>;
} {
  const carried = new Set<string>();
  const take = (key: string): string | undefined => {
    const value = row[key];
    if (value === undefined || value === null || value === '') return;
    carried.add(key);
    return String(value);
  };
  const office = take('office');
  const place =
    office === 'P'
      ? undefined
      : office === 'H'
        ? [take('state'), take('district')].filter(Boolean).join('-')
        : take('state');
  const label = office === undefined ? undefined : (OFFICE_LABEL[office] ?? office);
  const heading = [place, label, take('cycle')].filter(Boolean).join(' ');
  return { heading: heading || 'Race locator', carried };
}

/** Applied when the caller leaves `election_full` unset on a non-ZIP query. */
const ELECTION_FULL_DEFAULT = true;

/** What a ZIP-scoped search accepts — quoted in the rejection. */
const ZIP_SEARCH_INPUTS = [
  'mode',
  'office',
  'cycle',
  'state',
  'district',
  'zip',
  'page',
  'per_page',
];
const SUMMARY_INPUTS = ['mode', 'office', 'cycle', 'state', 'district', 'election_full'];

export const lookupElections = tool('openfec_lookup_elections', {
  description:
    "Look up federal election races and candidate financial summaries. Find who's running in a race with fundraising totals, or get an aggregate race summary.",
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'cycle_must_be_even',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Cycle is an odd year',
      recovery:
        'Federal election cycles are two-year periods ending in even years (e.g., 2024, 2026).',
    },
    {
      reason: 'missing_state_for_office',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Senate or House office without a state and without a zip',
      recovery:
        'Provide a two-letter state code (e.g., AZ) or a zip code to scope the senate or house race.',
    },
    {
      reason: 'missing_district_for_house',
      code: JsonRpcErrorCode.ValidationError,
      when: 'House office without a district number and without a zip',
      recovery:
        'Provide a two-digit district number (e.g., "07"), 00 for an at-large seat, or a zip code to identify the House race.',
    },
    {
      reason: 'inputs_not_applicable_to_office',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A presidential race given a state other than US, or a presidential or Senate race given a district other than 00 (or 0, which OpenFEC pads to 00) — values OpenFEC never files those races under',
      recovery:
        'Omit state for a presidential race and district for a presidential or Senate race, or pass the values those races carry: state US for President, district 00 for President and Senate.',
    },
    {
      reason: 'summary_does_not_support_zip',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Summary mode invoked with a zip parameter',
      recovery:
        'Use mode "search" for ZIP-based lookups, or remove zip and use state and district for summary mode.',
    },
    {
      reason: 'inputs_not_applicable_to_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The resolved elections endpoint does not accept one or more explicitly supplied inputs',
      recovery:
        'Remove the named inputs or choose a mode and geography whose concrete endpoint supports them.',
    },
  ],

  input: z.object({
    mode: z
      .enum(['search', 'summary'])
      .default('search')
      .describe(
        'search = candidates in a race with financial totals; with zip, locators for the races covering that ZIP instead. summary = aggregate race financial summary.',
      ),
    office: z.enum(['H', 'S', 'P']).describe('Office sought: H=House, S=Senate, P=President.'),
    cycle: z.number().int().describe('Election cycle year (even years only, e.g. 2024).'),
    state: z
      .string()
      .optional()
      .describe(
        'Two-letter US state code (e.g., AZ, CA). Required for senate/house unless zip is provided. Presidential races are filed under US: omit it or pass US.',
      ),
    district: z
      .string()
      .optional()
      .describe(
        'Two-digit district number (e.g. "07"); 00 for an at-large House seat (e.g., WY, AK). Required for house unless zip is provided. Presidential and Senate races are filed under 00: omit it or pass 00.',
      ),
    zip: z
      .string()
      .optional()
      .describe(
        'ZIP code — returns a locator (office, state, district, cycle) for each race covering this ZIP, not candidates; pass a locator back as state and district for that race. Search mode only.',
      ),
    election_full: z
      .boolean()
      .optional()
      .describe(
        'Expand to full election period (4yr president, 6yr senate, 2yr house). Defaults to true when omitted; a ZIP-scoped search rejects it, since that endpoint has no such parameter. Carries no schema default, so an explicit value is distinguishable from an omission.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Page number (1-indexed). Search mode only; explicit page is rejected in summary mode. Defaults to 1 for search.',
      ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Results per page. Search mode only; defaults to 20.'),
  }),

  output: z.object({
    results: z
      .array(
        z
          .looseObject({})
          .describe(
            'Candidate financial row (search mode), race locator (search with zip), or aggregate race summary (summary mode).',
          ),
      )
      .describe(
        'Election race result set; candidate financial rows in search mode, race locators (office, state, district, cycle) in a search with zip, a single aggregate summary row in summary mode.',
      ),
    mode: z
      .enum(['search', 'summary'])
      .describe(
        'Query mode as the server resolved it. Row shapes differ by mode — search rows are per-candidate financial records, summary is one aggregate race row — so read this rather than inferring the shape from the fields present.',
      ),
    pagination: PaginationSchema,
    search_criteria: SearchCriteriaSchema,
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching candidates, race locators, or race summaries.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the response carries no election results: how to broaden a search that matched nothing, or which requested position ran out when results did match.',
      ),
  },

  async handler(input, ctx) {
    if (input.cycle % 2 !== 0) {
      throw ctx.fail('cycle_must_be_even', undefined, {
        cycle: input.cycle,
      });
    }
    // ZIP resolves geography on its own — only require state/district when no zip
    if (!input.zip) {
      if ((input.office === 'S' || input.office === 'H') && !input.state) {
        throw ctx.fail('missing_state_for_office', undefined, {
          office: input.office,
        });
      }
      if (input.office === 'H' && !input.district) {
        throw ctx.fail('missing_district_for_house', undefined, {
          office: input.office,
          state: input.state,
        });
      }
    }

    const filed = FILED_GEOGRAPHY[input.office];
    if (filed) {
      const misplaced = (['state', 'district'] as const).filter((field) => {
        const value = input[field];
        const expected = filed[field];
        return expected !== undefined && !!value && asFiled(field, value) !== expected;
      });
      if (misplaced.length > 0) {
        const race = input.office === 'P' ? 'presidential' : 'Senate';
        throw ctx.fail(
          'inputs_not_applicable_to_office',
          `OpenFEC files every ${race} race under ${misplaced.map((f) => `${f} ${filed[f]}`).join(' and ')}, so ${misplaced.map((f) => `${f} "${input[f]}"`).join(' and ')} cannot select one.`,
          {
            office: input.office,
            inapplicable_inputs: misplaced,
            filed_values: Object.fromEntries(misplaced.map((f) => [f, filed[f]])),
          },
        );
      }
    }
    if (input.state) validateStateCode('state', input.state);

    if (input.zip && input.election_full !== undefined) {
      throw ctx.fail(
        'inputs_not_applicable_to_mode',
        `A ZIP-scoped search runs /elections/search/, which cannot apply election_full — it accepts only ${ZIP_SEARCH_INPUTS.join(', ')}. Sending it would have returned a result set the flag never narrowed.`,
        {
          mode: input.mode,
          inapplicable_inputs: ['election_full'],
          supported_inputs: ZIP_SEARCH_INPUTS,
        },
      );
    }

    if (input.mode === 'summary') {
      if (input.zip) {
        throw ctx.fail('summary_does_not_support_zip');
      }
      const inapplicableInputs = [
        ...(input.page !== undefined ? ['page'] : []),
        ...(input.per_page !== undefined ? ['per_page'] : []),
      ];
      if (inapplicableInputs.length > 0) {
        throw ctx.fail(
          'inputs_not_applicable_to_mode',
          `Mode "summary" cannot apply ${inapplicableInputs.join(', ')}.`,
          {
            mode: input.mode,
            inapplicable_inputs: inapplicableInputs,
            supported_inputs: SUMMARY_INPUTS,
          },
        );
      }
    }

    const fec = getOpenFecService();

    /** election_full carries no schema default, so the echo reports the effective value. */
    const electionFull = input.election_full ?? ELECTION_FULL_DEFAULT;

    const params: FecParams = {
      office: OFFICE_API_FORM[input.office],
      cycle: input.cycle,
    };
    if (input.state) params.state = input.state;
    if (input.district) params.district = input.district;
    if (input.zip) params.zip = input.zip;

    if (input.mode === 'summary') {
      params.election_full = electionFull;
      ctx.log.info('Fetching election summary', { office: input.office, cycle: input.cycle });
      const summary = await fec.getElectionSummary(params, ctx);
      ctx.enrich.total(1);
      const summaryRecord: Record<string, unknown> = {
        ...(summary as unknown as Record<string, unknown>),
        _independent_expenditures_note:
          'Unreconciled upstream aggregate — may be inflated due to double-counting across reporting periods. openfec_search_expenditures mode by_candidate gives per-committee totals from periodic reports; for the current cycle those leave out spending reported so far only on 24/48-hour notices, which mode itemized with is_notice: true returns.',
      };
      return {
        results: [summaryRecord],
        mode: 'summary' as const,
        pagination: { page: 1, pages: 1, count: 1, per_page: 1 },
        search_criteria: buildSearchCriteria({ ...input, election_full: electionFull }),
      };
    }

    // Paging applies to search mode only — /elections/summary/ accepts no page params
    params.page = input.page ?? 1;
    params.per_page = input.per_page ?? 20;

    // /elections/search/ supports zip but not election_full; /elections/ supports election_full
    ctx.log.info('Searching elections', {
      office: input.office,
      cycle: input.cycle,
      zip: input.zip,
    });
    /**
     * A page past the end of a nonzero result set is a position to correct,
     * not a race that never happened — so it never gets the zero-match hint.
     */
    const noticeFor = (data: PageResult, zeroMatchNotice: string) => {
      ctx.enrich.total(data.pagination.count);
      const exhausted = exhaustedPage(data.pagination, data.results.length);
      if (exhausted) {
        ctx.enrich.notice(describeExhaustedPosition(exhausted));
      } else if (data.results.length === 0) {
        ctx.enrich.notice(zeroMatchNotice);
      }
    };

    if (input.zip) {
      const data = await fec.searchElectionsByZip(params, ctx);
      noticeFor(
        data,
        'No election races found for this ZIP. Verify the cycle is an even year and the ZIP code is a valid US ZIP.',
      );
      return {
        results: data.results,
        mode: 'search' as const,
        pagination: toPagination(data.pagination),
        search_criteria: buildSearchCriteria(input),
      };
    }
    params.election_full = electionFull;
    const data = await fec.searchElections(params, ctx);
    noticeFor(
      data,
      'No election races matched. Verify the cycle is an even year, the state code is correct for senate/house races, and the district exists for the given state.',
    );
    return {
      results: data.results,
      mode: 'search' as const,
      pagination: toPagination(data.pagination),
      search_criteria: buildSearchCriteria({ ...input, election_full: electionFull }),
    };
  },

  format: (result) => {
    if (result.results.length === 0) {
      const exhausted = exhaustedPage(result.pagination, 0);
      if (exhausted) {
        return formatExhaustedResult(result.search_criteria, exhausted, result.mode);
      }
      return formatEmptyResult(
        result.search_criteria,
        'Verify the cycle is an even year, the state code is correct for senate/house races, and the district exists for the given state.',
        result.mode,
      );
    }

    const { page, pages, count, per_page, count_is_approximate } = result.pagination;
    const criteriaLine = formatSearchCriteria(result.search_criteria);
    const footer = [
      `\n_${fmtTotal(count, count_is_approximate, 'result(s)')} · page ${page}/${pages} · ${per_page} per page_`,
      criteriaLine,
    ]
      .filter(Boolean)
      .join('\n');

    // Summary mode returns a single flat object with aggregate totals
    const first = result.results[0];
    if (
      first &&
      'receipts' in first &&
      'disbursements' in first &&
      'independent_expenditures' in first
    ) {
      const noteKey = '_independent_expenditures_note';
      const note = typeof first[noteKey] === 'string' ? (first[noteKey] as string) : undefined;
      const skipInFormat = new Set([noteKey]);
      const body = renderRecord(first, skipInFormat);
      const caveat = note ? `\n\n> **Note on independent_expenditures:** ${note}` : '';
      return [
        {
          type: 'text',
          text: `**Election Summary**\n**Mode:** ${result.mode}\n${body}${caveat}\n${footer}`,
        },
      ];
    }

    const headerKeys = new Set(['candidate_name', 'candidate_id']);
    /** A ZIP search returns race locators, not candidates. */
    const zipSearch = result.search_criteria.zip !== undefined;

    const lines = [
      `**Mode:** ${result.mode}`,
      ...result.results.map((r) => {
        if (zipSearch) {
          const { heading, carried } = raceLocatorHeading(r);
          const fields = renderRecord(r, carried);
          return fields ? `**${heading}**\n${fields}` : `**${heading}**`;
        }
        const name = String(r.candidate_name ?? 'Unknown');
        const id = r.candidate_id ? String(r.candidate_id) : '';
        const header = id ? `**${name}** (${id})` : `**${name}**`;
        const fields = renderRecord(r, headerKeys);
        return fields ? `${header}\n${fields}` : header;
      }),
      footer,
    ];

    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
