# Changelog

## [0.1.0] — 2026-04-04

### Added

- Project scaffold from `@cyanheads/mcp-ts-core` — TypeScript, Bun runtime, MCP transport (stdio/HTTP), Vitest, Biome, Docker support
- Agent protocol (`CLAUDE.md`) with full API reference section pointing to the OpenFEC OpenAPI spec
- Design document (`docs/design.md`) mapping out 9 tools, 3 resources, and 2 prompts for the OpenFEC API surface
- OpenFEC OpenAPI spec (`docs/openapi-spec.json`) — Swagger 2.0, 100 paths, 203 definitions
- Server research doc (`docs/openfec-mcp-server.md`) with tool/resource/prompt specifications
- Echo tool, resource, and prompt scaffolds with matching tests
- Build, clean, devcheck, tree, and lint-mcp scripts
- Server metadata (`server.json`) for MCP client discovery
- Skill library synced from `@cyanheads/mcp-ts-core`

### Changed

- Package name scoped to `@cyanheads/openfec-mcp-server`
