import { afterEach, describe, expect, it } from 'vitest';
import { LocalObjectStorageProvider } from '../../src/cloud/object-storage';
import type { QueueJobMessage } from '../../src/cloud/types';
import type { PublishOptions, QueueProvider } from '../../src/cloud/queue';
import { CloudJobService } from '../../src/jobs/job-service';
import { LocalJobStore } from '../../src/jobs/job-store';
import type { CloudJob } from '../../src/jobs/types';
import { parseCosJobManifest } from '../../src/jobs/cos-manifest';
import {
  authenticateApiKey,
  canAccessTaskType,
  canAccessTenant,
  hasScope,
  parseApiKeyDefinitions,
} from '../../src/middleware/auth';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

class RecordingQueue implements QueueProvider {
  readonly providerName = 'local' as const;
  readonly messages: QueueJobMessage[] = [];

  async publish(message: QueueJobMessage, _options?: PublishOptions): Promise<void> {
    this.messages.push(message);
  }

  async claimNext(): Promise<CloudJob | undefined> {
    return undefined;
  }

  async complete(): Promise<void> {
    return undefined;
  }

  async release(): Promise<void> {
    return undefined;
  }
}

async function tempFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-external-api-'));
  return path.join(dir, name);
}

describe('external async API primitives', () => {
  const originalApiKey = process.env.API_KEY;
  const originalApiKeys = process.env.API_KEYS;

  afterEach(() => {
    process.env.API_KEY = originalApiKey;
    process.env.API_KEYS = originalApiKeys;
  });

  it('authenticates scoped API keys and enforces tenant/task scopes', () => {
    process.env.API_KEY = '';
    process.env.API_KEYS = JSON.stringify([
      {
        name: 'partner-a',
        key: 'partner-secret',
        scopes: ['jobs:create', 'jobs:read'],
        tenantId: 'tenant-a',
        taskTypes: ['model.optimize'],
      },
    ]);

    expect(parseApiKeyDefinitions()).toHaveLength(1);
    const principal = authenticateApiKey('partner-secret');

    expect(principal?.name).toBe('partner-a');
    expect(hasScope(principal, 'jobs:create')).toBe(true);
    expect(hasScope(principal, 'jobs:cancel')).toBe(false);
    expect(canAccessTenant(principal, 'tenant-a')).toBe(true);
    expect(canAccessTenant(principal, 'tenant-b')).toBe(false);
    expect(canAccessTaskType(principal, 'model.optimize')).toBe(true);
    expect(canAccessTaskType(principal, 'video.transcode')).toBe(false);
  });

  it('parses COS-only manifests and rejects objects outside the tenant prefix', () => {
    const manifestObject = {
      bucket: 'model-optimizer-1251022382',
      region: 'ap-nanjing',
      key: 'tenants/tenant-a/incoming/manifest.json',
    };
    const input = parseCosJobManifest(
      JSON.stringify({
        tenantId: 'tenant-a',
        taskType: 'model.optimize',
        input: 'tenants/tenant-a/incoming/source.glb',
        callbackUrl: 'https://example.com/callback',
        idempotencyKey: 'external-1',
      }),
      manifestObject
    );

    expect(input).toMatchObject({
      tenantId: 'tenant-a',
      taskType: 'model.optimize',
      idempotencyKey: 'external-1',
      input: {
        bucket: 'model-optimizer-1251022382',
        region: 'ap-nanjing',
        key: 'tenants/tenant-a/incoming/source.glb',
      },
    });

    expect(() =>
      parseCosJobManifest(
        JSON.stringify({ tenantId: 'tenant-a', input: 'tenants/tenant-b/source.glb' }),
        manifestObject
      )
    ).toThrow('COS object must be under tenants/tenant-a/');
  });

  it('returns a local upload grant scoped to the object prefix', async () => {
    const storage = new LocalObjectStorageProvider();
    const object = {
      bucket: 'model-optimizer-1251022382',
      region: 'ap-nanjing',
      key: 'tenants/tenant-a/jobs/job-a/input/source.glb',
    };

    const grant = await storage.createUploadGrant(object, 60);

    expect(grant).toMatchObject({
      provider: 'local',
      method: 'PUT',
      object,
      allowedPrefix: 'tenants/tenant-a/jobs/job-a/input/',
    });
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('deduplicates repeated external COS events via idempotency key', async () => {
    const store = new LocalJobStore(await tempFile('jobs.json'));
    const queue = new RecordingQueue();
    const service = new CloudJobService(store, queue);
    const input = {
      tenantId: 'tenant-a',
      taskType: 'model.optimize',
      filename: 'source.glb',
      input: {
        bucket: 'model-optimizer-1251022382',
        region: 'ap-nanjing',
        key: 'tenants/tenant-a/incoming/source.glb',
      },
      idempotencyKey: 'cos-event-1',
    };

    const first = await service.createJob(input);
    const second = await service.createJob(input);

    expect(second.id).toBe(first.id);
    expect(queue.messages).toHaveLength(1);
  });

  it('publishes once when complete-upload moves a job from waiting_upload to queued', async () => {
    const store = new LocalJobStore(await tempFile('jobs.json'));
    const queue = new RecordingQueue();
    const service = new CloudJobService(store, queue);

    const created = await service.createJob({
      tenantId: 'tenant-a',
      taskType: 'model.optimize',
      filename: 'source.glb',
    });

    const queued = await service.completeUpload(created.id);
    const duplicate = await service.completeUpload(created.id);

    expect(queued.status).toBe('queued');
    expect(duplicate.status).toBe('queued');
    expect(queue.messages).toHaveLength(1);
  });

  it('rejects unregistered task types before queueing', async () => {
    const store = new LocalJobStore(await tempFile('jobs.json'));
    const queue = new RecordingQueue();
    const service = new CloudJobService(store, queue);

    await expect(
      service.createJob({
        tenantId: 'tenant-a',
        taskType: 'video.transcode',
        input: {
          bucket: 'model-optimizer-1251022382',
          region: 'ap-nanjing',
          key: 'tenants/tenant-a/incoming/source.mp4',
        },
      })
    ).rejects.toThrow('Unsupported taskType: video.transcode');
    expect(queue.messages).toHaveLength(0);
  });
});
