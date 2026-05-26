import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { LocalJobStore } from '../../src/jobs/job-store';
import { LocalQueueProvider } from '../../src/cloud/queue';
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
