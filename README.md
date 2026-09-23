<div align="center">
  <h1>@cyanheads/openfec-mcp-server</h1>
  <p><b>Access FEC campaign finance data through MCP. Query data about candidates, money trails, and election filings. STDIO & Streamable HTTP.</b>
  <div>12 Tools • 5 Resources • 2 Prompts</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/openfec-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfec-mcp-server) [![Version](https://img.shields.io/badge/Version-0.8.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openfec-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-^1.4.0-f9f1e1.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openfec-mcp-server/releases/latest/download/openfec-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openfec-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmZlYy1tY3Atc2VydmVyIl0sImVudiI6eyJGRUNfQVBJX0tFWSI6InlvdXItYXBpLWtleSJ9fQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openfec-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/openfec-mcp-server%22%5D%2C%22env%22%3A%7B%22FEC_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openfec.caseyjhand.com/mcp](https://openfec.caseyjhand.com/mcp)

</div>

---

## Overview

US federal campaign finance data from the FEC's OpenFEC API. Search candidates, committees, and filings, trace contributions (Schedule A), disbursements (Schedule B), and independent and coordinated party expenditures (Schedules E/F), and look up election races, legal documents, and filing deadlines. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `openfec_search_candidates` | Find federal candidates by name, state, office, party, or cycle; fetch one by FEC ID with financial totals. |
| `openfec_search_committees` | Find political committees by name, type, candidate affiliation, or state; fetch one by FEC ID. |
| `openfec_get_committee_totals` | Pre-aggregated committee financial totals — one committee's per-cycle summary, or a ranked search across committees of one entity type. |
| `openfec_search_contributions` | Search itemized individual contributions (Schedule A) or aggregate breakdowns by size, state, employer, or occupation. |
| `openfec_search_disbursements` | Search itemized committee spending (Schedule B) or aggregate breakdowns by purpose or recipient. |
| `openfec_search_expenditures` | Search independent expenditures (Schedule E) supporting or opposing federal candidates, itemized or aggregated by candidate. |
| `openfec_search_coordinated_expenditures` | Search coordinated party expenditures (Schedule F) made on behalf of a candidate. |
| `openfec_search_filings` | Search FEC filings and reports by committee, candidate, form type, or date range. |
| `openfec_lookup_elections` | Look up federal election races and candidate financial summaries. |
| `openfec_search_legal` | Search FEC legal documents: advisory opinions, enforcement cases, administrative fines, and statutes. |
| `openfec_get_legal_document` | Fetch one legal document in full, including the arrays search trims away. |
| `openfec_lookup_calendar` | Look up FEC calendar events, filing deadlines, and election dates. |

### Resources

| Resource | Description |
|:---|:---|
| `openfec://candidate/{candidate_id}` | Federal candidate profile with current financial totals and principal committees by current designation — for a cycle's principal committee, use `openfec_lookup_elections` `candidate_pcc_id`. |
| `openfec://committee/{committee_id}` | Political committee profile with type, designation, and financial summary. |
| `openfec://election/{cycle}/{office}` | Presidential election race with candidate financial totals. |
| `openfec://election/{cycle}/{office}/{state}` | Senate or at-large House election race with candidate financial totals. |
| `openfec://election/{cycle}/{office}/{state}/{district}` | House district election race with candidate financial totals. |

### Prompts

| Prompt | Description |
|:---|:---|
| `openfec_money_trail` | Framework for tracing the flow of money around a candidate or race. |
| `openfec_campaign_analysis` | Structured analysis of a candidate's financial position. |

## Capability reference

### `openfec_search_candidates` <sub>tool</sub>

- Full-text name search, or a direct lookup by FEC candidate ID (H/S/P + eight letters or digits) that returns full detail
- Filters: state, district, office, party, cycle, election_year, incumbent_challenge, candidate_status, has_raised_funds
- `include_totals` merges receipts/disbursements/cash-on-hand per cycle — defaults to true on an ID lookup, false on search; capped at 5 pages of 100 rows, with uncovered IDs listed in `missing_totals` for re-query
- Pagination up to 100 results per page
- Typed errors: `candidate_not_found`; `inputs_not_applicable_to_id_lookup` when search-only filters accompany a direct ID lookup

---

### `openfec_search_committees` <sub>tool</sub>

- Full-text name search, or a direct lookup by FEC committee ID (`C` + eight digits)
- Filters: candidate_id, state, party, committee_type, designation, cycle, treasurer_name
- Pagination up to 100 results per page
- Typed errors: `committee_not_found`; `inputs_not_applicable_to_id_lookup` when search-only filters accompany a direct ID lookup

---

### `openfec_get_committee_totals` <sub>tool</sub>

- `mode: "single"` (default): one committee's totals, one row per two-year cycle filed. `mode: "by_entity_type"`: ranks or screens every committee of one entity type (presidential, pac, party, pac-party, house-senate, ie-only)
- `by_entity_type`-only filters: committee_state, committee_type, committee_designation, organization_type, and receipts/disbursements min/max bounds
- Returns receipts, disbursements, cash on hand, debts, and the itemized/unitemized contribution split
- Typed errors: `committee_id_required_for_single_mode`, `entity_type_required_for_group_mode`, `inputs_not_applicable_to_mode`, `committee_totals_not_found`

---

### `openfec_search_contributions` <sub>tool</sub>

- Modes: `itemized` (Schedule A records, requires committee_id, keyset cursor pagination), `by_size`/`by_state` (committee_id or candidate_id), `by_employer`/`by_occupation` (committee_id only)
- Itemized filters: contributor name, employer, occupation, city, state, ZIP, date range, amount range, is_individual; defaults to the current cycle when omitted
- Sort defaults to `-contribution_receipt_date`; a cursor is valid only for an otherwise-identical call
- Typed errors: `itemized_requires_committee_id`, `aggregate_requires_committee_id`, `itemized_only_filters_in_aggregate_mode`, `inputs_not_applicable_to_mode`

---

### `openfec_search_disbursements` <sub>tool</sub>

- Modes: `itemized` (Schedule B records, keyset cursor pagination), `by_purpose`, `by_recipient`, `by_recipient_id` — committee_id required for every mode
- Itemized filters: recipient name/state/city/committee ID, description, purpose category, date range, amount range; defaults to the current cycle when omitted
- Sort defaults to `-disbursement_date`
- Typed errors: `itemized_only_filters_in_aggregate_mode`; `inputs_not_applicable_to_mode` for an explicit page in itemized mode

---

### `openfec_search_expenditures` <sub>tool</sub>

- Modes: `itemized` (Schedule E, keyset cursor pagination, defaults to the current cycle and `most_recent: true`) and `by_candidate` (aggregated per targeted candidate — needs candidate_id or a full race scope: office alone for President, plus state for Senate, plus district for House)
- Itemized filters: payee_name, candidate_party, is_notice (24/48-hour notices), date range, amount range, support_oppose (S/O)
- Typed errors: `by_candidate_requires_scope`, `itemized_only_filters_in_aggregate_mode`, `inputs_not_applicable_to_mode`

---

### `openfec_search_coordinated_expenditures` <sub>tool</sub>

- Schedule F — party committee spending coordinated with a candidate's campaign, a separate legal category from independent expenditures and direct contributions
- Filters: committee_id (spending party committee), candidate_id (benefiting candidate), cycle, payee_name, date range, amount range; unscoped queries span all years
- Page-based pagination; the spending committee is hoisted out of rows when committee_id is supplied

---

### `openfec_search_filings` <sub>tool</sub>

- Form types: F3 (House/Senate quarterly), F3P (Presidential), F3X (PAC/party), F24 (24-hour IE notice), F1 (statement of organization), F2 (statement of candidacy), F5 (IE by persons)
- Filters: committee_id, candidate_id, filer_name, report_type, report_year, cycle, is_amended, receipt date range
- `most_recent` defaults to true, filtering out superseded amendments
- Page-based pagination, up to 100 results per page

---

### `openfec_lookup_elections` <sub>tool</sub>

- `mode: "search"` (default): candidates in a race with financial totals. `mode: "summary"`: aggregate race financial totals
- Search rows carry `candidate_pcc_id`/`candidate_pcc_name` — the candidate's principal campaign committee for that cycle, even one since redesignated
- Requires office and cycle; Senate/House also need state (House also needs district) unless a ZIP is given — ZIP resolves geography for search mode only
- `election_full` defaults to true (expands to the full election period: 4yr president, 6yr senate, 2yr house); rejected on ZIP-scoped searches
- Typed errors: `cycle_must_be_even`, `missing_state_for_office`, `missing_district_for_house`, `summary_does_not_support_zip`, `inputs_not_applicable_to_mode`

---

### `openfec_search_legal` <sub>tool</sub>

- Types: advisory_opinions, murs (enforcement cases), adrs, admin_fines, statutes; requires at least one scoping filter (query, type, ao_number, case_number, respondent, citation, penalty bound, or a date bound)
- Date filters are type-scoped — pick a `date_kind` the type records (advisory opinions: issue/request/document date; murs/adrs: open/close/document date; admin_fines: rtb/fd date; statutes have none)
- Every result is trimmed: highlights capped at 3, the `documents` array replaced by a count and category summary, `commission_votes` cut to a date and a 200-character action — retrieve the untrimmed record with `openfec_get_legal_document`
- Offset-based pagination (`from_hit`/`hits_returned`), up to 200 results per page

---

### `openfec_get_legal_document` <sub>tool</sub>

- Fetches one legal document untouched — the full `documents` array and complete `commission_votes` that `openfec_search_legal` trims
- `doc_type` is the plural of a search result's `document_type` (`mur` → `murs`); `no` is that result's `no` field
- Typed error: `legal_document_not_found`

---

### `openfec_lookup_calendar` <sub>tool</sub>

- Modes: `events` (calendar_category_id, one of 18 category codes), `filing_deadlines` (report_type, report_year), `election_dates` (state, office, district, election_year)
- `district` narrows election dates to one House district (sent as `election_district`; a single digit is zero-padded); at-large races carry no district upstream and never match it
- `min_date`/`max_date` apply in every mode; other filters are mode-specific and rejected outside their mode
- Typed error: `inputs_not_applicable_to_mode`

---

### `openfec://candidate/{candidate_id}` <sub>resource</sub>

- Candidate record merged with its current financial totals and `principal_committees` (designation `P`)
- `principal_committees` reflects each committee's current designation with no cycle, so it can list past campaigns and miss a committee since redesignated — for a cycle's principal committee, use `openfec_lookup_elections` `candidate_pcc_id`
- `candidate_id` comes from `openfec_search_candidates`
- Typed error: `candidate_not_found`

---

### `openfec://committee/{committee_id}` <sub>resource</sub>

- Committee record merged with its financial totals; totals are simply omitted for a committee that files no Form 3/3X/3P, while a totals request that fails (rate limit, timeout, malformed response) fails the read
- `committee_id` comes from `openfec_search_committees`
- Typed error: `committee_not_found`

---

### `openfec://election/{cycle}/{office}` <sub>resource</sub>

- Presidential races only (`office` literal `P`); candidates returned with financial totals for the full election period
- Truncates to the first page when a race has more candidates than one page holds — use `openfec_lookup_elections` mode `search` to page further
- An empty race carries an `empty_result_notice` (check the cycle is an even year, the state code, and that the district exists)
- Any other `office` code is rejected with a message naming the sibling template that serves it

---

### `openfec://election/{cycle}/{office}/{state}` <sub>resource</sub>

- Senate races, or an at-large House race in a single-district state (`office` `S` or `H`)
- Same first-page truncation, empty-result notice, and office rejection as the presidential variant

---

### `openfec://election/{cycle}/{office}/{state}/{district}` <sub>resource</sub>

- House district races (`office` `H`)
- Same first-page truncation, empty-result notice, and office rejection as the presidential variant

---

### `openfec_money_trail` <sub>prompt</sub>

- Args: `candidate_name` or `candidate_id` (one required), optional `cycle` (defaults to the current cycle)
- Seven-step framework: identify the candidate → map committees (the cycle's principal committee from `openfec_lookup_elections` `candidate_pcc_id`, related committees from `openfec_search_committees`) → direct fundraising → outside independent expenditures → coordinated party spending → disbursements → synthesis

---

### `openfec_campaign_analysis` <sub>prompt</sub>

- Args: `candidate_name` or `candidate_id` (one required), optional `cycle` (defaults to the current cycle)
- Seven-step framework: candidate overview → principal committee (from `openfec_lookup_elections` `candidate_pcc_id`) and per-cycle totals trajectory → fundraising breakdown → burn rate and spending → competitive position → outside money context → assessment

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenFEC-specific:

- Type-safe client for the [OpenFEC REST API](https://api.open.fec.gov/developers/), with automatic retry and configurable timeout
- Keyset cursor pagination for high-volume Schedule A/B/E queries; page-based pagination everywhere else
- Multi-mode tools reject a filter that belongs to a different mode rather than silently dropping it
- Error sanitization strips API keys from error messages; HTTP status errors are enriched with actionable recovery hints
- Two guided prompts (`openfec_money_trail`, `openfec_campaign_analysis`) chain multiple tools into a financial investigation

Agent-friendly output:

- Provenance on every response — a `search_criteria` echo of the effective (post-default) filters, so an implicit cycle default is never hidden
- Empty results carry a `notice` enrichment suggesting how to broaden the query, instead of a bare empty array
- Typed per-tool error contracts (`reason` plus actionable `recovery` text) instead of generic validation failures

## Getting started

### Public Hosted Instance

A public instance is available at `https://openfec.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "openfec-mcp-server": {
      "type": "streamable-http",
      "url": "https://openfec.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "openfec-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/openfec-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "FEC_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "openfec-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/openfec-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "FEC_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "openfec-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "-e", "FEC_API_KEY=your-api-key", "ghcr.io/cyanheads/openfec-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 FEC_API_KEY=your-key bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node ≥24)
- (Optional) A free [OpenFEC API key](https://api.data.gov/signup/) for higher rate limits (1,000 req/hr vs 30 req/hr with the default `DEMO_KEY`)

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/openfec-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd openfec-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set FEC_API_KEY (optional)
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `FEC_API_KEY` | OpenFEC API key. Optional — defaults to `DEMO_KEY` (30 req/hr). Provide your own key (free at [api.data.gov/signup](https://api.data.gov/signup/)) for 1,000 req/hr. | `DEMO_KEY` |
| `FEC_BASE_URL` | OpenFEC API base URL. | `https://api.open.fec.gov/v1` |
| `FEC_MAX_RETRIES` | Max retry attempts for failed API requests. | `3` |
| `FEC_REQUEST_TIMEOUT` | Request timeout in milliseconds. | `30000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_HTTP_HOST` | Hostname for HTTP server. | `localhost` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. `createApp()` declares `stateless` in `src/`; set this only to override it. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  bun run rebuild
  bun run start:stdio   # or start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck      # Lint, format, typecheck, security audit
  bun run test          # Vitest test suite
  bun run lint:mcp      # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t openfec-mcp-server .
docker run --rm -e FEC_API_KEY=your-key -p 3010:3010 openfec-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/openfec-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts/definitions/` | Prompt definitions (`*.prompt.ts`). |
| `src/services/openfec/` | OpenFEC API client and domain types. |
| `tests/` | Unit and integration tests. |
| `scripts/` | Build, clean, devcheck, tree, and lint scripts. |
| `docs/` | Design docs and OpenAPI spec. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for domain-specific logging, `ctx.state` for storage
- Register new tools and resources in the `index.ts` barrel files
- Wrap the OpenFEC API: validate raw → normalize to domain type → return the output schema; never fabricate fields the upstream response omitted

## Contributing

Issues are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
