# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
