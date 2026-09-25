<div align="center">
  <h1>@cyanheads/openfec-mcp-server</h1>
  <p><b>Access FEC campaign finance data through MCP. Query data about candidates, money trails, and election filings. STDIO & Streamable HTTP.</b>
  <div>12 Tools • 5 Resources • 2 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.9.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openfec-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openfec-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfec-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-^1.4.0-f9f1e1.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openfec-mcp-server/releases/latest/download/openfec-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openfec-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmZlYy1tY3Atc2VydmVyIl0sImVudiI6eyJGRUNfQVBJX0tFWSI6InlvdXItYXBpLWtleSJ9fQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openfec-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenfec-mcp-server%22%5D%2C%22env%22%3A%7B%22FEC_API_KEY%22%3A%22your-api-key%22%7D%7D)

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
| `openfec_search_candidates` | Find federal candidates by name, state, office, party, or cycle; fetch one by FEC ID with financial totals |
| `openfec_search_committees` | Find political committees by name, type, candidate affiliation, or state; fetch one by FEC ID |
| `openfec_get_committee_totals` | Pre-aggregated financial totals for one committee by cycle, or ranked across committees of one entity type |
| `openfec_search_contributions` | Itemized contributions (Schedule A), or aggregates by size, state, employer, or occupation |
| `openfec_search_disbursements` | Itemized committee spending (Schedule B), or aggregates by purpose or recipient |
| `openfec_search_expenditures` | Independent expenditures (Schedule E) supporting or opposing candidates, itemized or totaled per candidate |
| `openfec_search_coordinated_expenditures` | Coordinated party expenditures (Schedule F) made on behalf of a candidate |
| `openfec_search_filings` | FEC filings and reports by committee, candidate, form type, or date range |
| `openfec_lookup_elections` | Candidates in a federal race with their fundraising totals, or an aggregate race summary |
| `openfec_search_legal` | Advisory opinions, enforcement cases, alternative dispute resolutions, administrative fines, and statutes |
| `openfec_get_legal_document` | One legal document in full, including the arrays search trims away, paged by entry when too large for one response |
| `openfec_lookup_calendar` | FEC calendar events, filing deadlines, and election dates |

### Resources

| Resource | Description |
|:---|:---|
| `openfec://candidate/{candidate_id}` | Candidate profile with financial totals and principal committees |
| `openfec://committee/{committee_id}` | Committee profile with type, designation, and financial summary |
| `openfec://election/{cycle}/{office}` | Presidential race with candidate financial totals |
| `openfec://election/{cycle}/{office}/{state}` | Senate or at-large House race with candidate financial totals |
| `openfec://election/{cycle}/{office}/{state}/{district}` | House district race with candidate financial totals |

The same data is reachable through `openfec_search_candidates`, `openfec_search_committees`, and `openfec_lookup_elections` for tool-only clients.

### Prompts

| Prompt | Description |
|:---|:---|
| `openfec_money_trail` | Trace the money around a candidate: direct fundraising, PAC support, independent expenditures, and party spending |
| `openfec_campaign_analysis` | Structured analysis of a candidate's financial position |

## Capability reference

### `openfec_search_candidates` <sub>tool</sub>

- `query` name search filtered by state, district, office, party, cycle, election_year, incumbent_challenge, candidate_status, and has_raised_funds, up to 100 per page; or a `candidate_id` lookup (H/S/P + eight letters or digits) returning one full record
- `include_totals` (default on for an ID lookup) adds per-cycle `totals` rows and caps a search page at 35 candidates when cycle or election_year scopes the totals, 5 when they span every cycle; candidates the totals fetch didn't reach are listed in `missing_totals`
- Typed errors: `candidate_not_found`, `inputs_not_applicable_to_id_lookup`

---

### `openfec_search_committees` <sub>tool</sub>

- `query` name search filtered by candidate_id, state, party, committee_type, designation, cycle, and treasurer_name, up to 100 per page; or a `committee_id` lookup (`C` + eight digits)
- Typed errors: `committee_not_found`, `inputs_not_applicable_to_id_lookup`

---

### `openfec_get_committee_totals` <sub>tool</sub>

- `mode: "single"` (default) takes a `committee_id` and returns one row per two-year cycle; `mode: "by_entity_type"` ranks every committee of one `entity_type` (`presidential`, `pac`, `party`, `pac-party`, `house-senate`, `ie-only`), filterable by state, type, designation, organization type, and receipts/disbursements bounds; up to 100 per page
- Rows carry receipts, disbursements, cash on hand, debts, and the itemized/unitemized split; the output `mode` says whether rows are cycles or committees
- Typed errors: `committee_id_required_for_single_mode`, `entity_type_required_for_group_mode`, `committee_totals_not_found`

---

### `openfec_search_contributions` <sub>tool</sub>

- `itemized` (default) needs a `committee_id` and filters by contributor name, employer, occupation, city, state, ZIP, date and amount ranges, and `is_individual`, 30 rows per page; `by_size` / `by_state` take a `committee_id` or `candidate_id`, `by_employer` / `by_occupation` a `committee_id`
- The output `mode` becomes `by_size_candidate` or `by_state_candidate` when scoped by candidate, a different row shape; itemized responses carry `next_cursor`, `count`, and `count_is_approximate`
- Typed errors: `itemized_requires_committee_id`, `aggregate_requires_committee_id`

---

### `openfec_search_disbursements` <sub>tool</sub>

- `committee_id` required in every mode: `itemized` (default; recipient name, state, city, and committee ID, description, purpose category, date and amount ranges, 30 rows per page), `by_purpose`, `by_recipient`, `by_recipient_id`
- Itemized responses carry `next_cursor`, `count`, and `count_is_approximate`; aggregate modes page by number

---

### `openfec_search_expenditures` <sub>tool</sub>

- `itemized` (default) filters by committee, candidate, `support_oppose`, payee, targeted office/state/district, party, `is_notice` (24/48-hour notices), dates, and amounts; `most_recent` defaults to true; 60 rows per page when scoped by `committee_id`, 30 otherwise
- `by_candidate` totals need a `candidate_id` or a full race scope (`candidate_office=P` alone, `S` plus `candidate_office_state`, `H` plus state and `candidate_office_district`), or fail as `by_candidate_requires_scope`

---

### `openfec_search_coordinated_expenditures` <sub>tool</sub>

- Scope by spending party `committee_id`, benefiting `candidate_id`, `cycle`, payee, dates, and amounts; unscoped queries span all years
- Page-based, 80 rows per page when scoped by `committee_id` and 25 otherwise; rows carry `subordinate_committee_id`, the committee the spending is attributed to

---

### `openfec_search_filings` <sub>tool</sub>

- Filters: committee_id, candidate_id, filer_name, form_type (F3, F3P, F3X, F24, F1, F2, F5), report_type, report_year, cycle, is_amended, and receipt date range; 65 rows per page
- `most_recent` defaults to true, hiding superseded amendments; rows carry form and report type, financial totals, and `pdf_url`

---

### `openfec_lookup_elections` <sub>tool</sub>

- `office` and an even `cycle` are required; Senate also needs `state` and House `state` plus `district`, unless a `zip` scopes a search
- `mode: "search"` (default) returns the race's candidates with totals and `candidate_pcc_id` / `candidate_pcc_name`, that cycle's principal campaign committee; `mode: "summary"` returns one aggregate race row
- Typed errors: `cycle_must_be_even`, `missing_state_for_office`, `missing_district_for_house`, `summary_does_not_support_zip`

---

### `openfec_search_legal` <sub>tool</sub>

- `type` (`advisory_opinions`, `murs`, `adrs`, `admin_fines`, `statutes`), query, ao_number, case_number, respondent, citations, penalty bounds, or dates; at least one is required (`missing_filter`), and a date bound needs `type` plus a `date_kind` that type records
- Citations, penalty bounds, respondent, ao_number, and case_number each filter only some types; one sent with a `type` it doesn't filter fails as `filter_not_valid_for_type`, and with `type` omitted the search returns only the types they all apply to, with a total over those types. On MURs and ADRs a citation can't be combined with case_number, respondent, a penalty bound, or an open/close date bound, which upstream would ignore; the two citation fields together match either one
- Citations take the form upstream parses — `52 U.S.C. 30104` or `11 CFR 110.1` (`USC`, `C.F.R.`, `§`, and suffixes like `30104(g)` are fine); a bare `30106` or `110.1` fails as `invalid_citation` instead of silently returning unfiltered results. One citation per field: upstream applies only the first citation in a value, so `52 U.S.C. 30104, 52 U.S.C. 30118` fails the same way
- Offset paging via `from_hit` / `hits_returned`, up to 200 per type within a 10,000-result window
- Results are trimmed: `documents` becomes `document_count` and `document_categories`, `dispositions` becomes `disposition_count` and `disposition_categories`, highlights stop at 3 with their `<em>` match markup removed and render one per line, and `commission_votes` shrink to a date and a 200-character action; `openfec_get_legal_document` returns the full record
- Each response stays under 100,000 bytes: whole results are admitted one type at a time until the next would not fit, and a page that held some back reports `truncated`, `shown`, and `nextFromHit` — the `from_hit` that continues each type, passed back with that `type`

---

### `openfec_get_legal_document` <sub>tool</sub>

- `doc_type` is the plural of a search result's `document_type` (`mur` → `murs`); `no` is that result's `no` field
- Returns the untrimmed record, including `documents`, `commission_votes`, and `dispositions`; fails as `legal_document_not_found`
- A record over 100,000 bytes returns its scalar fields, the arrays that fit (smallest first), and `withheld` — each held-back array with its entry count and size; re-call with `array` and `offset` for that array's entries while they fit, plus `next_offset`. An array the record lacks fails as `array_not_in_record`

---

### `openfec_lookup_calendar` <sub>tool</sub>

- `events` (default; `category`, one of 18 codes, and `description`), `filing_deadlines` (`report_type`, `report_year`), or `election_dates` (`state`, `office`, `district`, `election_year`); `min_date` / `max_date` apply in every mode, up to 100 per page
- A `district` filter never matches an at-large race; pair it with `state`

---

### `openfec://candidate/{candidate_id}` <sub>resource</sub>

- Candidate record merged with its financial totals and `principal_committees` (current designation `P`, not scoped to a cycle)
- `candidate_id` comes from `openfec_search_candidates`; fails as `candidate_not_found`

---

### `openfec://committee/{committee_id}` <sub>resource</sub>

- Committee record merged with its financial totals, which are absent for a committee that files no Form 3/3X/3P
- `committee_id` comes from `openfec_search_committees`; fails as `committee_not_found`

---

### `openfec://election/{cycle}/{office}` <sub>resource</sub>

- Presidential races (`office` `P`), with totals for the full election period
- First page only: a longer race carries `truncation_notice` pointing to `openfec_lookup_elections`, and an empty one `empty_result_notice`

---

### `openfec://election/{cycle}/{office}/{state}` <sub>resource</sub>

- Senate races, or an at-large House race in a single-district state (`office` `S` or `H`)
- Same first-page limit and notices as the presidential template

---

### `openfec://election/{cycle}/{office}/{state}/{district}` <sub>resource</sub>

- House district races (`office` `H`)
- Same first-page limit and notices as the presidential template

---

### `openfec_money_trail` <sub>prompt</sub>

- Arguments: `candidate_name` or `candidate_id` (one required), optional `cycle`
- Seven steps: identify the candidate, resolve the cycle's principal committee via `candidate_pcc_id`, then direct fundraising, independent expenditures, coordinated party spending, disbursements, and a synthesis

---

### `openfec_campaign_analysis` <sub>prompt</sub>

- Arguments: `candidate_name` or `candidate_id` (one required), optional `cycle`
- Seven steps: candidate overview, principal committee and per-cycle trajectory, fundraising mix, burn rate, competitive position, outside money, and an assessment

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenFEC-specific:

- Type-safe client for the [OpenFEC REST API](https://api.open.fec.gov/developers/) with retry and a configurable timeout; error messages have the API key stripped and HTTP failures carry recovery hints
- Cycles are even years covering two calendar years (2024 = Jan 2023 – Dec 2024); itemized Schedule A/B/E default to the current cycle when `cycle` is omitted, and `election_full` (default true) widens a race total to the full election period (4yr president, 6yr senate, 2yr house)
- Itemized contributions and disbursements scope to a `committee_id`, not a `candidate_id`. Committee `designation` and `principal_committees` reflect current designation only, so for a cycle's principal committee read `candidate_pcc_id` from `openfec_lookup_elections`
- Itemized Schedule A/B/E page with an opaque `next_cursor`, valid only for an otherwise-identical call; other tools page by number, and legal search by offset

Agent-friendly output:

- Effective-query echo: every tool response carries `search_criteria` with the post-default filters, and an empty result carries a `notice` on how to broaden it
- Response budget of 100,000 bytes per surface: high-volume tools cap rows per page and report `truncated`, `shown`, and `cap` when a page falls below the requested `per_page` (page-based tools also echo the applied size in `pagination.per_page`); legal search holds back whole results and reports `nextFromHit`, and a large legal document pages its arrays by `offset`; a single-committee query lifts that committee into one top-level `committee` field instead of repeating it per row
- Typed contracts: multi-mode tools echo the resolved `mode` and reject a filter the mode can't apply (`itemized_only_filters_in_aggregate_mode`, `inputs_not_applicable_to_mode`) instead of dropping it; every failure carries a typed `reason` and `recovery` text, and estimated totals are flagged `count_is_approximate`

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: a free [OpenFEC API key](https://api.data.gov/signup/) raises the rate limit from 30 to 1,000 requests per hour over the default `DEMO_KEY`.

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
|:---|:---|:---|
| `FEC_API_KEY` | OpenFEC API key from [api.data.gov](https://api.data.gov/signup/). `DEMO_KEY` allows 30 req/hr; your own key allows 1,000. | `DEMO_KEY` |
| `FEC_BASE_URL` | OpenFEC API base URL. | `https://api.open.fec.gov/v1` |
| `FEC_MAX_RETRIES` | Retry attempts for failed API requests. | `3` |
| `FEC_REQUEST_TIMEOUT` | Per-request timeout, in ms. | `30000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. Overrides the `stateless` mode the server declares. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits the OpenFEC service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`), with shared validators and formatters in `definitions/utils/`. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Candidate, committee, and three election-race templates. |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). Money trail and campaign analysis. |
| `src/services/openfec` | OpenFEC API client and domain types. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |
| `scripts/` | Build, clean, devcheck, tree, changelog, and lint scripts. |
| `docs/` | Design notes and the OpenFEC OpenAPI spec. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the barrels at `src/mcp-server/*/definitions/index.ts`
- Wrap the OpenFEC API: validate raw → normalize to domain type → return the output schema; never fabricate fields the upstream response omitted

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
