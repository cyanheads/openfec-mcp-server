# Agent Protocol

**Server:** openfec-mcp-server
**Version:** 0.8.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.6`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0

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
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never await a user mid-handler. Check `ctx.sample` for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

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

### Session posture and shutdown

Two more `createApp()` options shape how the server runs rather than how it presents itself:

```ts
await createApp({
  sessionMode: 'stateless',          // or { default: 'stateful', require: 'stateful' }
  setup() { initOpenFecService(); },
  async teardown() { /* release a watcher, socket, or ref'd timer — this server allocates none */ },
});
```

`sessionMode` declares the HTTP session posture in `src/` instead of leaving it to a deployment's `MCP_SESSION_MODE`, which still wins whenever it carries a meaningful value (an empty string and an unsubstituted `${…}` placeholder read as unset and fall through to the option). This server declares `stateless`: every tool and resource is a one-shot read of the OpenFEC API, and nothing gates on `ctx.requestInput`. Add `require: 'stateful'` only if a tool starts asking the caller for input mid-handler — startup then fails with a `ConfigurationError` rather than serving a mode in which a 2025-era client can never answer the prompt. Stdio is never refused.

`teardown(core)` is the `setup()` counterpart — release a watcher, socket, or non-`unref()`'d timer there. It runs after the transport stops and before the logger closes, on every shutdown path, and a signal-triggered shutdown then exits the process explicitly (0, or 1 if a step never settles within the framework's 10 s ceiling). `initOpenFecService()` allocates nothing that needs releasing, so this server declares no `teardown`.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.requestInput` | Suspend and ask the caller for more input — `return ctx.requestInput({ inputRequests: { key: inputRequired.elicit({ message, requestedSchema }) } })`. Never returns; the handler is re-entered with the answers. Always present. |
| `ctx.inputs` | Reader over a re-entered request's responses — `.accepted(key, schema)`, `.view(key)`, `.state()`, `.dropped`. Empty on the first round. |
| `ctx.enrich` | Success-path agent context (empty-result notices, query echo, pagination totals) — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). |
| `ctx.content` | Non-text content blocks — `.image(data, mimeType)`, `.audio(data, mimeType)`, or `ctx.content(block)` for a raw block. Prepended to `content[]` after `format()`; never enters `structuredContent`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT; `'default'` for stdio or HTTP with auth off. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()`. The handler then receives `ctx.fail(reason, msg?, data?)` keyed against the contract reason union — `ctx.fail('typo')` is a TypeScript error. The framework auto-populates `data.reason`, the linter enforces conformance, and the `recovery` string (≥5 words) is the source of truth for the recovery hint that flows to the wire. Spread `ctx.recoveryFor('reason')` into `data` to opt the contract recovery onto the wire payload — lint-enforced per throw site (`error-contract-recovery-unforwarded`), so every `ctx.fail` site carries either that resolver or its own `recovery` key. `severity` (`debug` | `info` | `notice` | `warning`) moves that one log record's level and nothing else. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

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

**Fallback (no contract entry fits):** error factories or plain `Error`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely without contract entries.

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
      search-candidates.tool.ts         # 12 tool definitions (*.tool.ts)
      search-committees.tool.ts
      get-committee-totals.tool.ts
      search-contributions.tool.ts
      search-disbursements.tool.ts
      search-expenditures.tool.ts
      search-coordinated-expenditures.tool.ts
      search-filings.tool.ts
      lookup-elections.tool.ts
      search-legal.tool.ts
      get-legal-document.tool.ts
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

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

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
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills and framework scripts |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input, recoveryFor |
| `api-errors` | McpError, JsonRpcErrorCode, typed error contracts, factories |
| `api-linter` | MCP definition lint rules reference — look here when devcheck flags `format-parity`, `schema-*`, `name-*`, `server-json-*`, etc. |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |
| `api-mirror` | MirrorService: persistent self-refreshing local SQLite mirror of a bulk upstream dataset — Tier 3 opt-in |
| `orchestrations` | Multi-server pipeline workflows — gated phase tables for maintenance, field-test, fix-wrapup-release, greenfield |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run lint:mcp` | Validate MCP tool/resource/prompt definitions |
| `bun run lint:packaging` | Validate `manifest.json` + `server.json` env var alignment |
| `bun run list-skills` | Print index of available project skills |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create GitHub Release from the current annotated tag |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run start` | Production mode (transport from `MCP_TRANSPORT_TYPE`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

For dev / smoke-testing, use `bun run rebuild && bun run start:stdio` (or `start:http`) — production-shape execution against the built `dist/`.

**CI is one file.** `.github/workflows/codeql.yml` is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. MCPB is stdio-only — HTTP deployments are unaffected. If you don't need it, delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.8.x/0.8.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.8.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

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
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `bun run devcheck` passes
