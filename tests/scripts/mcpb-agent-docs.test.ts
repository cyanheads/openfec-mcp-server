/**
 * @fileoverview MCPB cleanup keeps runtime skill modules while removing dependency agent docs.
 * @module tests/scripts/mcpb-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

// The copied linter has a framework-repository source fallback; load it at runtime.
const {
  checkBundleEntries,
}: { checkBundleEntries: (entries: string[], label: string) => string[] } = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);

const runtimeEntries = [
  'skills/openfec-guide/SKILL.md',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@scope/parent/node_modules/plain/dist/skills/index.js',
  'node_modules/plain/dist/framework-skills/index.js',
  'node_modules/skills/index.js',
  'node_modules/plain/skills-helper/index.js',
];

const agentDocs = [
  'node_modules/plain/skills/guide/SKILL.md',
  'node_modules/plain/skills/guide/references/query.md',
  'node_modules/@scope/package/framework-skills/add-tool/SKILL.md',
  'node_modules/@scope/package/.claude/settings.json',
  'node_modules/plain/.agents/skills/guide/SKILL.md',
  'node_modules/parent/node_modules/child/skills/guide/references/query.md',
  'node_modules/@scope/parent/node_modules/@scope/child/skills/guide/references/query.md',
  'node_modules/plain/docs/SKILL.md',
];

describe('MCPB dependency agent-document boundary', () => {
  it('preserves runtime modules and the published server guide', () => {
    expect(filterAgentDocEntries(runtimeEntries)).toEqual([]);
  });

  it('removes package-root agent trees and standalone skill documents', () => {
    expect(filterAgentDocEntries(agentDocs)).toEqual(agentDocs);
  });

  it('accepts runtime skill modules in the completed bundle', () => {
    expect(checkBundleEntries(runtimeEntries, 'fixture.mcpb')).toEqual([]);
  });

  it('rejects dependency-root agent documentation in the completed bundle', () => {
    for (const entry of agentDocs) {
      const errors = checkBundleEntries([entry], 'fixture.mcpb');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(entry);
    }
  });
});
