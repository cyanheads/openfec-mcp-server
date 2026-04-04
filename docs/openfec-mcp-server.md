---
name: openfec-mcp-server
status: researched
priority: high
difficulty: medium
category: government
api_docs: https://api.open.fec.gov/developers/
---

# OpenFEC MCP Server

## Overview

Wraps the FEC's official REST API to give agents access to U.S. federal campaign finance data: candidates, committees, contributions, disbursements, independent expenditures, filings, election summaries, and enforcement actions. Covers presidential, Senate, and House races from 1979-present with nightly data refreshes. Free API key, 1,000 requests/hour (elevated to 7,200 by request).

**Dependencies**: OpenFEC API v1 (free key from api.data.gov), `@cyanheads/mcp-ts-core`

---

## Tools

All tools are read-only and idempotent (`readOnlyHint: true`, `idempotentHint: true`).

### `openfec_search_candidates`

Find federal candidates and retrieve their details, history, and financial totals. Search by name, state, office, party, or election cycle. Retrieve a specific candidate by FEC candidate ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | No | Full-text candidate name search |
| `candidate_id` | string | No | FEC candidate ID (e.g., `P00003392`, `H2CO07170`). First character indicates office: H=House, S=Senate, P=President. |
| `state` | string | No | Two-letter state code |
| `district` | string | No | District number (House candidates) |
| `office` | enum | No | `H` (House), `S` (Senate), `P` (President) |
| `party` | string | No | Three-letter party code (e.g., `DEM`, `REP`) |
| `cycle` | number | No | Two-year election cycle (e.g., `2024`) |
| `election_year` | number | No | Year of the election |
| `incumbent_challenge` | enum | No | `I` (incumbent), `C` (challenger), `O` (open seat) |
| `is_active` | boolean | No | Only active candidates |
| `include_totals` | boolean | No | Include financial totals (receipts, disbursements, cash on hand). Default true for single candidate lookup. |
| `page` | number | No | Page number (1-indexed) |
| `per_page` | number | No | Results per page (max 100) |

**Returns:** Candidate list or detail with name, party, state, office, district, incumbent status, and optionally financial totals (total receipts, disbursements, cash on hand, debt).

---

### `openfec_search_committees`

Find political committees (campaign committees, PACs, Super PACs, party committees) and retrieve their details. Search by name, type, candidate affiliation, or state.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | No | Full-text committee name search |
| `committee_id` | string | No | FEC committee ID (e.g., `C00358796`) |
| `candidate_id` | string | No | Find committees linked to this candidate |
| `state` | string | No | Two-letter state code |
| `party` | string | No | Three-letter party code |
| `committee_type` | enum | No | `H` (House), `S` (Senate), `P` (Presidential), `I` (Independent Expenditure-only/Super PAC), `N` (PAC — qualified), `O` (Independent Expenditure-only — not qualified), `Q` (PAC — unqualified), `V` (Cooperative), `W` (Corporation), `X` (Party — qualified), `Y` (Party — unqualified) |
| `designation` | enum | No | `A` (authorized by candidate), `B` (lobbyist/registrant PAC), `D` (leadership PAC), `J` (joint fundraiser), `P` (principal campaign committee), `U` (unauthorized) |
| `cycle` | number | No | Two-year election cycle |
| `treasurer_name` | string | No | Full-text treasurer name search |
| `page` | number | No | Page number |
| `per_page` | number | No | Results per page (max 100) |

**Returns:** Committee list or detail with name, type, designation, party, treasurer, candidate linkage, filing frequency, and financial summary.

---

### `openfec_search_contributions`

Search itemized individual contributions (Schedule A) to federal committees. Find who donated, how much, and to whom. Also provides aggregate breakdowns by size, state, employer, or occupation.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | enum | No | `itemized` (default) — individual contribution records. `by_size` — aggregate by contribution size bucket. `by_state` — aggregate by contributor state. `by_employer` — aggregate by employer. `by_occupation` — aggregate by occupation. |
| `committee_id` | string | No | Receiving committee ID |
| `candidate_id` | string | No | Candidate ID (aggregate modes only) |
| `contributor_name` | string | No | Full-text donor name search |
| `contributor_employer` | string | No | Full-text employer search |
| `contributor_occupation` | string | No | Full-text occupation search |
| `contributor_city` | string | No | Contributor city |
| `contributor_state` | string | No | Two-letter state code |
| `contributor_zip` | string | No | ZIP code prefix (starts-with match) |
| `cycle` | number | No | Two-year election cycle |
| `min_date` | string | No | Earliest contribution date (ISO 8601 or natural language) |
| `max_date` | string | No | Latest contribution date |
| `min_amount` | number | No | Minimum contribution amount |
| `max_amount` | number | No | Maximum contribution amount |
| `is_individual` | boolean | No | Only individual contributions (excludes committee-to-committee) |
| `sort` | enum | No | `contribution_receipt_date` or `contribution_receipt_amount` |
| `per_page` | number | No | Results per page (max 100) |

**Returns:** Itemized mode: contribution records with donor name, employer, occupation, city/state/ZIP, amount, date, recipient committee, and memo. Aggregate modes: breakdown totals by the selected dimension.

**Pagination note:** Itemized contributions use keyset pagination — the response includes cursor values for the next page rather than page numbers. The tool handles this transparently.

---

### `openfec_search_disbursements`

Search itemized committee spending (Schedule B). Find what committees spent money on, who received payments, and for what purpose. Also provides aggregate breakdowns by purpose or recipient.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | enum | No | `itemized` (default), `by_purpose`, `by_recipient`, `by_recipient_id` |
| `committee_id` | string | No | Spending committee ID |
| `recipient_name` | string | No | Full-text payee name search |
| `recipient_state` | string | No | Recipient state |
| `recipient_city` | string | No | Recipient city |
| `recipient_committee_id` | string | No | Recipient committee ID (committee-to-committee transfers) |
| `disbursement_description` | string | No | Full-text description search |
| `disbursement_purpose_category` | string | No | Purpose category code |
| `cycle` | number | No | Two-year election cycle |
| `min_date` | string | No | Earliest disbursement date |
| `max_date` | string | No | Latest disbursement date |
| `min_amount` | number | No | Minimum amount |
| `max_amount` | number | No | Maximum amount |
| `sort` | enum | No | `disbursement_date` or `disbursement_amount` |
| `per_page` | number | No | Results per page (max 100) |

**Returns:** Itemized mode: disbursement records with recipient, amount, date, purpose description, and committee. Aggregate modes: totals by purpose category or recipient.

**Pagination note:** Uses keyset pagination (same as contributions).

---

### `openfec_search_expenditures`

Search independent expenditures (Schedule E) — spending by outside groups (Super PACs, party committees) explicitly supporting or opposing federal candidates. A key dataset for tracking outside money in elections.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | enum | No | `itemized` (default), `by_candidate` — aggregated totals per candidate |
| `committee_id` | string | No | Spending committee ID |
| `candidate_id` | string | No | Targeted candidate ID |
| `support_oppose` | enum | No | `S` (support) or `O` (oppose) |
| `payee_name` | string | No | Full-text payee name search |
| `candidate_office` | enum | No | `H`, `S`, `P` |
| `candidate_office_state` | string | No | State of the targeted race |
| `candidate_party` | string | No | Party of the targeted candidate |
| `cycle` | number | No | Two-year election cycle |
| `min_date` | string | No | Earliest expenditure date |
| `max_date` | string | No | Latest expenditure date |
| `min_amount` | number | No | Minimum amount |
| `max_amount` | number | No | Maximum amount |
| `is_notice` | boolean | No | 24/48-hour notice filings (near-election spending) |
| `most_recent` | boolean | No | Only the most recent version of amended filings |
| `sort` | enum | No | `expenditure_date`, `expenditure_amount`, `office_total_ytd` |
| `per_page` | number | No | Results per page (max 100) |

**Returns:** Itemized mode: expenditure records with spender, payee, amount, date, support/oppose indicator, targeted candidate, and office. Aggregate mode: total spending for/against each candidate by committee.

**Pagination note:** Uses keyset pagination.

---

### `openfec_search_filings`

Search FEC filings and reports by committee, candidate, form type, or date range. Covers all disclosure documents: financial reports, statements of candidacy, organizational filings, and amendments.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `committee_id` | string | No | Filing committee ID |
| `candidate_id` | string | No | Associated candidate ID |
| `filer_name` | string | No | Full-text filer name search |
| `form_type` | string | No | FEC form type (e.g., `F3` quarterly report, `F3P` presidential, `F3X` PAC/party, `F24` 24-hour IE notice, `F1` statement of organization) |
| `report_type` | string | No | Report type code (e.g., `Q1`, `Q2`, `Q3`, `YE`, `M3`-`M12`, `12G`, `12P`, `30G`) |
| `report_year` | number | No | Filing year |
| `cycle` | number | No | Two-year election cycle |
| `is_amended` | boolean | No | Only original or only amended filings |
| `most_recent` | boolean | No | Only the most recent version (filters out superseded amendments) |
| `min_receipt_date` | string | No | Earliest date FEC received the filing |
| `max_receipt_date` | string | No | Latest receipt date |
| `page` | number | No | Page number |
| `per_page` | number | No | Results per page (max 100) |

**Returns:** Filing list with form type, report type, filer, receipt date, coverage period, amendment info, total receipts/disbursements, cash on hand, and PDF link.

---

### `openfec_lookup_elections`

Look up federal election races and financial summaries. Find all candidates running in a given race with their fundraising totals, or get aggregate financial summaries for a race.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | enum | No | `search` (default) — find elections. `summary` — aggregate race financial summary. |
| `office` | enum | Yes | `president`, `senate`, `house` |
| `cycle` | number | Yes | Election cycle year (e.g., `2024`) |
| `state` | string | No | Two-letter state code (required for Senate/House) |
| `district` | string | No | District number (required for House) |
| `zip` | string | No | ZIP code (search mode — finds races covering this ZIP) |
| `election_full` | boolean | No | Expand to full election period: 4 years for President, 6 for Senate, 2 for House. Default true. |

**Returns:** Search mode: list of candidates in the race with total receipts, disbursements, cash on hand, and committee IDs. Summary mode: aggregate receipts, disbursements, and independent expenditure totals for the race.

---

### `openfec_search_legal`

Search FEC legal documents: advisory opinions (AOs), enforcement cases (Matters Under Review), alternative dispute resolutions, and administrative fines. Useful for understanding campaign finance rules and precedent.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | No | Full-text search across legal documents |
| `type` | enum | No | `advisory_opinions`, `murs` (Matters Under Review), `adrs` (Alternative Dispute Resolution), `admin_fines`, `statutes`. Omit to search all. |
| `ao_number` | string | No | Specific advisory opinion number |
| `case_number` | string | No | Specific MUR/ADR case number |
| `respondent` | string | No | Respondent name (enforcement cases) |
| `regulatory_citation` | string | No | CFR citation (e.g., `11 CFR 112.4`) |
| `statutory_citation` | string | No | U.S.C. citation (e.g., `52 U.S.C. 30106`) |
| `min_penalty_amount` | number | No | Minimum penalty amount (enforcement cases) |
| `max_penalty_amount` | number | No | Maximum penalty amount |
| `min_date` | string | No | Earliest document date |
| `max_date` | string | No | Latest document date |
| `hits_returned` | number | No | Results per page (max 200) |

**Returns:** Legal document list with type, number/name, date, summary/description, citations, and disposition. Enforcement cases include respondents, penalty amounts, and case status.

**Note:** Legal search is powered by OpenSearch — supports proximity search and returns highlighted snippets.

---

### `openfec_lookup_calendar`

Look up FEC calendar events, filing deadlines, and election dates. Useful for understanding the campaign finance reporting schedule.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | enum | No | `events` (default) — FEC calendar events. `filing_deadlines` — report due dates. `election_dates` — upcoming elections. |
| `state` | string | No | Two-letter state code (election dates) |
| `office` | enum | No | Office sought (election dates) |
| `report_type` | string | No | Report type code (filing deadlines) |
| `report_year` | number | No | Report year (filing deadlines) |
| `election_year` | number | No | Election year |
| `description` | string | No | Full-text event description search |
| `min_date` | string | No | Earliest date |
| `max_date` | string | No | Latest date |
| `page` | number | No | Page number |
| `per_page` | number | No | Results per page (max 100) |

**Returns:** Events mode: calendar entries with date, category, description. Filing deadlines: report type, due date, coverage period. Election dates: state, office, election type, date.

---

## Resources

All resource data is also reachable via tools.

| URI | Description |
|---|---|
| `openfec://candidate/{candidate_id}` | Candidate profile with financial totals |
| `openfec://committee/{committee_id}` | Committee profile with type, designation, and financial summary |
| `openfec://election/{cycle}/{office}/{state}/{district}` | Election race summary |

---

## Prompts

| Prompt | Description |
|---|---|
| `openfec_money_trail` | Framework for tracing the flow of money around a candidate or race: direct fundraising, PAC support, independent expenditures, and party spending |
| `openfec_campaign_analysis` | Structured analysis of a candidate's financial position: fundraising trajectory, burn rate, cash reserves, donor base composition, and comparison to opponents |

---

## Implementation Notes

- **Auth**: Free API key from [api.data.gov](https://api.data.gov/signup/). Set `FEC_API_KEY` env var. `DEMO_KEY` available for testing but severely rate-limited.
- **Rate limit**: 1,000 requests/hour standard. Request elevated access (7,200/hour) via APIinfo@fec.gov for production use.
- **Pagination**: Two models — page-based (most endpoints) and keyset/seek-based (Schedule A, B, E, H4, electioneering). Keyset endpoints return `last_indexes` cursor values instead of page numbers. The server must handle both transparently.
- **Per-page cap**: 100 results maximum per request across all endpoints.
- **Data freshness**: Nightly refresh from FEC's master database. E-file endpoints have near-real-time data but only retain ~4 months.
- **Legal search**: Uses OpenSearch with a different pagination model (`from_hit`/`hits_returned`, max 200). Supports proximity search.
- **Data restrictions**: Contributor data cannot be used for commercial solicitation (federal law).
- **Response caching**: API responses carry `Cache-Control: public, max-age=3600` (1 hour). Server-side caching is worthwhile.
- **ID formats**: Candidate IDs start with H/S/P prefix + digits. Committee IDs start with `C` + digits.

---

## References

- [OpenFEC API Interactive Docs](https://api.open.fec.gov/developers/)
- [api.data.gov signup](https://api.data.gov/signup/)
- [OpenFEC source (GitHub)](https://github.com/fecgov/openFEC)
- [FEC.gov](https://www.fec.gov/)
- [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
