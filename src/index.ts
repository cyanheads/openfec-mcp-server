#!/usr/bin/env node
/**
 * @fileoverview openfec-mcp-server entry point.
 * Registers all tools, resources, and prompts, then starts the server.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allPromptDefinitions } from './mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initOpenFecService } from './services/openfec/openfec-service.js';

await createApp({
  name: 'openfec-mcp-server',
  title: 'openfec-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions:
    'Use the openfec_* tools for US federal campaign finance data: candidates, committees, contributions (Schedule A), disbursements (Schedule B), independent expenditures (Schedule E), filings, elections, calendar, and legal documents. Candidate IDs use H/S/P prefixes (House/Senate/President); committee IDs use C. Cycles are even-year integers covering the prior 2 years (2024 = Jan 2023 – Dec 2024). Itemized contributions and disbursements scope to committee_id, not candidate_id.',
  landing: {
    // Public hosted catalog — serve full tool/resource/prompt inventory without auth
    requireAuth: false,
  },
  // The discovery surface only changes when this server is redeployed, so a
  // 2026-07-28 client may hold it for an hour. `resources/read` is left unset
  // (no caching): every resource proxies live FEC data.
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'prompts/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
  },
  setup() {
    initOpenFecService();
  },
});
