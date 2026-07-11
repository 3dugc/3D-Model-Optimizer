import { afterEach, describe, expect, it } from 'vitest';
import {
  RuntimeConfigurationError,
  assertRuntimeConfig,
  config,
  getRuntimeConfigErrors,
  validateConfig,
} from '../../src/config';
import { parseServerConfig } from '../../src/config/server';
import type { RuntimeRole, ServerConfig } from '../../src/config';

const originalNodeEnv = process.env.NODE_ENV;
const originalAllowQueryAuthTokens = process.env.ALLOW_QUERY_AUTH_TOKENS;
const originalCallbackSigningSecrets = process.env.CALLBACK_SIGNING_SECRETS;

function restoreEnv(
  name: 'NODE_ENV' | 'ALLOW_QUERY_AUTH_TOKENS' | 'CALLBACK_SIGNING_SECRETS',
  value: string | undefined
): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function testConfig(): ServerConfig {
  return {
    ...config,
    cloud: { ...config.cloud },
    database: { ...config.database },
    billing: { ...config.billing },
    invoice: { ...config.invoice },
    webAuth: { ...config.webAuth },
  };
}

afterEach(() => {
  restoreEnv('NODE_ENV', originalNodeEnv);
  restoreEnv('ALLOW_QUERY_AUTH_TOKENS', originalAllowQueryAuthTokens);
  restoreEnv('CALLBACK_SIGNING_SECRETS', originalCallbackSigningSecrets);
});

describe('runtime configuration hardening', () => {
  it('disables query-string authentication by default in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_QUERY_AUTH_TOKENS;
    expect(parseServerConfig().allowQueryAuthTokens).toBe(false);

    process.env.NODE_ENV = 'development';
    expect(parseServerConfig().allowQueryAuthTokens).toBe(true);
  });

  it('still permits an explicit production query-token compatibility override', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_QUERY_AUTH_TOKENS = 'true';
    expect(parseServerConfig().allowQueryAuthTokens).toBe(true);
  });

  it('reports the development web token secret as an API production error only', () => {
    process.env.NODE_ENV = 'production';
    const current = testConfig();
    current.webAuth.tokenSecret = 'dev-web-auth-secret';

    expect(getRuntimeConfigErrors('api', current)).toContain(
      'WEB_AUTH_SECRET must not use the development default in production.'
    );
    expect(getRuntimeConfigErrors('worker', current)).not.toContain(
      'WEB_AUTH_SECRET must not use the development default in production.'
    );
  });

  it('requires a payment service key for API wechat_native billing', () => {
    process.env.NODE_ENV = 'production';
    const current = testConfig();
    current.billing.mode = 'wechat_native';
    current.billing.paymentServiceUrl = 'http://payment-service:3010';
    current.billing.paymentServiceApiKey = undefined;

    expect(getRuntimeConfigErrors('api', current)).toContain(
      'PAYMENT_SERVICE_API_KEY is required when PAYMENT_SERVICE_URL is used with wechat_native billing.'
    );
  });

  it.each<RuntimeRole>(['api', 'worker', 'dispatcher', 'monitor'])(
    'rejects a local state store for the %s remote-cloud production runtime',
    (role) => {
      process.env.NODE_ENV = 'production';
      const current = testConfig();
      current.cloud.provider = 'tencent';
      current.cloud.queueProvider = 'tdmq-cmq';
      current.database.stateStoreProvider = 'local';

      expect(getRuntimeConfigErrors(role, current)).toContain(
        `${role} cannot use STATE_STORE_PROVIDER=local with Tencent Cloud or TDMQ-CMQ in production.`
      );
    }
  );

  it('throws a stable role-aware assertion error', () => {
    process.env.NODE_ENV = 'production';
    const current = testConfig();
    current.cloud.queueProvider = 'tdmq-cmq';
    current.database.stateStoreProvider = 'local';

    expect(() => assertRuntimeConfig('api', current)).toThrowError(RuntimeConfigurationError);
    try {
      assertRuntimeConfig('api', current);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_RUNTIME_CONFIGURATION',
        role: 'api',
      });
    }
  });

  it('rejects malformed callback signing secret maps before API or Worker startup', () => {
    process.env.NODE_ENV = 'production';
    process.env.CALLBACK_SIGNING_SECRETS = '{';
    const current = testConfig();

    expect(getRuntimeConfigErrors('api', current)).toContain(
      'CALLBACK_SIGNING_SECRETS must be valid JSON.'
    );
    expect(getRuntimeConfigErrors('worker', current)).toContain(
      'CALLBACK_SIGNING_SECRETS must be valid JSON.'
    );
  });

  it('keeps validateConfig as the existing warnings array API', () => {
    process.env.NODE_ENV = 'production';
    const current = testConfig();
    current.webAuth.tokenSecret = 'dev-web-auth-secret';
    current.allowQueryAuthTokens = true;

    const warnings = validateConfig(current);
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings).toContain('WEB_AUTH_SECRET is using the development default in production.');
    expect(warnings).toContain(
      'ALLOW_QUERY_AUTH_TOKENS is enabled in production; keep only for legacy download links.'
    );
  });

  it('does not return runtime errors outside production', () => {
    process.env.NODE_ENV = 'test';
    const current = testConfig();
    current.webAuth.tokenSecret = 'dev-web-auth-secret';
    current.cloud.provider = 'tencent';
    current.database.stateStoreProvider = 'local';
    expect(getRuntimeConfigErrors('api', current)).toEqual([]);
  });
});
