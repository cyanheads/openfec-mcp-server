/**
 * @fileoverview Tests for server-specific configuration parsing.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Reset the lazy-parsed singleton between tests by re-importing the module
const loadModule = async () => {
  const mod = await import('@/config/server-config.js');
  return mod;
};

describe('getServerConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('parses valid environment variables', async () => {
    process.env.FEC_API_KEY = 'test-api-key-123';
    process.env.FEC_BASE_URL = 'https://custom.fec.api/v1';
    process.env.FEC_MAX_RETRIES = '5';
    process.env.FEC_REQUEST_TIMEOUT = '60000';

    const { getServerConfig } = await loadModule();
    const config = getServerConfig();

    expect(config.fecApiKey).toBe('test-api-key-123');
    expect(config.fecBaseUrl).toBe('https://custom.fec.api/v1');
    expect(config.fecMaxRetries).toBe(5);
    expect(config.fecRequestTimeout).toBe(60000);
  });

  it('applies defaults for optional fields', async () => {
    process.env.FEC_API_KEY = 'test-key';
    delete process.env.FEC_BASE_URL;
    delete process.env.FEC_MAX_RETRIES;
    delete process.env.FEC_REQUEST_TIMEOUT;

    const { getServerConfig } = await loadModule();
    const config = getServerConfig();

    expect(config.fecBaseUrl).toBe('https://api.open.fec.gov/v1');
    expect(config.fecMaxRetries).toBe(3);
    expect(config.fecRequestTimeout).toBe(30_000);
  });

  it('throws when FEC_API_KEY is missing', async () => {
    delete process.env.FEC_API_KEY;

    const { getServerConfig } = await loadModule();
    expect(() => getServerConfig()).toThrow();
  });

  it('throws when FEC_API_KEY is empty', async () => {
    process.env.FEC_API_KEY = '';

    const { getServerConfig } = await loadModule();
    expect(() => getServerConfig()).toThrow();
  });

  it('throws when FEC_REQUEST_TIMEOUT is below minimum', async () => {
    process.env.FEC_API_KEY = 'test-key';
    process.env.FEC_REQUEST_TIMEOUT = '500';

    const { getServerConfig } = await loadModule();
    expect(() => getServerConfig()).toThrow();
  });

  it('coerces string numbers for retries and timeout', async () => {
    process.env.FEC_API_KEY = 'test-key';
    process.env.FEC_MAX_RETRIES = '7';
    process.env.FEC_REQUEST_TIMEOUT = '15000';

    const { getServerConfig } = await loadModule();
    const config = getServerConfig();

    expect(config.fecMaxRetries).toBe(7);
    expect(config.fecRequestTimeout).toBe(15000);
  });

  it('caches the config after first parse', async () => {
    process.env.FEC_API_KEY = 'cached-key';

    const { getServerConfig } = await loadModule();
    const first = getServerConfig();

    process.env.FEC_API_KEY = 'changed-key';
    const second = getServerConfig();

    expect(second.fecApiKey).toBe('cached-key');
    expect(first).toBe(second);
  });
});
