# Changelog

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
