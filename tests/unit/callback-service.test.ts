import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCallbackDestinationIsSafe,
  validateCallbackUrl,
  type CallbackResolver,
} from '../../src/callbacks/callback-url-policy';
import { sendJobCallback } from '../../src/callbacks/callback-service';
import { parseCallbackSigningSecrets } from '../../src/callbacks/callback-secrets';
import { config } from '../../src/config';
import type { CloudJob } from '../../src/jobs/types';

function makeCallbackJob(callbackUrl = 'https://hooks.example.com/model-ready'): CloudJob {
  return {
    id: 'job-callback-1',
    tenantId: 'tenant-a',
    taskType: 'model.optimize',
    task: {
      type: 'model.optimize',
      version: '1.0',
      payload: { filename: 'input.glb' },
      resourceClass: 'cpu-medium',
    },
    status: 'succeeded',
    options: {},
    inputBucket: 'input',
    inputRegion: 'ap-nanjing',
    inputKey: 'tenants/tenant-a/jobs/job-callback-1/input.glb',
    outputBucket: 'output',
    outputRegion: 'ap-nanjing',
    outputKey: 'tenants/tenant-a/jobs/job-callback-1/model.glb',
    reportKey: 'tenants/tenant-a/jobs/job-callback-1/report.json',
    callbackUrl,
    callbackSecretId: 'partner-key-1',
    callbackSigningSecret: 'callback-secret',
    paymentRequired: false,
    attempts: 1,
    maxAttempts: 3,
    createdAt: '2026-07-11T00:00:00.000Z',
  };
}

const publicResolver: CallbackResolver = async () => [{ address: '93.184.216.34', family: 4 }];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('callback URL policy', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSigningSecrets = process.env.CALLBACK_SIGNING_SECRETS;

  afterEach(() => {
    restoreEnv('NODE_ENV', originalNodeEnv);
    restoreEnv('CALLBACK_SIGNING_SECRETS', originalSigningSecrets);
  });

  it('requires HTTPS and rejects embedded credentials and local destinations', () => {
    expect(validateCallbackUrl('https://hooks.example.com/callback').hostname).toBe('hooks.example.com');
    expect(() => validateCallbackUrl('http://hooks.example.com/callback')).toThrow('must use HTTPS');
    expect(() => validateCallbackUrl('https://user:pass@hooks.example.com/callback')).toThrow('must not contain credentials');
    expect(() => validateCallbackUrl('https://localhost/callback')).toThrow('must not target localhost');
    expect(() => validateCallbackUrl('https://127.0.0.1/callback')).toThrow('private or reserved');
    expect(() => validateCallbackUrl('https://169.254.169.254/latest/meta-data')).toThrow('private or reserved');
    expect(() => validateCallbackUrl('https://[::1]/callback')).toThrow('private or reserved');
  });

  it('allows HTTP and private destinations only with explicit non-production policy', () => {
    process.env.NODE_ENV = 'test';
    expect(
      validateCallbackUrl('http://127.0.0.1:4100/callback', {
        allowHttp: true,
        allowPrivateNetworks: true,
      }).toString()
    ).toBe('http://127.0.0.1:4100/callback');

    process.env.NODE_ENV = 'production';
    expect(() =>
      validateCallbackUrl('http://127.0.0.1:4100/callback', {
        allowHttp: true,
        allowPrivateNetworks: true,
      })
    ).toThrow('must use HTTPS');
    expect(() =>
      validateCallbackUrl('https://127.0.0.1/callback', {
        allowPrivateNetworks: true,
      })
    ).toThrow('private or reserved');
    expect(() => validateCallbackUrl('https://hooks.example.com:8443/callback')).toThrow(
      'standard HTTPS port 443'
    );
  });

  it('supports exact hosts and wildcard subdomains without matching the wildcard apex', () => {
    const allowedHosts = ['hooks.example.com', '*.partner.example.com'];
    expect(validateCallbackUrl('https://hooks.example.com/cb', { allowedHosts }).hostname).toBe('hooks.example.com');
    expect(validateCallbackUrl('https://a.partner.example.com/cb', { allowedHosts }).hostname).toBe(
      'a.partner.example.com'
    );
    expect(() => validateCallbackUrl('https://partner.example.com/cb', { allowedHosts })).toThrow(
      'CALLBACK_ALLOWED_HOSTS'
    );
    expect(() => validateCallbackUrl('https://evil-example.com/cb', { allowedHosts })).toThrow(
      'CALLBACK_ALLOWED_HOSTS'
    );
  });

  it('rejects a hostname when any DNS answer is private or reserved', async () => {
    const url = validateCallbackUrl('https://hooks.example.com/callback');
    await expect(
      assertCallbackDestinationIsSafe(url, async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.8', family: 4 },
      ])
    ).rejects.toThrow('resolves to a private or reserved IP address');
  });

  it('strictly parses server-managed callback signing secrets', () => {
    expect(parseCallbackSigningSecrets('{"partner-a":"secret-a"}')).toEqual({ 'partner-a': 'secret-a' });
    expect(() => parseCallbackSigningSecrets('{')).toThrow('must be valid JSON');
    expect(() => parseCallbackSigningSecrets('[]')).toThrow('must be a JSON object');
    expect(() => parseCallbackSigningSecrets('{"partner-a":""}')).toThrow('must be non-empty strings');
  });
});

describe('callback delivery retries', () => {
  const originalMaxAttempts = config.cloud.callbackMaxAttempts;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSigningSecrets = process.env.CALLBACK_SIGNING_SECRETS;

  afterEach(() => {
    config.cloud.callbackMaxAttempts = originalMaxAttempts;
    restoreEnv('NODE_ENV', originalNodeEnv);
    restoreEnv('CALLBACK_SIGNING_SECRETS', originalSigningSecrets);
  });

  it('retries network-safe transient statuses with bounded exponential backoff', async () => {
    const statuses = [500, 429, 204];
    const sleeps: number[] = [];
    const requestOptions: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestOptions.push(init || {});
      const status = statuses.shift() || 500;
      return new Response(null, { status });
    };

    const result = await sendJobCallback(makeCallbackJob(), 1, {
      maxAttempts: 5,
      fetchImpl,
      resolver: publicResolver,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 15,
    });

    expect(result).toEqual({ delivered: true, attempts: 3, statusCode: 204, error: undefined });
    expect(sleeps).toEqual([10, 15]);
    expect(requestOptions).toHaveLength(3);
    expect(requestOptions.every((options) => options.redirect === 'manual')).toBe(true);
    expect((requestOptions[2].headers as Record<string, string>)['x-optimizer-attempt']).toBe('3');
    expect((requestOptions[2].headers as Record<string, string>)['x-optimizer-signature']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not retry ordinary 4xx responses or redirects', async () => {
    for (const status of [302, 400, 401, 404]) {
      let calls = 0;
      const result = await sendJobCallback(makeCallbackJob(), 1, {
        maxAttempts: 4,
        resolver: publicResolver,
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status });
        },
        sleep: async () => {
          throw new Error('sleep must not be called for a permanent response');
        },
      });

      expect(result).toMatchObject({ delivered: false, attempts: 1, statusCode: status });
      expect(calls).toBe(1);
    }
  });

  it('retries network failures and stops after CALLBACK_MAX_ATTEMPTS', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await sendJobCallback(makeCallbackJob(), 1, {
      maxAttempts: 3,
      resolver: publicResolver,
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError('connection reset');
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      retryBaseDelayMs: 2,
      retryMaxDelayMs: 10,
    });

    expect(result).toEqual({ delivered: false, attempts: 3, error: 'connection reset' });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([2, 4]);
  });

  it('uses the configured CALLBACK_MAX_ATTEMPTS when no call override is supplied', async () => {
    config.cloud.callbackMaxAttempts = 2;
    let calls = 0;
    const result = await sendJobCallback(makeCallbackJob(), 1, {
      resolver: publicResolver,
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 503 });
      },
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({ delivered: false, attempts: 2, statusCode: 503 });
    expect(calls).toBe(2);
  });

  it('revalidates DNS before sending and never fetches a private resolution', async () => {
    let fetchCalls = 0;
    const result = await sendJobCallback(makeCallbackJob(), 1, {
      maxAttempts: 4,
      resolver: async () => [{ address: '169.254.0.23', family: 4 }],
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 204 });
      },
    });

    expect(result).toMatchObject({ delivered: false, attempts: 1 });
    expect(result.error).toContain('private or reserved');
    expect(fetchCalls).toBe(0);
  });

  it('reports zero attempts for an invalid legacy callback URL', async () => {
    const result = await sendJobCallback(makeCallbackJob('http://169.254.169.254/latest/meta-data'), 1, {
      maxAttempts: 3,
    });
    expect(result).toMatchObject({ delivered: false, attempts: 0 });
  });

  it('pins the approved DNS address and treats redirects as terminal responses', async () => {
    let requestedUrl: string | undefined;
    let pinnedAddress: string | undefined;
    const result = await sendJobCallback(makeCallbackJob(), 1, {
      maxAttempts: 1,
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl: async (url, approvedAddress) => {
        requestedUrl = url.toString();
        pinnedAddress = approvedAddress.address;
        return 302;
      },
    });

    expect(result).toMatchObject({ delivered: false, attempts: 1, statusCode: 302 });
    expect(requestedUrl).toBe('https://hooks.example.com/model-ready');
    expect(pinnedAddress).toBe('93.184.216.34');
  });

  it('resolves production signatures by callbackSecretId without storing an inline secret', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CALLBACK_SIGNING_SECRETS = JSON.stringify({ 'partner-key-1': 'managed-secret' });
    const job = makeCallbackJob();
    job.callbackSigningSecret = undefined;
    let sentHeaders: Record<string, string> | undefined;

    const result = await sendJobCallback(job, 1, {
      maxAttempts: 1,
      resolver: publicResolver,
      fetchImpl: async (_input, init) => {
        sentHeaders = init?.headers as Record<string, string>;
        return new Response(null, { status: 204 });
      },
    });

    expect(result.delivered).toBe(true);
    expect(sentHeaders?.['x-optimizer-secret-id']).toBe('partner-key-1');
    expect(sentHeaders?.['x-optimizer-signature']).toMatch(/^[a-f0-9]{64}$/);
  });
});
