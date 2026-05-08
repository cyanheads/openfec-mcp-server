# Changelog

## 0.4.2 — 2026-05-08

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.7.0` to `^0.8.19` (entire 0.8.x series). Notable consumer-facing additions adopted in this release:
  - **Typed error contracts** — every tool and resource that surfaces a domain-specific failure now declares `errors: [{ reason, code, when, recovery }]` and routes throws through `ctx.fail(reason, msg?, data?)`. Reasons are TypeScript-checked at the throw site; declared `recovery` strings flow to the wire via `ctx.recoveryFor(reason)`.
  - **`candidate.resource` and `committee.resource`** now declare contracts; `committee.resource` newly validates committee_id format up front via the shared `validateCommitteeId` helper instead of letting the API return an empty result.
  - **Error-code semantics** — replaced `invalidParams` with `validationError` for all semantic post-shape checks (ID format, missing required filters, mode-specific guards). `invalidParams` is reserved for malformed JSON-RPC params; `validationError` is the correct code for "input parsed cleanly but is semantically wrong." Tests updated accordingly (`InvalidParams` → `ValidationError`).
- Engines bumped: `bun` `>=1.2.0 → >=1.3.0`, `node` `>=22.0.0 → >=24.0.0`. README Bun badge bumped in lockstep.
- DevDeps: `@biomejs/biome` `^2.4.13 → ^2.4.14`, `@types/node` `^25.6.0 → ^25.6.2`, `tsc-alias` `^1.8.16 → ^1.8.17`.
- Synced project skills against framework 0.8.19; added 3 new skills (`api-canvas`, `api-telemetry`, `tool-defs-analysis`) and refreshed 14 existing ones to their package versions.
- Synced framework scripts via `maintenance` Phase C: added `check-framework-antipatterns.ts` (now wired into `devcheck`) and `split-changelog.ts`; `build-changelog.ts` learned to render a `🛡️ Security` badge alongside `⚠️ Breaking`.
- `CLAUDE.md` refreshed against the upstream consumer template — typed-error-contract pattern documented inline, `ctx.recoveryFor` reference added, dev/start scripts updated (no more `dev:stdio`/`dev:http`; use `rebuild && start:stdio` for smoke testing).

---

## 0.4.1 — 2026-04-24

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from 0.5.3 to 0.7.0 (skipping the 0.6.x series). Notable consumer-facing upgrades now live alongside this release:
  - **Directory-based changelog format** is shipped by the framework (opt-in); this server stays on the monolithic `CHANGELOG.md` for now
  - **`/` landing page + `/.well-known/mcp.json` SEP-1649 Server Card** appear in HTTP mode with zero config
  - **`MCP_PUBLIC_URL`** env var now available for TLS-terminating reverse-proxy deployments
  - **`security-pass`**, **`release-and-publish`**, and **`api-linter`** skills added; `field-test` rewritten to drive a live HTTP server over JSON-RPC
  - **ZodError** now surfaces a flat `<message> at <path> (+N more)` string plus structured `data.issues`, so validation failures read as prose in logs and tool error payloads
- Fixed 10 new `describe-on-fields` lint warnings surfaced by framework 0.6.16's recursive walk into array element types — every `z.looseObject({})` inside `z.array(...)` output now carries its own `.describe()` across all 9 tool definitions
- Patch bumps: `@biomejs/biome` 2.4.12 → 2.4.13, `vitest` 4.1.4 → 4.1.5
- Synced 15 project skills to their new package versions; added 3 new skills (`api-linter` 1.1, `release-and-publish` 2.1, `security-pass` 1.1)
- Synced framework scripts via the new `maintenance` skill Phase C: added `build-changelog.ts`, `check-docs-sync.ts`, `check-skills-sync.ts`; refreshed `devcheck.ts` and `tree.ts`
- `CLAUDE.md` refreshed against the upstream consumer template: `security-pass` inserted in "What's Next?", skills table picks up `api-linter` / `release-and-publish` / `security-pass` / `migrate-mcp-ts-template`, Core Rules gained the `ctx.elicit` / `ctx.sample` presence-check rule, Publishing section now points at the `release-and-publish` skill

---

## 0.4.0 — 2026-04-20

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from 0.3.8 to 0.5.3 and synced 7 project skills (`add-tool` 1.6, `api-config` 1.2, `design-mcp-server` 2.4, `field-test` 1.2, `maintenance` 1.3, `polish-docs-meta` 1.4, `setup` 1.3)
- **Tool output now passes the new `format-parity` lint rule** — all 9 tools render every scalar field from their output schema, so clients forwarding `content[]` (Claude Desktop) see the same information as clients forwarding `structuredContent` (Claude Code). User-visible effects:
  - Itemized modes (contributions, disbursements, expenditures) expose the real `next_cursor` value in the footer instead of a generic "more available" notice
  - Pagination footers consistently show `Page X of Y · N total · P per page` — `per_page` was previously hidden
  - Count headers render raw digits (`10468532 total contributions`) instead of locale-formatted (`10,468,532`) so sentinel matching in the linter stays reliable
- Relaxed `results[]`/`candidates[]`/`committees[]`/etc. output item schemas from `z.record(z.string(), z.unknown())` to `z.looseObject({})` — the framework's documented escape hatch for genuinely dynamic upstream payloads like the FEC API. Structured data flow unchanged; linter no longer emits false `<key>` parity failures
- Migrated `src/config/server-config.ts` to `parseEnvConfig()` from `@cyanheads/mcp-ts-core/config`. Missing `FEC_API_KEY` now produces the framework's formatted banner (`FEC_API_KEY (fecApiKey): Invalid input...`) instead of a raw ZodError dump
- Tightened security overrides in `package.json`: `hono >=4.12.14`, `@hono/node-server >=1.19.13`, `vite >=8.0.5`. `bun audit` now clean (was reporting 10 advisories from transitive deps)

---

## 0.3.2 — 2026-04-19

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from 0.2.12 to 0.3.8 and synced 15 project skills; added new `add-app-tool` skill
- Bumped devDependencies to latest: `@biomejs/biome` 2.4.12, `@types/node` 25.6.0, `typescript` 6.0.3, `vitest` 4.1.4
- Collapsed `+` string concatenations in all tool and resource descriptions, enum `.describe()` calls, and the itemized-contribution error message to single string literals — aligns with the project's CLAUDE.md convention and the updated `design-mcp-server` skill guidance
- `candidate.resource.ts` now uses the shared `validateCandidateId()` helper instead of an inline regex check, so invalid candidate IDs surface as `invalidParams` (MCP error `-32602`) instead of a generic `Error`, matching the tool-side behavior

---

## 0.3.1 — 2026-04-04

### Added

- Search criteria echo on empty results — all 9 tools now return the filters that produced zero matches, helping diagnose why a query returned nothing
- `buildSearchCriteria()`, `formatEmptyResult()`, and `SearchCriteriaSchema` in `format-helpers.ts` for consistent empty-result rendering across tools

### Changed

- Empty-result format messages unified to "No results found" with echoed criteria and domain-specific suggestions (previously each tool had a bespoke message)

---

## 0.3.0 — 2026-04-04

### Changed

- **Format output overhaul:** All tool `format()` functions now use a shared `renderRecord()` helper instead of bespoke field-by-field rendering — text output shows raw field names (`total_receipts:`) instead of human-readable labels (`Receipts:`)
- Prompt descriptions switched from `+` string concatenation to template literals
- Contribution aggregates now default to `sort: '-total', sort_hide_null: true` for more useful ordering
- Disbursement aggregates likewise default to descending-total sort
- Legal search `type` description warns that `admin_fines` is slow without a query or respondent filter
- Elections tool relaxes state/district requirements when a ZIP code is provided; summary mode rejects ZIP lookups with an explicit error
- `enrichStatusError()` now sanitizes the error message before pattern-matching HTTP status codes (avoids double-sanitization)

### Added

- `renderRecord()` in `utils/format-helpers.ts` — generic key/value renderer with skip-set for header fields
- `searchElectionsByZip()` service method using the `/elections/search/` endpoint which accepts ZIP parameters
- Candidate resource handler validates candidate ID format before API call
- `FETCH_TIMEOUT` recognized as transient error for retry logic

### Fixed

- `enrichStatusError()` was sanitizing twice in the hint branch; now sanitizes once upfront

---

## 0.2.3 — 2026-04-04

### Added

- Public hosted instance at `https://openfec.caseyjhand.com/mcp` — no API key or installation required
- `remotes` field in `server.json` advertising the Streamable HTTP endpoint for MCP client discovery
- "Public Hosted Instance" section in README Getting Started with connection config example

---

## 0.2.2 — 2026-04-04

### Fixed

- Legal search `respondent` parameter now maps to the correct API field (`case_respondents` instead of `respondent`)

### Changed

- Server description updated to mention STDIO & Streamable HTTP transport support (server.json, Dockerfile OCI label)
- Removed stale `ctx.elicit`/`ctx.sample` guidance from CLAUDE.md

---

## 0.2.1 — 2026-04-04

### Changed

- Renamed tool exports for consistency: `lookupCalendarTool` → `lookupCalendar`, `lookupElectionsTool` → `lookupElections`, `searchLegalTool` → `searchLegal`
- `FecParams` type now supports `string[]` values for repeated query parameters (e.g., multiple `candidate_id` values)
- `search-candidates` tool sends multi-candidate totals lookups as repeated query params instead of comma-separated strings
- Calendar tool `report_type` parameter scoped to filing deadlines mode only; added dedicated `category` parameter for calendar category filtering in events mode
- Disbursements tool `committee_id` enforced as required via `.min(1)` schema constraint instead of runtime guard

### Added

- Shared `utils/format-helpers.ts` — extracted `fmt$`, `str`, and `PaginationSchema` from duplicated inline definitions across tools
- Shared `utils/id-validators.ts` — extracted `validateCandidateId` and `validateCommitteeId` with consistent error messages
- Contributions tool now validates `candidate_id` and `committee_id` format before API calls

---

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
