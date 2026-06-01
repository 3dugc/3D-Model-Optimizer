import crypto from 'crypto';
import type { CallbackPayload } from './types';
import type { CloudJob } from '../jobs/types';

export interface CallbackSendResult {
  delivered: boolean;
  statusCode?: number;
  error?: string;
}

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

export async function sendJobCallback(job: CloudJob, timeoutSeconds: number): Promise<CallbackSendResult> {
  if (!job.callbackUrl) return { delivered: false, error: 'No callback URL configured' };
  const payload = createJobCallbackPayload(job);
  if (!payload) return { delivered: false, error: `No callback payload for status ${job.status}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  const timestamp = new Date().toISOString();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-optimizer-event': payload.event,
    'x-optimizer-job-id': job.id,
    'x-optimizer-timestamp': timestamp,
  };
  if (job.callbackSecretId) {
    headers['x-optimizer-secret-id'] = job.callbackSecretId;
  }
  if (job.callbackSigningSecret) {
    headers['x-optimizer-signature'] = signCallbackPayload(payload, job.callbackSigningSecret, timestamp);
  }

  try {
    const response = await fetch(job.callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return {
      delivered: response.ok,
      statusCode: response.status,
      error: response.ok ? undefined : `Callback returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      delivered: false,
      error: error instanceof Error ? error.message : 'Callback request failed',
    };
  } finally {
    clearTimeout(timer);
  }
}
