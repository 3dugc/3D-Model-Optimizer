import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { CosObjectRef, QueueJobMessage } from '../cloud/types';
import { createQueueProvider, type QueueProvider } from '../cloud/queue';
import { taskRegistry } from '../tasks/registry';
import type { HeavyTaskDescriptor } from '../tasks/types';
import type { CreateCloudJobInput, CloudJob } from './types';
import { jobStore, type JobStore } from './job-store';

function nowIso(): string {
  return new Date().toISOString();
}

function buildInputObject(jobId: string, tenantId: string, filename: string): CosObjectRef {
  const safeFilename = filename.replace(/[^\w.\-()+\u4e00-\u9fa5]/g, '_') || 'input.glb';
  return {
    bucket: config.cloud.inputBucket,
    region: config.cloud.region,
    key: `tenants/${tenantId}/jobs/${jobId}/input/${safeFilename}`,
  };
}

function buildOutputObject(jobId: string, tenantId: string): CosObjectRef {
  return {
    bucket: config.cloud.outputBucket,
    region: config.cloud.region,
    key: `tenants/${tenantId}/jobs/${jobId}/output/model.glb`,
  };
}

function buildReportObject(jobId: string, tenantId: string): CosObjectRef {
  return {
    bucket: config.cloud.outputBucket,
    region: config.cloud.region,
    key: `tenants/${tenantId}/jobs/${jobId}/output/report.json`,
  };
}

function buildDefaultTask(input: CreateCloudJobInput): HeavyTaskDescriptor {
  const type = input.taskType || config.cloud.defaultTaskType;
  return {
    type,
    version: '1.0',
    payload: {
      filename: input.filename,
      preset: input.preset,
      options: input.options || {},
    },
    resourceClass: type === 'model.optimize' ? 'cpu-medium' : 'cpu-large',
    estimatedTimeoutSeconds: config.cloud.jobTimeoutSeconds,
  };
}

export class CloudJobService {
  constructor(
    private readonly store: JobStore = jobStore,
    private readonly queue: QueueProvider = createQueueProvider()
  ) {}

  async createJob(input: CreateCloudJobInput): Promise<CloudJob> {
    if (!input.tenantId) {
      throw new Error('tenantId is required');
    }

    if (input.idempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(input.tenantId, input.idempotencyKey);
      if (existing) return existing;
    }

    const id = uuidv4();
    const filename = input.filename || 'input.glb';
    const inputObject = input.input || buildInputObject(id, input.tenantId, filename);
    const outputObject = buildOutputObject(id, input.tenantId);
    const reportObject = buildReportObject(id, input.tenantId);
    const task = input.task || buildDefaultTask({ ...input, filename });
    if (!taskRegistry.has(task.type)) {
      throw new Error(`Unsupported taskType: ${task.type}`);
    }

    const paymentRequired = input.paymentRequired ?? false;
    const createdAt = nowIso();
    const job: CloudJob = {
      id,
      tenantId: input.tenantId,
      externalJobId: input.externalJobId,
      idempotencyKey: input.idempotencyKey,
      taskType: task.type,
      task,
      status: input.input ? (paymentRequired ? 'waiting_payment' : 'queued') : 'waiting_upload',
      preset: input.preset,
      options: input.options || {},
      inputBucket: inputObject.bucket,
      inputRegion: inputObject.region,
      inputKey: inputObject.key,
      inputEtag: inputObject.etag,
      outputBucket: outputObject.bucket,
      outputRegion: outputObject.region,
      outputKey: outputObject.key,
      reportKey: reportObject.key,
      callbackUrl: input.callbackUrl,
      callbackSecretId: input.callbackSecretId,
      callbackSigningSecret: input.callbackSigningSecret,
      paymentRequired,
      attempts: 0,
      maxAttempts: config.cloud.jobMaxAttempts,
      createdAt,
      uploadedAt: input.input ? createdAt : undefined,
      queuedAt: input.input && !paymentRequired ? createdAt : undefined,
    };

    const created = await this.store.create(job);
    if (created.status === 'queued') {
      await this.publish(created);
    }
    return this.store.get(created.id) as Promise<CloudJob>;
  }

  async getJob(jobId: string): Promise<CloudJob | undefined> {
    return this.store.get(jobId);
  }

  async completeUpload(jobId: string, input?: CosObjectRef): Promise<CloudJob> {
    const job = await this.requireJob(jobId);
    const updates: Partial<CloudJob> = {
      uploadedAt: nowIso(),
      inputBucket: input?.bucket || job.inputBucket,
      inputRegion: input?.region || job.inputRegion,
      inputKey: input?.key || job.inputKey,
      inputEtag: input?.etag || job.inputEtag,
    };

    if (job.paymentRequired) {
      return this.store.transition(jobId, 'waiting_payment', updates);
    }

    const updated = await this.store.transition(jobId, 'queued', {
      ...updates,
      queuedAt: nowIso(),
    });
    await this.publish(updated);
    return updated;
  }

  async markPaid(jobId: string, orderId: string): Promise<CloudJob> {
    const job = await this.requireJob(jobId);
    if (!job.uploadedAt) {
      return this.store.update(jobId, { orderId });
    }
    const updated = await this.store.transition(jobId, 'queued', {
      orderId,
      queuedAt: nowIso(),
    });
    await this.publish(updated);
    return updated;
  }

  async attachOrder(jobId: string, orderId: string): Promise<CloudJob> {
    await this.requireJob(jobId);
    return this.store.update(jobId, { orderId, paymentRequired: true });
  }

  async cancelJob(jobId: string): Promise<CloudJob> {
    return this.store.transition(jobId, 'cancelled', { completedAt: nowIso() });
  }

  private async publish(job: CloudJob): Promise<void> {
    const message: QueueJobMessage = {
      jobId: job.id,
      tenantId: job.tenantId,
      taskType: job.taskType,
      attempt: job.attempts,
      traceId: job.externalJobId,
    };
    await this.queue.publish(message);
  }

  private async requireJob(jobId: string): Promise<CloudJob> {
    const job = await this.store.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return job;
  }
}

export const cloudJobService = new CloudJobService();
