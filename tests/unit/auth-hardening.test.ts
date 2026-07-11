import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiAuthConfigurationError,
  assertProductionApiAuthConfigured,
  authenticateApiKey,
  authMiddleware,
  canAccessTaskType,
  canAccessTenant,
  hasScope,
  isAuthEnabled,
  parseApiKeyDefinitions,
} from '../../src/middleware/auth';

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  API_KEY: process.env.API_KEY,
  API_KEYS: process.env.API_KEYS,
  ALLOW_ANONYMOUS_API: process.env.ALLOW_ANONYMOUS_API,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv('NODE_ENV');
  restoreEnv('API_KEY');
  restoreEnv('API_KEYS');
  restoreEnv('ALLOW_ANONYMOUS_API');
  vi.restoreAllMocks();
});

describe('API authentication configuration hardening', () => {
  it('rejects malformed JSON with a stable configuration error', () => {
    expect(() => parseApiKeyDefinitions('{')).toThrowError(ApiAuthConfigurationError);
    try {
      parseApiKeyDefinitions('{');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_API_KEYS_JSON' });
      expect((error as Error).message).toBe('API_KEYS must be valid JSON.');
    }
  });

  it('rejects a non-array API_KEYS value', () => {
    expect(() => parseApiKeyDefinitions('{"key":"secret"}')).toThrowError(
      expect.objectContaining({ code: 'INVALID_API_KEYS_TYPE' })
    );
  });

  it.each([
    ['scopes', 'jobs:read'],
    ['tenantIds', 'tenant-a'],
    ['taskTypes', 'model.optimize'],
  ])('rejects an invalid %s type instead of filtering the entry', (field, value) => {
    const raw = JSON.stringify([
      { key: 'valid-secret', scopes: ['jobs:read'] },
      { key: 'invalid-secret', [field]: value },
    ]);
    expect(() => parseApiKeyDefinitions(raw)).toThrowError(
      expect.objectContaining({ code: 'INVALID_API_KEY_DEFINITION' })
    );
  });

  it('rejects unsupported fields so a scope typo cannot grant wildcard access', () => {
    expect(() => parseApiKeyDefinitions('[{"key":"secret","scope":["jobs:read"]}]')).toThrowError(
      expect.objectContaining({ code: 'INVALID_API_KEY_DEFINITION' })
    );
  });

  it('preserves explicit empty scopes as no operation permissions', () => {
    process.env.API_KEYS = JSON.stringify([{ key: 'no-scope-secret', scopes: [] }]);
    delete process.env.API_KEY;

    const principal = authenticateApiKey('no-scope-secret');
    expect(principal?.scopes).toEqual([]);
    expect(hasScope(principal, 'jobs:read')).toBe(false);
  });

  it('keeps wildcard operation scope independent from tenant and task restrictions', () => {
    process.env.API_KEYS = JSON.stringify([{
      key: 'tenant-secret',
      scopes: ['*'],
      tenantIds: ['tenant-a'],
      taskTypes: ['model.optimize'],
    }]);
    delete process.env.API_KEY;

    const principal = authenticateApiKey('tenant-secret');
    expect(hasScope(principal, 'jobs:create')).toBe(true);
    expect(canAccessTenant(principal, 'tenant-a')).toBe(true);
    expect(canAccessTenant(principal, 'tenant-b')).toBe(false);
    expect(canAccessTaskType(principal, 'model.optimize')).toBe(true);
    expect(canAccessTaskType(principal, 'video.transcode')).toBe(false);
  });

  it('rejects different-length API keys without throwing', () => {
    process.env.API_KEY = 'a-long-production-shaped-key';
    delete process.env.API_KEYS;
    expect(authenticateApiKey('short')).toBeUndefined();
  });

  it('fails authorization checks when no principal was established', () => {
    expect(hasScope(undefined, 'jobs:read')).toBe(false);
    expect(canAccessTenant(undefined, 'tenant-a')).toBe(false);
    expect(canAccessTaskType(undefined, 'model.optimize')).toBe(false);
  });

  it('requires API credentials in production by default', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.API_KEY;
    delete process.env.API_KEYS;
    delete process.env.ALLOW_ANONYMOUS_API;

    expect(() => assertProductionApiAuthConfigured()).toThrowError(
      expect.objectContaining({ code: 'API_AUTH_REQUIRED' })
    );
  });

  it('rejects documented placeholder API keys in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.API_KEY = 'change-me';
    delete process.env.API_KEYS;
    delete process.env.ALLOW_ANONYMOUS_API;

    expect(() => assertProductionApiAuthConfigured()).toThrowError(
      expect.objectContaining({ code: 'INSECURE_API_KEY' })
    );
  });

  it('allows an intentional anonymous production API only through the explicit override', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.API_KEY;
    delete process.env.API_KEYS;
    process.env.ALLOW_ANONYMOUS_API = 'true';

    expect(() => assertProductionApiAuthConfigured()).not.toThrow();
    expect(isAuthEnabled()).toBe(false);
  });

  it('fails closed at request time if a custom production launcher skips startup validation', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.API_KEY;
    delete process.env.API_KEYS;
    delete process.env.ALLOW_ANONYMOUS_API;
    const next = vi.fn();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    authMiddleware({ headers: {}, query: {} } as never, { status } as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });
});
