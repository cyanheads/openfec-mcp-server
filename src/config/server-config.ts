/**
 * @fileoverview Server-specific configuration for OpenFEC API access.
 * Lazy-parsed from environment variables — safe for Workers runtime.
 * @module src/config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';

const ServerConfigSchema = z.object({
  fecApiKey: z
    .string()
    .min(1, 'FEC_API_KEY is required. Get a free key at https://api.data.gov/signup/'),
  fecBaseUrl: z.string().default('https://api.open.fec.gov/v1').describe('OpenFEC API base URL'),
  fecMaxRetries: z.coerce.number().int().min(0).default(3).describe('Max retry attempts'),
  fecRequestTimeout: z.coerce
    .number()
    .int()
    .min(1000)
    .default(30_000)
    .describe('Request timeout in ms'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Returns validated server config, lazily parsed from env vars. */
export function getServerConfig(): ServerConfig {
  _config ??= ServerConfigSchema.parse({
    fecApiKey: process.env.FEC_API_KEY,
    fecBaseUrl: process.env.FEC_BASE_URL,
    fecMaxRetries: process.env.FEC_MAX_RETRIES,
    fecRequestTimeout: process.env.FEC_REQUEST_TIMEOUT,
  });
  return _config;
}
