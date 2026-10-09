/**
 * @fileoverview Test helpers for asserting a tool's declared failure as the caller
 * receives it. `runToolContract` fills a declared reason's `recovery` hint onto the
 * envelope, as production does; a direct `definition.handler(...)` throw carries
 * only what the throw site built.
 * @module tests/mcp-server/tools/definitions/contract-failure
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';

type ToolDefinition = Parameters<typeof runToolContract>[0];

/** The `structuredContent.error` of a failed tool call. */
export interface ToolFailure {
  code: number;
  data: Record<string, unknown> & { reason?: string; recovery?: { hint: string } };
  message: string;
}

/** Runs `definition` through `runToolContract`, asserts it failed, and returns the error envelope. */
export async function contractFailure<T extends ToolDefinition>(
  definition: T,
  input: Parameters<typeof runToolContract<T>>[1],
): Promise<ToolFailure> {
  const result = await runToolContract(definition, input);
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: ToolFailure }).error;
}

/** The `recovery` string `definition` declares for `reason` — the hint a bare `ctx.fail` puts on the wire. */
export function declaredRecovery(definition: ToolDefinition, reason: string): string {
  const entry = definition.errors?.find((contract) => contract.reason === reason);
  if (!entry) throw new Error(`${definition.name} declares no errors[] entry for ${reason}.`);
  return entry.recovery;
}
