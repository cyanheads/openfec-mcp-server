/**
 * @fileoverview Barrel export for all prompt definitions.
 * @module src/mcp-server/prompts/definitions/index
 */

export { campaignAnalysisPrompt } from './campaign-analysis.prompt.js';
export { moneyTrailPrompt } from './money-trail.prompt.js';

import { campaignAnalysisPrompt } from './campaign-analysis.prompt.js';
import { moneyTrailPrompt } from './money-trail.prompt.js';

export const allPromptDefinitions = [moneyTrailPrompt, campaignAnalysisPrompt];
