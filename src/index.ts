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
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  setup() {
    initOpenFecService();
  },
});
