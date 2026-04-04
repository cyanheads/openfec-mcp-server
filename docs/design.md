# OpenFEC MCP Server — Design

## MCP Surface

### Tools

All tools are read-only and idempotent (`readOnlyHint: true`, `idempotentHint: true`).

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `openfec_search_candidates` | Find federal candidates by name, state, office, party, or cycle. Retrieve a specific candidate by FEC ID with financial totals. | `query`, `candidate_id`, `state`, `office`, `party`, `cycle`, `include_totals` | readOnly, idempotent |
| `openfec_search_committees` | Find political committees (campaign, PAC, Super PAC, party) by name, type, candidate affiliation, or state. | `query`, `committee_id`, `candidate_id`, `state`, `committee_type`, `designation`, `cycle` | readOnly, idempotent |
| `openfec_search_contributions` | Search itemized individual contributions (Schedule A) or get aggregate breakdowns by size, state, employer, or occupation. | `mode`, `committee_id`, `candidate_id`, `contributor_name`, `contributor_state`, `cycle`, `min_amount`, `max_amount` | readOnly, idempotent |
| `openfec_search_disbursements` | Search itemized committee spending (Schedule B) or get aggregate breakdowns by purpose or recipient. | `mode`, `committee_id`, `recipient_name`, `disbursement_description`, `cycle`, `min_amount`, `max_amount` | readOnly, idempotent |
| `openfec_search_expenditures` | Search independent expenditures (Schedule E) — outside spending supporting or opposing federal candidates. | `mode`, `committee_id`, `candidate_id`, `support_oppose`, `cycle`, `min_amount`, `max_amount` | readOnly, idempotent |
| `openfec_search_filings` | Search FEC filings and reports by committee, candidate, form type, or date range. | `committee_id`, `candidate_id`, `form_type`, `report_type`, `cycle`, `most_recent` | readOnly, idempotent |
| `openfec_lookup_elections` | Look up federal election races and candidate financial summaries. Find who's running with fundraising totals. | `mode`, `office`, `cycle`, `state`, `district` | readOnly, idempotent |
| `openfec_search_legal` | Search FEC legal documents: advisory opinions, enforcement cases (MURs), alternative dispute resolutions, and administrative fines. | `query`, `type`, `ao_number`, `case_number`, `respondent` | readOnly, idempotent |
| `openfec_lookup_calendar` | Look up FEC calendar events, filing deadlines, and election dates. | `mode`, `state`, `min_date`, `max_date` | readOnly, idempotent |

### Resources

All resource data is also reachable via tools. Resources add convenience for clients that support injectable context.

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `openfec://candidate/{candidate_id}` | Candidate profile with current financial totals | No |
| `openfec://committee/{committee_id}` | Committee profile with type, designation, and financial summary | No |
| `openfec://election/{cycle}/{office}` | Election race summary. `state` and `district` appended as path segments when applicable (e.g., `openfec://election/2024/senate/AZ`). | No |

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `openfec_money_trail` | Framework for tracing the flow of money around a candidate or race — direct fundraising, PAC support, independent expenditures, and party spending. Guides the agent through a multi-tool investigation. | `candidate_name` or `candidate_id`, `cycle` (optional) |
| `openfec_campaign_analysis` | Structured analysis of a candidate's financial position — fundraising trajectory, burn rate, cash reserves, donor composition, and opponent comparison. | `candidate_name` or `candidate_id`, `cycle` (optional) |

---

## Overview

Wraps the FEC's official REST API (OpenFEC v1) to give agents access to U.S. federal campaign finance data. Covers presidential, Senate, and House races from 1979–present with nightly data refreshes.

**Target users:** Agents investigating campaign finance — journalists, researchers, policy analysts, or anyone asking questions like "who's funding this candidate?", "how much has this PAC spent?", or "what's the fundraising picture in this race?"

**Scope:** Read-only. No write operations. The API is entirely public data.

---

## Requirements

- Free API key from [api.data.gov](https://api.data.gov/signup/). `DEMO_KEY` available for testing (severely rate-limited: ~40 requests/hour)
- Standard key: 1,000 requests/hour. Elevated key (email `APIinfo@fec.gov`): 120 requests/minute (7,200/hour)
- All endpoints read-only, no auth scopes needed beyond API key
- Must handle two pagination models transparently (page-based and keyset)
- Legal search uses a third pagination model (`from_hit`/`hits_returned`) with type-keyed result arrays
- Schedule A (contributions) requires `two_year_transaction_period` parameter — derive from `cycle`
- Contributor data cannot be used for commercial solicitation (federal law)
- API responses carry `Cache-Control: public, max-age=3600` — server-side caching worthwhile

---

## Tool Design Detail

### `openfec_search_candidates`

Find federal candidates and retrieve their details, history, and financial totals.

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `query` | string | No | Full-text candidate name search. |
| `candidate_id` | string | No | FEC candidate ID (e.g., `P00003392`, `H2CO07170`). First character indicates office: H=House, S=Senate, P=President. When provided, returns a single candidate with full detail. |
| `state` | string | No | Two-letter US state code (e.g., `AZ`, `CA`). |
| `district` | string | No | Two-digit district number for House candidates (e.g., `07`). |
| `office` | `H` \| `S` \| `P` | No | Filter by office: H=House, S=Senate, P=President. |
| `party` | string | No | Three-letter party code (e.g., `DEM`, `REP`, `LIB`, `GRE`). |
| `cycle` | number | No | Two-year election cycle (e.g., `2024`). Even years only. |
| `election_year` | number | No | Specific election year the candidate ran in. |
| `incumbent_challenge` | `I` \| `C` \| `O` | No | Incumbent status: I=incumbent, C=challenger, O=open seat. |
| `candidate_status` | `C` \| `F` \| `N` \| `P` | No | Candidate status: C=present candidate, F=future candidate, N=not yet a candidate, P=prior candidate. |
| `has_raised_funds` | boolean | No | Only candidates whose committee has received receipts for this office. Useful for filtering out paperwork-only candidates. |
| `include_totals` | boolean | No | Include financial totals (receipts, disbursements, cash on hand, debt). Defaults to true when fetching a single candidate by ID. Adds a second API call. |
| `page` | number | No | Page number (1-indexed). Default 1. |
| `per_page` | number | No | Results per page. Default 20, max 100. |

**Output:** Candidate records with: `candidate_id`, `name`, `party`/`party_full`, `state`, `office`/`office_full`, `district_number`, `incumbent_challenge`/`incumbent_challenge_full`, `cycles`, `election_years`, `candidate_status`, `first_file_date`, `has_raised_funds`. When `include_totals` is true: `receipts`, `disbursements`, `cash_on_hand_end_period`, `debts_owed_by_committee`, `individual_itemized_contributions`, `coverage_start_date`, `coverage_end_date`.

**Pagination:** Page-based. Response includes `page`, `pages`, `count`, `per_page`.

**Error modes:**
- Invalid `candidate_id` format → `InvalidParams`: "Invalid candidate ID format. FEC candidate IDs start with H (House), S (Senate), or P (President) followed by digits (e.g., 'P00003392')."
- No results → Empty result array (not an error). Format message: "No candidates found matching the given criteria."

**Upstream endpoints:**
- `/v1/candidates/` — search with filters
- `/v1/candidates/{candidate_id}/` — single candidate lookup
- `/v1/candidates/totals/` — financial totals (when `include_totals` is true)

---

### `openfec_search_committees`

Find political committees — campaign committees, PACs, Super PACs, party committees.

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `query` | string | No | Full-text committee name search. |
| `committee_id` | string | No | FEC committee ID (e.g., `C00358796`). Starts with `C` followed by digits. Returns a single committee with full detail. |
| `candidate_id` | string | No | Find committees linked to this candidate (authorized, leadership, joint fundraising). |
| `state` | string | No | Two-letter state code. |
| `party` | string | No | Three-letter party code. |
| `committee_type` | string | No | Committee type code. Common values: `H` (House), `S` (Senate), `P` (Presidential), `O` (Super PAC — independent expenditure-only), `N` (PAC nonqualified), `Q` (PAC qualified), `X` (Party nonqualified), `Y` (Party qualified). Full list: `C` (communication cost), `D` (delegate), `E` (electioneering communication), `I` (independent expenditure filer — not a committee), `U` (single candidate IE), `V` (PAC with non-contribution account, nonqualified), `W` (PAC with non-contribution account, qualified), `Z` (national party non-federal account). |
| `designation` | string | No | Committee designation. `A` (authorized by candidate), `B` (lobbyist/registrant PAC), `D` (leadership PAC), `J` (joint fundraiser), `P` (principal campaign committee), `U` (unauthorized). |
| `cycle` | number | No | Two-year election cycle. |
| `treasurer_name` | string | No | Full-text treasurer name search. |
| `page` | number | No | Page number. Default 1. |
| `per_page` | number | No | Results per page. Default 20, max 100. |

**Output:** Committee records with: `committee_id`, `name`, `committee_type`/`committee_type_full`, `designation`/`designation_full`, `party`/`party_full`, `state`, `treasurer_name`, `filing_frequency`, `organization_type`/`organization_type_full`, `candidate_ids`, `cycles`, `first_file_date`, `last_file_date`.

**Pagination:** Page-based.

**Error modes:**
- Invalid `committee_id` format → `InvalidParams`: "Invalid committee ID format. FEC committee IDs start with 'C' followed by digits (e.g., 'C00358796')."

**Upstream endpoints:**
- `/v1/committees/` — search with filters
- `/v1/committees/{committee_id}/` — single committee lookup

---

### `openfec_search_contributions`

Search itemized individual contributions (Schedule A) or get aggregate breakdowns. Central tool for answering "who's funding this candidate/committee?"

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `mode` | enum | No | `itemized` (default) — individual contribution records. `by_size` — aggregate by contribution size bucket ($200 and under, $200.01–$499.99, etc.). `by_state` — aggregate by contributor state. `by_employer` — aggregate by employer. `by_occupation` — aggregate by occupation. |
| `committee_id` | string | No | Receiving committee ID. Required for `itemized`, `by_employer`, `by_occupation` modes. |
| `candidate_id` | string | No | Candidate ID. Used for `by_size` and `by_state` aggregate modes (routes to the `/by_candidate` variant). |
| `contributor_name` | string | No | Full-text donor name search. Itemized mode only. |
| `contributor_employer` | string | No | Full-text employer search. Itemized mode only. |
| `contributor_occupation` | string | No | Full-text occupation search. Itemized mode only. |
| `contributor_city` | string | No | Contributor city. Itemized mode only. |
| `contributor_state` | string | No | Two-letter state code. Itemized mode only. |
| `contributor_zip` | string | No | ZIP code prefix (starts-with match). Itemized mode only. |
| `cycle` | number | No | Two-year election cycle. For itemized mode, this sets `two_year_transaction_period` (required by the API). Defaults to current cycle if omitted. |
| `min_date` | string | No | Earliest contribution date (YYYY-MM-DD). Itemized mode only. |
| `max_date` | string | No | Latest contribution date (YYYY-MM-DD). Itemized mode only. |
| `min_amount` | number | No | Minimum contribution amount in dollars. Itemized mode only. |
| `max_amount` | number | No | Maximum contribution amount in dollars. Itemized mode only. |
| `is_individual` | boolean | No | Only individual contributions (excludes committee-to-committee transfers). Itemized mode only. |
| `sort` | `contribution_receipt_date` \| `contribution_receipt_amount` | No | Sort field. Itemized mode only. |
| `per_page` | number | No | Results per page. Default 20, max 100. |
| `cursor` | string | No | Opaque pagination cursor from a previous response. Itemized mode uses keyset pagination — pass the cursor to get the next page. |

**Output:**
- *Itemized:* Contribution records with: `contributor_name`, `contributor_employer`, `contributor_occupation`, `contributor_city`, `contributor_state`, `contributor_zip`, `contribution_receipt_amount`, `contribution_receipt_date`, `contributor_aggregate_ytd`, `committee_id`, `committee_name`, `candidate_id`, `candidate_name`, `receipt_type_full`, `is_individual`, `memo_text`, `pdf_url`. Plus `next_cursor` for pagination.
- *Aggregates:* Records with: dimension field (`size`, `state`, `employer`, `occupation`), `count`, `total`, `cycle`, and either `committee_id` or `candidate_id`.

**Pagination:**
- Itemized: Keyset (SEEK). Response includes `next_cursor` (opaque string encoding `last_indexes`). Pass as `cursor` to get next page.
- Aggregates: Page-based.

**Error modes:**
- Itemized without `committee_id` → `InvalidParams`: "Itemized contribution search requires a committee_id. To search contributions by candidate, use a 'by_size' or 'by_state' aggregate mode with candidate_id, or first look up the candidate's committee with openfec_search_committees."
- `by_employer`/`by_occupation` without `committee_id` → `InvalidParams`: "Aggregate by employer/occupation requires a committee_id."
- Missing `cycle` on itemized → auto-default to current cycle (API requires `two_year_transaction_period`).

**Upstream endpoints:**
- `/v1/schedules/schedule_a/` — itemized contributions (SEEK)
- `/v1/schedules/schedule_a/by_size/` — aggregate by size (committee)
- `/v1/schedules/schedule_a/by_size/by_candidate/` — aggregate by size (candidate)
- `/v1/schedules/schedule_a/by_state/` — aggregate by state (committee)
- `/v1/schedules/schedule_a/by_state/by_candidate/` — aggregate by state (candidate)
- `/v1/schedules/schedule_a/by_employer/` — aggregate by employer
- `/v1/schedules/schedule_a/by_occupation/` — aggregate by occupation

---

### `openfec_search_disbursements`

Search itemized committee spending (Schedule B) or get aggregate breakdowns. Answers "what is this committee spending money on?"

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `mode` | enum | No | `itemized` (default) — individual disbursement records. `by_purpose` — aggregate by purpose category. `by_recipient` — aggregate by recipient name. `by_recipient_id` — aggregate by recipient committee ID (committee-to-committee transfers). |
| `committee_id` | string | No | Spending committee ID. Required for all modes. |
| `recipient_name` | string | No | Full-text payee name search. Itemized mode only. |
| `recipient_state` | string | No | Recipient state. Itemized mode only. |
| `recipient_city` | string | No | Recipient city. Itemized mode only. |
| `recipient_committee_id` | string | No | Recipient committee ID (for committee-to-committee transfers). Itemized mode only. |
| `disbursement_description` | string | No | Full-text description search (e.g., "media buy", "consulting"). Itemized mode only. |
| `disbursement_purpose_category` | string | No | Purpose category code. Itemized mode only. |
| `cycle` | number | No | Two-year election cycle. |
| `min_date` | string | No | Earliest disbursement date (YYYY-MM-DD). Itemized mode only. |
| `max_date` | string | No | Latest disbursement date (YYYY-MM-DD). Itemized mode only. |
| `min_amount` | number | No | Minimum amount. Itemized mode only. |
| `max_amount` | number | No | Maximum amount. Itemized mode only. |
| `sort` | `disbursement_date` \| `disbursement_amount` | No | Sort field. Itemized mode only. |
| `per_page` | number | No | Results per page. Default 20, max 100. |
| `cursor` | string | No | Opaque pagination cursor from a previous response. Itemized mode only. |

**Output:**
- *Itemized:* Disbursement records with: `recipient_name`, `recipient_city`, `recipient_state`, `recipient_zip`, `disbursement_amount`, `disbursement_date`, `disbursement_description`, `disbursement_purpose_category`, `committee_id`, `committee_name`, `candidate_id`, `candidate_name`, `entity_type`, `memo_text`, `pdf_url`. Plus `next_cursor`.
- *by_purpose:* Records with: `purpose`, `count`, `total`, `memo_count`, `memo_total`, `cycle`, `committee_id`.
- *by_recipient:* Records with: `recipient_name`, `count`, `total`, `recipient_disbursement_percent`, `cycle`, `committee_id`.
- *by_recipient_id:* Records with: `recipient_id`, `recipient_name`, `committee_name`, `count`, `total`, `cycle`.

**Pagination:** Itemized: keyset. Aggregates: page-based.

**Error modes:**
- Missing `committee_id` → `InvalidParams`: "Disbursement search requires a committee_id. Use openfec_search_committees to find a committee's ID."

**Upstream endpoints:**
- `/v1/schedules/schedule_b/` — itemized (SEEK)
- `/v1/schedules/schedule_b/by_purpose/` — aggregate by purpose
- `/v1/schedules/schedule_b/by_recipient/` — aggregate by recipient name
- `/v1/schedules/schedule_b/by_recipient_id/` — aggregate by recipient committee

---

### `openfec_search_expenditures`

Search independent expenditures (Schedule E) — spending by outside groups (Super PACs, party committees) explicitly supporting or opposing federal candidates. Key dataset for tracking outside money.

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `mode` | enum | No | `itemized` (default) — individual expenditure records. `by_candidate` — aggregated totals per candidate by committee. |
| `committee_id` | string | No | Spending committee ID. |
| `candidate_id` | string | No | Targeted candidate ID. |
| `support_oppose` | `S` \| `O` | No | `S` = support, `O` = oppose. |
| `payee_name` | string | No | Full-text payee name search. Itemized mode only. |
| `candidate_office` | `H` \| `S` \| `P` | No | Office of the targeted candidate. |
| `candidate_office_state` | string | No | State of the targeted race. |
| `candidate_party` | string | No | Party of the targeted candidate. |
| `cycle` | number | No | Two-year election cycle. |
| `min_date` | string | No | Earliest expenditure date (YYYY-MM-DD). Itemized mode only. |
| `max_date` | string | No | Latest expenditure date (YYYY-MM-DD). Itemized mode only. |
| `min_amount` | number | No | Minimum amount. Itemized mode only. |
| `max_amount` | number | No | Maximum amount. Itemized mode only. |
| `is_notice` | boolean | No | Only 24/48-hour notice filings (near-election spending). Itemized mode only. |
| `most_recent` | boolean | No | Only the most recent version of amended filings. Default true. Itemized mode only. |
| `sort` | `expenditure_date` \| `expenditure_amount` \| `office_total_ytd` | No | Sort field. Itemized mode only. |
| `per_page` | number | No | Results per page. Default 20, max 100. |
| `cursor` | string | No | Opaque pagination cursor. Itemized mode only. |

**Output:**
- *Itemized:* Expenditure records with: `committee_id`, `committee_name`, `payee_name`, `expenditure_amount`, `expenditure_date`, `expenditure_description`, `support_oppose_indicator`, `candidate_id`, `candidate_name`, `candidate_office`, `candidate_office_state`, `candidate_party`, `is_notice`, `dissemination_date`, `office_total_ytd`, `most_recent`, `pdf_url`. Plus `next_cursor`.
- *by_candidate:* Records with: `candidate_id`, `candidate_name`, `committee_id`, `committee_name`, `support_oppose_indicator`, `count`, `total`, `cycle`.

**Pagination:** Itemized: keyset. Aggregate: page-based.

**Upstream endpoints:**
- `/v1/schedules/schedule_e/` — itemized (SEEK)
- `/v1/schedules/schedule_e/by_candidate/` — aggregate by candidate

---

### `openfec_search_filings`

Search FEC filings and reports. Covers all disclosure documents: financial reports (F3/F3P/F3X), statements of candidacy, organizational filings, and amendments.

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `committee_id` | string | No | Filing committee ID. |
| `candidate_id` | string | No | Associated candidate ID. |
| `filer_name` | string | No | Full-text filer name search. |
| `form_type` | string | No | FEC form type. Common values: `F3` (House/Senate quarterly), `F3P` (Presidential), `F3X` (PAC/party), `F24` (24-hour IE notice), `F1` (statement of organization), `F2` (statement of candidacy), `F5` (IE by persons other than committees). |
| `report_type` | string | No | Report type code. Common values: `Q1`/`Q2`/`Q3` (quarterly), `YE` (year-end), `M3`–`M12` (monthly), `12G`/`12P`/`30G` (pre/post election). |
| `report_year` | number | No | Filing year. |
| `cycle` | number | No | Two-year election cycle. |
| `is_amended` | boolean | No | Filter to original or amended filings only. |
| `most_recent` | boolean | No | Only the most recent version (filters out superseded amendments). Default true. |
| `min_receipt_date` | string | No | Earliest date FEC received the filing (YYYY-MM-DD). |
| `max_receipt_date` | string | No | Latest FEC receipt date (YYYY-MM-DD). |
| `page` | number | No | Page number. Default 1. |
| `per_page` | number | No | Results per page. Default 20, max 100. |

**Output:** Filing records with: `committee_id`, `committee_name`, `candidate_id`, `candidate_name`, `form_type`, `form_category`, `report_type`/`report_type_full`, `report_year`, `receipt_date`, `coverage_start_date`, `coverage_end_date`, `is_amended`, `most_recent`, `amendment_chain`, `total_receipts`, `total_disbursements`, `total_individual_contributions`, `cash_on_hand_beginning_period`, `cash_on_hand_end_period`, `debts_owed_by_committee`, `pdf_url`, `csv_url`, `fec_file_id`, `means_filed`, `pages`.

**Pagination:** Page-based (but `is_count_exact` may be false on large result sets).

**Upstream endpoints:**
- `/v1/filings/` — search with filters

---

### `openfec_lookup_elections`

Look up federal election races and candidate financial summaries. Answers "who's running and how much have they raised?"

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `mode` | enum | No | `search` (default) — find candidates in a race with financial totals. `summary` — aggregate race financial summary. |
| `office` | `president` \| `senate` \| `house` | Yes | Office sought. |
| `cycle` | number | Yes | Election cycle year (e.g., `2024`). Even years only. |
| `state` | string | No | Two-letter state code. Required for Senate and House races. |
| `district` | string | No | Two-digit district number. Required for House races. |
| `zip` | string | No | ZIP code — finds races covering this ZIP. Search mode only. |
| `election_full` | boolean | No | Expand to full election period: 4 years for President, 6 for Senate, 2 for House. Default true. |

**Output:**
- *Search:* Candidate records in the race with: `candidate_id`, `candidate_name`, `candidate_pcc_id`, `candidate_pcc_name`, `party_full`, `incumbent_challenge_full`, `total_receipts`, `total_disbursements`, `cash_on_hand_end_period`, `coverage_end_date`, `committee_ids`.
- *Summary:* Aggregate totals for the race.

**Pagination:** Page-based.

**Error modes:**
- Senate/House without `state` → `InvalidParams`: "Senate and House election lookups require a state. Provide a two-letter state code."
- House without `district` → `InvalidParams`: "House election lookups require a district number."
- Odd cycle year → `InvalidParams`: "Election cycles are even years (e.g., 2024, 2026)."

**Upstream endpoints:**
- `/v1/elections/` — candidates in a race
- `/v1/elections/summary/` — aggregate race summary

---

### `openfec_search_legal`

Search FEC legal documents. Powered by OpenSearch with proximity search and highlighted snippets.

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `query` | string | No | Full-text search across legal documents. Supports proximity search. |
| `type` | enum | No | `advisory_opinions`, `murs` (Matters Under Review), `adrs` (Alternative Dispute Resolution), `admin_fines`, `statutes`. Omit to search all types. |
| `ao_number` | string | No | Specific advisory opinion number (e.g., `2024-01`). |
| `case_number` | string | No | Specific MUR or ADR case number. |
| `respondent` | string | No | Respondent name (enforcement cases). |
| `regulatory_citation` | string | No | CFR citation (e.g., `11 CFR 112.4`). |
| `statutory_citation` | string | No | U.S.C. citation (e.g., `52 U.S.C. 30106`). |
| `min_penalty_amount` | number | No | Minimum penalty amount (enforcement cases). |
| `max_penalty_amount` | number | No | Maximum penalty amount. |
| `min_date` | string | No | Earliest document date (YYYY-MM-DD). |
| `max_date` | string | No | Latest document date (YYYY-MM-DD). |
| `from_hit` | number | No | Offset for pagination (0-indexed). Default 0. |
| `hits_returned` | number | No | Results per page. Default 20, max 200. |

**Output:** Varies by `type`:
- *Advisory opinions:* `ao_no`, `name`, `summary`, `issue_date`, `request_date`, `status`, `requestor_names`, `regulatory_citations`, `statutory_citations`, `highlights`, `documents` (array with `url`, `filename`, `category`).
- *MURs:* Case number, name, respondents, penalty amounts, disposition, citations.
- *Admin fines:* Case details, penalty amounts, respondents.
- *Statutes:* Citation, title, text.

The server normalizes the type-keyed response arrays into a uniform `results` array with a `document_type` discriminator.

**Pagination:** Custom model — `from_hit`/`hits_returned` (not page-based). The tool exposes this directly since it differs from other tools. Response includes `total_count` for the queried type(s).

**Error modes:**
- No `query` or `type` or specific identifier → `InvalidParams`: "Provide at least a search query, document type, or specific identifier (ao_number, case_number)."

**Upstream endpoints:**
- `/v1/legal/search/` — unified legal search

---

### `openfec_lookup_calendar`

Look up FEC calendar events, filing deadlines, and election dates.

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `mode` | enum | No | `events` (default) — FEC calendar events. `filing_deadlines` — report due dates. `election_dates` — upcoming/past elections. |
| `state` | string | No | Two-letter state code. Election dates mode. |
| `office` | `H` \| `S` \| `P` | No | Office sought. Election dates mode. |
| `report_type` | string | No | Report type code (e.g., `Q1`, `Q2`). Filing deadlines. Events mode calendar category search. |
| `report_year` | number | No | Report year. Filing deadlines. |
| `election_year` | number | No | Election year. Election dates mode. |
| `description` | string | No | Full-text event description search. Events mode. |
| `min_date` | string | No | Earliest date (YYYY-MM-DD). |
| `max_date` | string | No | Latest date (YYYY-MM-DD). |
| `page` | number | No | Page number. Default 1. |
| `per_page` | number | No | Results per page. Default 20, max 100. |

**Output:**
- *Events:* `event_id`, `summary`, `description`, `category`, `start_date`, `end_date`, `location`, `url`, `all_day`.
- *Filing deadlines:* `report_type`, `due_date`, `coverage_start_date`, `coverage_end_date`, `report_year`.
- *Election dates:* `election_date`, `election_state`, `election_type_full`, `election_year`, `office_sought`, `election_party`, `election_district`, `election_notes`.

**Pagination:** Page-based.

**Upstream endpoints:**
- `/v1/calendar-dates/` — calendar events
- `/v1/reporting-dates/` — filing deadlines
- `/v1/election-dates/` — election dates

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OpenFecService` | OpenFEC REST API v1 (`https://api.open.fec.gov/v1`) | All tools and resources |

### `OpenFecService` design

Single service wrapping all API interactions. Uses `fetchWithTimeout` from `@cyanheads/mcp-ts-core/utils`.

**Methods by group:**

| Method | Endpoint(s) | Pagination |
|:-------|:------------|:-----------|
| `searchCandidates(params)` | `/candidates/`, `/candidates/{id}/` | Offset |
| `getCandidateTotals(params)` | `/candidates/totals/` | Offset |
| `searchCommittees(params)` | `/committees/`, `/committees/{id}/` | Offset |
| `searchContributions(params)` | `/schedules/schedule_a/` | Seek |
| `getContributionAggregates(mode, params)` | `/schedules/schedule_a/by_*` | Offset |
| `searchDisbursements(params)` | `/schedules/schedule_b/` | Seek |
| `getDisbursementAggregates(mode, params)` | `/schedules/schedule_b/by_*` | Offset |
| `searchExpenditures(params)` | `/schedules/schedule_e/` | Seek |
| `getExpendituresByCandidate(params)` | `/schedules/schedule_e/by_candidate/` | Offset |
| `searchFilings(params)` | `/filings/` | Offset |
| `searchElections(params)` | `/elections/` | Offset |
| `getElectionSummary(params)` | `/elections/summary/` | Offset |
| `searchLegal(params)` | `/legal/search/` | Custom |
| `getCalendarDates(params)` | `/calendar-dates/` | Offset |
| `getReportingDates(params)` | `/reporting-dates/` | Offset |
| `getElectionDates(params)` | `/election-dates/` | Offset |

**Resilience:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Wraps full request (fetch + JSON parse). `withRetry` from `/utils`. |
| Backoff calibration | 1s base delay (rate-limit oriented). The API's 429 includes `Retry-After` header — honor it when present. |
| Max retries | 3 (configurable via `FEC_MAX_RETRIES`). |
| HTTP status check | `fetchWithTimeout` handles non-OK → `ServiceUnavailable`. 429 specifically → retry with backoff. |
| Parse failure | Detect HTML error pages (FEC occasionally returns these) → transient error, retry. |
| Rate limit awareness | Track remaining calls via `X-RateLimit-Remaining` header. Log warnings at 10% remaining. |

**Internal helpers:**

| Helper | Purpose |
|:-------|:--------|
| `buildUrl(path, params)` | Construct URL with query params, inject `api_key`, strip undefined values. |
| `fetchJson<T>(path, params)` | `fetchWithTimeout` → JSON parse → validate envelope → return `{ pagination, results }`. |
| `fetchSeek<T>(path, params)` | Like `fetchJson` but returns `{ pagination, results, nextCursor }` from `last_indexes`. |
| `fetchLegal<T>(params)` | Special handling for legal search response shape. |
| `encodeCursor(lastIndexes)` | Base64-encode `last_indexes` into an opaque cursor string. |
| `decodeCursor(cursor)` | Decode cursor back to `last_indexes` query params. |

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `FEC_API_KEY` | Yes | — | OpenFEC API key from api.data.gov. `DEMO_KEY` for testing. |
| `FEC_BASE_URL` | No | `https://api.open.fec.gov/v1` | API base URL. |
| `FEC_MAX_RETRIES` | No | `3` | Max retry attempts for failed requests. |
| `FEC_REQUEST_TIMEOUT` | No | `30000` | Request timeout in milliseconds. |

---

## Domain Mapping

| Noun | Operations | API Endpoints |
|:-----|:-----------|:-------------|
| Candidate | search, get by ID, financial totals | `/candidates/`, `/candidates/{id}/`, `/candidates/totals/` |
| Committee | search, get by ID | `/committees/`, `/committees/{id}/` |
| Contribution | itemized search, aggregate by size/state/employer/occupation | `/schedules/schedule_a/`, `/schedules/schedule_a/by_*` |
| Disbursement | itemized search, aggregate by purpose/recipient | `/schedules/schedule_b/`, `/schedules/schedule_b/by_*` |
| Independent Expenditure | itemized search, aggregate by candidate | `/schedules/schedule_e/`, `/schedules/schedule_e/by_candidate/` |
| Filing | search | `/filings/` |
| Election | candidate race lookup, aggregate summary | `/elections/`, `/elections/summary/` |
| Legal Document | search (AOs, MURs, ADRs, admin fines, statutes) | `/legal/search/` |
| Calendar Event | events, filing deadlines, election dates | `/calendar-dates/`, `/reporting-dates/`, `/election-dates/` |

### Excluded from initial scope

| Noun | Reason |
|:-----|:-------|
| Loans (Schedule C) | Niche. Add if demand warrants. |
| Debts (Schedule D) | Niche. Debt data partially available via candidate totals. |
| Party Coordinated Expenditures (Schedule F) | Very low volume, specialized. |
| E-filing (real-time) | Short retention (~4 months), different data model. |
| Communication Costs (F7) | Rare filing type. |
| Electioneering Communications | Overlaps with independent expenditures for most use cases. |
| Presidential Map Data | Specialized visualization endpoint. |
| Audit Cases | Very low volume, admin-oriented. |
| National Party Accounts | Narrow audience. |

---

## Workflow Analysis

### "Who's funding this candidate?"
1. `openfec_search_candidates` → get `candidate_id`
2. `openfec_search_committees` with `candidate_id` → get principal campaign committee `committee_id`
3. `openfec_search_contributions` with `committee_id` (itemized or by_size/by_state/by_employer aggregates)

### "What's the outside money picture for this race?"
1. `openfec_lookup_elections` → get `candidate_id`s for all candidates in the race
2. `openfec_search_expenditures` with `candidate_id`, mode `by_candidate` → totals for/against each candidate
3. `openfec_search_expenditures` with `support_oppose=O` → who's opposing whom

### "Trace the money trail for a Super PAC"
1. `openfec_search_committees` → get Super PAC `committee_id`
2. `openfec_search_contributions` with `committee_id` → who funds the PAC
3. `openfec_search_disbursements` with `committee_id` → what the PAC spends on
4. `openfec_search_expenditures` with `committee_id` → which candidates the PAC supports/opposes

### "Has this committee had legal issues?"
1. `openfec_search_legal` with committee/candidate name as `query` → enforcement cases, advisory opinions

### "When's the next filing deadline?"
1. `openfec_lookup_calendar` with mode `filing_deadlines`, `min_date` = today

---

## Design Decisions

### 1. Mode-based consolidation over separate tools

Contributions, disbursements, expenditures, elections, and calendar each use a `mode` parameter rather than separate tools for itemized vs. aggregate queries. This keeps the tool count at 9 (manageable for LLM tool selection) while preserving full access to ~25 underlying API endpoints.

### 2. Opaque cursor for keyset pagination

Schedule A/B/E use keyset pagination with `last_indexes` containing multiple cursor fields. Rather than exposing these internal details, the server base64-encodes them into a single `cursor` string. The LLM passes it back verbatim without needing to understand the structure.

### 3. `two_year_transaction_period` abstraction

The API requires `two_year_transaction_period` on Schedule A but not other schedules. The tool accepts `cycle` uniformly and the service layer maps it to the correct API parameter. No API quirk leaks to the agent.

### 4. Legal search pagination exposed differently

Legal search uses `from_hit`/`hits_returned` (offset-based, max 200) with type-keyed result arrays. This is different enough from both page-based and keyset pagination that it's simpler to expose the native model rather than force it into the cursor abstraction. The tool uses `from_hit` and `hits_returned` directly.

### 5. `_full` fields for LLM readability

The API provides both code and human-readable versions of enumerated fields (`party` / `party_full`, `office` / `office_full`). The `format()` function uses `_full` variants for display. Output schemas include both for chaining (codes are needed for follow-up queries).

### 6. No caching in v0.1.0

The API sets `Cache-Control: public, max-age=3600`. Server-side caching is worthwhile but adds complexity. Ship without it, add in a follow-up if rate limits become a bottleneck.

---

## Known Limitations

- **Rate limits:** 1,000 requests/hour with a standard key. Complex multi-tool workflows can consume 5–10 requests per user interaction. Heavy use requires an elevated key.
- **DEMO_KEY:** ~40 requests/hour. Barely functional for testing. Users need a real key.
- **Approximate counts on high-volume endpoints:** Schedule A/B/E return `is_count_exact: false`. The `count` field is an estimate, not a precise total.
- **Schedule A date range limitation:** The API does not support date ranges spanning multiple `two_year_transaction_period`s. Queries are scoped to a single cycle.
- **Legal search vs. entity search:** Legal search is full-text, not entity-linked. Searching for a committee name may miss cases where the committee is referenced differently.
- **Data freshness:** Nightly refresh for most data. E-filing data is near-real-time but only retained ~4 months and is excluded from this server's scope.
- **No field selection:** The API does not support a `fields` parameter. Full records are returned. Schedule A/B/E records with nested committee objects can be 2–3KB each.

---

## API Reference

### Authentication

API key via query parameter `api_key` or header `X-Api-Key`. Keys from [api.data.gov](https://api.data.gov/signup/).

### Rate Limit Headers

| Header | Description |
|:-------|:------------|
| `X-RateLimit-Limit` | Calls allowed in current window |
| `X-RateLimit-Remaining` | Remaining calls |
| `Retry-After` | Seconds until reset (on 429 only) |

### 429 Error Shape

```json
{
  "error": {
    "code": "OVER_RATE_LIMIT",
    "message": "You have exceeded your rate limit..."
  }
}
```

### Standard Response Envelope

```json
{
  "api_version": "1.0",
  "pagination": { "count": 100, "page": 1, "pages": 10, "per_page": 10 },
  "results": [...]
}
```

### Keyset Pagination (Schedule A/B/E)

```json
{
  "api_version": "1.0",
  "pagination": {
    "count": 263917409,
    "is_count_exact": false,
    "last_indexes": {
      "last_index": "4121220241075839599",
      "last_contribution_receipt_date": "2024-01-15"
    },
    "per_page": 20
  },
  "results": [...]
}
```

### Legal Search Response

```json
{
  "advisory_opinions": [...],
  "total_advisory_opinions": 2093,
  "murs": [...],
  "total_murs": 0,
  "total_all": 2093
}
```

### ID Formats

| Entity | Format | Example |
|:-------|:-------|:--------|
| Candidate | `[HSP]\d{8}` | `P00003392`, `H2CO07170`, `S4AZ00345` |
| Committee | `C\d{8}` | `C00358796` |

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with `FEC_API_KEY`, `FEC_BASE_URL`, `FEC_MAX_RETRIES`, `FEC_REQUEST_TIMEOUT`
2. **Service** — `src/services/openfec/openfec-service.ts` with URL builder, fetch helpers, pagination handling, retry/backoff
3. **Read-only tools (entity lookup)** — `openfec_search_candidates`, `openfec_search_committees` (simplest, good for validating service layer)
4. **Financial data tools** — `openfec_search_contributions`, `openfec_search_disbursements`, `openfec_search_expenditures` (keyset pagination, mode routing)
5. **Filing and election tools** — `openfec_search_filings`, `openfec_lookup_elections`
6. **Legal and calendar tools** — `openfec_search_legal` (custom pagination), `openfec_lookup_calendar`
7. **Resources** — `openfec://candidate/{id}`, `openfec://committee/{id}`, `openfec://election/{cycle}/{office}`
8. **Prompts** — `openfec_money_trail`, `openfec_campaign_analysis`
9. **Remove echo definitions** — delete echo tool/resource/prompt, update `index.ts`

Each step is independently testable. Run `devcheck` after each.
