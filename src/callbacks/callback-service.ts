import crypto from 'crypto';
import http from 'http';
import https from 'https';
import type { CallbackPayload } from './types';
import type { CloudJob } from '../jobs/types';
import { config } from '../config';
import {
  assertCallbackDestinationIsSafe,
  CallbackUrlValidationError,
  defaultCallbackResolver,
  validateCallbackUrl,
  type CallbackResolver,
  type CallbackResolvedAddress,
  type CallbackUrlPolicyOptions,
} from './callback-url-policy';
import { resolveCallbackSigningSecret } from './callback-secrets';

const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 5000;
const MAX_CALLBACK_ATTEMPTS_CAP = 10;

export interface CallbackSendResult {
  delivered: boolean;
  attempts: number;
  statusCode?: number;
  error?: string;
}

export interface CallbackSendOptions extends CallbackUrlPolicyOptions {
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  resolver?: CallbackResolver;
  sleep?: (milliseconds: number) => Promise<void>;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  requestImpl?: CallbackRequestImpl;
}

export type CallbackRequestImpl = (
  url: URL,
  approvedAddress: CallbackResolvedAddress,
  headers: Record<string, string>,
  body: string,
  timeoutSeconds: number
) => Promise<number>;

export function signCallbackPayload(payload: CallbackPayload, secret: string, timestamp: string): string {
  const body = JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function createJobCallbackPayload(job: CloudJob): CallbackPayload | undefined {
  if (job.status === 'succeeded') {
    if (!job.outputKey) return undefined;
    return {
      event: 'job.succeeded',
      jobId: job.id,
      externalJobId: job.externalJobId,
      status: job.status,
      result: {
        outputKey: job.outputKey,
      },
    };
  }
  if (job.status === 'failed') {
    return {
      event: 'job.failed',
      jobId: job.id,
      externalJobId: job.externalJobId,
      status: job.status,
      error: {
        code: job.errorCode || 'JOB_FAILED',
        message: job.errorMessage || 'Job failed',
      },
    };
  }
  if (job.status === 'cancelled') {
    return {
      event: 'job.cancelled',
      jobId: job.id,
      externalJobId: job.externalJobId,
      status: job.status,
    };
  }
  return undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedPositiveInteger(value: number, fallback: number, maximum: number): number {
  const candidate = Number.isFinite(value) && value > 0 ? value : fallback;
  return Math.min(maximum, Math.max(1, Math.floor(candidate)));
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function retryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 20));
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
}

async function fetchCallbackForTest(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutSeconds: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.floor(timeoutSeconds * 1000));
  const timer = setTimeout(() => controller.abort(new Error(`Callback timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestPinnedCallback(
  url: URL,
  approvedAddress: CallbackResolvedAddress,
  headers: Record<string, string>,
  body: string,
  timeoutSeconds: number
): Promise<number> {
  const timeoutMs = Math.max(1, Math.floor(timeoutSeconds * 1000));
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise<number>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
    };
    const request = transport.request(
      url,
      {
        method: 'POST',
        headers,
        servername: url.hostname,
        lookup: (_hostname, _options, callback) => {
          callback(null, approvedAddress.address, approvedAddress.family);
        },
      },
      (response) => {
        const statusCode = response.statusCode || 0;
        response.once('error', (error) => {
          clearTimer();
          reject(error);
        });
        response.once('aborted', () => {
          clearTimer();
          reject(new Error('Callback response was aborted before completion.'));
        });
        response.resume();
        response.once('end', () => {
          clearTimer();
          resolve(statusCode);
        });
      }
    );
    timer = setTimeout(() => {
      request.destroy(new Error(`Callback timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    request.once('error', (error) => {
      clearTimer();
      reject(error);
    });
    request.end(body);
  });
}

export async function sendJobCallback(
  job: CloudJob,
  timeoutSeconds: number,
  options: CallbackSendOptions = {}
): Promise<CallbackSendResult> {
  if (!job.callbackUrl) return { delivered: false, attempts: 0, error: 'No callback URL configured' };
  const payload = createJobCallbackPayload(job);
  if (!payload) return { delivered: false, attempts: 0, error: `No callback payload for status ${job.status}` };

  let callbackUrl: URL;
  try {
    callbackUrl = validateCallbackUrl(job.callbackUrl, options);
  } catch (error) {
    return {
      delivered: false,
      attempts: 0,
      error: error instanceof Error ? error.message : 'Invalid callback URL',
    };
  }

  const maxAttempts = boundedPositiveInteger(
    options.maxAttempts ?? config.cloud.callbackMaxAttempts,
    config.cloud.callbackMaxAttempts,
    MAX_CALLBACK_ATTEMPTS_CAP
  );
  const baseDelayMs = boundedPositiveInteger(
    options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    DEFAULT_RETRY_BASE_DELAY_MS,
    DEFAULT_RETRY_MAX_DELAY_MS
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    boundedPositiveInteger(
      options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
      DEFAULT_RETRY_MAX_DELAY_MS,
      60_000
    )
  );
  const fetchImpl = options.fetchImpl;
  const requestImpl = options.requestImpl ?? requestPinnedCallback;
  const resolver = options.resolver ?? defaultCallbackResolver;
  const sleepImpl = options.sleep ?? sleep;
  const body = JSON.stringify(payload);
  let signingSecret: string | undefined;
  try {
    signingSecret = job.callbackSigningSecret || resolveCallbackSigningSecret(job.callbackSecretId);
  } catch (error) {
    return {
      delivered: false,
      attempts: 0,
      error: error instanceof Error ? error.message : 'Invalid callback signing secret configuration',
    };
  }
  if (process.env.NODE_ENV === 'production' && job.callbackSecretId && !signingSecret) {
    return {
      delivered: false,
      attempts: 0,
      error: `No callback signing secret configured for secret id ${job.callbackSecretId}`,
    };
  }
  let lastResult: CallbackSendResult = { delivered: false, attempts: 0, error: 'Callback request failed' };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const approvedAddresses = await assertCallbackDestinationIsSafe(callbackUrl, resolver, options);
      const timestamp = new Date().toISOString();
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-optimizer-event': payload.event,
        'x-optimizer-job-id': job.id,
        'x-optimizer-timestamp': timestamp,
        'x-optimizer-attempt': String(attempt),
      };
      if (job.callbackSecretId) {
        headers['x-optimizer-secret-id'] = job.callbackSecretId;
      }
      if (signingSecret) {
        headers['x-optimizer-signature'] = signCallbackPayload(payload, signingSecret, timestamp);
      }

      let statusCode: number;
      if (fetchImpl) {
        const response = await fetchCallbackForTest(
          fetchImpl,
          callbackUrl.toString(),
          headers,
          body,
          timeoutSeconds
        );
        statusCode = response.status;
        await response.body?.cancel().catch(() => undefined);
      } else {
        statusCode = await requestImpl(
          callbackUrl,
          approvedAddresses[0],
          headers,
          body,
          timeoutSeconds
        );
      }
      lastResult = {
        delivered: statusCode >= 200 && statusCode < 300,
        attempts: attempt,
        statusCode,
        error:
          statusCode >= 200 && statusCode < 300
            ? undefined
            : `Callback returned HTTP ${statusCode}`,
      };
      if (lastResult.delivered || !isRetryableStatus(statusCode)) return lastResult;
    } catch (error) {
      lastResult = {
        delivered: false,
        attempts: attempt,
        error: error instanceof Error ? error.message : 'Callback request failed',
      };
      if (error instanceof CallbackUrlValidationError) return lastResult;
    }

    if (attempt < maxAttempts) {
      await sleepImpl(retryDelayMs(attempt, baseDelayMs, maxDelayMs));
    }
  }

  return lastResult;
}
