import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { CosObjectRef } from '../cloud/types';
import { createObjectStorageProvider, type ObjectStorageProvider } from '../cloud/object-storage';
import { createQueueProvider, type QueueProvider } from '../cloud/queue';
import { jobStore, type JobStore } from '../jobs/job-store';
import type { CloudJob } from '../jobs/types';
import { taskRegistry, type TaskRegistry } from '../tasks/registry';
import { sendJobCallback } from '../callbacks/callback-service';
import logger from '../utils/logger';
import type { WorkerHeartbeat, WorkerRuntimeConfig } from './types';

function objectFromJobInput(job: CloudJob): CosObjectRef {
  return {
    bucket: job.inputBucket,
    region: job.inputRegion,
    key: job.inputKey,
    etag: job.inputEtag,
  };
}

function objectFromJobOutput(job: CloudJob): CosObjectRef {
  if (!job.outputBucket || !job.outputRegion || !job.outputKey) {
    throw new Error(`Job is missing output object fields: ${job.id}`);
  }
  return {
    bucket: job.outputBucket,
    region: job.outputRegion,
    key: job.outputKey,
  };
}

function reportObjectFromJob(job: CloudJob): CosObjectRef {
  if (!job.outputBucket || !job.outputRegion || !job.reportKey) {
    throw new Error(`Job is missing report object fields: ${job.id}`);
  }
  return {
    bucket: job.outputBucket,
    region: job.outputRegion,
    key: job.reportKey,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class CloudWorker {
  private running = false;
  private draining = false;
  private busySlots = 0;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(
    private readonly runtime: WorkerRuntimeConfig,
    private readonly queue: QueueProvider = createQueueProvider(),
    private readonly storage: ObjectStorageProvider = createObjectStorageProvider(),
    private readonly store: JobStore = jobStore,
    private readonly registry: TaskRegistry = taskRegistry
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.installSignalHandlers();
    this.startHeartbeat();
    logger.info({ workerId: this.runtime.workerId, concurrency: this.runtime.concurrency }, 'Cloud worker started');

    const loops = Array.from({ length: this.runtime.concurrency }, (_unused, slotIndex) => this.runSlot(slotIndex));
    await Promise.all(loops);
  }

  stop(): void {
    this.draining = true;
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  private async runSlot(slotIndex: number): Promise<void> {
    while (this.running) {
      if (this.draining) {
        await sleep(1000);
        continue;
      }

      const job = await this.queue.claimNext({ workerId: this.runtime.workerId });
      if (!job) {
        await sleep(2000);
        continue;
      }

      this.busySlots++;
      try {
        logger.info({ workerId: this.runtime.workerId, slotIndex, jobId: job.id, taskType: job.taskType }, 'Claimed cloud job');
        await this.processJob(job);
      } catch (error) {
        logger.error({ error, jobId: job.id }, 'Cloud job processing failed');
      } finally {
        this.busySlots--;
      }
    }
  }

  private async processJob(job: CloudJob): Promise<void> {
    const scratchDir = path.join(os.tmpdir(), 'optimizer-worker', this.runtime.workerId, job.id);
    const inputPath = path.join(scratchDir, 'input', path.basename(job.inputKey));
    const outputPath = path.join(scratchDir, 'output', 'model.glb');
    const reportPath = path.join(scratchDir, 'output', 'report.json');

    try {
      await fs.promises.mkdir(path.dirname(inputPath), { recursive: true });
      await this.storage.downloadObject(objectFromJobInput(job), inputPath);
      const report = await this.registry.run(inputPath, outputPath, job.task);

      if (!report.success) {
        throw new Error(report.errorMessage || 'Task handler reported failure');
      }

      await this.storage.uploadObject(outputPath, objectFromJobOutput(job));
      await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2));
      await this.storage.uploadObject(reportPath, reportObjectFromJob(job));

      const completed = await this.store.transition(job.id, 'succeeded', {
        completedAt: new Date().toISOString(),
        errorCode: undefined,
        errorMessage: undefined,
      });
      await this.safeCompleteQueueMessage(completed);
      await this.maybeSendCallback(completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown worker error';
      const shouldRetry = job.attempts < job.maxAttempts;
      const status = shouldRetry ? 'retry_wait' : 'failed';
      const delaySeconds = Math.min(300, 2 ** Math.max(job.attempts, 0) * 10);
      const updated = await this.store.transition(job.id, status, {
        errorCode: 'WORKER_FAILED',
        errorMessage: message,
        queuedAt: shouldRetry ? new Date(Date.now() + delaySeconds * 1000).toISOString() : job.queuedAt,
        completedAt: shouldRetry ? undefined : new Date().toISOString(),
      });
      await this.safeReleaseQueueMessage(updated, shouldRetry ? delaySeconds : undefined);
      if (!shouldRetry) {
        await this.maybeSendCallback(updated);
      }
    } finally {
      await fs.promises.rm(scratchDir, { recursive: true, force: true });
    }
  }

  private async maybeSendCallback(job: CloudJob): Promise<void> {
    if (!job.callbackUrl) return;
    const result = await sendJobCallback(job, config.cloud.callbackTimeoutSeconds);
    logger.info({ jobId: job.id, callback: result }, 'Callback delivery attempted');
  }

  private async safeCompleteQueueMessage(job: CloudJob): Promise<void> {
    try {
      await this.queue.complete(job);
    } catch (error) {
      logger.error({ error, jobId: job.id }, 'Failed to acknowledge queue message');
    }
  }

  private async safeReleaseQueueMessage(job: CloudJob, delaySeconds?: number): Promise<void> {
    try {
      await this.queue.release(job, delaySeconds ? { delaySeconds } : undefined);
    } catch (error) {
      logger.error({ error, jobId: job.id }, 'Failed to release queue message');
    }
  }

  private startHeartbeat(): void {
    this.writeHeartbeat().catch((error: unknown) => logger.warn({ error }, 'Worker heartbeat failed'));
    this.heartbeatTimer = setInterval(() => {
      this.writeHeartbeat().catch((error: unknown) => logger.warn({ error }, 'Worker heartbeat failed'));
    }, this.runtime.heartbeatIntervalMs);
  }

  private async writeHeartbeat(): Promise<void> {
    const heartbeat: WorkerHeartbeat = {
      workerId: this.runtime.workerId,
      instanceId: this.runtime.instanceId,
      status: this.draining ? 'draining' : 'active',
      slotsTotal: this.runtime.concurrency,
      slotsBusy: this.busySlots,
      draining: this.draining,
      timestamp: new Date().toISOString(),
    };
    const filePath = path.join('data/cloud/workers', `${this.runtime.workerId}.json`);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(heartbeat, null, 2));
  }

  private installSignalHandlers(): void {
    process.once('SIGTERM', () => {
      logger.info({ workerId: this.runtime.workerId }, 'Worker received SIGTERM, entering drain mode');
      this.stop();
    });
    process.once('SIGINT', () => {
      logger.info({ workerId: this.runtime.workerId }, 'Worker received SIGINT, entering drain mode');
      this.stop();
    });
  }
}

export function createWorkerRuntimeConfig(): WorkerRuntimeConfig {
  const workerId = process.env.WORKER_ID || `worker-${uuidv4()}`;
  return {
    workerId,
    instanceId: process.env.INSTANCE_ID || os.hostname(),
    concurrency: config.cloud.workerConcurrency,
    heartbeatIntervalMs: config.cloud.workerHeartbeatIntervalMs,
    jobTimeoutMs: config.cloud.jobTimeoutSeconds * 1000,
  };
}
