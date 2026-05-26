import type { QueueJobMessage } from './types';
import { config } from '../config';
import type { ClaimJobInput, CloudJob } from '../jobs/types';
import { jobStore, type JobStore } from '../jobs/job-store';

export interface QueueProvider {
  providerName: 'local' | 'tdmq-cmq';
  publish(message: QueueJobMessage): Promise<void>;
  claimNext(input: ClaimJobInput): Promise<CloudJob | undefined>;
}

export class LocalQueueProvider implements QueueProvider {
  readonly providerName = 'local' as const;

  constructor(private readonly store: JobStore = jobStore) {}

  async publish(message: QueueJobMessage): Promise<void> {
    const job = await this.store.get(message.jobId);
    if (!job) {
      throw new Error(`Cannot publish unknown job: ${message.jobId}`);
    }
    if (job.status === 'queued') return;
    await this.store.transition(message.jobId, 'queued', {
      queuedAt: new Date().toISOString(),
    });
  }

  async claimNext(input: ClaimJobInput): Promise<CloudJob | undefined> {
    return this.store.claimNext(input);
  }
}

export class TencentCmqQueueProvider implements QueueProvider {
  readonly providerName = 'tdmq-cmq' as const;

  async publish(_message: QueueJobMessage): Promise<void> {
    throw new Error('TDMQ/CMQ provider is not wired in this build. Use CLOUD_PROVIDER=local or add the Tencent Cloud SDK adapter before production deployment.');
  }

  async claimNext(_input: ClaimJobInput): Promise<CloudJob | undefined> {
    throw new Error('TDMQ/CMQ provider is not wired in this build. Use CLOUD_PROVIDER=local or add the Tencent Cloud SDK adapter before production deployment.');
  }
}

export function createQueueProvider(): QueueProvider {
  return config.cloud.provider === 'tencent' ? new TencentCmqQueueProvider() : new LocalQueueProvider();
}
