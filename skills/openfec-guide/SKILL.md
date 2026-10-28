---
name: openfec-guide
description: Investigate federal campaign funding, outside spending, and FEC legal records with openfec_* tools. Use for candidate-to-committee money trails, historical campaign comparisons, PAC investigations, or checking legal records when complete coverage and correct entity attribution matter.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use OpenFEC for federal campaign-finance research and FEC legal records. Near-real-time e-filing data is outside this server's scope; do not use an empty result to rule out a newly filed report.

## Identifiers

- Resolve a candidate's name with `openfec_search_candidates`. Carry the returned candidate ID and race geography into the investigation.
- Resolve the cycle's principal campaign committee from that candidate's `openfec_lookup_elections` search row: `candidate_pcc_id` identifies the committee and `candidate_pcc_name` names it. Page the race until the candidate is found.
- Use `openfec_search_committees` to resolve a PAC by name or discover a candidate's related committees. Keep each returned committee ID attached to its own records.
- For legal detail, take `no` and `document_type` from `openfec_search_legal`. `openfec_get_legal_document` accepts the plural form of that document type; do not substitute a committee ID or infer a case number from the search text.

## Gates

1. **Establish historical affiliation before attributing money.** A committee's designation is current even when a committee search is cycle-filtered. Do not use a current principal designation as proof of the principal committee for a past race; use the race's candidate row.
2. **Match reporting scope before comparing amounts.** Carry the requested cycle through financial calls and inspect `search_criteria` and coverage dates. Race totals and aggregated independent expenditures can cover a full election period; choose the period the question requires before comparing them with cycle-scoped transactions. Label unequal coverage rather than presenting it as a like-for-like comparison.
3. **Use reported totals for financial summaries.** Start with candidate or committee totals rather than treating a page of transactions as total receipts or spending. A totals lookup with no record can mean no filing for the selected cycle, not an unknown committee.
4. **Preserve committee boundaries.** Candidate totals do not include every leadership PAC or joint fundraising committee associated with that candidate. Retrieve related committees' own totals and report them separately.
5. **Check the selected mode before narrowing a question.** Aggregate modes do not support every itemized filter. If the question depends on a donor, payee, date, or amount filter that only itemized mode supports, use itemized records rather than dropping the filter to obtain an aggregate.
6. **Establish coverage before claiming completeness or absence.** Follow the response's continuation mechanism. A short page can be bounded by the server; an empty page can be an exhausted position in a nonempty result set. Restart an itemized search when changing its filters instead of reusing its cursor. Treat counts marked approximate as estimates.
7. **Read the legal record before characterizing its outcome.** Search results summarize documents, dispositions, and votes. Fetch detail and retrieve any relevant withheld arrays before reporting the record complete. Legal search is full-text rather than entity-linked: no name match does not establish that a committee has no cases.

## Core chain

For a candidate money trail, resolve the candidate, then the cycle's race row, then the principal committee. Read financial totals before drilling into contribution and disbursement breakdowns. Discover related committees separately and retain their identities throughout the analysis.

For a PAC investigation, resolve the committee directly, read its totals, then examine its funding, disbursements, and independent expenditures. Use the candidate IDs on expenditure results to connect the PAC's spending to races.

## Workflows

### Compare campaigns

Reuse the race search to identify opponents. Compare totals and coverage dates first; use contribution-size, geography, employer, and spending breakdowns to explain the differences. For a committee's trajectory, retrieve each comparison cycle explicitly with `openfec_get_committee_totals`; omitting `cycle` can miss historical periods when the committee has changed type. Compare the returned period rows rather than inferring a trend from one cycle.

### Account for outside and party spending

Use `openfec_search_expenditures` to distinguish independent spending supporting a candidate from spending opposing that candidate. Query `openfec_search_coordinated_expenditures` separately for coordinated party spending. Keep both categories distinct from the campaign's own disbursements and identify the spending committee when describing outside support.

### Investigate legal records

Search the entity's name and inspect which document types the applied filters actually cover. If attribution or absence matters, check alternate names from committee records; report the scope searched rather than claiming a complete legal history from one name query.

Fetch relevant search hits with `openfec_get_legal_document`. When a search response supplies per-type continuations, continue each indicated type with the same filters. When detail lists withheld arrays, retrieve the arrays needed for the conclusion and follow their returned offsets until complete. Distinguish a retrieved canonical record from its attached documents; use the returned document links when the underlying filing is needed.
