# openfec-mcp-server - Directory Structure

Generated on: 2026-07-26 16:51:36

```text
openfec-mcp-server/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   └── template.md
├── claude-plans/
├── docs/
│   ├── design.md
│   └── openapi-spec.json
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       ├── campaign-analysis.prompt.ts
│   │   │       ├── index.ts
│   │   │       └── money-trail.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── candidate.resource.ts
│   │   │       ├── committee.resource.ts
│   │   │       ├── election.resource.ts
│   │   │       └── index.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── utils/
│   │           │   ├── election-cycle.ts
│   │           │   ├── format-helpers.ts
│   │           │   └── id-validators.ts
│   │           ├── index.ts
│   │           ├── lookup-calendar.tool.ts
│   │           ├── lookup-elections.tool.ts
│   │           ├── search-candidates.tool.ts
│   │           ├── search-committees.tool.ts
│   │           ├── search-contributions.tool.ts
│   │           ├── search-disbursements.tool.ts
│   │           ├── search-expenditures.tool.ts
│   │           ├── search-filings.tool.ts
│   │           └── search-legal.tool.ts
│   ├── services/
│   │   └── openfec/
│   │       ├── openfec-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       ├── campaign-analysis.prompt.test.ts
│   │   │       └── money-trail.prompt.test.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── candidate.resource.test.ts
│   │   │       ├── committee.resource.test.ts
│   │   │       └── election.resource.test.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── utils/
│   │           │   ├── format-helpers.test.ts
│   │           │   └── id-validators.test.ts
│   │           ├── lookup-calendar.tool.test.ts
│   │           ├── lookup-elections.tool.test.ts
│   │           ├── search-candidates.tool.test.ts
│   │           ├── search-committees.tool.test.ts
│   │           ├── search-contributions.tool.test.ts
│   │           ├── search-disbursements.tool.test.ts
│   │           ├── search-expenditures.tool.test.ts
│   │           ├── search-filings.tool.test.ts
│   │           ├── search-legal.tool.test.ts
│   │           └── security.test.ts
│   └── services/
│       └── openfec/
│           ├── openfec-service-extended.test.ts
│           ├── openfec-service-security.test.ts
│           └── openfec-service.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
