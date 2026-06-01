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
import { accountService } from '../accounts/account-service';
import logger from '../utils/logger';
import type { WorkerHeartbeat, WorkerRuntimeConfig } from './types';
import { createWorkerHeartbeatStore, type WorkerHeartbeatStore } from './worker-store';

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
  private lastActivityAt = Date.now();
  private heartbeatTimer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private spotInterruptionTimer?: NodeJS.Timeout;
  private readonly leaseRenewalTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly runtime: WorkerRuntimeConfig,
    private readonly queue: QueueProvider = createQueueProvider(),
    private readonly storage: ObjectStorageProvider = createObjectStorageProvider(),
    private readonly store: JobStore = jobStore,
    private readonly registry: TaskRegistry = taskRegistry,
    private readonly heartbeatStore: WorkerHeartbeatStore = createWorkerHeartbeatStore()
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.installSignalHandlers();
    this.startHeartbeat();
    this.startExpiredLeaseRecovery();
    this.startSpotInterruptionMonitor();
    logger.info({ workerId: this.runtime.workerId, concurrency: this.runtime.concurrency }, 'Cloud worker started');

    const loops = Array.from({ length: this.runtime.concurrency }, (_unused, slotIndex) => this.runSlot(slotIndex));
    await Promise.all(loops);
  }

  stop(): void {
    this.draining = true;
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    if (this.spotInterruptionTimer) clearInterval(this.spotInterruptionTimer);
    for (const timer of this.leaseRenewalTimers.values()) clearInterval(timer);
    this.leaseRenewalTimers.clear();
  }

  private async runSlot(slotIndex: number): Promise<void> {
    while (this.running) {
      if (this.draining) {
        if (this.busySlots === 0) {
          this.stop();
          break;
        }
        await sleep(1000);
        continue;
      }

      const job = await this.queue.claimNext({
        workerId: this.runtime.workerId,
        leaseDurationMs: this.runtime.jobLeaseMs,
      });
      if (!job) {
        if (this.shouldExitAfterIdle()) {
          logger.info(
            { workerId: this.runtime.workerId, idleExitMs: this.runtime.idleExitMs },
            'Worker idle timeout reached, stopping'
          );
          this.stop();
          break;
        }
        await sleep(this.nextIdlePollMs());
        continue;
      }

      this.lastActivityAt = Date.now();
      this.busySlots++;
      try {
        logger.info({ workerId: this.runtime.workerId, slotIndex, jobId: job.id, taskType: job.taskType }, 'Claimed cloud job');
        await this.processJob(job);
      } catch (error) {
        logger.error({ error, jobId: job.id }, 'Cloud job processing failed');
      } finally {
        this.busySlots--;
        this.lastActivityAt = Date.now();
        if (this.draining && this.busySlots === 0) {
          this.stop();
        }
      }
    }
  }

  private shouldExitAfterIdle(): boolean {
    if (!this.runtime.idleExitMs || this.busySlots > 0) return false;
    return Date.now() - this.lastActivityAt >= this.runtime.idleExitMs;
  }

  private nextIdlePollMs(): number {
    if (!this.runtime.idleExitMs) return 2000;
    const remaining = this.runtime.idleExitMs - (Date.now() - this.lastActivityAt);
    return Math.max(100, Math.min(2000, remaining));
  }

  private async processJob(job: CloudJob): Promise<void> {
    const scratchDir = path.join(os.tmpdir(), 'optimizer-worker', this.runtime.workerId, job.id);
    const inputPath = path.join(scratchDir, 'input', path.basename(job.inputKey));
    const outputPath = path.join(scratchDir, 'output', 'model.glb');
    const reportPath = path.join(scratchDir, 'output', 'report.json');

    try {
      this.startJobLeaseRenewal(job.id);
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
        leaseExpiresAt: undefined,
        lastHeartbeatAt: undefined,
        errorCode: undefined,
        errorMessage: undefined,
      });
      await this.settleWalletCharge(completed.id);
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
        workerId: shouldRetry ? undefined : job.workerId,
        leaseExpiresAt: undefined,
        lastHeartbeatAt: undefined,
        queuedAt: shouldRetry ? new Date(Date.now() + delaySeconds * 1000).toISOString() : job.queuedAt,
        completedAt: shouldRetry ? undefined : new Date().toISOString(),
      });
      await this.safeReleaseQueueMessage(updated, shouldRetry ? delaySeconds : undefined);
      if (!shouldRetry) {
        await this.releaseWalletCharge(updated.id, 'Job failed after all worker attempts; releasing held balance.');
        await this.maybeSendCallback(updated);
      }
    } finally {
      this.stopJobLeaseRenewal(job.id);
      await fs.promises.rm(scratchDir, { recursive: true, force: true });
    }
  }

  private async maybeSendCallback(job: CloudJob): Promise<void> {
    if (!job.callbackUrl) return;
    const result = await sendJobCallback(job, config.cloud.callbackTimeoutSeconds);
    logger.info({ jobId: job.id, callback: result }, 'Callback delivery attempted');
  }

  private async settleWalletCharge(jobId: string): Promise<void> {
    try {
      await accountService.settleJobCharge(jobId);
    } catch (error) {
      logger.error({ error, jobId }, 'Failed to settle wallet charge for completed job');
    }
  }

  private async releaseWalletCharge(jobId: string, note: string): Promise<void> {
    try {
      await accountService.releaseJobCharge(jobId, note);
    } catch (error) {
      logger.error({ error, jobId }, 'Failed to release wallet charge for failed job');
    }
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

  private startExpiredLeaseRecovery(): void {
    if (!this.runtime.expiredJobRecoveryIntervalMs) return;
    this.recoverExpiredLeases().catch((error: unknown) => logger.warn({ error }, 'Expired job lease recovery failed'));
    this.recoveryTimer = setInterval(() => {
      this.recoverExpiredLeases().catch((error: unknown) => logger.warn({ error }, 'Expired job lease recovery failed'));
    }, this.runtime.expiredJobRecoveryIntervalMs);
  }

  private async recoverExpiredLeases(): Promise<void> {
    const recovered = await this.store.recoverExpiredLeases({
      limit: Math.max(10, this.runtime.concurrency * 4),
      reason: 'Worker lease expired before the job completed; requeueing for another attempt.',
    });
    for (const job of recovered) {
      if (job.status === 'retry_wait') {
        await this.queue.publish({
          jobId: job.id,
          tenantId: job.tenantId,
          taskType: job.taskType,
          attempt: job.attempts,
          traceId: job.externalJobId,
        });
        logger.warn({ jobId: job.id, attempts: job.attempts }, 'Recovered expired processing job lease');
      } else if (job.status === 'failed') {
        await this.releaseWalletCharge(job.id, 'Worker lease expired after all attempts; releasing held balance.');
        await this.maybeSendCallback(job);
        logger.error({ jobId: job.id, attempts: job.attempts }, 'Expired processing job lease exceeded max attempts');
      }
    }
  }

  private startJobLeaseRenewal(jobId: string): void {
    this.stopJobLeaseRenewal(jobId);
    const intervalMs = Math.max(5000, Math.min(this.runtime.heartbeatIntervalMs, Math.floor(this.runtime.jobLeaseMs / 3)));
    const renew = async () => {
      const renewed = await this.store.renewLease(jobId, {
        workerId: this.runtime.workerId,
        leaseDurationMs: this.runtime.jobLeaseMs,
      });
      if (!renewed) {
        logger.warn({ jobId, workerId: this.runtime.workerId }, 'Job lease renewal skipped because worker no longer owns job');
      }
    };
    this.leaseRenewalTimers.set(
      jobId,
      setInterval(() => {
        renew().catch((error: unknown) => logger.warn({ error, jobId }, 'Job lease renewal failed'));
      }, intervalMs)
    );
  }

  private stopJobLeaseRenewal(jobId: string): void {
    const timer = this.leaseRenewalTimers.get(jobId);
    if (!timer) return;
    clearInterval(timer);
    this.leaseRenewalTimers.delete(jobId);
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
    await this.heartbeatStore.writeHeartbeat(heartbeat);
  }

  private installSignalHandlers(): void {
    process.once('SIGTERM', () => {
      logger.info({ workerId: this.runtime.workerId }, 'Worker received SIGTERM, entering drain mode');
      this.requestDrain('sigterm');
    });
    process.once('SIGINT', () => {
      logger.info({ workerId: this.runtime.workerId }, 'Worker received SIGINT, entering drain mode');
      this.requestDrain('sigint');
    });
  }

  private requestDrain(reason: string): void {
    if (this.draining) return;
    this.draining = true;
    logger.warn({ workerId: this.runtime.workerId, reason, busySlots: this.busySlots }, 'Worker entering drain mode');
    if (this.busySlots === 0) {
      this.stop();
    }
  }

  private startSpotInterruptionMonitor(): void {
    if (!this.runtime.spotTerminationCheckUrl || !this.runtime.spotTerminationPollMs) return;
    this.spotInterruptionTimer = setInterval(() => {
      this.checkSpotInterruption().catch((error: unknown) =>
        logger.debug({ error }, 'Spot interruption check failed')
      );
    }, this.runtime.spotTerminationPollMs);
  }

  private async checkSpotInterruption(): Promise<void> {
    if (!this.runtime.spotTerminationCheckUrl) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(this.runtime.spotTerminationCheckUrl, { signal: controller.signal });
      if (response.status === 404) return;
      if (!response.ok) return;
      const terminationTime = (await response.text()).trim();
      if (!terminationTime) return;
      this.requestDrain(`spot-termination:${terminationTime}`);
    } finally {
      clearTimeout(timeout);
    }
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
    jobLeaseMs: config.cloud.jobLeaseSeconds * 1000,
    expiredJobRecoveryIntervalMs: config.cloud.expiredJobRecoveryIntervalSeconds * 1000,
    idleExitMs: config.cloud.workerIdleExitSeconds > 0 ? config.cloud.workerIdleExitSeconds * 1000 : undefined,
    spotTerminationCheckUrl: config.cloud.workerSpotTerminationCheckUrl,
    spotTerminationPollMs: config.cloud.workerSpotTerminationPollMs,
  };
}
