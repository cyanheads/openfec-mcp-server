# Changelog

## 0.2.0 — 2026-04-04

### Changed

- **Breaking:** Split election resource into 3 URI templates with explicit params:
  - `openfec://election/{cycle}/{office}` — presidential/at-large races
  - `openfec://election/{cycle}/{office}/{state}` — senate/state races
  - `openfec://election/{cycle}/{office}/{state}/{district}` — house district races
  - State and district are now explicit params instead of parsed from the URI path
- Election summary mode returns a flat aggregate object (`count`, `receipts`, `disbursements`, `independent_expenditures`) instead of a paginated response
- All empty-result format messages now include actionable troubleshooting suggestions
- Candidate ID regex relaxed to accept alphanumeric suffixes (`[HSP][0-9A-Z]+`)

### Fixed

- Calendar tool date parameters now map to correct endpoint-specific field names (`min_start_date`/`max_start_date` for events, `min_due_date`/`max_due_date` for filing deadlines, `min_election_date`/`max_election_date` for election dates)

### Added

- API error sanitization: API keys are stripped from error messages before surfacing to clients
- HTTP status errors enriched with actionable hints (rate limits, bad params, service unavailable)
- Legal search response trimming for LLM context windows (highlights capped at 3, documents summarized as count + categories, commission votes condensed)
- `NotFound` errors for candidate and committee ID-specific lookups that return empty results
- Expenditure tool validates candidate/committee ID formats and requires `candidate_id` for `by_candidate` mode
- `ElectionSummary` type for the flat `/elections/summary/` endpoint response
- Defensive null coalescing on pagination fields in service layer
- Security overrides for transitive dependencies (`brace-expansion`, `express-rate-limit`, `hono`, `path-to-regexp`, `picomatch`, `yaml`, `lodash`)
- Funding info, author email, and `typescript`/`ai-agent` keywords to package.json
- Consistent `bun run` prefix for all package scripts; start scripts use `bun` runtime

---

## 0.1.0 — 2026-04-04

Initial release.

### Added

- 9 tools for querying federal election campaign finance data:
  - `openfec_search_candidates` — find candidates by name, state, office, party, or cycle
  - `openfec_search_committees` — find committees by name, type, or candidate affiliation
  - `openfec_search_contributions` — itemized individual contributions and aggregate breakdowns
  - `openfec_search_disbursements` — itemized committee spending and aggregate breakdowns
  - `openfec_search_expenditures` — independent expenditures supporting or opposing candidates
  - `openfec_search_filings` — FEC filings and reports by form type, committee, or date
  - `openfec_lookup_elections` — election races and candidate financial summaries
  - `openfec_search_legal` — advisory opinions, enforcement cases, and administrative fines
  - `openfec_lookup_calendar` — FEC calendar events, filing deadlines, and election dates
- 3 resources for direct entity lookup:
  - `openfec://candidate/{candidate_id}` — candidate profile with financial totals
  - `openfec://committee/{committee_id}` — committee profile with financial summary
  - `openfec://election/{cycle}/{office}` — election race summary
- 2 prompts for guided campaign finance analysis:
  - `openfec_campaign_analysis` — structured candidate financial position analysis
  - `openfec_money_trail` — multi-tool money flow investigation framework
- OpenFEC API service with retry logic, configurable timeout, and type-safe client
- STDIO and Streamable HTTP transport support
- Docker deployment with OCI labels
- Built on `@cyanheads/mcp-ts-core` framework
