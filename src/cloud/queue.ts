import type { QueueJobMessage } from './types';
import { TencentCmqClient } from './tencent-cmq-client';
import { config } from '../config';
import type { ClaimJobInput, CloudJob } from '../jobs/types';
import { jobStore, type JobStore } from '../jobs/job-store';
import { isTerminalJobStatus } from '../jobs/state-machine';

export interface PublishOptions {
  delaySeconds?: number;
}

export interface QueueProvider {
  providerName: 'local' | 'tdmq-cmq';
  publish(message: QueueJobMessage, options?: PublishOptions): Promise<void>;
  claimNext(input: ClaimJobInput): Promise<CloudJob | undefined>;
  complete(job: CloudJob): Promise<void>;
  release(job: CloudJob, options?: PublishOptions): Promise<void>;
}

export class LocalQueueProvider implements QueueProvider {
  readonly providerName = 'local' as const;

  constructor(private readonly store: JobStore = jobStore) {}

  async publish(message: QueueJobMessage, options: PublishOptions = {}): Promise<void> {
    const job = await this.store.get(message.jobId);
    if (!job) {
      throw new Error(`Cannot publish unknown job: ${message.jobId}`);
    }
    if (options.delaySeconds && options.delaySeconds > 0) {
      await this.store.transition(message.jobId, 'retry_wait', {
        queuedAt: new Date(Date.now() + options.delaySeconds * 1000).toISOString(),
      });
      return;
    }
    if (job.status === 'queued') return;
    await this.store.transition(message.jobId, 'queued', {
      queuedAt: new Date().toISOString(),
    });
  }

  async claimNext(input: ClaimJobInput): Promise<CloudJob | undefined> {
    return this.store.claimNext(input);
  }

  async complete(_job: CloudJob): Promise<void> {
    return Promise.resolve();
  }

  async release(_job: CloudJob, _options: PublishOptions = {}): Promise<void> {
    return Promise.resolve();
  }
}

export class TencentCmqQueueProvider implements QueueProvider {
  readonly providerName = 'tdmq-cmq' as const;
  private readonly receipts = new Map<string, string>();

  constructor(
    private readonly store: JobStore = jobStore,
    private readonly client: TencentCmqClient = createTencentCmqClient()
  ) {}

  async publish(message: QueueJobMessage, options: PublishOptions = {}): Promise<void> {
    await this.client.sendMessage(message, options.delaySeconds);
  }

  async claimNext(input: ClaimJobInput): Promise<CloudJob | undefined> {
    const received = await this.client.receiveMessage();
    if (!received) return undefined;

    const existing = await this.store.get(received.body.jobId);
    if (!existing) {
      await this.client.deleteMessage(received.receiptHandle);
      return undefined;
    }
    const job = await this.store.claim(received.body.jobId, input);
    if (!job) {
      const latest = (await this.store.get(received.body.jobId)) || existing;
      if (isTerminalJobStatus(latest.status)) {
        await this.client.deleteMessage(received.receiptHandle);
      } else if (latest.status === 'processing') {
        await this.deferWatchdogMessage(received.receiptHandle, latest);
      } else if (latest.status === 'retry_wait') {
        await this.deferWatchdogMessage(received.receiptHandle, latest);
      } else {
        await this.client.deleteMessage(received.receiptHandle);
      }
      return undefined;
    }
    this.receipts.set(job.id, received.receiptHandle);
    return job;
  }

  async complete(job: CloudJob): Promise<void> {
    await this.deleteReceipt(job.id);
  }

  async release(job: CloudJob, options: PublishOptions = {}): Promise<void> {
    await this.deleteReceipt(job.id);
    if (job.status === 'retry_wait') {
      await this.publish(
        {
          jobId: job.id,
          tenantId: job.tenantId,
          taskType: job.taskType,
          attempt: job.attempts,
          traceId: job.externalJobId,
        },
        options
      );
    }
  }

  private async deleteReceipt(jobId: string): Promise<void> {
    const receiptHandle = this.receipts.get(jobId);
    if (!receiptHandle) return;
    this.receipts.delete(jobId);
    await this.client.deleteMessage(receiptHandle);
  }

  private async deferWatchdogMessage(receiptHandle: string, job: CloudJob): Promise<void> {
    await this.client.deleteMessage(receiptHandle);
    await this.publish(
      {
        jobId: job.id,
        tenantId: job.tenantId,
        taskType: job.taskType,
        attempt: job.attempts,
        traceId: job.externalJobId,
      },
      { delaySeconds: delaySecondsForJobWatchdog(job) }
    );
  }
}

function delaySecondsForJobWatchdog(job: CloudJob): number {
  const candidates = [job.leaseExpiresAt, job.queuedAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => Math.ceil((new Date(value).getTime() - Date.now()) / 1000))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!candidates.length) return 10;
  return Math.min(900, Math.max(1, Math.min(...candidates)));
}

function createTencentCmqClient(): TencentCmqClient {
  if (!config.cloud.queueEndpoint) {
    throw new Error('Tencent CMQ requires QUEUE_ENDPOINT.');
  }
  if (!config.cloud.tencentSecretId || !config.cloud.tencentSecretKey) {
    throw new Error('Tencent CMQ requires TENCENT_SECRET_ID and TENCENT_SECRET_KEY.');
  }
  return new TencentCmqClient({
    endpoint: config.cloud.queueEndpoint,
    queueName: config.cloud.queueName,
    secretId: config.cloud.tencentSecretId,
    secretKey: config.cloud.tencentSecretKey,
    token: config.cloud.tencentToken,
    region: config.cloud.region,
  });
}

export function createQueueProvider(): QueueProvider {
  return config.cloud.queueProvider === 'tdmq-cmq' ? new TencentCmqQueueProvider() : new LocalQueueProvider();
}
