# OpenFEC MCP Server — Design

## MCP Surface

### Tools

All tools are read-only and idempotent (`readOnlyHint: true`, `idempotentHint: true`).

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `openfec_search_candidates` | Find federal candidates by name, state, office, party, or cycle. Retrieve a specific candidate by FEC ID with financial totals. | `query`, `candidate_id`, `state`, `office`, `party`, `cycle`, `include_totals` | readOnly, idempotent |
| `openfec_search_committees` | Find political committees (campaign, PAC, Super PAC, party) by name, type, candidate affiliation, or state. | `query`, `committee_id`, `candidate_id`, `state`, `committee_type`, `designation`, `cycle` | readOnly, idempotent |
| `openfec_get_committee_totals` | Pre-aggregated committee financial totals — one committee's per-cycle summary, or a ranked search across every committee of one entity type. | `mode`, `committee_id`, `entity_type`, `cycle`, `committee_state`, `min_receipts`, `sort` | readOnly, idempotent |
| `openfec_search_contributions` | Search itemized individual contributions (Schedule A) by recipient committee or by donor, or get aggregate breakdowns by size, state, employer, or occupation. | `mode`, `committee_id`, `candidate_id`, `contributor_id`, `contributor_name`, `contributor_employer`, `contributor_state`, `cycle`, `min_amount`, `max_amount` | readOnly, idempotent |
| `openfec_search_disbursements` | Search itemized committee spending (Schedule B) or get aggregate breakdowns by purpose or recipient. | `mode`, `committee_id`, `recipient_name`, `disbursement_description`, `cycle`, `min_amount`, `max_amount` | readOnly, idempotent |
| `openfec_search_expenditures` | Search independent expenditures (Schedule E) — outside spending supporting or opposing federal candidates. | `mode`, `committee_id`, `candidate_id`, `support_oppose`, `cycle`, `min_amount`, `max_amount` | readOnly, idempotent |
| `openfec_search_coordinated_expenditures` | Search coordinated party expenditures (Schedule F) — party committee spending made on behalf of a candidate, in coordination with that campaign. | `committee_id`, `candidate_id`, `cycle`, `payee_name`, `min_date`, `max_date`, `min_amount`, `max_amount` | readOnly, idempotent |
| `openfec_search_filings` | Search FEC filings and reports by committee, candidate, form type, or date range. | `committee_id`, `candidate_id`, `form_type`, `report_type`, `cycle`, `most_recent` | readOnly, idempotent |
| `openfec_lookup_elections` | Look up federal election races and candidate financial summaries. Find who's running with fundraising totals. | `mode`, `office`, `cycle`, `state`, `district` | readOnly, idempotent |
| `openfec_search_legal` | Search FEC legal documents: advisory opinions, enforcement cases (MURs), alternative dispute resolutions, administrative fines, and statutes. | `query`, `type`, `ao_number`, `case_number`, `respondent` | readOnly, idempotent |
| `openfec_get_legal_document` | Fetch one legal document in full by type and number — the detail counterpart to the compact search results. A record over the 100,000-byte response budget pages its arrays by entry offset. | `doc_type`, `no`, `array`, `offset` | readOnly, idempotent |
| `openfec_lookup_calendar` | Look up FEC calendar events, filing deadlines, and election dates. | `mode`, `state`, `min_date`, `max_date` | readOnly, idempotent |

### Resources

All resource data is also reachable via tools. Resources add convenience for clients that support injectable context.

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `openfec://candidate/{candidate_id}` | Candidate profile with current financial totals and `principal_committees`. That list filters on each committee's current designation with no cycle, so it can include past campaigns and miss a committee since redesignated; a cycle's principal committee comes from `openfec_lookup_elections` `candidate_pcc_id`. | No |
| `openfec://committee/{committee_id}` | Committee profile with type, designation, and financial summary. A committee with no totals on file resolves with its base record alone; a failed totals request fails the read. | No |
| `openfec://election/{cycle}/{office}` | Election race summary. `state` and `district` appended as path segments when applicable (e.g., `openfec://election/2024/S/AZ`). The state template reads an `H` race as district `00`, the district OpenFEC files at-large seats under (`openfec://election/2026/H/WY`). `{state}` wider than two characters fails `invalid_state_code` (decision 21). Each template's `office` enum rejects the codes it does not serve with a message naming the sibling template that does. | First page only — returns the upstream `pagination` block, plus a `truncation_notice` pointing at `openfec_lookup_elections` when more pages exist. An empty race instead carries an `empty_result_notice` with the same guidance `openfec_lookup_elections` gives: check that the cycle is an even year, the state code, and that the district exists. |

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

- Free API key from [api.data.gov](https://api.data.gov/signup/). `DEMO_KEY` works without one, for testing: a small daily allowance shared by every caller on the same IP. The hourly figures api.data.gov and OpenFEC publish for it disagree with each other and with the daily window OpenFEC enforces, so no surface of this server states a `DEMO_KEY` count.
- Personal key: OpenFEC's published 1,000 requests/hour. Elevated key (email `APIinfo@fec.gov`): 120 requests/minute (7,200/hour)
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
| `state` | string | No | Two-letter US state code (e.g., `AZ`, `CA`); a leading `-` excludes it (`-GA`). Wider than two characters after that `-` fails `invalid_state_code` (decision 21). |
| `district` | string | No | Two-digit district number for House candidates (e.g., `07`). |
| `office` | `H` \| `S` \| `P` | No | Filter by office: H=House, S=Senate, P=President. |
| `party` | string | No | Party code as OpenFEC files it, up to three characters (e.g., `DEM`, `REP`, `LIB`, `W`); a leading `-` excludes it (`-DEM`). Wider after that `-` fails `invalid_party_code` (decision 21). |
| `cycle` | number | No | Two-year election cycle (e.g., `2024`). Even years only. |
| `election_year` | number | No | Specific election year the candidate ran in. |
| `incumbent_challenge` | `I` \| `C` \| `O` | No | Incumbent status: I=incumbent, C=challenger, O=open seat. |
| `candidate_status` | `C` \| `F` \| `N` \| `P` | No | Candidate status: C=present candidate, F=future candidate, N=not yet a candidate, P=prior candidate. |
| `has_raised_funds` | boolean | No | Only candidates whose committee has received receipts for this office. Useful for filtering out paperwork-only candidates. |
| `include_totals` | boolean | No | Include financial totals (receipts, disbursements, cash on hand, debt). Defaults to true when fetching a single candidate by ID. Adds at least one further API call — see the totals sub-fetch note below. |
| `page` | number | No | Page number (1-indexed). Default 1. Addresses the candidate list only. |
| `per_page` | number | No | Results per page. Default 20, max 100, sent upstream as given (decision 16). |

**Output:** Candidate records with: `candidate_id`, `name`, `party`/`party_full`, `state`, `office`/`office_full`, `district_number`, `incumbent_challenge`/`incumbent_challenge_full`, `cycles`, `election_years`, `candidate_status`, `first_file_date`, `has_raised_funds`. When `include_totals` is true: `receipts`, `disbursements`, `cash_on_hand_end_period`, `debts_owed_by_committee`, `individual_itemized_contributions`, `coverage_start_date`, `coverage_end_date`. Totals the call could not read in full come back with a `notice` saying so. Null and empty fields are dropped from candidate and totals rows.

**Pagination:** Page-based. Response includes `page`, `pages`, `count`, `per_page`; `per_page` echoes the caller's value.

**Totals sub-fetch:** `/v1/candidates/totals/` is a separately paged endpoint, not a view onto the candidate list — one candidate yields one row per cycle, so N candidates routinely produce more than N rows. The sub-fetch therefore ignores the candidate search's `page`/`per_page` and reads every totals row of the page's candidates with `getAllCandidateTotals`, a candidate keyset walk (decision 24). The candidate read and the walk share one 50 s budget (decision 25). If the budget runs out, a later request fails, or one candidate's rows fill a whole page, the candidates read so far come back whole and the `notice` says the totals are incomplete: a candidate shown without totals may still have them on file.

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
| `state` | string | No | Two-letter state code; `other` selects foreign, invalid, and missing states, and a leading `-` excludes a code (`-GA`). Anything else wider than two characters fails `invalid_state_code` (decision 21). |
| `party` | string | No | Party code as OpenFEC files it, up to three characters (e.g., `DEM`, `REP`, `LIB`, `W`); a leading `-` excludes it (`-DEM`). Wider after that `-` fails `invalid_party_code` (decision 21). |
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
| `cycle` | number | No | Two-year election cycle. Omit in `single` mode for every cycle on record, across changes of committee type (decision 11a). |
| `committee_state` | string | No | Two-letter state code; `other` selects foreign, invalid, and missing states, and a leading `-` excludes a code (`-PA`). Anything else wider than two characters fails `invalid_state_code` (decision 21). `by_entity_type` only. |
| `committee_type` | string | No | Committee type code, in any case, upper-cased before it is sent: one of `C D E H I N O P Q S U V W X Y Z`, else `invalid_committee_type` (decision 21); a leading `-` excludes the code and is kept (`-o` is sent as `-O`). `by_entity_type` only. |
| `committee_designation` | string | No | Committee designation code, in any case, upper-cased before it is sent: one of `A B D J P U`, else `invalid_committee_designation` (decision 21); a leading `-` excludes the code and is kept (`-u` is sent as `-U`). `by_entity_type` only. |
| `organization_type` | string | No | Sponsoring organization type. `by_entity_type` only. |
| `min_receipts` / `max_receipts` | number | No | Total receipts bound in dollars. `by_entity_type` only. |
| `min_disbursements` / `max_disbursements` | number | No | Total disbursements bound in dollars. `by_entity_type` only. |
| `sort` | enum | No | `cycle`, `receipts`, `disbursements`, `last_cash_on_hand_end_period`, each with a `-` descending form. |
| `page` | number | No | Page number. Default 1. |
| `per_page` | number | No | Results per page. Default 20, max 100. |

**Output:** Committee totals rows with `committee_id`, `committee_name`, `cycle`, `receipts`, `disbursements`, `last_cash_on_hand_end_period`, `last_debts_owed_by_committee`, the individual/PAC/party contribution breakdown, and `coverage_start_date`/`coverage_end_date`. `mode` echoes the resolved mode; `search_criteria` echoes every filter applied, minus paging, with `committee_type` and `committee_designation` as sent (upper-cased).

**Pagination:** Page-based in both modes. A long-running committee can hold more cycles than one page.

**Error modes:**
- `single` mode without a `committee_id` → `ValidationError` (`committee_id_required_for_single_mode`).
- `by_entity_type` mode without an `entity_type` → `ValidationError` (`entity_type_required_for_group_mode`), carrying `valid_entity_types`.
- A grouped-search filter supplied alongside `single` mode → `ValidationError` (`inputs_not_applicable_to_mode`). The single-committee endpoint accepts only paging, `cycle`, and `sort`, so applying one would have returned unfiltered totals.
- `single` mode matching no row → `NotFound` (`committee_totals_not_found`). The endpoint answers 404 for an unknown ID or a cycle the committee did not file, and 200 with no rows for a committee that has a filing history but no totals (one that files no financial report, say), so all three land here; the message names the cycle when one was given.
- `single` mode without `cycle` whose history read, a read of another type's cycles, or the whole-table re-read of the current type fails for any reason but a rate limit or cancellation (a 4xx, 5xx, timeout, dropped connection, or malformed answer — a 404 for cycles the history named included) → success with the rows the reads that succeeded hold and a `notice` naming what may be missing. A rate limit or cancellation fails the call; so does any such failure when the reads that succeeded hold no rows, since an empty page would read as "no totals on file". OpenFEC's own 404 for the history reads as an empty history, so an unknown ID still lands on `committee_totals_not_found`.

**Upstream endpoints:**
- `/v1/committee/{committee_id}/totals/` — one committee, one row per cycle
- `/v1/committee/{committee_id}/history/` — the committee's type per cycle, read beside an omitted-cycle totals request (decision 11a)
- `/v1/totals/{entity_type}/` — grouped search across committees of one entity type

---

### `openfec_search_contributions`

Search itemized individual contributions (Schedule A) or get aggregate breakdowns. Central tool for answering "who's funding this candidate/committee?" and "where has this donor given?"

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `mode` | enum | No | `itemized` (default) — individual contribution records. `by_size` — aggregate by contribution size bucket ($200 and under, $200.01–$499.99, etc.). `by_state` — aggregate by contributor state. `by_employer` — aggregate by employer. `by_occupation` — aggregate by occupation. |
| `committee_id` | string | No | Receiving committee ID. Required for `by_employer` and `by_occupation`. In `itemized` mode it scopes the search on its own or narrows a donor scope to gifts to this committee. |
| `candidate_id` | string | No | Candidate ID. Used for `by_size` and `by_state` aggregate modes (routes to the `/by_candidate` variant), whose totals cover the full election period ending in `cycle`. |
| `contributor_id` | string | No | FEC committee ID of a registered donor (`C` + eight digits): the receipts recipients reported from it. Earmarked contributions carry the conduit ID here (e.g., ActBlue, `C00401224`) with the individual in `contributor_name`. Itemized mode only. |
| `contributor_name` | string | No | Full-text donor name search. Itemized mode only; scopes the search on its own. Without `committee_id`, a common name can time out upstream. |
| `contributor_employer` | string | No | Full-text employer search. Itemized mode only; scopes the search on its own. Without `committee_id`, an employer scan can time out upstream. |
| `contributor_occupation` | string | No | Full-text occupation search. Itemized mode only. |
| `contributor_city` | string | No | Contributor city. Itemized mode only. |
| `contributor_state` | string | No | Two-letter state code; `other` selects foreign, invalid, and missing states, and a leading `-` excludes a code (`-GA`). Anything else wider than two characters fails `invalid_state_code` (decision 21). Itemized mode only. |
| `contributor_zip` | string | No | ZIP code prefix (starts-with match). Itemized mode only. |
| `cycle` | number | No | Two-year election cycle. For itemized mode, this sets `two_year_transaction_period` (required by the API). Defaults to current cycle if omitted, for candidate-scoped `by_size`/`by_state` too, where it names the election and the totals cover the full election period ending in it (4yr president, 6yr senate, 2yr house). |
| `min_date` | string | No | Earliest contribution date (YYYY-MM-DD). Itemized mode only. |
| `max_date` | string | No | Latest contribution date (YYYY-MM-DD). Itemized mode only. |
| `min_amount` | number | No | Minimum contribution amount in dollars. Itemized mode only. |
| `max_amount` | number | No | Maximum contribution amount in dollars. Itemized mode only. |
| `is_individual` | boolean | No | Only individual contributions (excludes committee-to-committee transfers). Itemized mode only. |
| `sort` | `contribution_receipt_date` \| `contribution_receipt_amount`, each with an optional `-` prefix for descending | No | Sort field. Itemized mode only. |
| `page` | number | No | Page number (1-indexed). Defaults to 1 in aggregate modes. Explicit values are rejected in itemized mode, which paginates with `cursor`. |
| `per_page` | number | No | Results per page. Default 20, max 100, sent upstream as given (decision 16). |
| `cursor` | string | No | Opaque pagination cursor from a previous response. Itemized mode uses keyset pagination — pass the cursor to get the next page. Valid only for an otherwise-identical call. |

**Output:**
- *Itemized:* Contribution records with: `contributor_name`, `contributor_employer`, `contributor_occupation`, `contributor_city`, `contributor_state`, `contributor_zip`, `contribution_receipt_amount`, `contribution_receipt_date`, `contributor_aggregate_ytd`, `committee_id`, `committee_name`, `candidate_id`, `candidate_name`, `receipt_type_full`, `is_individual`, `memo_code`, `memoed_subtotal`, `memo_text`, `pdf_url`. Plus `next_cursor` for pagination. Committee records are carried once per page, in full on both surfaces (decision 9). Scoped by `committee_id`, the receiving committee is hoisted into a top-level `committee` field. Scoped by donor alone, rows span recipients: nothing is hoisted and each recipient's record is in `committees`, keyed by the row's `committee_id` — the only place the recipient's name appears, since the flat `committee_name` is null. A donor that is itself a committee is in `contributor_committees`, keyed by the row's `contributor_id`. A row with `memo_code` `X` is a memo entry and is labelled as one (decision 23).
- *Aggregates:* Records with: dimension field (`size`, `state`, `employer`, `occupation`), `count`, `total`, `cycle`, and either `committee_id` or `candidate_id`. `by_size` and `by_size_candidate` rows carry `size_range` after `size`: `$200 and under (includes unitemized)` for floor 0 (so its `count` is null), then `$200.01 to $499.99`, `$500 to $999.99`, `$1,000 to $1,999.99`, `$2,000 and over`; a floor outside those five carries none. `by_state`, `by_employer`, and `by_occupation` rows gain no `size_range`.
- *Aggregate notices:* `by_size` and `by_state` with neither `committee_id` nor `candidate_id` return every committee's bucket for every cycle, one row per committee and cycle, not a combined breakdown; the rows stay and the `notice` says so, followed by the approximate-count sentence when the count is an estimate (decision 15). Any other non-empty aggregate page with an estimated count carries the approximate-count sentence. An exhausted position carries the exhausted-position notice instead (decision 14).
- *All modes:* `mode` echoes the mode the server resolved (a `by_size`/`by_state` query scoped by `candidate_id` resolves to `by_size_candidate`/`by_state_candidate`, which send and echo `election_full: true` in `search_criteria`), and `search_criteria` echoes every filter applied, minus paging.

**Pagination:**
- Itemized: Keyset (SEEK). Response includes `next_cursor` (opaque string encoding `last_indexes`). Pass as `cursor` to get next page.
- Aggregates: Page-based.

**Error modes:**
- Itemized with none of `committee_id`, `contributor_id`, `contributor_name`, or `contributor_employer` (a blank or whitespace value does not count) → `ValidationError` (`itemized_requires_scope`), before any upstream call. Occupation, city, state, ZIP, date, amount, and `is_individual` filters narrow a scoped search but cannot scope one. The scopes combine freely, `committee_id` included (a PAC's gifts to one campaign). Candidate scoping is not offered: for a candidate use a `by_size` or `by_state` aggregate mode with `candidate_id`, or look up the candidate's committee with `openfec_search_committees`.
- A malformed `contributor_id` → `ValidationError` (`invalid_committee_id`) naming `contributor_id`.
- `contributor_state` wider than two characters, unless it is `other` or a code after a leading `-` → `ValidationError` (`invalid_state_code`).
- `by_employer`/`by_occupation` without `committee_id` → `ValidationError` (`aggregate_requires_committee_id`).
- An itemized-only input in any aggregate mode → `ValidationError` (`itemized_only_filters_in_aggregate_mode`). The aggregate endpoints accept only `committee_id`, `candidate_id`, `cycle`, `mode`, `page`, `per_page`; every contributor filter (`contributor_id` included), date bound, amount bound, `is_individual`, `sort`, and `cursor` is itemized-only. The rejection names both the offending inputs and the mode's supported set rather than dropping the filters and answering an unnarrowed query.
- An explicit `page` or `candidate_id` in itemized mode → `ValidationError` (`inputs_not_applicable_to_mode`); the Schedule A itemized endpoint accepts `per_page` and `cursor`, but neither page-number pagination nor candidate scoping.
- `candidate_id` in `by_employer` / `by_occupation`, or both IDs when `by_size` / `by_state` resolves to its candidate endpoint → `ValidationError` (`inputs_not_applicable_to_mode`). Each resolved aggregate endpoint receives only the identifier it actually supports.
- Missing `cycle` on itemized → auto-default to current cycle (API requires `two_year_transaction_period`).

**Upstream endpoints:**
- `/v1/schedules/schedule_a/` — itemized contributions (SEEK). A query OpenFEC cancels at its statement timeout answers 504 `Query timed out`, which is attempted once rather than retried (see the Resilience table); a broad `contributor_name` or `contributor_employer` without `committee_id` can reach it.
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
| `recipient_state` | string | No | Recipient state; `other` selects foreign, invalid, and missing states, and a leading `-` excludes a code (`-GA`). Anything else wider than two characters fails `invalid_state_code` (decision 21). Itemized mode only. |
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
| `per_page` | number | No | Results per page. Default 20, max 100, sent upstream as given (decision 16). |
| `cursor` | string | No | Opaque pagination cursor from a previous response. Itemized mode only. Valid only for an otherwise-identical call. |

**Output:**
- *Itemized:* Disbursement records with: `recipient_name`, `recipient_city`, `recipient_state`, `recipient_zip`, `disbursement_amount`, `disbursement_date`, `disbursement_description`, `disbursement_purpose_category`, `committee_id`, `committee_name`, `candidate_id`, `candidate_name`, `entity_type`, `memo_code`, `memoed_subtotal`, `memo_text`, `pdf_url`. Plus `next_cursor`. Committee records are carried once per page, in full on both surfaces (decision 9): the spending committee is hoisted into a top-level `committee` field (`committee_id` is required, so it is identical in every row), and each payee that is itself a committee is in `recipient_committees`, keyed by the row's `recipient_committee_id`. A row with `memo_code` `X` is a memo entry and is labelled as one (decision 23).
- *by_purpose:* Records with: `purpose`, `count`, `total`, `memo_count`, `memo_total`, `cycle`, `committee_id`. `memo_count` and `memo_total` are the bucket's memo entries, which `count` and `total` already exclude; never add them to `count` or `total`.
- *by_recipient:* Records with: `recipient_name`, `count`, `total`, `recipient_disbursement_percent`, `cycle`, `committee_id`.
- *by_recipient_id:* Records with: `recipient_id`, `recipient_name`, `committee_name`, `count`, `total`, `cycle`.
- *All modes:* `mode` echoes the resolved mode and `search_criteria` echoes every filter applied, minus paging.

**Pagination:** Itemized: keyset. Aggregates: page-based.

**Error modes:**
- `committee_id` is required in every mode: the input schema rejects a missing or empty one, and a malformed one fails `invalid_committee_id`.
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
| `mode` | enum | No | `itemized` (default) — individual expenditure records. `by_candidate` — aggregated totals per candidate by committee, largest `total` first (`sort=-total` is sent on every page; `sort` itself stays rejected in this mode). |
| `committee_id` | string | No | Spending committee ID. |
| `candidate_id` | string | No | Targeted candidate ID. |
| `support_oppose` | `S` \| `O` | No | `S` = support, `O` = oppose. Sent as `support_oppose_indicator` (itemized) or `support_oppose` (`by_candidate`). |
| `payee_name` | string | No | Full-text payee name search. Itemized mode only. |
| `candidate_office` | `H` \| `S` \| `P` | No | Office of the targeted candidate. Sent as `candidate_office` (itemized) or translated to `office` = `house`/`senate`/`president` (`by_candidate`). |
| `candidate_office_state` | string | No | State of the targeted race. Sent as `candidate_office_state` (itemized) or `state` (`by_candidate`). Presidential `by_candidate` rows carry no state. Itemized mode also takes `other` (foreign, invalid, and missing states) and a leading `-` that excludes a code (`-GA`); `by_candidate` matches the state exactly and takes neither. Any other value wider than two characters fails `invalid_state_code` before any request, in both modes (decision 21). |
| `candidate_office_district` | string | No | Two-digit House district of the targeted race. Sent as `candidate_office_district` (itemized) or `district` (`by_candidate`). Senate and presidential `by_candidate` rows carry no district. |
| `candidate_party` | string | No | Party code as OpenFEC files it, up to three characters (e.g., `DEM`, `REP`, `LIB`, `W`), of the targeted candidate; a leading `-` excludes it (`-DEM`), and wider after that `-` fails `invalid_party_code` (decision 21). Itemized mode only — `by_candidate` rejects it, since the aggregate endpoint has no party filter. |
| `cycle` | number | No | Two-year election cycle. Itemized mode defaults to the current cycle when omitted. In `by_candidate` mode it names the election, and `election_full` decides the period its totals cover. |
| `election_full` | boolean | No | `by_candidate` mode only: totals over the full election period ending in `cycle` (4yr president, 6yr senate, 2yr house) instead of the two-year cycle alone. Defaults to true — OpenFEC's own default and `openfec_lookup_elections`' — and the effective value is sent upstream and echoed in `search_criteria`. Carries no schema default, so an explicit value is distinguishable from an omission. |
| `min_date` | string | No | Earliest expenditure date (YYYY-MM-DD). Itemized mode only. |
| `max_date` | string | No | Latest expenditure date (YYYY-MM-DD). Itemized mode only. |
| `min_amount` | number | No | Minimum amount. Itemized mode only. |
| `max_amount` | number | No | Maximum amount. Itemized mode only. |
| `is_notice` | boolean | No | Which Schedule E filings to read. Omitted returns 24/48-hour notices and periodic-report rows together, which overlap — most spending filed on a notice is reported again on the same spender's next periodic report — so never add the two kinds together. `false` returns report rows only, which sum once memo entries are left out. `true` returns notices only, the newest spending, filed before it reaches a periodic report. Itemized mode only. |
| `most_recent` | boolean | No | Only the most recent version of amended filings. Itemized mode only — defaults to true there when omitted, and `by_candidate` rejects it. Carries no schema default, so an explicit value is distinguishable from an omission. |
| `sort` | `expenditure_date` \| `expenditure_amount` \| `office_total_ytd`, each with an optional `-` prefix for descending | No | Sort field. Itemized mode only. |
| `page` | number | No | Page number (1-indexed). Defaults to 1 in `by_candidate` mode. Explicit values are rejected in itemized mode, which paginates with `cursor`. |
| `per_page` | number | No | Results per page. Default 20, max 100, sent upstream as given (decision 16). |
| `cursor` | string | No | Opaque pagination cursor. Itemized mode only. Valid only for an otherwise-identical call. |

**Output:**
- *Itemized:* Expenditure records with: `committee_id`, `committee_name`, `payee_name`, `expenditure_amount`, `expenditure_date`, `expenditure_description`, `support_oppose_indicator`, `candidate_id`, `candidate_name`, `candidate_office`, `candidate_office_state`, `candidate_party`, `is_notice`, `dissemination_date`, `office_total_ytd`, `most_recent`, `memo_code`, `memoed_subtotal`, `pdf_url`. Plus `next_cursor`. A row with `is_notice: true` is labelled `24/48-hour notice` and a row with `memo_code` `X` is labelled `memo entry` in its `content[]` header; a page that mixes either kind with other rows carries a `notice` sentence with the count, "{n} of {m} rows on this page are …", and a do-not-sum warning (decision 23).
- *by_candidate:* Records with: `candidate_id`, `candidate_name`, `committee_id`, `committee_name`, `support_oppose_indicator`, `count`, `total`, `cycle`, largest `total` first. The totals come from periodic reports only; 24/48-hour notices are excluded so one buy is not counted twice. In the current cycle (`cycle` omitted, or the current cycle or later) the `notice` therefore says that spending reported so far only on a notice is missing from the totals, and names the itemized call that lists it — `mode: "itemized"`, `is_notice: true`, and the caller's scope. When the by_candidate call carried `page` or `election_full`, the sentence says to leave them out, since itemized mode rejects both. An earlier cycle's notices have all reappeared on reports, so it carries no such sentence. On an empty current-cycle page the sentence follows "No periodic report lists independent expenditures in this scope."; an empty past-cycle page gets the zero-match sentence.
- *All modes:* `mode` echoes the resolved mode and `search_criteria` echoes every filter applied, minus paging.

Itemized rows drop the nested `candidate` sub-object, whose three fields are the row's own `candidate_id`, an internal `idx`, and a `two_year_period` that restates the query's cycle. The nested `committee` object is hoisted into a top-level `committee` field **only when the caller supplied a `committee_id`** — Schedule E does not require one, so a candidate- or race-scoped page spans several spending committees and hoisting any single one would misattribute the rest. Without a `committee_id`, the page's spenders are collected into a top-level `committees` map keyed by `committee_id`, each rendered once in full on both surfaces; a row's `committee_id` line in `content[]` reads `C… (NAME)`.

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
| `per_page` | number | No | Results per page. Default 20, max 100, sent upstream as given (decision 16). |

**Output:** Coordinated expenditure records with `expenditure_date`, `expenditure_amount`, `expenditure_type_full`, `expenditure_purpose_full`, `payee_name`, `candidate_id`/`candidate_name`/`candidate_office`, `aggregate_general_election_expenditure`, `subordinate_committee_id`, `filing_form`, `image_number`, `memo_code`, and `pdf_url`. Spending committees are carried once per page (see Payload shaping). A row with `memo_code` `X` is a memo entry and is labelled as one; Schedule F rows carry no `memoed_subtotal`, so `memo_code` alone identifies it (decision 23).

**Pagination:** Page-based — unlike Schedules A, B, and E, this endpoint has no `last_index` keyset. Unscoped queries return promptly (roughly 82K rows across all history), so no cycle default is applied.

**Payload shaping:** Rows embed up to two committee objects. `committee` — the spender — is hoisted out once when the caller scoped the query to a single `committee_id`, following the Schedule B/E convention; otherwise it is collected into a top-level `committees` map keyed by `committee_id`, each spender once and in full on both surfaces. A row whose record differs from its ID's entry — the same committee's record for another cycle, on a page spanning cycles — keeps its own, rendered in full. `subordinate_committee` is dropped outright: across a 100-row sample it was null on 39 rows, the spender again on 60, and a different committee on 1, and in every case the row's own `subordinate_committee_id` matched it — so the ID is the recovery path, resolvable through `openfec_search_committees`.

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
| `per_page` | number | No | Results per page. Default 20, max 100, sent upstream as given (decision 16). |

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
| `office` | `H` \| `S` \| `P` | Yes | Office sought: H=House, S=Senate, P=President. |
| `cycle` | number | Yes | Election cycle year (e.g., `2024`). Even years only. |
| `state` | string | No | Two-letter state code. Required for Senate and House races unless `zip` is given. Presidential races are filed under `US`: omit it or pass `US` (any case). Wider than two characters fails `invalid_state_code` (decision 21). |
| `district` | string | No | Two-digit district number; `00` for an at-large House seat (e.g., WY, AK). Required for House races unless `zip` is given. Presidential and Senate races are filed under `00`: omit it or pass `00`. |
| `zip` | string | No | ZIP code — returns a locator (`office`, `state`, `district`, `cycle`) for each race covering this ZIP, not candidates. Pass a locator back as `state` and `district` for that race. Search mode only. |
| `election_full` | boolean | No | Expand to full election period: 4 years for President, 6 for Senate, 2 for House. Defaults to true when omitted, and a ZIP-scoped search rejects it. Carries no schema default, so an explicit value is distinguishable from an omission. |
| `page` | number | No | Page number (1-indexed). Defaults to 1 in search mode. An explicit value is rejected in summary mode. |
| `per_page` | number | No | Results per page. Default 20, max 100. Search mode only. |

**Output:**
- *Search:* Candidate records in the race with: `candidate_id`, `candidate_name`, `candidate_pcc_id`, `candidate_pcc_name`, `party_full`, `incumbent_challenge_full`, `total_receipts`, `total_disbursements`, `cash_on_hand_end_period`, `coverage_end_date`, `committee_ids`. With `zip`, race locators instead; `content[]` heads each with its race — `GA-05 House 2026`, `GA Senate 2026`, `President 2024` — and keeps a presidential race's state and a Senate race's district as fields, since they are the values to pass back.
- *Summary:* Aggregate totals for the race, with an `_independent_expenditures_note` that marks `independent_expenditures` as an unreconciled upstream aggregate and points to `openfec_search_expenditures` `by_candidate` for per-committee totals from periodic reports; in the current cycle those leave out spending reported so far only on 24/48-hour notices, which itemized mode with `is_notice: true` returns.
- *All modes:* `mode` echoes the resolved mode and `search_criteria` echoes every filter applied, minus paging — including the `election_full` default when the caller omitted it.

**Pagination:** Page-based.

**Error modes:**
- Senate/House without `state` and without `zip` → `ValidationError` (`missing_state_for_office`).
- House without `district` and without `zip` → `ValidationError` (`missing_district_for_house`); the recovery names `00` for an at-large seat.
- Odd cycle year → `ValidationError` (`cycle_must_be_even`).
- A presidential race given a `state` other than `US`, or a presidential or Senate race given a `district` other than `00` → `ValidationError` (`inputs_not_applicable_to_office`), in both modes and with a `zip`, before any request. OpenFEC files those races under `US` and `00`, so any other value matches nothing, and the empty-result notice would have blamed the state code. The error carries `inapplicable_inputs` and `filed_values`. `US` and `00` pass, and so does `0`, which OpenFEC's district arg pads to `00` (sent and echoed as given); `000` does not pad and fails. (`inputs_not_applicable_to_mode` means the endpoint cannot take the input; here it can.)
- `state` wider than two characters → `ValidationError` (`invalid_state_code`, decision 21).
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
| `type` | enum | No | `advisory_opinions`, `murs` (Matters Under Review), `adrs` (Alternative Dispute Resolution), `admin_fines`, `statutes`. Omit to search every type the type-specific filters below apply to — all five when none is given. |
| `ao_number` | string | No | Specific advisory opinion number (e.g., `2024-01`). `advisory_opinions` only. |
| `case_number` | string | No | Specific MUR, ADR, or administrative fine case number. `murs`, `adrs`, `admin_fines`. |
| `respondent` | string | No | Respondent name. `murs`, `adrs`. |
| `regulatory_citation` | string | No | One CFR citation, `<title> CFR <part>.<section>` (e.g., `11 CFR 110.1`). `advisory_opinions`, `murs`, `adrs`. |
| `statutory_citation` | string | No | One U.S.C. citation, `<title> U.S.C. <section>` (e.g., `52 U.S.C. 30104`). `advisory_opinions`, `murs`, `adrs`. |
| `min_penalty_amount` | number | No | Minimum penalty amount. `murs`, `adrs`, `admin_fines` — an administrative fine matches on its reason-to-believe or final-determination amount. |
| `max_penalty_amount` | number | No | Maximum penalty amount. `murs`, `adrs`, `admin_fines`. |
| `date_kind` | enum | No | Which date `min_date`/`max_date` bound: `issue_date`, `request_date`, `open_date`, `close_date`, `document_date`, `rtb_date`, `fd_date`. Must be one the chosen `type` records. Required alongside `type` whenever a bound is given. |
| `min_date` | string | No | Earliest date (YYYY-MM-DD) for the selected `date_kind`. Requires `type` and `date_kind`. |
| `max_date` | string | No | Latest date (YYYY-MM-DD) for the selected `date_kind`. Requires `type` and `date_kind`. |
| `from_hit` | number | No | Offset for pagination (0-indexed), counted within each document type. Default 0, max 9999. Bounded with `hits_returned` by the upstream result window: `from_hit + hits_returned <= 10000` (decision 4). |
| `hits_returned` | number | No | Results per page, applied per document type: a search covering several types returns up to this many of each. Default 20, max 200. Every result upstream returns is delivered. |

**Output:** Varies by `type`:
- *Advisory opinions:* `ao_no`, `name`, `summary`, `issue_date`, `request_date`, `status`, `requestor_names`, `regulatory_citations`, `statutory_citations`, `highlights`, and the related-filing summary `document_count` / `document_categories`.
- *MURs:* Case number, name, respondents, participants, subjects, and a disposition summary (`disposition_count`, `disposition_categories`).
- *Admin fines:* Case details, penalty amounts, respondents.
- *Statutes:* Citation, title, text.

The server normalizes the type-keyed response arrays into a uniform `results` array with a `document_type` discriminator. Every result is trimmed: `documents` becomes `document_count` and `document_categories`, `dispositions` becomes `disposition_count` and `disposition_categories` (the distinct `disposition` values, or `disposition_description` on administrative fines), `document_highlights` is dropped, highlights stop at three, and each `commission_votes` entry is cut to its `vote_date` and a 200-character `action`; `retrievalHint` points at `openfec_get_legal_document` for all of it. Every link is absolute (decision 22): the result's `url` is the record's page on fec.gov (a statute's is on govinfo.gov), and an advisory opinion, which arrives with none, is given `https://www.fec.gov/data/legal/advisory-opinions/<ao_no>/`. Each kept highlight has upstream's `<em>`/`</em>` match markup removed — only those two tokens, since the prose itself carries literal `<`, `>`, and `&` — and `content[]` puts each highlight on its own list line, since the snippets carry commas, with a snippet's own line breaks indented under its item. `format()` groups results by type, heads each by its number and `name` (or `mur_name` on an archived MUR), and renders nested fields through the legal field renderers of decision 18.

**Type-specific filters:** each is sent under the upstream name the selected type reads (decision 17):

| Input | `advisory_opinions` | `murs`, `adrs` | `admin_fines` | `statutes` |
|:--|:--|:--|:--|:--|
| `regulatory_citation` / `statutory_citation` | `ao_regulatory_citation` / `ao_statutory_citation` | `case_regulatory_citation` / `case_statutory_citation` | rejected (matches none) | rejected (ignored) |
| `min_penalty_amount` / `max_penalty_amount` | rejected (ignored) | `case_min_penalty_amount` / `case_max_penalty_amount` | `case_min_penalty_amount` / `case_max_penalty_amount` | rejected (ignored) |
| `respondent` | rejected (ignored) | `case_respondents` | rejected (matches none) | rejected (ignored) |
| `ao_number` | `ao_no` | rejected (ignored) | rejected (ignored) | rejected (ignored) |
| `case_number` | rejected (ignored) | `case_no` | `case_no` | rejected (ignored) |

**Pagination:** Custom model — `from_hit`/`hits_returned` (not page-based). The tool exposes this directly since it differs from other tools. The next page starts at `from_hit + hits_returned`, with the same filters (decision 4); a type that returned fewer than `hits_returned` is exhausted. `total_count` covers the types searched: `total_all` for a search scoped to one type (by `type`, or by filters that leave only one) or one with no type-specific filter, and otherwise the sum of the per-type `total_<type>` counts over the types kept.

**Error modes:**
- No scoping filter at all → `ValidationError` (`missing_filter`). Any one of `query`, `type`, `ao_number`, `case_number`, `respondent`, `regulatory_citation`, `statutory_citation`, a penalty bound, or a date bound satisfies it.
- A type-specific filter the selected `type` ignores or never matches, or — with `type` omitted — type-specific filters no single type accepts together (`ao_number` with `respondent`) → `ValidationError` (`filter_not_valid_for_type`), carrying `accepted_by`: each offending filter mapped to the types it applies to. A citation on `murs` or `adrs` sent with `case_number`, `respondent`, a penalty bound, or an `open_date`/`close_date` bound fails the same way, carrying `ignored_with_citation` (decision 17).
- A citation the search index cannot parse, or a value holding a second citation → `ValidationError` (`invalid_citation`), carrying `invalid_citations` (decision 19).
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

Fetch one legal document in full. The detail counterpart to `openfec_search_legal`, which trims every result unconditionally and offers no way to recover what it cut. A record too large for the 100,000-byte response budget is returned in parts (decision 20).

**Input schema:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `doc_type` | enum | Yes | `advisory_opinions`, `murs`, `adrs`, `admin_fines`, `statutes` — the plural of a search result's `document_type` discriminator. |
| `no` | string | Yes | Document number from the matching search result's `no` field. Advisory opinions are year-serial (`2024-01`); MURs, ADRs, and admin fines are digit strings (`8363`); statutes are U.S. Code section numbers (`30123`). |
| `array` | string | No | One top-level array field of the record to page through by entry — usually one `withheld` named. |
| `offset` | number | No | Entry offset (0-indexed) into `array`; requires `array`, defaults to 0 with it. |

**Output:** one flat object with three arms, rendered on field presence:
- *Whole:* `document` — the complete record as upstream sends it, with every link made absolute (decision 22), carrying the full `documents` array that search replaces with a count and category summary, the complete `dispositions` and `commission_votes`, and the scalar/date fields. Fields present vary by document type.
- *Bounded* (the whole record would exceed the budget): `document` carries every non-array field and the arrays that fit, smallest first, in the record's own key order; `withheld` lists the rest, smallest first, as `{ array, count, bytes }` — `bytes` is the array's JSON size in UTF-8. The `notice` names the re-call.
- *Slice* (`array` given): `document` carries the record's non-array fields; `slice` is `{ array, offset, total, next_offset?, entries }` — entries from `offset` while they fit, at least one while `offset` is inside the array, and `next_offset` until the last entry is in. An `offset` at or past the end returns no entries and a `notice` naming the array's length (decision 14); an empty array returns none and says so.

`search_criteria` echoes `doc_type`, `no`, and `array`, minus the paging `offset`. `attachedDocumentCount` enrichment reports the length of the record's `documents` in every arm — whether they are inline, in a slice, or held back — so it can be checked against the `document_count` the search result reported.

**Rendering:** `format()` heads the record by its number and `name`, or `mur_name` for an archived MUR whose `name` is null, and renders the nested fields through the legal field renderers of decision 18 — each `dispositions` entry's `citations` included. `withheld` renders as a list of array names with entry counts and sizes; a slice renders its entries numbered from `offset + 1` — every field of a `documents`, `commission_votes`, or `dispositions` entry, as their whole-record sections do, and an entry of any other array through that array's legal renderer — then the offset that continues it. Every array entry, in a whole-record section or a slice, is one CommonMark list item numbered by position, its first field on the marker line and the rest one per line at the item's content column. A field whose text spans lines renders as a list item under its key with its blank lines kept, so an upstream line that reads as a list marker (MUR 8309's vote action steps `1. Accept…`) stays inside its entry instead of joining the section's numbering.

**Not returned:** `highlights` and `document_highlights`. Those are a relevance artifact `/legal/search/` computes against a query, not data attached to a canonical record — the detail endpoint has no such field.

**Reachability:** search results carry the *singular* `document_type` (`mur`) while this path segment is *plural* (`murs`). The mapping is a trailing `s` in every case, and the tool description states it, because a caller chaining a search result cannot infer it from the schema alone. The number is always the result's `no`: `/legal/search/` records carry no `case_no` key at all, and `ao_no` is present only on advisory opinions, where it duplicates `no`.

**Error modes:**
- No record at the given `doc_type`/`no` → `NotFound` (`legal_document_not_found`).
- `array` names a field the record does not carry as an array → `ValidationError` (`array_not_in_record`), carrying `arrays`: the record's array fields.
- `offset` without `array` → `ValidationError` (`offset_without_array`), before any upstream call (decision 8).

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
| `state` | string | No | Two-letter state code, in any case; upper-cased before it is sent, since upstream matches it case-sensitively. A leading `-` excludes the state (`-ga` is sent as `-GA`). Wider than two characters after that `-` fails `invalid_state_code` (decision 21). Election dates mode. |
| `office` | `H` \| `S` \| `P` | No | Office sought. Election dates mode. |
| `district` | string | No | Two-digit House district (e.g., `14`), sent as `election_district`; a leading `-` excludes the district. A single digit is zero-padded, after that `-` too (`1` → `01`, `-1` → `-01`), since upstream matches only the padded form (measured live 2026-11-16: CA 2026 returned 6 election dates with no district and with `-1`, 4 with `-01`). Any other digit string passes through, and so does a whitespace-only value, which selects the rows upstream files with a blank district (at-large races). A value that is neither digits (after an optional `-`) nor spaces fails `invalid_district`. Upstream applies it without `state` — alone it matches that district number in every state. A numbered district never matches an at-large race. Election dates mode. |
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
- A `district` that is neither digits (after an optional `-`) nor spaces → `ValidationError` (`invalid_district`): no election date carries it.
- `state` wider than two characters after an optional leading `-` → `ValidationError` (`invalid_state_code`, decision 21).

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
| `searchCandidates(params, ctx, options?)` | `/candidates/`, `/candidates/{id}/` | Offset |
| `getCandidateTotals(params)` | `/candidates/totals/` | Offset |
| `getAllCandidateTotals(params, ctx, options?)` | `/candidates/totals/` → `{ results, complete }` | Candidate keyset (`sort=candidate_id`, `page=1` on every request, 100 per page), under one budget (decision 24) |
| `searchCommittees(params)` | `/committees/`, `/committees/{id}/` | Offset |
| `getCommitteeTotals(id, params)` | `/committee/{id}/totals/` | Offset |
| `getCommitteeTotalsAllCycles(id, params)` | `/committee/{id}/history/`, `/committee/{id}/totals/` (once per totals table) | Offset, applied locally across the merged rows (decision 11a) |
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
| Backoff calibration | 1s base delay (rate-limit oriented). An upstream `Retry-After` of 30 s or less (`withRetry`'s `maxDelayMs`) replaces the backoff. |
| Max retries | 3 (configurable via `FEC_MAX_RETRIES`). |
| Call budget | Every read — page, keyset, legal search, summary, legal document — shares one 50 s deadline across its attempts and backoffs (`CALL_DEADLINE_MS`); a caller that chains reads holds one budget and passes each read what is left of it (decision 25). `FEC_REQUEST_TIMEOUT` still bounds each request, capped by the time the budget has left. |
| Budget expiry | A read whose budget runs out reports the failure of the last attempt that completed — a 429's wait, a 5xx's or gateway 504's retry hint — with the expiry as its cause. With no completed attempt, or one that timed out on its own clock, it fails as `Timeout` with reason `retry_deadline_exceeded`: "FEC /path/ request did not finish within this call's 50-second budget (N attempts).", hint "Retry shortly; if it runs out of time again, narrow the query with more selective filters." |
| HTTP status check | `fetchWithTimeout` maps each non-OK status to its own code: 429 → `RateLimited`, 504 → `Timeout`, other 5xx → `ServiceUnavailable`; these retry, 501 excepted, and a 504 whose body is OpenFEC's own `{"message":"Query timed out","status":504}` (its database cancelled the query at the statement timeout) is attempted once, since the same query times out the same way again. A 429 whose `Retry-After` exceeds 30 s (an exhausted key's runs to hours) fails at once without retrying. Its message names that wait and, on `DEMO_KEY`, points at a personal `FEC_API_KEY`. A 504 carries the hint "The FEC API timed out running this query. Narrow it with more selective filters, then retry." |
| OpenFEC's stated reason | A 400, 404, or 422 whose body is OpenFEC's own `{message, status}` ends its message with OpenFEC's reason instead of a fixed hint: `OpenFEC rejected <param>: <messages>; …` for a validation map, `OpenFEC: <message>` for a string, whitespace folded to one line. `data.body` keeps the original. Any other body — edge HTML or plain text, api.data.gov's `{"error":…}`, a longer-than-captured document, JSON of another shape — keeps the fixed hint. |
| Parse failure | A 2xx body that is not JSON (an edge error page served with 200) or an envelope without a `results` array → `ServiceUnavailable`, retried like a 503. |
| Rate limit awareness | Not tracked: the `X-RateLimit-*` headers are never read. A 429's `Retry-After` is the only limit signal, passed through as `data.retryAfter` and named in the message. |

**Internal helpers:**

| Helper | Purpose |
|:-------|:--------|
| `buildUrl(path, params)` | Construct URL with query params, inject `api_key`, strip undefined values. |
| `getJson(url, ctx, attempt)` | One `fetchWithTimeout` GET under the request timeout or the attempt's remaining budget, whichever is smaller, and the attempt's signal (the read's deadline and the caller's cancellation), with `exposeErrorBody` set, parsed as JSON; a 2xx body that is not JSON fails as `ServiceUnavailable`. With 1 ms or less of budget left it sends nothing and waits for the deadline or the cancellation to settle the attempt. |
| `ladder<T>(operation, ctx, options, read)` | One read's request ladder: `read` under `withRetry`, every attempt and backoff inside `options.deadlineMs` (default `CALL_DEADLINE_MS`), a failure rethrown sanitized. It remembers the last attempt that completed, so an expired budget reports that failure (Resilience, "Budget expiry"). Every fetch helper below runs through it. |
| `fetchPage<T>(path, params, ctx, options?)` | `getJson` → validate envelope → return `{ pagination, results }`, inside `ladder`. |
| `fetchSeek<T>(path, params, query, ctx, delivered)` | Like `fetchPage` but returns `{ pagination, results, nextCursor }` from `last_indexes`, with the cursor bound to `query` and carrying the rows delivered through this page. |
| `fetchLegalSearch(params, ctx)` | Special handling for legal search response shape. |
| `cursorQuery(scope, input)` | Normalize a tool's arguments into the `{ scope, args }` identity its cursors are bound to (`cursor`, `page`, and `per_page` excluded). |
| `encodeCursor(lastIndexes, query, delivered?)` | Base64-encode `last_indexes`, the issuing query, and the rows delivered so far into an opaque cursor string. |
| `decodeCursor(cursor, expected)` | Validate the cursor and decode it back to `{ indexes, delivered }` — the `last_indexes` params and the rows delivered before it (0 for a cursor minted without the count). Throws `validationError` with `reason: 'invalid_cursor'` (malformed) or `'cursor_query_mismatch'` (issued for a different query). |

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `FEC_API_KEY` | No | `DEMO_KEY` | OpenFEC API key from api.data.gov. `DEMO_KEY` is a small daily allowance shared per IP; a personal key gets OpenFEC's published 1,000 requests/hour. |
| `FEC_BASE_URL` | No | `https://api.open.fec.gov/v1` | API base URL. |
| `FEC_MAX_RETRIES` | No | `3` | Max retry attempts for failed requests. |
| `FEC_REQUEST_TIMEOUT` | No | `30000` | Per-request timeout in milliseconds. Each call is also capped at 50 s across its attempts (decision 25). |

---

## Domain Mapping

| Noun | Operations | API Endpoints |
|:-----|:-----------|:-------------|
| Candidate | search, get by ID, financial totals | `/candidates/`, `/candidates/{id}/`, `/candidates/totals/` |
| Committee | search, get by ID | `/committees/`, `/committees/{id}/` |
| Committee Totals | one committee's per-cycle totals, grouped search by entity type | `/committee/{id}/totals/`, `/committee/{id}/history/`, `/totals/{entity_type}/` |
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
2. `openfec_search_expenditures` with `candidate_id`, mode `by_candidate` → totals for/against each candidate, largest first, from periodic reports only. In the current cycle, add the 24/48-hour notices (`mode` itemized, `is_notice: true`) dated after each spender's last periodic report, which those totals do not include yet.
3. `openfec_search_expenditures` with `support_oppose=O` → who's opposing whom. Never add up an itemized page that mixes notices with report rows (`is_notice: false` returns report rows alone), and leave memo entries (`memo_code` `X`) out of any sum.

### "Trace the money trail for a Super PAC"
1. `openfec_search_committees` → get Super PAC `committee_id`
2. `openfec_search_contributions` with `committee_id` → who funds the PAC
3. `openfec_search_disbursements` with `committee_id` → what the PAC spends on
4. `openfec_search_expenditures` with `committee_id` → which candidates the PAC supports/opposes
5. `openfec_search_contributions` with `contributor_id` set to the PAC's `committee_id` → which committees the PAC gave to

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

`last_indexes` alone cannot say whether a next page exists: OpenFEC populates it for the last row of every page, terminal pages included. A cursor is therefore minted only when the page could have a successor — `last_indexes` is populated, the page came back full (`results.length >= per_page`), and an exact count does not already account for every row delivered so far (`is_count_exact === true && count <= delivered + results.length`). A short page ends the walk. The SEEK envelope carries no `page`, so `pages` is not a usable cross-check: there is no position to compare it against, and when the count is an estimate `pages` is derived from that estimate. The cursor therefore carries the position itself — `n`, the rows delivered through the page that minted it — so an exact count ends the walk on whichever page reaches it, even a full one. A cursor without `n` reads as position 0, which can only under-count and never ends a walk early. When the count is not declared exact, a full page that happens to be terminal still mints a cursor — nothing in the envelope distinguishes it — and the empty page that follows reports an exhausted position (decision 14) rather than a search that matched nothing.

### 3. `two_year_transaction_period` abstraction

The API requires `two_year_transaction_period` on Schedule A but not other schedules. The tool accepts `cycle` uniformly and the service layer maps it to the correct API parameter. No API quirk leaks to the agent.

### 4. Legal search pagination exposed differently

Legal search uses `from_hit`/`hits_returned` (offset-based, max 200) with type-keyed result arrays. This is different enough from both page-based and keyset pagination that it's simpler to expose the native model rather than force it into the cursor abstraction. The tool uses `from_hit` and `hits_returned` directly.

Both ride the OpenSearch result window behind `/legal/search/`, which serves a request only while `from_hit + hits_returned <= 10000`, inclusive. Past it upstream answers 400 with `Opensearch failed to execute query` — a message that names the engine, not the window. The ceiling moves with the page size, so it cannot be expressed as a static `.max()` on its own: `from_hit` advertises the ceiling it has at `hits_returned: 1` (9999) and the sum is checked in the handler before dispatch, rejected as `legal_window_exceeded` with the largest `from_hit` the supplied page size allows. That follows decision 8 — reject an unservable input rather than spend the round trip on a 400 that misattributes the cause. No document type holds enough records to reach the window (the largest single-type total measured is 7,670 MURs), so a paging run runs out of documents first; this is about the advertised contract and the error text.

Because `from_hit` offsets within each type, a page is `hits_returned` results of each type searched, and the next page starts at `from_hit + hits_returned` with the same filters. A type that returned fewer than `hits_returned` is exhausted; the others continue. A page carries every result upstream returned, so no per-type continuation value is needed (decision 16).

### 5. `_full` fields for LLM readability

The API provides both code and human-readable versions of enumerated fields (`party` / `party_full`, `office` / `office_full`). The `format()` function uses `_full` variants for display. Output schemas include both for chaining (codes are needed for follow-up queries).

### 6. No caching in v0.1.0

The API sets `Cache-Control: public, max-age=3600`. Server-side caching is worthwhile but adds complexity. Ship without it, add in a follow-up if rate limits become a bottleneck.

### 7. Every response states the query it ran

All twelve tools return `search_criteria` on every response, not only empty ones, and the six multi-mode tools also return the resolved `mode`. A caller cannot otherwise tell that a cycle defaulted, that `by_size` resolved to `by_size_candidate` against a different endpoint, or which of several row shapes it is holding. `search_criteria` echoes the **effective** filters — the caller's parsed input with every server-applied default folded in — minus paging arguments (`page`, `per_page`, `cursor`, `from_hit`, `hits_returned`, and `openfec_get_legal_document`'s entry `offset`); query-shaping booleans such as `most_recent` and `election_full` stay in, because they narrow the result set. Echoing the raw input instead would reproduce the failure the field exists to close: the itemized branches fall back to the current cycle and to `most_recent: true`, and a caller who omitted both would see neither in the echo while both shaped the result. The itemized keyset cursor is bound to the same effective values, so an omitted default and an explicit one resolve to one cursor identity rather than two. `format()` renders both fields, so `content[]`-only clients see the same record as `structuredContent` clients.

### 8. Endpoint-inapplicable inputs are rejected, never dropped

Every handler validates the concrete endpoint selected by an ID or mode before dispatch. Direct candidate and committee lookup reject search-only inputs; Schedule A aggregate variants accept only the identifier their resolved endpoint supports; Schedule A/B/E itemized reject page-number pagination; election summary rejects paging. The rejection names the offending inputs and the endpoint's supported set. Silently dropping one is the worse failure: the caller gets an unnarrowed result set that looks like an answer to the narrowed question.

The check sits at input-presence level before the branch builds `params`, because the service allowlist only sees outbound names and cannot catch an input that was never copied. A branch-scoped input therefore carries no Zod `.default()` when omission must be distinguished from explicit presence; `page` on ID/mode-dispatched tools, `most_recent` on `openfec_search_expenditures`, and `election_full` on `openfec_lookup_elections` and `openfec_search_expenditures` are optional, with defaults applied inside the branches that support them. The service layer separately checks every outbound parameter name against the allowlist of each endpoint it has an entry for — `/schedules/schedule_a/` and its six aggregate paths, Schedule B, E, and F, `/candidates/totals/`, legal search, committee totals and history, grouped totals, election summary, and election dates — as a final backstop against future routing drift.

The same rule covers code-shaped inputs OpenFEC would answer with an empty success: a state, party, committee type, or committee designation outside what OpenFEC files fails before the request (decision 21), and a race given a state or district it is never filed under fails as `inputs_not_applicable_to_office`.

### 9. Committee records are carried once per page, in full

OpenFEC embeds a ~40-field committee object in every itemized Schedule A/B/E/F row — the filing committee on every row, and on some a donor or payee that is itself a committee. They repeat: a 100-row Schedule F page spanning committees carries 11 distinct ones. Each record is therefore carried once per page and in full on both surfaces, so the payload sheds the repetition and no field.

- **Hoist.** When the query is scoped to one `committee_id`, the filing committee is identical across the page and is lifted into a single top-level `committee` field. Schedule B requires a `committee_id`, so the hoist is unconditional there. Schedules A, E, and F hoist only when the caller supplied one: a Schedule A page scoped by donor alone and a candidate- or race-scoped Schedule E page span several committees, and attributing those rows to one of them would be worse than the payload cost.
- **Maps.** Every other record leaves its row for a page-level map keyed by the ID the row already carries: `contributor_committees[contributor_id]` (Schedule A donor that is a committee), `recipient_committees[recipient_committee_id]` (Schedule B payee that is a committee), and `committees[committee_id]` (the spender on Schedule E/F pages without `committee_id`, the recipient on donor-scoped Schedule A pages). A record whose row carries no matching ID, and a value under the key that is not a record, stay on the row with the generic rendering.
- **Rendering.** The hoisted record and each map entry render in `content[]` in full: a title line, then every other non-empty field. Map entries follow the rows, and a row's ID line reads `C… (NAME)`, so the row still names whose it is. The generic JSON fallback in `renderValue` stays for fields with no known shape.
- **One ID, several records.** A committee's embedded record is its filing history for the row's own cycle, so a page spanning cycles can hold different records under one ID (Schedule F with `cycle` omitted: the same committee's 2016 and 2018 records differ). The hoisted record or map entry is the one most rows with that ID carry, the first seen on a tie; a row carrying another record keeps it, rendered in full. Lifting the first row's record alone would have dropped the other cycles' data from the page.

Schedule E's nested `candidate` object is dropped outright — its three fields are the row's own `candidate_id`, an internal `idx`, and a `two_year_period` that restates the query's cycle.

### 10. The outbound parameter guard resolves interpolated paths to their spec template

`assertKnownParams` is keyed on the paths `docs/openapi-spec.json` declares, but `buildUrl` receives paths with the identifier already substituted — `/committee/C00703975/totals/`, not `/committee/{committee_id}/totals/`. Since the guard returns early for a path it has no entry for, registering the template alone would have been dead configuration: every path-parameterized endpoint would silently skip the check that exists because OpenFEC answers 200 and drops a parameter name it does not recognize. A short regex table maps each interpolated form back to its template before lookup. The `/totals/{entity_type}/` pattern is anchored to the six enum values rather than a wildcard segment, so a different `/totals/…` endpoint is not checked against the wrong allowlist.

### 11. Committee totals dispatch on mode across two unrelated endpoints

`/committee/{committee_id}/totals/` and `/totals/{entity_type}/` answer different questions — one committee's cycles versus a ranked page of committees — and share only a row shape. They are one `mode`-dispatched tool rather than two, matching the consolidation in decision 1: the single-committee half is the common case and the default, and the grouped half costs one branch. Only the single half was reachable before, and only through a resource, so tool-only clients could not read committee totals at all.

Both single-record endpoints answer 404 for a miss rather than an empty `results` array — `/committee/{id}/totals/` for an unknown ID and for a cycle the committee did not file. (A committee with a filing history but no totals row gets 200 with no rows.) The service normalizes that to a zero-row page so the tool can throw its own `committee_totals_not_found` with an actionable message, instead of surfacing the framework's generic "verify the API path" hint for what is really an unknown ID. The normalization is gated on the 404 body parsing as OpenFEC's own JSON error object: the api.data.gov edge answers 404 with a plain-text routing error when the upstream host is unreachable, and reporting a whole-API outage as "this committee has no totals" would be a confidently wrong answer. Anything that is not the API's JSON error shape stays a failure and propagates. `openfec_get_legal_document` uses the same discriminator.

The `openfec://committee/{committee_id}` resource relies on that normalization and adds no error handling of its own around the totals leg. "No totals on file" already arrives as an empty page, so a rejection reaching the resource is a real failure (rate limit, timeout, malformed envelope) and fails the read, as the candidate resource's totals leg does. Swallowing it would return a successful profile with the financial fields silently missing, which a caller cannot tell apart from a committee that never filed.

### 11a. Omitted-cycle committee totals read the committee's history

OpenFEC keeps committee totals in one table per filing form — presidential (`P`), house-senate (`H`/`S`), ie-only (`I`), and pac-party for every other type — and `/committee/{committee_id}/totals/` reads only the table its newest matching history row's type maps to. With `cycle` omitted, a committee that changed type returned only its newest type's cycles: `C00703975` (presidential 2020–2024, PAC 2026) came back as 2026 alone, looking complete. A multi-value `cycle` resolves the same way, by its newest cycle, so no single request reaches both tables.

Single mode without `cycle` therefore reads `/committee/{committee_id}/history/` beside the unfiltered totals request — concurrently, so a single-type committee keeps today's latency and gets today's request and page unchanged. When the history spans more than one table, each other table is asked for its cycles with a multi-value `cycle`, the newest table is read whole when the caller's page did not hold all of it, and the merged rows are sorted (NULL placed as OpenFEC's PostgreSQL places it) and paged locally. A cycle both tables hold is answered by the table its history row names, as an explicit `cycle` request is. A committee whose newest type has no totals row yet now answers from its earlier types; the `openfec://committee/{committee_id}` resource still reads one unfiltered row and shows no financial summary in that state.

Cost: one extra request for a single-type committee, plus one per additional table, plus one when the caller's page split the newest table. The history-driven reads are best-effort, because detecting the gap needs the same history read as closing it: a failed one leaves the reads that succeeded standing with a notice naming what they lack, never a silent partial and never a rejected call the unfiltered page alone would have answered. Only a rate limit and a caller cancellation fail the call, since the caller's next step is to wait or to stop either way. A 404 for cycles the history just named counts as a failed read, not an empty one; OpenFEC's own 404 for the history itself reads as an empty history, the same rule the totals read follows. Every request shares one 50 s budget across attempts and backoffs (`CALL_DEADLINE_MS`, decision 25), so the call settles before an MCP SDK client's 60 s request timeout; the heaviest call (history, the unfiltered page, three other tables, a newest-table re-read) would otherwise run two sequential retry ladders of four 30 s attempts each, about 254 s, against about 127 s for the single unfiltered request it replaces.

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

### 16. The caller's page size is the page

`per_page` and `hits_returned` are the page. Every search tool sends the value asked for upstream (defaults stay 20; maxima 100, and 200 per legal type, are OpenFEC's own) and returns every row upstream sent. No response carries a page-bound field or a per-type continuation value: the keyset tools mint `next_cursor` from the last row returned, the page-based tools echo the caller's `per_page` and count pages at it, and legal search continues at `from_hit + hits_returned` (decision 4). Clients handle large results themselves; a server-side cut would hand callers a smaller page than they asked for, page numbers at a size they never sent, and per-type continuations to learn, in exchange for a bound the caller's own `per_page` already sets.

Weight is shaped by what a row carries, never by cutting a page:

1. **Null/empty-field drop.** `dropEmptyFields` removes `null`, `''`, `[]`, and records left empty, at every depth, from every itemized and filing row and from candidate and totals rows — 15–46% of row bytes, carrying nothing. `false` and `0` stay; array elements are never removed, since their positions can carry meaning.
2. **Committee records once per page** (decision 9) instead of once per row.
3. **The legal search-result trim** (`documents` and `dispositions` as counts and categories, highlights capped at three, votes cut to a date and an action) with `openfec_get_legal_document` returning the rest.

A candidate search with `include_totals` is the heaviest shape: one long-serving incumbent carries a totals row per cycle filed, so 100 House incumbents bring 653 totals rows. The page is still the caller's `per_page`, and the totals walk reads every row (decision 24).

Rejected: capping `per_page` by scope from measured row weights (the page the caller asked for is not the page it got, and every scope needed its own measured table), truncating a fetched page (breaks keyset continuation and discards rows the caller paid a request for), and DataCanvas `spillover()` (needs a canvas provider this server does not register).

### 17. Legal search routes each type-specific filter by document type

`/legal/search/` names the same filter differently per document type — `ao_regulatory_citation` for advisory opinions, `case_regulatory_citation` for MURs and ADRs — and answers 200 for a name a type does not read, returning that type unfiltered while the filter still looks applied. Measured live, a `case_*` citation or `case_respondents` against administrative fines matches none of them rather than being ignored. `FILTER_PARAMS` in the tool records, per filter, the upstream name each type reads; a typed search sends only that name and rejects a filter with no entry for its type as `filter_not_valid_for_type` (decision 8). With `type` omitted, the search keeps only the types every supplied type-specific filter applies to, sends only their names, and totals over them from the per-type `total_<type>` counts — `total_all` would count the other types unfiltered. Filters that share no type are rejected rather than returning a union nobody asked for. Filters that leave exactly one type send that `type` upstream, so the other types' pages — heavy MUR rows among them — are never fetched only to be discarded; the total is then that type's `total_all`, the same count the per-type sum gives. A search with no type-specific filter still returns all five types. Upstream computes every per-type total on an untyped search, so a missing one fails the call rather than being estimated.

Case search has a second blind spot: when a MUR or ADR search carries a citation, upstream returns the citation clause in place of the rest of its case filters, so `case_no`, `case_respondents`, the penalty bounds, and the open- and close-date bounds are dropped while the query and a `document_date` bound still apply. Measured live, `case_regulatory_citation=11 CFR 110.1` returns the same 95 MURs alone and with `case_respondents=Obama` (24 MURs alone), `case_no=6916`, `case_min_penalty_amount=1000000`, or `case_min_open_date=2020-01-01`; adding `q` or `case_min_document_date` narrows it. The tool rejects those combinations as `filter_not_valid_for_type` with `ignored_with_citation` naming the inputs that would be dropped. Advisory-opinion search applies a citation together with its other filters. The two citation fields combine as either-or on both families: `11 CFR 110.1` (95 MURs) with `52 U.S.C. 30104` (783) matches 833.

### 18. Nested legal fields render as text

Legal records nest participants, subjects, citations (a flat array per disposition on current MURs and ADRs, an object of `regulations`/`us_code` arrays on archived MURs), a recursive `subject` tree on archived MURs, advisory-opinion citation lists, and commission votes. `utils/legal-field-renderers.ts` gives each a text rendering — `name (role)`, `[52 U.S.C. 30104(g)](<url>)` (a citation linked to its URL through `markdownLink`), `11 CFR 100.4`, `AO 2000-25 (name)`, `>`-joined subject paths, and `[<last path segment>](<url>)` for a `url` field — through `renderRecord` field renderers, which take the raw value and decline (null) anything that is not the whole shape they know. A declined value, and any field with no renderer, keeps the generic JSON rendering, so an upstream shape change shows up as JSON rather than as silently missing text. The renderers never touch `structuredContent`. Commission votes and search highlights render as a CommonMark list, one item per entry with the entry's lines and blank lines inside it; a lone one-line entry stays on the key line. Upstream vote actions carry their own numbered steps, and an indented continuation line would open a code block, so only the list form keeps each vote whole. Dispositions need no renderer of their own: search summarizes them to `disposition_count` and `disposition_categories`, and the detail tool renders each one as a section entry, one list item with every field on its own line, with its `citations` through the citation renderer.

### 19. Legal citations are checked against the form upstream parses

`/legal/search/` reads a citation with a prefix match — `<title> U.S.C. <section>` or `<title> CFR <part>.<section>`, periods optional, `§` optional, anything after ignored — and drops a value that does not match, answering 200 with the type unfiltered. `30106`, `110.1`, and `52 U.S.C. zz` all return every MUR. The tool mirrors that prefix (case-insensitive, as upstream behaves) and rejects a non-matching citation as `invalid_citation` before dispatch; a matching one is sent byte-identical. The grammar was established by live probe against the unfiltered total as control, over subsection suffixes (`30104(g)`, `110.1(b)`), lettered sections (`441b`), `USC` and `C.F.R.` spellings, lowercase, repeated spaces and tabs, and `§`. Upstream's own pattern writes `\s+§*\s*`, which backtracks quadratically on a long run of spaces; the tool's `\s+(?:§+\s*)?` accepts the same strings in linear time.

Because the match ignores everything after the section number, a value holding two citations filters on the first alone: `52 U.S.C. 30104, 52 U.S.C. 30118` returns the 783 MURs `52 U.S.C. 30104` does, not the 346 of `30118`, and the reversed order returns 346. The tool rejects such a value as `invalid_citation` too, one citation per field. It reads the text after the section number, with parenthesized subsections removed, as a second citation when it holds another `U.S.C.` or `CFR` code, or another section number introduced by a list separator (`,` `;` `&` `/`), a range dash, `and`/`or`/`through`/`to`, or bare whitespace. A letter suffix (`441b`, `441a-1`), a dotted continuation (`110.1.2`), subsection lists (`30104(a), (b)`), and trailing words carry no second section and stay accepted, each confirmed live to narrow the result like its bare citation. Upstream takes each citation parameter as a repeatable array; exposing that is a schema change this tool does not make.

### 20. A legal record over the budget pages its arrays, measured by bytes

`openfec_get_legal_document` returns one record, so there is no page size a caller could set to bound it. Legal record size is heavy-tailed — eleven MURs and one ADR exceed 100,000 bytes as detail records, and MUR 6916 alone runs near 500 KB — so the tool measures what it returns against a 100,000-byte budget on each surface, independently (`RESPONSE_BUDGET_BYTES`, `utf8Bytes`), and returns a record over it in parts. Search results are not measured: a search page is the caller's `hits_returned` per type (decision 16), already trimmed (decision 18).

- **Charge.** An array or an array entry is charged the larger of its UTF-8 bytes on the two surfaces — its JSON and its `format()` rendering — plus its separator, against the budget minus the envelope: every byte that is not content (criteria echo, headings, the `withheld` list or slice metadata, and the enrichment with its trailer), reserved at its largest. Links are made absolute before anything is measured (decision 22), so the budget counts what is sent. Charging the larger surface keeps both under the budget; the cost is that the lighter surface runs under it.
- **Whole.** A record that fits returns whole.
- **Bounded.** Otherwise it returns its non-array fields plus its arrays smallest-first while they fit, and lists the rest in `withheld` as `{ array, count, bytes }`.
- **Slice.** A re-call naming one array and an entry `offset` returns entries from there while they fit, plus `next_offset`; the first entry is always returned, so an entry larger than the budget alone still advances the walk (the largest entry measured is a 7 KB commission vote).

The framework's `outlineOnOverflow`/`selectSections` was the alternative and does not fit: it measures UTF-16 `length` rather than bytes, its outline carries none of the record's scalar fields, and `selectSections` returns a named top-level section whole — MUR 6916's `dispositions` alone is 333 KB, MUR 7594's `documents` 219 KB.

Measured live 2026-09-24, UTF-8 bytes per surface:

| Call | Record as upstream sends it, `structuredContent` / `content[]` | Returned | Shape |
|:--|--:|--:|:--|
| MUR 8123 | 126,499 / 126,429 | 53,943 / 52,825 | `dispositions` withheld |
| MUR 7594 | 350,658 / 346,109 | 41,352 / 34,939 | `dispositions`, `documents` withheld |
| MUR 6916 | 497,977 / 488,820 | 68,136 / 54,278 | `documents`, `dispositions` withheld |
| MUR 7594 `documents` by offset | — | ≤ 99,488 / ≤ 99,727 | 3 calls, 667 entries |
| MUR 6916 `dispositions` by offset | — | ≤ 99,732 / ≤ 71,813 | 4 calls, 763 entries |

Statute 30113, advisory opinion 1980-35, and administrative fine 4229 return whole. The three heaviest MURs are kept as a test fixture (`tests/fixtures/heaviest-legal-records.json`) — masked scalars and the exact byte size of every array entry, expanded to each record's live weight — so a renderer or envelope that outgrows the budget fails the suite.

Rejected: a per-array entry `limit` (entries run from 30 bytes to 7 KB, so no count suits every array).

### 21. State, party, and committee codes are checked by width, not shape

OpenFEC matches state, party, and committee code filters literally and answers a spelled-out name (`Georgia`, `Democratic`) with an empty success whose notice says to broaden the search. A letters-only check would reject codes OpenFEC does file: state `US` (presidential candidates), `00` (Schedule E presidential rows), `14`, and one-character Schedule B states; party `W` (write-in), `N`, `D/C`, `N/A`. No filed state is longer than two characters and no party longer than three, so the check is width, run before any request (`utils/code-validators.ts`): a wider value, apart from the two filter values below, fails `invalid_state_code` or `invalid_party_code`, carrying `field`, `value`, and a recovery hint showing the expected form.

- **Where.** `state` on candidates, committees, elections, calendar, and the election resources' `{state}`; `contributor_state`, `recipient_state`, `candidate_office_state`, `committee_state`; `party` on candidates and committees; `candidate_party` (itemized only — `by_candidate` rejects it as inapplicable first).
- **Pass-through.** Values reach OpenFEC as given, except `openfec_lookup_calendar` `state` and the two committee totals codes, which are upper-cased: `/election-dates/` and `/totals/{entity_type}/` match case-sensitively, so a lowercase `ga` or `o` returned nothing where `GA` and `O` returned rows. `search_criteria` echoes the value sent.
- **Exclusion and `other`.** Two values wider than a code are OpenFEC filter syntax, not names, and pass where the field's endpoint reads them. A leading `-` excludes the code after it on fields OpenFEC filters through `filter_multi` (`-GA`: every state but Georgia), and the width check runs on the code after that one `-`. `other`, in any case, selects foreign, invalid, and missing states on OpenFEC's STATE_OTHER fields. Still rejected: `-GAA`, `-Georgia`, `-other`, `--GA`, `-DEMO`, and `other` on a field without it. So is an exclusion that excludes nothing, `-` alone or `--D`: OpenFEC answers it with the unfiltered set (Senate 2026 `state: "-"` returns all 1,565 candidates, as no state does).

  | Field | `-CODE` | `other` |
  |:--|:--|:--|
  | `openfec_search_candidates` `state`, `party` | yes | no |
  | `openfec_search_committees` `state` / `party` | yes | yes / — |
  | `contributor_state`, `recipient_state`, `committee_state` | yes | yes |
  | `candidate_office_state`, itemized / `by_candidate` | yes / no | yes / no |
  | `candidate_party` | yes | — |
  | `committee_type`, `committee_designation` | yes: kept, code upper-cased (`-o` → `-O`) | — |
  | `openfec_lookup_calendar` `state`; `district` | yes; yes, digit zero-padded (`-1` → `-01`) | no |
  | `openfec_lookup_elections` `state`, the election resources' `{state}` | no: `/elections/` matches the state exactly | no |

- **Closed sets.** `/totals/{entity_type}/` answers any committee code with HTTP 200 rather than a 422, so `committee_type` and `committee_designation` are checked against OpenFEC's lists (`C D E H I N O P Q S U V W X Y Z`; `A B D J P U`, in any case, after an optional leading `-`) and fail `invalid_committee_type` / `invalid_committee_designation`. `openfec_search_committees` leaves `committee_type`, `designation`, and `organization_type` unchecked: OpenFEC's 422 there names the parameter, and the server passes that reason through (Resilience, "OpenFEC's stated reason").
- **Schemas unchanged.** No input gains a `pattern`, `maxLength`, or `enum`: OpenFEC upper-cases most codes before its check, so a schema-level enum would reject calls that work.

### 22. Legal links are resolved to absolute fec.gov URLs

Upstream writes legal links site-relative (`/legal/matter-under-review/8112/`, `/files/legal/murs/8112/8112_11.pdf`, `/regulations/100-26/CURRENT`), which a caller cannot open from a tool result. `resolveLegalLinks` makes every `url` at any depth of a legal record absolute, on `structuredContent` and `content[]` alike, in search results, whole records, and `array` slices:

| Link | Upstream | Resolved | Checked live |
|:--|:--|:--|:--|
| record `url` (MUR, ADR, admin fine) | `/legal/matter-under-review/8112/` | `https://www.fec.gov/data/legal/matter-under-review/8112/` | 200 (the same path at the site root is a 404) |
| advisory opinion `url` (absent upstream) | — | `https://www.fec.gov/data/legal/advisory-opinions/2024-01/` | 200 |
| `documents[].url` | `/files/legal/murs/8112/8112_11.pdf` | `https://www.fec.gov/files/legal/murs/8112/8112_11.pdf` | 200 |
| citation `url` in `dispositions[].citations` | `/regulations/100-26/CURRENT` | `https://www.fec.gov/regulations/100-26/CURRENT` | 302 to eCFR |

A path under `/legal/` takes the `https://www.fec.gov/data` prefix, since fec.gov serves record pages there; every other site-relative path takes `https://www.fec.gov`; an absolute URL (a statute's govinfo.gov link) is kept as sent, and a `//host` reference is not treated as site-relative. The advisory-opinion page, built from its number, is the one link the server constructs; a record with no `url` otherwise stays without one rather than getting a guess. The change reaches `structuredContent` values, not just rendering, because a link the caller cannot open is the defect; the field renderers of decision 18 still never touch the structured record. `content[]` renders each link as a Markdown link, `[8112_11.pdf](<https://www.fec.gov/files/legal/murs/8112/8112_11.pdf>)`, through the framework's `markdownLink`.

### 23. Rows that must not be summed are labelled, not dropped

Two kinds of itemized row sit beside the rows they overlap. A memo entry (`memo_code` `X`, on Schedules A, B, E, and F) itemizes or restates another row and sits outside FEC report totals. A 24/48-hour notice (Schedule E, `is_notice: true`) is the newest spending, and most of it is reported again on the spender's next periodic report. OpenFEC takes no memo filter, and notices are data a caller may want, so the rows stay and the server says what they are (`utils/row-kinds.ts`):

- **Marker.** Each such row's `content[]` header ends `· memo entry` or `· 24/48-hour notice`. `structuredContent` rows are unchanged.
- **Page sentence.** For each kind a page mixes with other rows — at least one such row and at least one other — the `notice` carries "{n} of {m} rows on this page are …" counted on the returned rows, with the do-not-sum warning. A page of one kind sums consistently within itself, and an empty page has nothing to sum, so neither gets one. Measured live: "3 of 5 rows … memo entries" on a Schedule A page, "15 of 28 … 24/48-hour notices" on a Schedule E page.
- **One test per kind.** `memo_code === "X"` is the memo test that holds on all four schedules (Schedule F rows carry no `memoed_subtotal`). The kinds are judged separately; a row can be both.
- **One notice.** The enrichment `notice` is last-wins, so the approximate-count sentence, the zero-match or exhausted-position sentence, and the row-kind sentences are composed into one call, in that order.
- **Aggregates.** `memo_count` and `memo_total` on disbursement `by_purpose` rows are the bucket's memo entries, already excluded from `count` and `total`. `by_candidate` totals exclude notices for the same reason, which leaves a current-cycle gap that its `notice` names (see `openfec_search_expenditures`).

Rejected: dropping the rows (a notice is the only record of spending not yet on a report, and a memo entry names the transaction it itemizes).

### 24. Candidate totals are walked by candidate keyset

`/candidates/totals/` orders on its one `sort` column with no tiebreaker, so rows that tie reorder between requests. An offset walk over 100 House incumbents' 653 rows returned 19 of them twice and missed 19 others. `getAllCandidateTotals` therefore walks by candidate, not by page: every request asks for page 1, `per_page=100`, `sort=candidate_id`, and lists only the candidates not yet read. A full page holds every candidate but the one in its last row whole; those are kept, and the next request starts at that last candidate. Each candidate's rows come from exactly one response, so none repeats and none is missed, with no deduplication; a set that fits one page takes one request, and the 100 incumbents took seven. Rows come back newest election year first, then newest cycle.

The walk shares one 50 s budget with the candidate read (decision 25). It stops early with the candidates read whole and `complete: false` when the budget runs out, a later request fails, or a full page holds no whole candidate (one candidate's rows alone fill it, and OpenFEC cannot page them in a fixed order). It never sends an unfiltered request, and a candidate's rows are all returned or none are, so a candidate shown with totals has every cycle and one shown without may still have them on file; the tool's `notice` says so. A caller cancellation, a rate limit, and any other failure of the first request reject the call, since the caller's next step is to stop or wait and no rows exist to stand on.

Rejected: a fixed page limit on the walk with a list of unread candidates in the output (a limit made sense only while the candidate page itself was capped; with the caller's page size it would drop whole cycles while reporting nothing missing) and an offset walk with deduplication (it cannot recover the rows an unstable order skipped).

### 25. Every read runs under a 50 s budget, and its expiry reports what failed

MCP SDK clients abandon a request after 60 s by default, and one read's retry ladder of four 30 s attempts would run about 127 s. Every service read — page, keyset, legal search, election summary, legal document — therefore runs under one 50 s deadline across its attempts and backoffs (`CALL_DEADLINE_MS`), so the call settles with an answer before the client gives up. Decision 11a's history reads set the pattern; the default now covers all of them. A tool that chains reads (a candidate read then the totals walk, or committee totals' several tables) holds one `countdown(CALL_DEADLINE_MS)` and passes each read what is left of it; a read with 1 ms or less left sends nothing.

When the deadline runs out, the read reports the failure of the last attempt that completed rather than the expiry: a 429's wait, a 5xx's or gateway 504's retry hint, with the expiry as its `cause`. That failure names the caller's next step, and a bare "ran out of time" would hide it. With no completed attempt, or one that timed out on its own clock, the read fails as `Timeout` with reason `retry_deadline_exceeded`, a message naming the 50-second budget and attempt count, and the hint to retry or narrow the query.

OpenFEC's own `Query timed out` 504 is the exception to retrying. The same query times out the same way again, so a retry only spends the budget: a broad `contributor_employer` search times out upstream every time in 15–18 s, and three retries would take about 79 s, past a client's 60 s timeout. A 504 with any other body comes from the gateway in front of OpenFEC and is still retried.

---

## Known Limitations

- **Rate limits:** OpenFEC publishes 1,000 requests/hour for a personal key. Complex multi-tool workflows can consume 5–10 requests per user interaction. Heavy use requires an elevated key.
- **DEMO_KEY:** a small daily allowance shared by every caller on the same IP, observed to reset at 00:00 UTC. Once it is spent, every call fails with a 429 whose `Retry-After` runs to that reset, often many hours away. Barely functional for testing; users need a personal key.
- **Committee resource after a type change:** `openfec://committee/{committee_id}` reads one unfiltered totals row, which OpenFEC takes from the committee's current type only. A committee that has changed type but not yet filed under the new one shows no financial summary there; `openfec_get_committee_totals` without `cycle` returns its earlier cycles (decision 11a).
- **Approximate counts on high-volume endpoints:** Schedule A/B/E and `/filings/` return `is_count_exact: false` above roughly a million rows. The `count` field is then an estimate, not a precise total, and `pages` inherits its error. Responses carry `count_is_approximate` and render the total as `≈N total (approximate)` when that happens (decision 15), but the estimate itself cannot be improved.
- **Schedule A date range limitation:** The API does not support date ranges spanning multiple `two_year_transaction_period`s. Queries are scoped to a single cycle.
- **Legal search vs. entity search:** Legal search is full-text, not entity-linked. Searching for a committee name may miss cases where the committee is referenced differently.
- **Data freshness:** Nightly refresh for most data. E-filing data is near-real-time but only retained ~4 months and is excluded from this server's scope.
- **No field selection:** The API does not support a `fields` parameter, so full records come back — a Schedule A/B/E row runs 3–4KB, and a `per_page: 100` page of a high-volume tool runs 125–295 KB on a surface. Null and empty fields are dropped and each committee record is carried once per page (decisions 9 and 16), but a page is never cut: the caller's `per_page` is the bound, and a smaller one is the way to a lighter response.
- **Heavy all-cycles candidate pages:** a candidate search with `include_totals` and no `cycle` or `election_year` carries a totals row per cycle filed for each candidate, so a page of 100 long-serving House incumbents is 653 totals rows and about 885 KB on each surface. It is complete, not bounded; lower `per_page` or scope the cycle.
- **Legal detail records over the budget:** a single array entry, or a detail record's non-array fields, larger than the budget is still returned alone rather than stalling the walk — the heaviest measured is a 7 KB entry, within it. Search results are not bounded (decision 16).

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

An untyped search carries all five arrays and `total_<type>` counts, which sum to `total_all`. A search with `type` set carries only that type's array and count; the other keys are absent, not zero.

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
