# OpenFEC MCP Server — Design

## MCP Surface

### Tools

All tools are read-only and idempotent (`readOnlyHint: true`, `idempotentHint: true`).

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `openfec_search_candidates` | Find federal candidates by name, state, office, party, or cycle. Retrieve a specific candidate by FEC ID with financial totals. | `query`, `candidate_id`, `state`, `office`, `party`, `cycle`, `include_totals` | readOnly, idempotent |
| `openfec_search_committees` | Find political committees (campaign, PAC, Super PAC, party) by name, type, candidate affiliation, or state. | `query`, `committee_id`, `candidate_id`, `state`, `committee_type`, `designation`, `cycle` | readOnly, idempotent |
| `openfec_get_committee_totals` | Pre-aggregated committee financial totals — one committee's per-cycle summary, or a ranked search across every committee of one entity type. | `mode`, `committee_id`, `entity_type`, `cycle`, `committee_state`, `min_receipts`, `sort` | readOnly, idempotent |
| `openfec_search_contributions` | Search itemized individual contributions (Schedule A) or get aggregate breakdowns by size, state, employer, or occupation. | `mode`, `committee_id`, `candidate_id`, `contributor_name`, `contributor_state`, `cycle`, `min_amount`, `max_amount` | readOnly, idempotent |
| `openfec_search_disbursements` | Search itemized committee spending (Schedule B) or get aggregate breakdowns by purpose or recipient. | `mode`, `committee_id`, `recipient_name`, `disbursement_description`, `cycle`, `min_amount`, `max_amount` | readOnly, idempotent |
| `openfec_search_expenditures` | Search independent expenditures (Schedule E) — outside spending supporting or opposing federal candidates. | `mode`, `committee_id`, `candidate_id`, `support_oppose`, `cycle`, `min_amount`, `max_amount` | readOnly, idempotent |
| `openfec_search_coordinated_expenditures` | Search coordinated party expenditures (Schedule F) — party committee spending made on behalf of a candidate, in coordination with that campaign. | `committee_id`, `candidate_id`, `cycle`, `payee_name`, `min_date`, `max_date`, `min_amount`, `max_amount` | readOnly, idempotent |
| `openfec_search_filings` | Search FEC filings and reports by committee, candidate, form type, or date range. | `committee_id`, `candidate_id`, `form_type`, `report_type`, `cycle`, `most_recent` | readOnly, idempotent |
| `openfec_lookup_elections` | Look up federal election races and candidate financial summaries. Find who's running with fundraising totals. | `mode`, `office`, `cycle`, `state`, `district` | readOnly, idempotent |
| `openfec_search_legal` | Search FEC legal documents: advisory opinions, enforcement cases (MURs), alternative dispute resolutions, and administrative fines. | `query`, `type`, `ao_number`, `case_number`, `respondent` | readOnly, idempotent |
| `openfec_get_legal_document` | Fetch one legal document in full by type and number — the detail counterpart to the compact search results. | `doc_type`, `no` | readOnly, idempotent |
| `openfec_lookup_calendar` | Look up FEC calendar events, filing deadlines, and election dates. | `mode`, `state`, `min_date`, `max_date` | readOnly, idempotent |

### Resources

All resource data is also reachable via tools. Resources add convenience for clients that support injectable context.

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `openfec://candidate/{candidate_id}` | Candidate profile with current financial totals and `principal_committees`. That list filters on each committee's current designation with no cycle, so it can include past campaigns and miss a committee since redesignated; a cycle's principal committee comes from `openfec_lookup_elections` `candidate_pcc_id`. | No |
| `openfec://committee/{committee_id}` | Committee profile with type, designation, and financial summary. A committee with no totals on file resolves with its base record alone; a failed totals request fails the read. | No |
| `openfec://election/{cycle}/{office}` | Election race summary. `state` and `district` appended as path segments when applicable (e.g., `openfec://election/2024/S/AZ`). Each template's `office` enum rejects the codes it does not serve with a message naming the sibling template that does. | First page only — returns the upstream `pagination` block, plus a `truncation_notice` pointing at `openfec_lookup_elections` when more pages exist. An empty race instead carries an `empty_result_notice` with the same guidance `openfec_lookup_elections` gives: check that the cycle is an even year, the state code, and that the district exists. |

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
| `candidate_id` | string | No | FEC candidate ID: H, S, or P followed by exactly eight letters or digits (e.g., `P00003392`, `H2CO07170`). The prefix indicates office: H=House, S=Senate, P=President. When provided, returns a single candidate with full detail. |
| `state` | string | No | Two-letter US state code (e.g., `AZ`, `CA`). |
| `district` | string | No | Two-digit district number for House candidates (e.g., `07`). |
| `office` | `H` \| `S` \| `P` | No | Filter by office: H=House, S=Senate, P=President. |
| `party` | string | No | Three-letter party code (e.g., `DEM`, `REP`, `LIB`, `GRE`). |
| `cycle` | number | No | Two-year election cycle (e.g., `2024`). Even years only. |
| `election_year` | number | No | Specific election year the candidate ran in. |
| `incumbent_challenge` | `I` \| `C` \| `O` | No | Incumbent status: I=incumbent, C=challenger, O=open seat. |
| `candidate_status` | `C` \| `F` \| `N` \| `P` | No | Candidate status: C=present candidate, F=future candidate, N=not yet a candidate, P=prior candidate. |
| `has_raised_funds` | boolean | No | Only candidates whose committee has received receipts for this office. Useful for filtering out paperwork-only candidates. |
| `include_totals` | boolean | No | Include financial totals (receipts, disbursements, cash on hand, debt). Defaults to true when fetching a single candidate by ID. Adds at least one further API call — see the totals sub-fetch note below. |
| `page` | number | No | Page number (1-indexed). Default 1. Addresses the candidate list only. |
| `per_page` | number | No | Results per page. Default 20, max 100. A search with totals requests at most 35 candidates when `cycle` or `election_year` scopes the totals and 5 when they span every cycle (decision 16). |

**Output:** Candidate records with: `candidate_id`, `name`, `party`/`party_full`, `state`, `office`/`office_full`, `district_number`, `incumbent_challenge`/`incumbent_challenge_full`, `cycles`, `election_years`, `candidate_status`, `first_file_date`, `has_raised_funds`. When `include_totals` is true: `receipts`, `disbursements`, `cash_on_hand_end_period`, `debts_owed_by_committee`, `individual_itemized_contributions`, `coverage_start_date`, `coverage_end_date`. `missing_totals` lists any candidate IDs the totals sub-fetch could not cover. Null and empty fields are dropped from candidate and totals rows.

**Pagination:** Page-based. Response includes `page`, `pages`, `count`, `per_page`; `per_page` echoes the size actually requested, and `truncated`/`shown`/`cap` report a page the totals cap bounded below the request.

**Totals sub-fetch:** `/v1/candidates/totals/` is a separately paged endpoint, not a view onto the candidate list — one candidate yields one row per cycle, so N candidates routinely produce more than N rows. The sub-fetch therefore ignores the candidate search's `page`/`per_page` and walks the totals endpoint's own pages at 100 per page, capped at 5 pages. If the cap is reached before every requested candidate is covered, the uncovered IDs are returned in `missing_totals` and rendered in the text output.

**Error modes:**
- Invalid `candidate_id` format → `ValidationError` (`invalid_candidate_id`): candidate IDs are H, S, or P followed by exactly eight letters or digits.
- A direct `candidate_id` lookup with a search-only input, or with `cycle` / `election_year` while `include_totals=false`, → `ValidationError` (`inputs_not_applicable_to_id_lookup`). Direct lookup always accepts `candidate_id` and `include_totals`; totals-only scope is accepted only when totals are included. Paging and candidate-search filters require the search path.
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
| `committee_id` | string | No | FEC committee ID: C followed by exactly eight digits (e.g., `C00358796`). Returns a single committee with full detail. |
| `candidate_id` | string | No | Find committees linked to this candidate (authorized, leadership, joint fundraising). |
| `state` | string | No | Two-letter state code. |
| `party` | string | No | Three-letter party code. |
| `committee_type` | string | No | Committee type code. Common values: `H` (House), `S` (Senate), `P` (Presidential), `O` (Super PAC — independent expenditure-only), `N` (PAC nonqualified), `Q` (PAC qualified), `X` (Party nonqualified), `Y` (Party qualified). Full list: `C` (communication cost), `D` (delegate), `E` (electioneering communication), `I` (independent expenditure filer — not a committee), `U` (single candidate IE), `V` (PAC with non-contribution account, nonqualified), `W` (PAC with non-contribution account, qualified), `Z` (national party non-federal account). |
| `designation` | string | No | Committee designation. `A` (authorized by candidate), `B` (lobbyist/registrant PAC), `D` (leadership PAC), `J` (joint fundraiser), `P` (principal campaign committee), `U` (unauthorized). Matches each committee's current designation only, even with `cycle` set, so a past principal committee since redesignated drops out of `P`; a cycle's principal committee comes from `openfec_lookup_elections` `candidate_pcc_id`. |
| `cycle` | number | No | Two-year election cycle. |
| `treasurer_name` | string | No | Full-text treasurer name search. |
| `page` | number | No | Page number. Default 1. |
| `per_page` | number | No | Results per page. Default 20, max 100. |

**Output:** Committee records with: `committee_id`, `name`, `committee_type`/`committee_type_full`, `designation`/`designation_full`, `party`/`party_full`, `state`, `treasurer_name`, `filing_frequency`, `organization_type`/`organization_type_full`, `candidate_ids`, `cycles`, `first_file_date`, `last_file_date`.

**Pagination:** Page-based.

**Error modes:**
- Invalid `committee_id` format → `ValidationError` (`invalid_committee_id`): committee IDs are C followed by exactly eight digits.
- A direct `committee_id` lookup with any search-only input → `ValidationError` (`inputs_not_applicable_to_id_lookup`). Direct lookup accepts only `committee_id`.

**Upstream endpoints:**
- `/v1/committees/` — search with filters
- `/v1/committees/{committee_id}/` — single committee lookup

---

### `openfec_get_committee_totals`

Pre-aggregated committee finances. Answers "how much has this committee raised this cycle?" in one call instead of paginating Schedule A.

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `mode` | enum | No | `single` (default) — one committee's totals, one row per cycle. `by_entity_type` — a page of committees of one entity type. |
| `committee_id` | string | Yes in `single` | Committee ID. In `by_entity_type` mode it narrows the grouped search to that one committee. |
| `entity_type` | enum | Yes in `by_entity_type` | `presidential`, `pac`, `party`, `pac-party`, `house-senate`, `ie-only`. |
| `cycle` | number | No | Two-year election cycle. Omit in `single` mode for every cycle on record. |
| `committee_state` | string | No | Two-letter state code. `by_entity_type` only. |
| `committee_type` | string | No | Committee type code. `by_entity_type` only. |
| `committee_designation` | string | No | Committee designation. `by_entity_type` only. |
| `organization_type` | string | No | Sponsoring organization type. `by_entity_type` only. |
| `min_receipts` / `max_receipts` | number | No | Total receipts bound in dollars. `by_entity_type` only. |
| `min_disbursements` / `max_disbursements` | number | No | Total disbursements bound in dollars. `by_entity_type` only. |
| `sort` | enum | No | `cycle`, `receipts`, `disbursements`, `last_cash_on_hand_end_period`, each with a `-` descending form. |
| `page` | number | No | Page number. Default 1. |
| `per_page` | number | No | Results per page. Default 20, max 100. |

**Output:** Committee totals rows with `committee_id`, `committee_name`, `cycle`, `receipts`, `disbursements`, `last_cash_on_hand_end_period`, `last_debts_owed_by_committee`, the individual/PAC/party contribution breakdown, and `coverage_start_date`/`coverage_end_date`. `mode` echoes the resolved mode; `search_criteria` echoes every filter applied, minus paging.

**Pagination:** Page-based in both modes. A long-running committee can hold more cycles than one page.

**Error modes:**
- `single` mode without a `committee_id` → `ValidationError` (`committee_id_required_for_single_mode`).
- `by_entity_type` mode without an `entity_type` → `ValidationError` (`entity_type_required_for_group_mode`), carrying `valid_entity_types`.
- A grouped-search filter supplied alongside `single` mode → `ValidationError` (`inputs_not_applicable_to_mode`). The single-committee endpoint accepts only paging, `cycle`, and `sort`, so applying one would have returned unfiltered totals.
- `single` mode matching no row → `NotFound` (`committee_totals_not_found`). The endpoint answers 404 for every empty case — unknown ID, a cycle the committee did not file, a committee that files no financial report — so all three land here; the message names the cycle when one was given.

**Upstream endpoints:**
- `/v1/committee/{committee_id}/totals/` — one committee, one row per cycle
- `/v1/totals/{entity_type}/` — grouped search across committees of one entity type

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
| `sort` | `contribution_receipt_date` \| `contribution_receipt_amount`, each with an optional `-` prefix for descending | No | Sort field. Itemized mode only. |
| `page` | number | No | Page number (1-indexed). Defaults to 1 in aggregate modes. Explicit values are rejected in itemized mode, which paginates with `cursor`. |
| `per_page` | number | No | Results per page. Default 20, max 100. Itemized mode requests at most 30 (decision 16). |
| `cursor` | string | No | Opaque pagination cursor from a previous response. Itemized mode uses keyset pagination — pass the cursor to get the next page. Valid only for an otherwise-identical call. |

**Output:**
- *Itemized:* Contribution records with: `contributor_name`, `contributor_employer`, `contributor_occupation`, `contributor_city`, `contributor_state`, `contributor_zip`, `contribution_receipt_amount`, `contribution_receipt_date`, `contributor_aggregate_ytd`, `committee_id`, `committee_name`, `candidate_id`, `candidate_name`, `receipt_type_full`, `is_individual`, `memo_text`, `pdf_url`. Plus `next_cursor` for pagination. The receiving committee's nested `committee` object is hoisted out of the rows into a top-level `committee` field — itemized mode always scopes to one `committee_id`, so it was identical in every row. The donor-as-committee `contributor` object stays on the row; it varies per donor and carries data no flat field does. `content[]` renders it as name, ID, and one attribute line; `structuredContent` keeps the full record.
- *Aggregates:* Records with: dimension field (`size`, `state`, `employer`, `occupation`), `count`, `total`, `cycle`, and either `committee_id` or `candidate_id`.
- *All modes:* `mode` echoes the mode the server resolved (a `by_size`/`by_state` query scoped by `candidate_id` resolves to `by_size_candidate`/`by_state_candidate`), and `search_criteria` echoes every filter applied, minus paging.

**Pagination:**
- Itemized: Keyset (SEEK). Response includes `next_cursor` (opaque string encoding `last_indexes`). Pass as `cursor` to get next page.
- Aggregates: Page-based.

**Error modes:**
- Itemized without `committee_id` → `InvalidParams`: "Itemized contribution search requires a committee_id. To search contributions by candidate, use a 'by_size' or 'by_state' aggregate mode with candidate_id, or first look up the candidate's committee with openfec_search_committees."
- `by_employer`/`by_occupation` without `committee_id` → `InvalidParams`: "Aggregate by employer/occupation requires a committee_id."
- An itemized-only input in any aggregate mode → `ValidationError` (`itemized_only_filters_in_aggregate_mode`). The aggregate endpoints accept only `committee_id`, `candidate_id`, `cycle`, `mode`, `page`, `per_page`; every contributor filter, date bound, amount bound, `is_individual`, `sort`, and `cursor` is itemized-only. The rejection names both the offending inputs and the mode's supported set rather than dropping the filters and answering an unnarrowed query.
- An explicit `page` or `candidate_id` in itemized mode → `ValidationError` (`inputs_not_applicable_to_mode`); the Schedule A itemized endpoint accepts `per_page` and `cursor`, but neither page-number pagination nor candidate scoping.
- `candidate_id` in `by_employer` / `by_occupation`, or both IDs when `by_size` / `by_state` resolves to its candidate endpoint → `ValidationError` (`inputs_not_applicable_to_mode`). Each resolved aggregate endpoint receives only the identifier it actually supports.
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
| `cycle` | number | No | Two-year election cycle. Itemized mode defaults to the current cycle when omitted, since an all-history Schedule B scan of an active committee times out upstream. |
| `min_date` | string | No | Earliest disbursement date (YYYY-MM-DD). Itemized mode only. |
| `max_date` | string | No | Latest disbursement date (YYYY-MM-DD). Itemized mode only. |
| `min_amount` | number | No | Minimum amount. Itemized mode only. |
| `max_amount` | number | No | Maximum amount. Itemized mode only. |
| `sort` | `disbursement_date` \| `disbursement_amount`, each with an optional `-` prefix for descending | No | Sort field. Itemized mode only. |
| `page` | number | No | Page number (1-indexed). Defaults to 1 in aggregate modes. Explicit values are rejected in itemized mode, which paginates with `cursor`. |
| `per_page` | number | No | Results per page. Default 20, max 100. Itemized mode requests at most 30 (decision 16). |
| `cursor` | string | No | Opaque pagination cursor from a previous response. Itemized mode only. Valid only for an otherwise-identical call. |

**Output:**
- *Itemized:* Disbursement records with: `recipient_name`, `recipient_city`, `recipient_state`, `recipient_zip`, `disbursement_amount`, `disbursement_date`, `disbursement_description`, `disbursement_purpose_category`, `committee_id`, `committee_name`, `candidate_id`, `candidate_name`, `entity_type`, `memo_text`, `pdf_url`. Plus `next_cursor`. The spending committee's nested `committee` object is hoisted out of the rows into a top-level `committee` field — `committee_id` is required, so it was identical in every row. A transfer row's `recipient_committee` stays on the row and renders in `content[]` as name, ID, and one attribute line.
- *by_purpose:* Records with: `purpose`, `count`, `total`, `memo_count`, `memo_total`, `cycle`, `committee_id`.
- *by_recipient:* Records with: `recipient_name`, `count`, `total`, `recipient_disbursement_percent`, `cycle`, `committee_id`.
- *by_recipient_id:* Records with: `recipient_id`, `recipient_name`, `committee_name`, `count`, `total`, `cycle`.
- *All modes:* `mode` echoes the resolved mode and `search_criteria` echoes every filter applied, minus paging.

**Pagination:** Itemized: keyset. Aggregates: page-based.

**Error modes:**
- Missing `committee_id` → `InvalidParams`: "Disbursement search requires a committee_id. Use openfec_search_committees to find a committee's ID."
- An itemized-only input in any aggregate mode → `ValidationError` (`itemized_only_filters_in_aggregate_mode`). The aggregate endpoints accept only `committee_id`, `cycle`, `mode`, `page`, `per_page`; every recipient filter, `disbursement_description`, `disbursement_purpose_category`, date bound, amount bound, `sort`, and `cursor` is itemized-only.
- Explicit `page` in itemized mode → `ValidationError` (`inputs_not_applicable_to_mode`); itemized accepts `per_page` and `cursor` instead.

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
| `support_oppose` | `S` \| `O` | No | `S` = support, `O` = oppose. Sent as `support_oppose_indicator` (itemized) or `support_oppose` (`by_candidate`). |
| `payee_name` | string | No | Full-text payee name search. Itemized mode only. |
| `candidate_office` | `H` \| `S` \| `P` | No | Office of the targeted candidate. Sent as `candidate_office` (itemized) or translated to `office` = `house`/`senate`/`president` (`by_candidate`). |
| `candidate_office_state` | string | No | State of the targeted race. Sent as `candidate_office_state` (itemized) or `state` (`by_candidate`). Presidential `by_candidate` rows carry no state. |
| `candidate_office_district` | string | No | Two-digit House district of the targeted race. Sent as `candidate_office_district` (itemized) or `district` (`by_candidate`). Senate and presidential `by_candidate` rows carry no district. |
| `candidate_party` | string | No | Party of the targeted candidate. Itemized mode only — `by_candidate` rejects it, since the aggregate endpoint has no party filter. |
| `cycle` | number | No | Two-year election cycle. Itemized mode defaults to the current cycle when omitted. In `by_candidate` mode it names the election, and `election_full` decides the period its totals cover. |
| `election_full` | boolean | No | `by_candidate` mode only: totals over the full election period ending in `cycle` (4yr president, 6yr senate, 2yr house) instead of the two-year cycle alone. Defaults to true — OpenFEC's own default and `openfec_lookup_elections`' — and the effective value is sent upstream and echoed in `search_criteria`. Carries no schema default, so an explicit value is distinguishable from an omission. |
| `min_date` | string | No | Earliest expenditure date (YYYY-MM-DD). Itemized mode only. |
| `max_date` | string | No | Latest expenditure date (YYYY-MM-DD). Itemized mode only. |
| `min_amount` | number | No | Minimum amount. Itemized mode only. |
| `max_amount` | number | No | Maximum amount. Itemized mode only. |
| `is_notice` | boolean | No | Only 24/48-hour notice filings (near-election spending). Itemized mode only. |
| `most_recent` | boolean | No | Only the most recent version of amended filings. Itemized mode only — defaults to true there when omitted, and `by_candidate` rejects it. Carries no schema default, so an explicit value is distinguishable from an omission. |
| `sort` | `expenditure_date` \| `expenditure_amount` \| `office_total_ytd`, each with an optional `-` prefix for descending | No | Sort field. Itemized mode only. |
| `page` | number | No | Page number (1-indexed). Defaults to 1 in `by_candidate` mode. Explicit values are rejected in itemized mode, which paginates with `cursor`. |
| `per_page` | number | No | Results per page. Default 20, max 100. Itemized mode requests at most 60 when `committee_id` is set and 30 otherwise (decision 16). |
| `cursor` | string | No | Opaque pagination cursor. Itemized mode only. Valid only for an otherwise-identical call. |

**Output:**
- *Itemized:* Expenditure records with: `committee_id`, `committee_name`, `payee_name`, `expenditure_amount`, `expenditure_date`, `expenditure_description`, `support_oppose_indicator`, `candidate_id`, `candidate_name`, `candidate_office`, `candidate_office_state`, `candidate_party`, `is_notice`, `dissemination_date`, `office_total_ytd`, `most_recent`, `pdf_url`. Plus `next_cursor`.
- *by_candidate:* Records with: `candidate_id`, `candidate_name`, `committee_id`, `committee_name`, `support_oppose_indicator`, `count`, `total`, `cycle`.
- *All modes:* `mode` echoes the resolved mode and `search_criteria` echoes every filter applied, minus paging.

Itemized rows drop the nested `candidate` sub-object, whose three fields are the row's own `candidate_id`, an internal `idx`, and a `two_year_period` that restates the query's cycle. The nested `committee` object is hoisted into a top-level `committee` field **only when the caller supplied a `committee_id`** — Schedule E does not require one, so a candidate- or race-scoped page spans several spending committees and hoisting any single one would misattribute the rest. Without a `committee_id`, each row keeps its own `committee`, which `content[]` renders as name, ID, and one attribute line — the hoisted header's layout, per row — while `structuredContent` keeps the full record.

**Pagination:** Itemized: keyset. Aggregate: page-based.

**Error modes:**
- `by_candidate` without `candidate_id` and without a full race scope → `ValidationError` (`by_candidate_requires_scope`). A race scope is `candidate_office` alone for `P`, plus `candidate_office_state` for `S`, plus `candidate_office_district` as well for `H` — the endpoint answers 422 for `house` or `senate` without a state and for `house` without a district, while `president` is a national race that takes neither and returns nothing when a state is supplied.
- An itemized-only input in `by_candidate` mode → `ValidationError` (`itemized_only_filters_in_aggregate_mode`). `/by_candidate/` accepts only `committee_id`, `candidate_id`, `support_oppose`, `candidate_office`, `candidate_office_state`, `candidate_office_district`, `cycle`, `election_full`, `mode`, `page`, `per_page`; `payee_name`, `candidate_party`, the date and amount bounds, `is_notice`, `most_recent`, `sort`, and `cursor` are itemized-only. This reason replaces the field-specific `candidate_party_not_supported_by_candidate`, which covered one of the ten.
- Explicit `page` or `election_full` in itemized mode → `ValidationError` (`inputs_not_applicable_to_mode`), naming every such input; `/schedules/schedule_e/` paginates by `per_page` and `cursor` and has no `election_full` parameter, so it would silently ignore the flag.

**Upstream endpoints:**
- `/v1/schedules/schedule_e/` — itemized (SEEK)
- `/v1/schedules/schedule_e/by_candidate/` — aggregate by candidate. Takes `office`/`state`/`district`/`support_oppose`, not the itemized `candidate_office`/`candidate_office_state`/`candidate_office_district`/`support_oppose_indicator`, and has no `candidate_party`.

---

### `openfec_search_coordinated_expenditures`

Search coordinated party expenditures (Schedule F) — spending a party committee makes on behalf of a candidate it supports, in coordination with that campaign. Distinct from Schedule E, which by definition cannot be coordinated, and from direct contributions: coordinated expenditures carry their own statutory limits.

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `committee_id` | string | No | Spending party committee ID. |
| `candidate_id` | string | No | Benefiting candidate ID. |
| `cycle` | number | No | Two-year election cycle. Omitting it searches every cycle on record. |
| `payee_name` | string | No | Full-text payee name search. |
| `min_date` / `max_date` | string | No | Expenditure date bound (YYYY-MM-DD). |
| `min_amount` / `max_amount` | number | No | Expenditure amount bound in dollars. |
| `sort` | enum | No | `expenditure_date` or `expenditure_amount`, each with a `-` descending form. |
| `page` | number | No | Page number. Default 1. |
| `per_page` | number | No | Results per page. Default 20, max 100. At most 80 are requested when `committee_id` is set and 25 otherwise (decision 16). |

**Output:** Coordinated expenditure records with `expenditure_date`, `expenditure_amount`, `expenditure_type_full`, `expenditure_purpose_full`, `payee_name`, `candidate_id`/`candidate_name`/`candidate_office`, `aggregate_general_election_expenditure`, `subordinate_committee_id`, `filing_form`, `image_number`, and `pdf_url`.

**Pagination:** Page-based — unlike Schedules A, B, and E, this endpoint has no `last_index` keyset. Unscoped queries return promptly (roughly 82K rows across all history), so no cycle default is applied.

**Payload shaping:** Rows embed up to two committee objects. `committee` — the spender — is hoisted out once when the caller scoped the query to a single `committee_id`, following the Schedule B/E convention; otherwise it stays on each row and renders in `content[]` as name, ID, and one attribute line. `subordinate_committee` is dropped outright: across a 100-row sample it was null on 39 rows, the spender again on 60, and a different committee on 1, and in every case the row's own `subordinate_committee_id` matched it — so the ID is the recovery path, resolvable through `openfec_search_committees`.

**Upstream endpoints:**
- `/v1/schedules/schedule_f/` — itemized coordinated expenditures

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
| `per_page` | number | No | Results per page. Default 20, max 100. At most 65 are requested (decision 16). |

**Output:** Filing records with: `committee_id`, `committee_name`, `candidate_id`, `candidate_name`, `form_type`, `form_category`, `report_type`/`report_type_full`, `report_year`, `receipt_date`, `coverage_start_date`, `coverage_end_date`, `is_amended`, `most_recent`, `amendment_chain`, `total_receipts`, `total_disbursements`, `total_individual_contributions`, `cash_on_hand_beginning_period`, `cash_on_hand_end_period`, `debts_owed_by_committee`, `pdf_url`, `csv_url`, `fec_file_id`, `means_filed`, `pages`.

**Pagination:** Page-based. `is_count_exact` comes back false on large result sets; the response then carries `pagination.count_is_approximate` and renders the total as approximate (decision 15).

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
| `election_full` | boolean | No | Expand to full election period: 4 years for President, 6 for Senate, 2 for House. Defaults to true when omitted, and a ZIP-scoped search rejects it. Carries no schema default, so an explicit value is distinguishable from an omission. |
| `page` | number | No | Page number (1-indexed). Defaults to 1 in search mode. An explicit value is rejected in summary mode. |
| `per_page` | number | No | Results per page. Default 20, max 100. Search mode only. |

**Output:**
- *Search:* Candidate records in the race with: `candidate_id`, `candidate_name`, `candidate_pcc_id`, `candidate_pcc_name`, `party_full`, `incumbent_challenge_full`, `total_receipts`, `total_disbursements`, `cash_on_hand_end_period`, `coverage_end_date`, `committee_ids`.
- *Summary:* Aggregate totals for the race.
- *All modes:* `mode` echoes the resolved mode and `search_criteria` echoes every filter applied, minus paging — including the `election_full` default when the caller omitted it.

**Pagination:** Page-based.

**Error modes:**
- Senate/House without `state` → `InvalidParams`: "Senate and House election lookups require a state. Provide a two-letter state code."
- House without `district` → `InvalidParams`: "House election lookups require a district number."
- Odd cycle year → `InvalidParams`: "Election cycles are even years (e.g., 2024, 2026)."
- `election_full` alongside `zip` → `ValidationError` (`inputs_not_applicable_to_mode`). A ZIP-scoped search runs `/elections/search/`, which has no such parameter; the rejection names it and the set that endpoint does accept.
- Explicit `page` or `per_page` in summary mode → `ValidationError` (`inputs_not_applicable_to_mode`); `/v1/elections/summary/` accepts neither.

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
| `min_penalty_amount` | number | No | Minimum penalty amount. Sent as `case_min_penalty_amount` — filters enforcement cases (`murs`, `adrs`) only. |
| `max_penalty_amount` | number | No | Maximum penalty amount. Sent as `case_max_penalty_amount` — filters enforcement cases only. |
| `date_kind` | enum | No | Which date `min_date`/`max_date` bound: `issue_date`, `request_date`, `open_date`, `close_date`, `document_date`, `rtb_date`, `fd_date`. Must be one the chosen `type` records. Required alongside `type` whenever a bound is given. |
| `min_date` | string | No | Earliest date (YYYY-MM-DD) for the selected `date_kind`. Requires `type` and `date_kind`. |
| `max_date` | string | No | Latest date (YYYY-MM-DD) for the selected `date_kind`. Requires `type` and `date_kind`. |
| `from_hit` | number | No | Offset for pagination (0-indexed), counted within each document type. Default 0, max 9999. Bounded with `hits_returned` by the upstream result window: `from_hit + hits_returned <= 10000` (decision 4). |
| `hits_returned` | number | No | Results per page, applied per document type. Default 20, max 200. |

**Output:** Varies by `type`:
- *Advisory opinions:* `ao_no`, `name`, `summary`, `issue_date`, `request_date`, `status`, `requestor_names`, `regulatory_citations`, `statutory_citations`, `highlights`, `documents` (array with `url`, `filename`, `category`).
- *MURs:* Case number, name, respondents, penalty amounts, disposition, citations.
- *Admin fines:* Case details, penalty amounts, respondents.
- *Statutes:* Citation, title, text.

The server normalizes the type-keyed response arrays into a uniform `results` array with a `document_type` discriminator.

**Pagination:** Custom model — `from_hit`/`hits_returned` (not page-based). The tool exposes this directly since it differs from other tools. Response includes `total_count` for the queried type(s).

**Error modes:**
- No scoping filter at all → `ValidationError` (`missing_filter`). Any one of `query`, `type`, `ao_number`, `case_number`, `respondent`, `regulatory_citation`, `statutory_citation`, a penalty bound, or a date bound satisfies it.
- A date bound without both `type` and `date_kind`, or a `date_kind` with neither bound → `ValidationError` (`date_filter_incomplete`).
- A `date_kind` the chosen `type` does not record → `ValidationError` (`date_kind_not_valid_for_type`), carrying `valid_date_kinds`.
- `from_hit + hits_returned` above 10,000 → `ValidationError` (`legal_window_exceeded`), carrying `max_from_hit` for the supplied page size.

**Date parameters:** the endpoint has no generic date bound. Each document type carries its own prefix and its own set of dates, so `type` + `date_kind` together select the upstream pair:

| `type` | `date_kind` | Upstream parameters |
|:-------|:------------|:--------------------|
| `advisory_opinions` | `issue_date` | `ao_min_issue_date` / `ao_max_issue_date` |
| `advisory_opinions` | `request_date` | `ao_min_request_date` / `ao_max_request_date` |
| `advisory_opinions` | `document_date` | `ao_min_document_date` / `ao_max_document_date` |
| `murs`, `adrs` | `open_date` | `case_min_open_date` / `case_max_open_date` |
| `murs`, `adrs` | `close_date` | `case_min_close_date` / `case_max_close_date` |
| `murs`, `adrs` | `document_date` | `case_min_document_date` / `case_max_document_date` |
| `admin_fines` | `rtb_date` | `af_min_rtb_date` / `af_max_rtb_date` |
| `admin_fines` | `fd_date` | `af_min_fd_date` / `af_max_fd_date` |
| `statutes` | — | none; statutes are not date-filterable |

**Upstream endpoints:**
- `/v1/legal/search/` — unified legal search

---

### `openfec_get_legal_document`

Fetch one legal document in full. The detail counterpart to `openfec_search_legal`, which trims every result unconditionally and offered no way to recover what it cut.

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `doc_type` | enum | Yes | `advisory_opinions`, `murs`, `adrs`, `admin_fines`, `statutes` — the plural of a search result's `document_type` discriminator. |
| `no` | string | Yes | Document number from the matching search result's `no` field. Advisory opinions are year-serial (`2024-01`); MURs, ADRs, and admin fines are digit strings (`8363`); statutes are U.S. Code section numbers (`30123`). |

**Output:** `document` — the complete record, carrying the full `documents` array that search replaces with a count and category summary, the complete `commission_votes` it reduces to a vote date and a truncated action, and the `dispositions` and scalar/date fields. Fields present vary by document type. `search_criteria` echoes both inputs. `attachedDocumentCount` enrichment reports the length of `documents`, so it can be checked against the `document_count` the search result reported.

**Not returned:** `highlights` and `document_highlights`. Those are a relevance artifact `/legal/search/` computes against a query, not data attached to a canonical record — the detail endpoint has no such field.

**Reachability:** search results carry the *singular* `document_type` (`mur`) while this path segment is *plural* (`murs`). The mapping is a trailing `s` in every case, and the tool description states it, because a caller chaining a search result cannot infer it from the schema alone. The number is always the result's `no`: `/legal/search/` records carry no `case_no` key at all, and `ao_no` is present only on advisory opinions, where it duplicates `no`.

**Error modes:**
- No record at the given `doc_type`/`no` → `NotFound` (`legal_document_not_found`).

**Response envelope:** the live endpoint wraps the record in a `docs` array; `docs/openapi-spec.json` documents a flat single object with the same fields at the top level. The service accepts both, preferring the array form when present.

**Upstream endpoints:**
- `/v1/legal/docs/{doc_type}/{no}` — single legal document

---

### `openfec_lookup_calendar`

Look up FEC calendar events, filing deadlines, and election dates.

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `mode` | enum | No | `events` (default) — FEC calendar events. `filing_deadlines` — report due dates. `election_dates` — upcoming/past elections. |
| `state` | string | No | Two-letter state code. Election dates mode. |
| `office` | `H` \| `S` \| `P` | No | Office sought. Election dates mode. |
| `district` | string | No | Two-digit House district (e.g., `14`), sent as `election_district`. A single digit is zero-padded, since upstream matches only the padded form; any other value passes through. Upstream applies it without `state` — alone it matches that district number in every state. At-large races carry a blank `election_district` upstream and never match. Election dates mode. |
| `report_type` | string | No | Report type code (e.g., `Q1`, `Q2`). Filing deadlines mode only. |
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
- *All modes:* `mode` echoes the resolved mode and `search_criteria` echoes every filter applied, minus paging.

**Pagination:** Page-based.

**Error modes:**
- An input belonging to another mode → `ValidationError` (`inputs_not_applicable_to_mode`). Each mode reads a different dataset: `events` accepts `description` and `category`, `filing_deadlines` accepts `report_type` and `report_year`, `election_dates` accepts `state`, `office`, `district`, and `election_year`; `min_date` and `max_date` work everywhere. The rejection names both the offending inputs, the mode that owns each, and the chosen mode's accepted set.

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
| `getCommitteeTotals(id, params)` | `/committee/{id}/totals/` | Offset |
| `getCommitteeTotalsByEntityType(type, params)` | `/totals/{entity_type}/` | Offset |
| `searchContributions(params)` | `/schedules/schedule_a/` | Seek |
| `getContributionAggregates(mode, params)` | `/schedules/schedule_a/by_*` | Offset |
| `searchDisbursements(params)` | `/schedules/schedule_b/` | Seek |
| `getDisbursementAggregates(mode, params)` | `/schedules/schedule_b/by_*` | Offset |
| `searchExpenditures(params)` | `/schedules/schedule_e/` | Seek |
| `getExpendituresByCandidate(params)` | `/schedules/schedule_e/by_candidate/` | Offset |
| `searchCoordinatedExpenditures(params)` | `/schedules/schedule_f/` | Offset |
| `searchFilings(params)` | `/filings/` | Offset |
| `searchElections(params)` | `/elections/` | Offset |
| `getElectionSummary(params)` | `/elections/summary/` | Offset |
| `searchLegal(params)` | `/legal/search/` | Custom |
| `getLegalDocument(docType, no)` | `/legal/docs/{doc_type}/{no}` | None (single record) |
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
| `fetchSeek<T>(path, params, query, ctx, delivered)` | Like `fetchJson` but returns `{ pagination, results, nextCursor }` from `last_indexes`, with the cursor bound to `query` and carrying the rows delivered through this page. |
| `fetchLegal<T>(params)` | Special handling for legal search response shape. |
| `cursorQuery(scope, input)` | Normalize a tool's arguments into the `{ scope, args }` identity its cursors are bound to (`cursor`, `page`, and `per_page` excluded). |
| `encodeCursor(lastIndexes, query, delivered?)` | Base64-encode `last_indexes`, the issuing query, and the rows delivered so far into an opaque cursor string. |
| `decodeCursor(cursor, expected)` | Validate the cursor and decode it back to `{ indexes, delivered }` — the `last_indexes` params and the rows delivered before it (0 for a cursor minted without the count). Throws `validationError` with `reason: 'invalid_cursor'` (malformed) or `'cursor_query_mismatch'` (issued for a different query). |

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
| Committee Totals | one committee's per-cycle totals, grouped search by entity type | `/committee/{id}/totals/`, `/totals/{entity_type}/` |
| Contribution | itemized search, aggregate by size/state/employer/occupation | `/schedules/schedule_a/`, `/schedules/schedule_a/by_*` |
| Disbursement | itemized search, aggregate by purpose/recipient | `/schedules/schedule_b/`, `/schedules/schedule_b/by_*` |
| Independent Expenditure | itemized search, aggregate by candidate | `/schedules/schedule_e/`, `/schedules/schedule_e/by_candidate/` |
| Coordinated Party Expenditure | itemized search | `/schedules/schedule_f/` |
| Filing | search | `/filings/` |
| Election | candidate race lookup, aggregate summary | `/elections/`, `/elections/summary/` |
| Legal Document | search (AOs, MURs, ADRs, admin fines, statutes), fetch one in full | `/legal/search/`, `/legal/docs/{doc_type}/{no}` |
| Calendar Event | events, filing deadlines, election dates | `/calendar-dates/`, `/reporting-dates/`, `/election-dates/` |

### Excluded from initial scope

| Noun | Reason |
|:-----|:-------|
| Loans (Schedule C) | Niche. Add if demand warrants. |
| Debts (Schedule D) | Niche. Debt data partially available via candidate totals. |
| E-filing (real-time) | Short retention (~4 months), different data model. |
| Communication Costs (F7) | Rare filing type. |
| Electioneering Communications | Overlaps with independent expenditures for most use cases. |
| Presidential Map Data | Specialized visualization endpoint. |
| Audit Cases | Very low volume, admin-oriented. |
| National Party Accounts | Narrow audience. |

---

## Workflow Analysis

### "Who's funding this candidate?"
1. `openfec_search_candidates` → get `candidate_id`, plus the record's `office`, `state`, and `district`
2. `openfec_lookup_elections` (mode `search`) with `office` and `cycle` — plus `state` for Senate, `state` and `district` for House, carried from step 1 → the candidate's row gives the cycle's principal campaign committee as `candidate_pcc_id`. `openfec_search_committees` with `designation=P` is not a substitute: it matches current designation only, so a principal committee since redesignated drops out.
3. `openfec_search_committees` with `candidate_id` → related committees (leadership PACs, joint fundraising committees)
4. `openfec_search_contributions` with the principal `committee_id` (itemized or by_size/by_state/by_employer aggregates)

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

Contributions, disbursements, expenditures, elections, calendar, and committee totals each use a `mode` parameter rather than separate tools for itemized vs. aggregate queries. This keeps the tool count at 12 (manageable for LLM tool selection) while preserving full access to ~25 underlying API endpoints.

### 2. Opaque cursor for keyset pagination

Schedule A/B/E use keyset pagination with `last_indexes` containing multiple cursor fields. Rather than exposing these internal details, the server base64-encodes them into a single `cursor` string. The LLM passes it back verbatim without needing to understand the structure.

The encoded payload also carries the query that issued it — the tool name plus the caller's arguments, minus `cursor`, `page`, and `per_page` (none of them changes which rows the keyset walks — `page` addresses the page-based aggregate modes). `decodeCursor` validates the structure and compares that identity against the current call, because `last_indexes` keys are sort-specific and OpenFEC silently ignores keys that do not match the active sort: without the check, a cursor replayed under a changed sort or filter is accepted and restarts at page one with no signal. A malformed cursor fails as `invalid_cursor`; a valid cursor from a different query fails as `cursor_query_mismatch`, naming the arguments that changed. The identity is a generic serialization of the arguments rather than a per-field allowlist, so new filters and sort values need no matching change here.

`last_indexes` alone cannot say whether a next page exists: OpenFEC populates it for the last row of every page, terminal pages included. A cursor is therefore minted only when the page could have a successor — `last_indexes` is populated, the page came back full (`results.length >= per_page`), and an exact count does not already account for every row delivered so far (`is_count_exact === true && count <= delivered + results.length`). A short page ends the walk. The SEEK envelope carries no `page`, so `pages` is not a usable cross-check: there is no position to compare it against, and when the count is an estimate `pages` is derived from that estimate. The cursor therefore carries the position itself — `n`, the rows delivered through the page that minted it — so an exact count ends the walk on whichever page reaches it, and a capped page never reports `truncated` (decision 16) with nothing left. A cursor without `n` reads as position 0, which can only under-count and never ends a walk early. When the count is not declared exact, a full page that happens to be terminal still mints a cursor — nothing in the envelope distinguishes it — and the empty page that follows reports an exhausted position (decision 14) rather than a search that matched nothing.

### 3. `two_year_transaction_period` abstraction

The API requires `two_year_transaction_period` on Schedule A but not other schedules. The tool accepts `cycle` uniformly and the service layer maps it to the correct API parameter. No API quirk leaks to the agent.

### 4. Legal search pagination exposed differently

Legal search uses `from_hit`/`hits_returned` (offset-based, max 200) with type-keyed result arrays. This is different enough from both page-based and keyset pagination that it's simpler to expose the native model rather than force it into the cursor abstraction. The tool uses `from_hit` and `hits_returned` directly.

Both ride the OpenSearch result window behind `/legal/search/`, which serves a request only while `from_hit + hits_returned <= 10000`, inclusive. Past it upstream answers 400 with `Opensearch failed to execute query` — a message that names the engine, not the window. The ceiling moves with the page size, so it cannot be expressed as a static `.max()` on its own: `from_hit` advertises the ceiling it has at `hits_returned: 1` (9999) and the sum is checked in the handler before dispatch, rejected as `legal_window_exceeded` with the largest `from_hit` the supplied page size allows. That follows decision 8 — reject an unservable input rather than spend the round trip on a 400 that misattributes the cause. No document type holds enough records to reach the window (the largest single-type total measured is 7,670 MURs), so a paging run runs out of documents first; this is about the advertised contract and the error text.

### 5. `_full` fields for LLM readability

The API provides both code and human-readable versions of enumerated fields (`party` / `party_full`, `office` / `office_full`). The `format()` function uses `_full` variants for display. Output schemas include both for chaining (codes are needed for follow-up queries).

### 6. No caching in v0.1.0

The API sets `Cache-Control: public, max-age=3600`. Server-side caching is worthwhile but adds complexity. Ship without it, add in a follow-up if rate limits become a bottleneck.

### 7. Every response states the query it ran

All twelve tools return `search_criteria` on every response, not only empty ones, and the six multi-mode tools also return the resolved `mode`. A caller cannot otherwise tell that a cycle defaulted, that `by_size` resolved to `by_size_candidate` against a different endpoint, or which of several row shapes it is holding. `search_criteria` echoes the **effective** filters — the caller's parsed input with every server-applied default folded in — minus paging arguments (`page`, `per_page`, `cursor`, `from_hit`, `hits_returned`); query-shaping booleans such as `most_recent` and `election_full` stay in, because they narrow the result set. Echoing the raw input instead would reproduce the failure the field exists to close: the itemized branches fall back to the current cycle and to `most_recent: true`, and a caller who omitted both would see neither in the echo while both shaped the result. The itemized keyset cursor is bound to the same effective values, so an omitted default and an explicit one resolve to one cursor identity rather than two. `format()` renders both fields, so `content[]`-only clients see the same record as `structuredContent` clients.

### 8. Endpoint-inapplicable inputs are rejected, never dropped

Every handler validates the concrete endpoint selected by an ID or mode before dispatch. Direct candidate and committee lookup reject search-only inputs; Schedule A aggregate variants accept only the identifier their resolved endpoint supports; Schedule A/B/E itemized reject page-number pagination; election summary rejects paging. The rejection names the offending inputs and the endpoint's supported set. Silently dropping one is the worse failure: the caller gets an unnarrowed result set that looks like an answer to the narrowed question.

The check sits at input-presence level before the branch builds `params`, because the service allowlist only sees outbound names and cannot catch an input that was never copied. A branch-scoped input therefore carries no Zod `.default()` when omission must be distinguished from explicit presence; `page` on ID/mode-dispatched tools, `most_recent` on `openfec_search_expenditures`, and `election_full` on `openfec_lookup_elections` and `openfec_search_expenditures` are optional, with defaults applied inside the branches that support them. The service layer separately allowlists the six Schedule A aggregate paths and election summary as a final backstop against future routing drift.

### 9. The nested committee object is hoisted, not duplicated per row

OpenFEC embeds a ~40-field committee object in every itemized Schedule A/B/E row. When the query is scoped to one `committee_id` it is identical across the page, so it is lifted into a single top-level `committee` field. Schedule A and B require a `committee_id`, so the hoist is unconditional there; Schedule E does not, so it hoists only when the caller supplied one — a candidate- or race-scoped Schedule E page spans several spending committees, and attributing those rows to one of them would be worse than the payload cost. Schedule A's donor-side `contributor` object is deliberately kept on the row: it varies per row and carries treasurer, designated-agent, and cycle-history data that appears nowhere else. A committee record left on a row — Schedule E/F's spender on a page spanning committees, Schedule A's donor-as-committee `contributor`, Schedule B's `recipient_committee` — renders in `content[]` as name, ID, and one attribute line through a `renderRecord` field renderer, the same summary the hoisted header uses; the generic JSON fallback in `renderValue` stays for fields with no known shape, and `structuredContent` keeps the full record. Schedule E's nested `candidate` object is dropped outright — its three fields are the row's own `candidate_id`, an internal `idx`, and a `two_year_period` that restates the query's cycle.

### 10. The outbound parameter guard resolves interpolated paths to their spec template

`assertKnownParams` is keyed on the paths `docs/openapi-spec.json` declares, but `buildUrl` receives paths with the identifier already substituted — `/committee/C00703975/totals/`, not `/committee/{committee_id}/totals/`. Since the guard returns early for a path it has no entry for, registering the template alone would have been dead configuration: every path-parameterized endpoint would silently skip the check that exists because OpenFEC answers 200 and drops a parameter name it does not recognize. A short regex table maps each interpolated form back to its template before lookup. The `/totals/{entity_type}/` pattern is anchored to the six enum values rather than a wildcard segment, so a different `/totals/…` endpoint is not checked against the wrong allowlist.

### 11. Committee totals dispatch on mode across two unrelated endpoints

`/committee/{committee_id}/totals/` and `/totals/{entity_type}/` answer different questions — one committee's cycles versus a ranked page of committees — and share only a row shape. They are one `mode`-dispatched tool rather than two, matching the consolidation in decision 1: the single-committee half is the common case and the default, and the grouped half costs one branch. Only the single half was reachable before, and only through a resource, so tool-only clients could not read committee totals at all.

Both single-record endpoints answer 404 for a miss rather than an empty `results` array — `/committee/{id}/totals/` for an unknown ID, a cycle the committee did not file, and a committee that files no financial report alike. The service normalizes that to a zero-row page so the tool can throw its own `committee_totals_not_found` with an actionable message, instead of surfacing the framework's generic "verify the API path" hint for what is really an unknown ID. The normalization is gated on the 404 body parsing as OpenFEC's own JSON error object: the api.data.gov edge answers 404 with a plain-text routing error when the upstream host is unreachable, and reporting a whole-API outage as "this committee has no totals" would be a confidently wrong answer. Anything that is not the API's JSON error shape stays a failure and propagates. `openfec_get_legal_document` uses the same discriminator.

The `openfec://committee/{committee_id}` resource relies on that normalization and adds no error handling of its own around the totals leg. "No totals on file" already arrives as an empty page, so a rejection reaching the resource is a real failure (rate limit, timeout, malformed envelope) and fails the read, as the candidate resource's totals leg does. Swallowing it would return a successful profile with the financial fields silently missing, which a caller cannot tell apart from a committee that never filed.

### 12. Coordinated expenditures use page-based pagination, unlike the other schedules

Schedules A, B, and E paginate by keyset and are wrapped with the opaque cursor of decision 2. Schedule F does not — the endpoint returns `page`/`pages`/`per_page` with no `last_index`, so the tool follows the page-based convention of `openfec_search_committees` instead. It also needs no defaulted cycle: Schedule E defaults to the current cycle because an unscoped scan times out upstream, while Schedule F's whole history is roughly 82K rows and answers an unscoped query promptly.

### 13. Range validation is shared and precedes dispatch

Every exposed min/max date or numeric pair uses one handler-level validator. Dates must be real calendar dates in `YYYY-MM-DD` form, and a supplied minimum cannot exceed its maximum; equal bounds and one-sided ranges remain valid. Failures use stable `invalid_date` or `invalid_range` data with field/value context and a recovery hint, before any upstream call. Legal search resolves its existing incomplete-date and invalid-date-kind contracts first, because those errors explain how to select an upstream date pair before generic value validation applies.

### 14. An exhausted position is reported as a position, not as a zero match

A request can come back with no rows for two unrelated reasons: nothing matched the filters, or the filters matched plenty and the requested position sits past the end. Both used to render as "No results found" plus advice to broaden the search, while the same response reported a nonzero total — advice that cannot help, next to a number that contradicts it.

The two are distinguishable from the response alone, per pagination model: page-based when `count > 0 && results.length === 0 && page > pages` (upstream answers 200, echoes the requested page, and keeps `pages` and `count` correct); keyset when a nonzero `count` comes back with no rows, which is the shape a cursor walking past the last row produces; and `from_hit` offsets when `total_count > 0` with no rows. `formatExhaustedResult` and the `notice` enrichment then state the same sentence: which position ran out, the total that still matched, and the way back — an earlier page, a lower `from_hit`, or dropping the cursor. Both surfaces read the same predicate, so `format()` and the `notice` enrichment never describe the same response differently. The predicates key on the position upstream reports, so a page whose `pages` was derived from an estimated count can still fall to the zero-match arm with a nonzero total.

`openfec_get_committee_totals` mode `single` is the sharpest case: its `committee_totals_not_found` error exists for the 404 that decision 11 normalizes to an empty page, and a page past the end used to trip it, failing the call for a committee whose totals sit on page 1. The error is now reserved for a zero-count page; an exhausted page is an ordinary result.

### 15. An estimated count is labelled as one

OpenFEC reports `is_count_exact: false` on its highest-volume datasets — measured on `/schedules/schedule_a/`, `/schedules/schedule_b/`, `/schedules/schedule_e/` and `/filings/`, above a threshold bracketed between 156,863 and 1,429,442 rows — where `count` is an estimate and `pages` inherits its error. The service carries the flag verbatim through `PageResult` and `SeekResult`; an absent flag stays absent, since reading it as `false` would label a tallied count an estimate.

Tools surface it as `count_is_approximate`, set only when upstream declared the count inexact, and `format()` then renders `≈N total (approximate)`. The polarity is deliberate: a positively-named flag that is simply absent for a tallied count keeps an exact response byte-identical on both surfaces, where an `is_count_exact: true` carried into the output would have to render a marker on every response to keep `structuredContent` and `content[]` in parity. The framework's `total` enrichment still renders a bare `**N total**` trailer from the number alone, so the four tools that measure inexact upstream also set the `notice` enrichment to say the total is an estimate. The static "may be approximate for itemized" caveat the three itemized tools used to carry on `count` is gone — it was wrong in both directions, hedging a `count: 1` terminal page while `openfec_search_filings` measured inexact with no caveat at all.

### 16. High-volume pages are bounded to 100,000 bytes per surface

At `per_page: 100` a single page from the six high-volume search tools ran 310–700KB across `structuredContent` and `content[]` — pagination worked, but one permitted page could fill a model's context. The budget is **100,000 bytes on each surface, independently**, reached by two lossless measures and no change to any schema-declared `per_page` maximum, which stays 100 (OpenFEC's own ceiling).

1. **Null/empty-field drop.** `dropEmptyFields` removes `null`, `''`, `[]`, and records left empty, at every depth, from every itemized and filing row and from candidate and totals rows — 15–46% of row bytes, carrying nothing. `false` and `0` stay; array elements are never removed, since their positions can carry meaning.
2. **An effective `per_page` cap.** Each tool sends `min(per_page, cap)` upstream, per scope. The cap lowers the request itself rather than trimming a fetched page, so no row is ever discarded: the keyset tools mint `next_cursor` from the last row upstream actually returned, and the page-based tools echo the size applied as `pagination.per_page`, with `pages` and every page number counted at that size.

A page bounded below the caller's request, with rows remaining past it, sets the `truncated`/`shown`/`cap` enrichment and a `notice` naming the continuation; `totalCount` and `count` keep the full upstream total. A page the cap did not bound, a naturally short last page, and an exhausted position report nothing — they are complete.

Each cap is the largest multiple of 5 for which a page of the heaviest row measured live in that scope stays within the budget on both surfaces, and a page at the heaviest measured per-row average stays within 90% of it. Measured 2026-09-23 against 2024 data, after the null-drop and compact committee rendering; `structuredContent` bytes per row (it outweighs `content[]` in every scope):

| Tool | Scope | Heaviest avg / row | Heaviest row | Cap |
|:--|:--|--:|--:|--:|
| `openfec_search_contributions` | itemized | 2,151 | 2,894 | 30 |
| `openfec_search_disbursements` | itemized | 2,391 | 2,961 | 30 |
| `openfec_search_expenditures` | itemized, `committee_id` (hoisted) | 1,427 | 1,487 | 60 |
| `openfec_search_expenditures` | itemized, no `committee_id` (per-row committee) | 2,689 | 3,100 | 30 |
| `openfec_search_coordinated_expenditures` | `committee_id` (hoisted) | 1,055 | 1,070 | 80 |
| `openfec_search_coordinated_expenditures` | no `committee_id` (per-row committee) | 3,026 | 3,130 | 25 |
| `openfec_search_filings` | all | 1,345 | 1,426 | 65 |
| `openfec_search_candidates` | `include_totals`, `cycle` or `election_year` set | 1,828 | 2,756 | 35 |
| `openfec_search_candidates` | `include_totals` across every cycle | 8,135 | 17,303 | 5 |

A candidate row is the candidate plus its totals rows — one per cycle filed, so an all-cycles page of long-serving incumbents is the heaviest shape the server returns. Candidate search without totals (835 bytes at the heaviest row) and every aggregate mode stay under the budget at 100 and are not capped. The heaviest row of each scope, strings masked to equal-length placeholders, is kept as a test fixture, so a cap or renderer that outgrows the budget fails the suite.

Rejected: truncating a fetched page (breaks keyset continuation and discards rows the caller paid a request for), lowering the schema maximum (a breaking contract change for a budget the server can meet on its own), and DataCanvas `spillover()` (needs a canvas provider this server does not register).

---

## Known Limitations

- **Rate limits:** 1,000 requests/hour with a standard key. Complex multi-tool workflows can consume 5–10 requests per user interaction. Heavy use requires an elevated key.
- **DEMO_KEY:** ~40 requests/hour. Barely functional for testing. Users need a real key.
- **Approximate counts on high-volume endpoints:** Schedule A/B/E and `/filings/` return `is_count_exact: false` above roughly a million rows. The `count` field is then an estimate, not a precise total, and `pages` inherits its error. Responses carry `count_is_approximate` and render the total as `≈N total (approximate)` when that happens (decision 15), but the estimate itself cannot be improved.
- **Schedule A date range limitation:** The API does not support date ranges spanning multiple `two_year_transaction_period`s. Queries are scoped to a single cycle.
- **Legal search vs. entity search:** Legal search is full-text, not entity-linked. Searching for a committee name may miss cases where the committee is referenced differently.
- **Data freshness:** Nightly refresh for most data. E-filing data is near-real-time but only retained ~4 months and is excluded from this server's scope.
- **No field selection:** The API does not support a `fields` parameter, so full records come back — a Schedule A/B/E row runs 3–4KB. The nested committee object, roughly a third of that weight, is hoisted out of the rows whenever the query is scoped to a single `committee_id`, null and empty fields are dropped, and each high-volume tool caps the page size it requests (decision 16). The cost is more calls per result set: at `per_page: 100` a bounded tool returns 5–80 rows a page, and walking a large set takes proportionally more requests against the rate limit.
- **Page budget is measured, not enforced:** The per-scope caps come from the heaviest rows measured live, not from serializing each response. An unusually heavy page can still exceed 100,000 bytes — most plausibly an all-cycles candidate search with totals, where one long-serving incumbent's totals alone run ~30KB.

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
    "pages": 13195871,
    "per_page": 20
  },
  "results": [...]
}
```

`last_indexes` is populated on the last row of every page, so its presence says nothing about whether another page exists — the terminal page of a set carries it, and the empty page past the end carries `last_indexes: null`. The envelope also carries no `page`. See decision 2 for the signals the cursor decision reads instead.

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
| Candidate | `[HSP][0-9A-Z]{8}` (case-insensitive) | `P00003392`, `H2CO07170`, `S4AZ00345` |
| Committee | `C[0-9]{8}` (case-insensitive) | `C00358796` |

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
