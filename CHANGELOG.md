# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.8.3](changelog/0.8.x/0.8.3.md) — 2026-09-23

Prompts resolve a cycle's principal committee via the correct source instead of current designation, committee reads fail on a rejected totals fetch, and election resources add empty-result guidance and a calendar district filter

## [0.8.2](changelog/0.8.x/0.8.2.md) — 2026-09-22

Exhausted pagination positions now report the position instead of a false zero-match, and high-volume counts are labelled as estimates

## [0.8.1](changelog/0.8.x/0.8.1.md) — 2026-09-19

mcp-ts-core ^0.13.6: stateless session posture, structured argument-rejection errors, and case-insensitive parameter aliasing

## [0.8.0](changelog/0.8.x/0.8.0.md) — 2026-08-30 · ⚠️ Breaking

OpenFEC tools now reject explicit inputs their resolved endpoints would ignore, with fixed-width ID and range validation before dispatch

## [0.7.2](changelog/0.7.x/0.7.2.md) — 2026-08-24

mcp-ts-core ^0.12.3 adopts MCP SDK v2 on the wire — strict tool inputs, JSON Schema 2020-12, an outputSchema declaring the error envelope, and protocol revision 2026-07-28 — plus discovery cache hints and a stateless session pin

## [0.7.1](changelog/0.7.x/0.7.1.md) — 2026-07-26

openfec_money_trail and openfec_campaign_analysis now chain openfec_get_committee_totals and openfec_search_coordinated_expenditures, pin the cycle on itemized calls, and fix an unexecutable openfec_lookup_elections step (#24)

## [0.7.0](changelog/0.7.x/0.7.0.md) — 2026-07-26

Three new tools — openfec_get_committee_totals, openfec_search_coordinated_expenditures, openfec_get_legal_document (9 → 12) — closing #14 and #1; the outbound parameter guard now checks path-parameterized endpoints, and a genuine upstream miss is distinguished from an edge routing failure

## [0.6.0](changelog/0.6.x/0.6.0.md) — 2026-07-26 · ⚠️ Breaking

Query responses now echo effective search criteria and resolved mode on every call (#5); itemized Schedule A/B/E rows hoist the shared committee object instead of repeating it per row (#11); aggregate modes on the three schedule tools reject itemized-only filters instead of silently ignoring them (#23)

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-07-26 · ⚠️ Breaking

Independent-expenditure and legal-search filters now reach the API instead of being silently dropped (#16, #17); itemized Schedule B and E queries are cycle-scoped (#19, #22); outbound parameter names are checked against the OpenFEC spec

## [0.4.15](changelog/0.4.x/0.4.15.md) — 2026-07-26

Page-based aggregate modes and elections search reach page 2 (#12); election resources surface pagination instead of dropping it (#12); candidate totals sub-fetch pages independently and every cycle renders (#13, #18); itemized next_cursor delimited for text-only clients (#21)

## [0.4.14](changelog/0.4.x/0.4.14.md) — 2026-07-26

Pagination cursors bind to query identity, rejecting cross-query replay (#15, #20) and adding descending sort variants for itemized search (#10); mcp-ts-core ^0.11.0, TypeScript ^7, Socket supply-chain scanning

## [0.4.13](changelog/0.4.x/0.4.13.md) — 2026-06-20

mcp-ts-core ^0.10.9 maintenance: framework dep bump, fresh-scaffold + dependency-specifier + plugin-manifest devcheck guards, ctx.content skill docs, biome 2.5 + dev-dep refresh

## [0.4.12](changelog/0.4.x/0.4.12.md) — 2026-06-12

mcp-ts-core 0.10.6 adoption; bundle-content + identity packaging guards; in-code identity pinning; Dockerfile healthcheck

## [0.4.11](changelog/0.4.x/0.4.11.md) — 2026-06-08

search_legal respondent/citation gate fix; handler-level ID validation; lookup_elections independent_expenditures caveat

## [0.4.10](changelog/0.4.x/0.4.10.md) — 2026-06-04

McpError code/data preservation in rethrowSanitized; totalCount enrichment on openfec_search_legal

## [0.4.9](changelog/0.4.x/0.4.9.md) — 2026-06-02

mcp-ts-core 0.9.21: per-request log context fix, secret-stripping in fetch errors, withRetry fail-fast

## [0.4.8](changelog/0.4.x/0.4.8.md) — 2026-05-30

enrichment adoption: search/lookup tools surface true result totals and empty-result guidance via typed enrichment block

## [0.4.7](changelog/0.4.x/0.4.7.md) — 2026-05-28

mcp-ts-core ^0.9.6 → ^0.9.13: HTTP 413 body cap, session-init gate, quieter 401/403/400/404 logs, GET /mcp surfaces keywords; manifest metadata; dep refresh

## [0.4.6](changelog/0.4.x/0.4.6.md) — 2026-05-26

Add Zod regex validators and workflow hints to candidate_id and committee_id fields

## [0.4.5](changelog/0.4.x/0.4.5.md) — 2026-05-23

mcp-ts-core ^0.9.1 → ^0.9.6, zod added, manifest.json + .mcpbignore scaffolded, changelog migrated to per-version format, install badges

## [0.4.4](changelog/0.4.x/0.4.4.md) — 2026-05-16

mcp-ts-core ^0.9.1: server instructions, schema portability lint, mcp_tool_scopes claim; skill and script syncs.

## [0.4.3](changelog/0.4.x/0.4.3.md) — 2026-05-08 · ⚠️ Breaking

Office codes H|S|P standardized; calendar category enum; pagination tightened; candidate/committee resources enriched; prompt refinements.

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-05-08

mcp-ts-core ^0.8.19: typed error contracts, error-code semantics fix (invalidParams→validationError), engines bump, skill and script syncs.

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-04-24

mcp-ts-core ^0.7.0: landing page, SEP-1649 server card, MCP_PUBLIC_URL, new skills (security-pass, release-and-publish, api-linter); describe-on-fields fixes.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-04-20

mcp-ts-core ^0.5.3: format-parity pass, looseObject output schemas, parseEnvConfig migration, security overrides.

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-04-19

mcp-ts-core ^0.3.8: 15 skills synced, devDep bumps, description string literal cleanup, candidate resource ID validation.

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-04-04

Search criteria echo on empty results across all 9 tools; shared buildSearchCriteria/formatEmptyResult helpers.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-04-04

Format output overhaul (renderRecord helper); election ZIP support; calendar/disbursement sort defaults; error sanitization fix.

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-04-04

Public hosted instance at openfec.caseyjhand.com/mcp; server.json remotes field.

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-04-04

Legal search respondent param fix (respondent → case_respondents); STDIO & HTTP transport mention in description.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-04-04

Tool export renames; FecParams multi-value support; calendar category param; disbursements committee_id required; shared format-helpers and id-validators.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-04-04 · ⚠️ Breaking

Election resource split into 3 URI templates with explicit params; API key sanitization; HTTP status enrichment; legal search trimming.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-04-04

Initial release: 9 tools, 3 resources, 2 prompts for FEC campaign finance data. STDIO and Streamable HTTP.
