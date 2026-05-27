import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { LocalJobStore } from '../../src/jobs/job-store';
import { LocalQueueProvider, TencentCmqQueueProvider } from '../../src/cloud/queue';
import { TencentCmqClient, cmqInternals } from '../../src/cloud/tencent-cmq-client';
import { signCallbackPayload } from '../../src/callbacks/callback-service';
import type { CloudJob } from '../../src/jobs/types';

function makeJob(id: string): CloudJob {
  const now = new Date().toISOString();
  return {
    id,
    tenantId: 'tenant-a',
    taskType: 'model.optimize',
    task: {
      type: 'model.optimize',
      version: '1.0',
      payload: { filename: 'input.glb' },
      resourceClass: 'cpu-medium',
    },
    status: 'waiting_upload',
    options: {},
    inputBucket: 'input',
    inputRegion: 'ap-nanjing',
    inputKey: `jobs/${id}/input.glb`,
    outputBucket: 'output',
    outputRegion: 'ap-nanjing',
    outputKey: `jobs/${id}/model.glb`,
    reportKey: `jobs/${id}/report.json`,
    paymentRequired: false,
    attempts: 0,
    maxAttempts: 3,
    createdAt: now,
  };
}

async function createTempFilePath(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-test-'));
  return path.join(dir, name);
}

describe('cloud runtime primitives', () => {
  it('claims queued jobs exactly once in local queue', async () => {
    const store = new LocalJobStore(await createTempFilePath('jobs.json'));
    const queue = new LocalQueueProvider(store);
    await store.create(makeJob('job-1'));

    await queue.publish({ jobId: 'job-1', tenantId: 'tenant-a', taskType: 'model.optimize', attempt: 0 });
    const claimed = await queue.claimNext({ workerId: 'worker-a' });
    const secondClaim = await queue.claimNext({ workerId: 'worker-b' });

    expect(claimed?.id).toBe('job-1');
    expect(claimed?.status).toBe('processing');
    expect(claimed?.workerId).toBe('worker-a');
    expect(claimed?.attempts).toBe(1);
    expect(secondClaim).toBeUndefined();
  });

  it('renews and recovers expired processing job leases', async () => {
    const store = new LocalJobStore(await createTempFilePath('jobs.json'));
    await store.create({ ...makeJob('job-lease'), status: 'queued' });

    const firstClaimAt = new Date('2026-05-27T00:00:00.000Z');
    const claimed = await store.claim('job-lease', {
      workerId: 'worker-a',
      now: firstClaimAt,
      leaseDurationMs: 1000,
    });

    expect(claimed?.status).toBe('processing');
    expect(claimed?.leaseExpiresAt).toBe('2026-05-27T00:00:01.000Z');

    const renewed = await store.renewLease('job-lease', {
      workerId: 'worker-a',
      now: new Date('2026-05-27T00:00:05.000Z'),
      leaseDurationMs: 1000,
    });

    expect(renewed?.leaseExpiresAt).toBe('2026-05-27T00:00:06.000Z');
    await expect(
      store.recoverExpiredLeases({ now: new Date('2026-05-27T00:00:05.500Z') })
    ).resolves.toHaveLength(0);

    const recovered = await store.recoverExpiredLeases({
      now: new Date('2026-05-27T00:00:06.500Z'),
      reason: 'test lease expired',
    });

    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('retry_wait');
    expect(recovered[0].workerId).toBeUndefined();
    expect(recovered[0].errorCode).toBe('WORKER_LEASE_EXPIRED');

    const reclaimed = await store.claim('job-lease', {
      workerId: 'worker-b',
      now: new Date('2026-05-27T00:00:07.000Z'),
      leaseDurationMs: 1000,
    });

    expect(reclaimed?.status).toBe('processing');
    expect(reclaimed?.workerId).toBe('worker-b');
    expect(reclaimed?.attempts).toBe(2);
  });

  it('claims a specific job by queue message id', async () => {
    const store = new LocalJobStore(await createTempFilePath('jobs.json'));
    await store.create({ ...makeJob('job-a'), status: 'queued' });
    await store.create({ ...makeJob('job-b'), status: 'queued' });

    const claimed = await store.claim('job-b', { workerId: 'worker-b' });

    expect(claimed?.id).toBe('job-b');
    expect(claimed?.workerId).toBe('worker-b');
    expect((await store.get('job-a'))?.status).toBe('queued');
  });

  it('builds deterministic CMQ signatures and parses empty receives', async () => {
    const endpoint = cmqInternals.normalizeEndpoint('https://cmq-nj.public.tencenttdmq.com');
    const signatureParams = {
      Action: 'SendMessage',
      Nonce: '123',
      SecretId: 'secret-id',
      SignatureMethod: 'HmacSHA1',
      Timestamp: '1700000000',
      queueName: 'optimizer-jobs',
      msgBody: JSON.stringify({ jobId: 'job-1', note: 'hello world' }),
    };
    const signature = cmqInternals.createSignature(
      'GET',
      endpoint,
      signatureParams,
      'secret-key'
    );
    const sameSignature = cmqInternals.createSignature(
      'GET',
      endpoint,
      signatureParams,
      'secret-key'
    );
    const signatureSource = cmqInternals.createSignatureSource('GET', endpoint, signatureParams);

    const client = new TencentCmqClient({
      endpoint: 'https://cmq-nj.public.tencenttdmq.com',
      queueName: 'optimizer-jobs',
      secretId: 'secret-id',
      secretKey: 'secret-key',
      fetchImpl: async () =>
        ({
          json: async () => ({ code: 7000, message: 'no message' }),
        }) as Response,
    });

    expect(endpoint.pathname).toBe('/v2/index.php');
    expect(signatureSource).toContain('msgBody={"jobId":"job-1","note":"hello world"}');
    expect(signatureSource).not.toContain('%7B');
    expect(signature).toBe(sameSignature);
    expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    await expect(client.receiveMessage()).resolves.toBeUndefined();
  });

  it('defers CMQ watchdog messages while a processing lease is still active', async () => {
    const store = new LocalJobStore(await createTempFilePath('jobs.json'));
    await store.create({
      ...makeJob('job-cmq-active'),
      status: 'processing',
      workerId: 'worker-a',
      attempts: 1,
      startedAt: '2026-05-27T00:00:00.000Z',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const deletedReceipts: string[] = [];
    const sentMessages: Array<{ msgBody: string | null; delaySeconds: string | null }> = [];
    const client = new TencentCmqClient({
      endpoint: 'https://cmq-nj.public.tencenttdmq.com',
      queueName: 'optimizer-jobs',
      secretId: 'secret-id',
      secretKey: 'secret-key',
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        const action = url.searchParams.get('Action');
        if (action === 'ReceiveMessage') {
          return {
            json: async () => ({
              code: 0,
              msgBody: JSON.stringify({
                jobId: 'job-cmq-active',
                tenantId: 'tenant-a',
                taskType: 'model.optimize',
                attempt: 1,
              }),
              receiptHandle: 'receipt-active',
              msgId: 'msg-active',
            }),
          } as Response;
        }
        if (action === 'DeleteMessage') {
          deletedReceipts.push(url.searchParams.get('receiptHandle') || '');
          return { json: async () => ({ code: 0 }) } as Response;
        }
        if (action === 'SendMessage') {
          sentMessages.push({
            msgBody: url.searchParams.get('msgBody'),
            delaySeconds: url.searchParams.get('delaySeconds'),
          });
          return { json: async () => ({ code: 0 }) } as Response;
        }
        throw new Error(`Unexpected CMQ action: ${action}`);
      },
    });
    const queue = new TencentCmqQueueProvider(store, client);

    const claimed = await queue.claimNext({ workerId: 'worker-b' });

    expect(claimed).toBeUndefined();
    expect(deletedReceipts).toEqual(['receipt-active']);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].msgBody).toContain('job-cmq-active');
    expect(Number(sentMessages[0].delaySeconds)).toBeGreaterThan(0);
  });

  it('blocks invalid terminal job transitions', async () => {
    const store = new LocalJobStore(await createTempFilePath('jobs.json'));
    await store.create({ ...makeJob('job-2'), status: 'failed', completedAt: new Date().toISOString() });

    await expect(store.transition('job-2', 'queued')).rejects.toThrow('Invalid job status transition');
  });

  it('signs callback payloads deterministically', () => {
    const payload = {
      event: 'job.succeeded' as const,
      jobId: 'job-3',
      status: 'succeeded',
      result: { outputKey: 'jobs/job-3/model.glb' },
    };
    const timestamp = '2026-05-26T00:00:00.000Z';

    expect(signCallbackPayload(payload, 'secret-a', timestamp)).toBe(
      signCallbackPayload(payload, 'secret-a', timestamp)
    );
    expect(signCallbackPayload(payload, 'secret-a', timestamp)).not.toBe(
      signCallbackPayload(payload, 'secret-b', timestamp)
    );
  });
});
