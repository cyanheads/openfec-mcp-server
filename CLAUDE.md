# Agent Protocol

**Server:** openfec-mcp-server
**Version:** 0.4.5
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.9.6`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## API Reference

The OpenFEC OpenAPI spec (Swagger 2.0) is at `docs/openapi-spec.json` — 100 paths, 203 definitions. **Consult it directly** for parameter names, enums, response shapes, and pagination models. Don't guess at API behavior.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Prefer typed contracts (`errors[]` + `ctx.fail(reason)`) when the failure is part of the public surface; fall back to error factories (`notFound()`, `validationError()`) or plain `Error` otherwise. The framework catches, classifies, and formats.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
import { validateCandidateId } from './utils/id-validators.js';

export const searchCandidates = tool('openfec_search_candidates', {
  description: 'Find federal candidates by name, state, office, party, or cycle.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'candidate_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Single-candidate lookup by candidate_id returned no record',
      recovery:
        'Verify the candidate_id format (H/S/P + digits) or drop it and search by name, state, or cycle.',
    },
  ],

  input: z.object({
    query: z.string().optional().describe('Full-text candidate name search.'),
    candidate_id: z.string().optional().describe('FEC candidate ID (e.g., P00003392).'),
    state: z.string().optional().describe('Two-letter US state code.'),
    office: z.enum(['H', 'S', 'P']).optional().describe('H=House, S=Senate, P=President.'),
    // ... more filters, pagination
  }),
  output: z.object({
    candidates: z.array(z.record(z.string(), z.unknown())).describe('Candidate records.'),
    pagination: z.object({ page: z.number(), pages: z.number(), count: z.number(), per_page: z.number() }),
  }),
  async handler(input, ctx) {
    const fec = getOpenFecService();
    if (input.candidate_id) validateCandidateId(input.candidate_id);
    const result = await fec.searchCandidates(input, ctx);
    if (input.candidate_id && result.candidates.length === 0) {
      throw ctx.fail('candidate_not_found', `Candidate ${input.candidate_id} not found.`, {
        candidate_id: input.candidate_id,
        ...ctx.recoveryFor('candidate_not_found'),
      });
    }
    ctx.log.info('Candidate search completed', { count: result.pagination.count });
    return result;
  },
  format: (result) => [{ type: 'text', text: /* render candidate records */ }],
});
```

### Resource

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { getOpenFecService } from '@/services/openfec/openfec-service.js';

export const candidateResource = resource('openfec://candidate/{candidate_id}', {
  name: 'FEC Candidate Profile',
  description: 'Fetch a federal candidate profile with current financial totals.',
  mimeType: 'application/json',
  params: z.object({
    candidate_id: z.string().describe('FEC candidate ID (e.g., P00003392)'),
  }),
  async handler(params, ctx) {
    const fec = getOpenFecService();
    const candidateResult = await fec.getCandidate(params.candidate_id, ctx);
    const candidate = candidateResult.results[0];
    if (!candidate) throw new Error(`Candidate ${params.candidate_id} not found`);
    const totalsResult = await fec.getCandidateTotals({ candidate_id: params.candidate_id }, ctx);
    ctx.log.info('Candidate resource fetched', { candidate_id: params.candidate_id });
    return { ...candidate, ...(totalsResult.results[0] ?? {}) };
  },
});
```

### Prompt

```ts
import { prompt, z } from '@cyanheads/mcp-ts-core';

export const moneyTrailPrompt = prompt('openfec_money_trail', {
  description: 'Framework for tracing the flow of money around a candidate or race.',
  args: z.object({
    candidate_name: z.string().optional().describe('Candidate name to investigate.'),
    candidate_id: z.string().optional().describe('FEC candidate ID (e.g., P00003392).'),
    cycle: z.string().optional().describe('Election cycle year (e.g., 2024).'),
  }),
  generate: (args) => {
    const target = args.candidate_id
      ? `candidate ID ${args.candidate_id}`
      : args.candidate_name
        ? `"${args.candidate_name}"`
        : 'the specified candidate';
    return [{ role: 'user', content: { type: 'text', text: `Trace the money trail for ${target}...` } }];
  },
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  fecApiKey: z.string().default('DEMO_KEY').describe('OpenFEC API key — optional (DEMO_KEY: 30 req/hr, own key: 1000 req/hr)'),
  fecBaseUrl: z.string().default('https://api.open.fec.gov/v1').describe('OpenFEC API base URL'),
  fecMaxRetries: z.coerce.number().int().min(0).default(3).describe('Max retry attempts'),
  fecRequestTimeout: z.coerce.number().int().min(1000).default(30_000).describe('Request timeout in ms'),
});
let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    fecApiKey: 'FEC_API_KEY',
    fecBaseUrl: 'FEC_BASE_URL',
    fecMaxRetries: 'FEC_MAX_RETRIES',
    fecRequestTimeout: 'FEC_REQUEST_TIMEOUT',
  });
  return _config;
}
```

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()`. The handler then receives `ctx.fail(reason, msg?, data?)` keyed against the contract reason union — `ctx.fail('typo')` is a TypeScript error. The framework auto-populates `data.reason`, the linter enforces conformance, and the `recovery` string (≥5 words) is the source of truth for the recovery hint that flows to the wire. Spread `ctx.recoveryFor('reason')` into `data` to opt the contract recovery onto the wire payload.

```ts
errors: [
  { reason: 'candidate_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'Single-candidate lookup returned no record',
    recovery: 'Verify the candidate_id (H/S/P + digits) or drop it and search by name.' },
],
async handler(input, ctx) {
  if (!found) {
    throw ctx.fail('candidate_not_found', `Candidate ${id} not found.`, {
      candidate_id: id,
      ...ctx.recoveryFor('candidate_not_found'),
    });
  }
}
```

**Declare contracts inline on each tool**, even when reasons look similar across tools — per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** error factories or plain `Error`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely without contract entries.

```ts
import { notFound, validationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw validationError('Invalid query format', { field: 'query' });    // baseline — fine
throw serviceUnavailable('API unavailable', { url }, { cause: err });
throw new Error('Item not found');                                    // auto-classifies → NotFound
```

Note: `invalidParams` is for malformed JSON-RPC params (rare post-Zod). For semantic post-shape validation, use `validationError`. See the framework `api-errors` skill for the full reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # Server-specific env vars (Zod schema)
  services/
    openfec/
      openfec-service.ts                # OpenFEC API client (init/accessor pattern)
      types.ts                          # API request/response types
  mcp-server/
    tools/definitions/
      search-candidates.tool.ts         # 9 tool definitions (*.tool.ts)
      search-committees.tool.ts
      search-contributions.tool.ts
      search-disbursements.tool.ts
      search-expenditures.tool.ts
      search-filings.tool.ts
      lookup-elections.tool.ts
      search-legal.tool.ts
      lookup-calendar.tool.ts
    resources/definitions/
      candidate.resource.ts             # 5 resource definitions (*.resource.ts)
      committee.resource.ts
      election.resource.ts              # 3 election resources (base, state, district)
    prompts/definitions/
      campaign-analysis.prompt.ts       # 2 prompt definitions (*.prompt.ts)
      money-trail.prompt.ts
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + UI resource pair |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of definition language across the surface (10 categories: voice, leaks, defaults, recovery, structure, …) |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `release-and-publish` | Post-wrapup ship workflow: verification gate, push commits/tags, publish to npm + MCP Registry + GHCR |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills and framework scripts |
| `migrate-mcp-ts-template` | Migrate a legacy template fork to use `@cyanheads/mcp-ts-core` as a package dependency |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress, sessionId, recoveryFor |
| `api-errors` | McpError, JsonRpcErrorCode, typed error contracts, factories |
| `api-linter` | MCP definition lint rules reference — look here when devcheck flags `format-parity`, `schema-*`, `name-*`, `server-json-*`, etc. |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run lint:mcp` | Validate MCP tool/resource/prompt definitions |
| `bun run lint:packaging` | Validate `manifest.json` + `server.json` env var alignment |
| `bun run list-skills` | Print index of available project skills |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run test` | Run tests |
| `bun run start` | Production mode (transport from `MCP_TRANSPORT_TYPE`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

For dev / smoke-testing, use `bun run rebuild && bun run start:stdio` (or `start:http`) — production-shape execution against the built `dist/`.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. If you don't need it, delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

---

## Publishing

Run the `release-and-publish` skill for the full flow (verification gate, push, npm + MCP Registry + GHCR). Reference commands:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/openfec-mcp-server:<version> \
  -t ghcr.io/cyanheads/openfec-mcp-server:latest \
  --push .
```

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getOpenFecService } from '@/services/openfec/openfec-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()` (including nested object fields and array element types), only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`); avoid non-portable `format` emitters (`z.url()`, `z.cuid()`, `z.ulid()`, `z.nanoid()`, `z.base64()`, `z.jwt()`) — use `z.string()` with the constraint in `.describe()`
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Wrapping the OpenFEC API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] Wrapping the OpenFEC API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] Wrapping the OpenFEC API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
