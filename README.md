<div align="center">
  <h1>@cyanheads/openfec-mcp-server</h1>
  <p><b>Access FEC campaign finance data through MCP. Query data about candidates, money trails, and election filings. STDIO & Streamable HTTP.</b></p>
  <p><b>9 Tools · 5 Resources · 2 Prompts</b></p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/openfec-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfec-mcp-server) [![Version](https://img.shields.io/badge/Version-0.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) 

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-^1.2.0-f9f1e1.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

**Public Hosted Server:** [https://openfec.caseyjhand.com/mcp](https://openfec.caseyjhand.com/mcp)

</div>

---

## Tools

Nine tools for querying federal election campaign finance data:

| Tool Name | Description |
|:----------|:------------|
| `openfec_search_candidates` | Find federal candidates by name, state, office, party, or cycle. |
| `openfec_search_committees` | Find political committees by name, type, candidate affiliation, or state. |
| `openfec_search_contributions` | Search itemized individual contributions or aggregate breakdowns by size, state, employer, or occupation. |
| `openfec_search_disbursements` | Search itemized committee spending or aggregate breakdowns by purpose or recipient. |
| `openfec_search_expenditures` | Search independent expenditures supporting or opposing federal candidates. |
| `openfec_search_filings` | Search FEC filings and reports by committee, candidate, form type, or date range. |
| `openfec_lookup_elections` | Look up election races and candidate financial summaries. |
| `openfec_search_legal` | Search FEC legal documents: advisory opinions, enforcement cases, and administrative fines. |
| `openfec_lookup_calendar` | Look up FEC calendar events, filing deadlines, and election dates. |

### `openfec_search_candidates`

Find federal candidates with optional financial totals.

- Full-text name search plus filters for state, district, office, party, cycle, incumbent status
- Fetch a specific candidate by FEC ID (H/S/P prefix) with full detail
- Optional financial totals: receipts, disbursements, cash on hand
- Pagination up to 100 results per page

---

### `openfec_search_committees`

Find political committees (campaign, PAC, Super PAC, party).

- Full-text name search plus filters for type, designation, party, state, candidate affiliation
- Fetch a specific committee by FEC ID (C prefix)
- Committee types: House, Senate, Presidential, Super PAC, PAC, Party
- Treasurer name search

---

### `openfec_search_contributions`

Search Schedule A contribution data with five query modes.

- **itemized**: Individual contribution records with keyset cursor pagination
- **by_size**: Aggregate breakdowns by contribution size range
- **by_state**: Geographic breakdown of contributions
- **by_employer**: Top employer aggregates
- **by_occupation**: Top occupation aggregates
- Filters: donor name, employer, occupation, city, state, ZIP, date range, amount range

---

### `openfec_search_disbursements`

Search Schedule B spending data with four query modes.

- **itemized**: Individual disbursement records with keyset cursor pagination
- **by_purpose**: Aggregate by spending purpose category
- **by_recipient**: Aggregate by payee name
- **by_recipient_id**: Aggregate by recipient committee ID
- Filters: recipient name, description, date range, amount range

---

### `openfec_search_expenditures`

Search Schedule E independent expenditure data.

- **itemized**: Individual expenditure records with support/oppose indicator
- **by_candidate**: Aggregated totals per targeted candidate
- Filters: committee, candidate, office, party, 24/48-hour notices, date and amount range

---

### `openfec_search_filings`

Search FEC filings and reports.

- Form types: F3 (House/Senate quarterly), F3P (Presidential), F3X (PAC/party), F24 (24-hour IE notice), F1/F2 (organizational/candidacy), F5 (IE by persons)
- Report type codes: Q1/Q2/Q3, YE, monthly, pre/post election
- Amendment filtering with most-recent-only option
- Date range filtering by FEC receipt date

---

### `openfec_search_legal`

Search across FEC legal document types.

- Advisory opinions, MURs (enforcement cases), ADRs, administrative fines, statutes
- Look up specific cases by AO number or case number
- Filter by respondent, regulatory/statutory citation, penalty amount range
- Offset-based pagination (up to 200 results per page)

---

### `openfec_lookup_elections`

Look up federal election races.

- **search**: Candidates in a race with financial totals
- **summary**: Aggregate race financial summary
- Office types: president, senate, house
- ZIP code lookup to find races covering a location
- Full election period expansion (4yr president, 6yr senate, 2yr house)

---

### `openfec_lookup_calendar`

Look up FEC dates and deadlines.

- **events**: FEC calendar events
- **filing_deadlines**: Report due dates by type and year
- **election_dates**: Upcoming and past election dates by state and office
- Date range filtering

## Resources

| URI Pattern | Description |
|:------------|:------------|
| `openfec://candidate/{candidate_id}` | Federal candidate profile with current financial totals. |
| `openfec://committee/{committee_id}` | Political committee profile with type, designation, and financial summary. |
| `openfec://election/{cycle}/{office}` | Presidential or at-large election race with candidate financial totals. |
| `openfec://election/{cycle}/{office}/{state}` | Senate or state-level election race with candidate financial totals. |
| `openfec://election/{cycle}/{office}/{state}/{district}` | House district election race with candidate financial totals. |

## Prompts

| Prompt | Description |
|:-------|:------------|
| `openfec_campaign_analysis` | Structured analysis of a candidate's financial position — fundraising trajectory, burn rate, cash reserves, donor composition, and opponent comparison. |
| `openfec_money_trail` | Framework for tracing the flow of money around a candidate or race — direct fundraising, PAC support, independent expenditures, and party spending. |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or via Docker from the same codebase

OpenFEC-specific:

- Type-safe client wrapping the [OpenFEC REST API](https://api.open.fec.gov/developers/)
- Multi-mode tools supporting both itemized records and aggregate breakdowns
- Keyset cursor pagination for high-volume Schedule A/B/E data
- Automatic retry with configurable timeout and max retries
- Error sanitization strips API keys from error messages; HTTP status errors enriched with actionable hints
- Two guided investigation prompts for campaign finance analysis workflows

## Getting Started

### Public Hosted Instance

A public instance is available at `https://openfec.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "openfec": {
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
    "openfec": {
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

Or with Docker:

```json
{
  "mcpServers": {
    "openfec": {
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

- [Bun v1.2.0](https://bun.sh/) or higher
- A free [OpenFEC API key](https://api.data.gov/signup/)

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

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `FEC_API_KEY` | **Required.** OpenFEC API key. Get one free at [api.data.gov/signup](https://api.data.gov/signup/). | — |
| `FEC_BASE_URL` | OpenFEC API base URL. | `https://api.open.fec.gov/v1` |
| `FEC_MAX_RETRIES` | Max retry attempts for failed API requests. | `3` |
| `FEC_REQUEST_TIMEOUT` | Request timeout in milliseconds. | `30000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_HTTP_HOST` | Hostname for HTTP server. | `localhost` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry tracing. | `false` |

## Running the Server

### Local Development

- **Build and run the production version:**
  ```sh
  bun run build
  bun run start:http   # or start:stdio
  ```

- **Run in dev mode (with watch):**
  ```sh
  bun run dev:stdio    # or dev:http
  ```

- **Run checks and tests:**
  ```sh
  bun run devcheck     # Lints, formats, type-checks
  bun run test         # Runs test suite
  ```

## Project Structure

| Directory | Purpose |
|:----------|:--------|
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts/definitions/` | Prompt definitions (`*.prompt.ts`). |
| `src/services/openfec/` | OpenFEC API client and domain types. |
| `src/config/` | Environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests. |
| `scripts/` | Build, clean, devcheck, tree, and lint scripts. |
| `docs/` | Design docs and OpenAPI spec. |

## Development Guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for domain-specific logging, `ctx.state` for storage
- Register new tools and resources in the `index.ts` barrel files

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
