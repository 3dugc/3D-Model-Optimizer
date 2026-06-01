import type { CloudJob } from '../jobs/types';
import type { DispatcherBacklogStats, ScalingPool } from './types';

function isRetryReady(job: CloudJob, now: Date): boolean {
  return !job.queuedAt || new Date(job.queuedAt).getTime() <= now.getTime();
}

function isProcessingLeaseExpired(job: CloudJob, now: Date): boolean {
  if (job.status !== 'processing') return false;
  if (job.leaseExpiresAt) return new Date(job.leaseExpiresAt).getTime() <= now.getTime();
  return false;
}

export function summarizeJobBacklog(
  jobs: CloudJob[],
  now: Date = new Date(),
  taskType?: string
): DispatcherBacklogStats {
  const scopedJobs = taskType ? jobs.filter((job) => job.taskType === taskType) : jobs;
  const stats: DispatcherBacklogStats = {
    queued: 0,
    retryReady: 0,
    activeProcessing: 0,
    expiredProcessing: 0,
    requiredSlots: 0,
  };

  for (const job of scopedJobs) {
    if (job.status === 'queued') {
      stats.queued++;
    } else if (job.status === 'retry_wait' && isRetryReady(job, now)) {
      stats.retryReady++;
    } else if (job.status === 'processing') {
      if (isProcessingLeaseExpired(job, now)) stats.expiredProcessing++;
      else stats.activeProcessing++;
    }
  }

  stats.requiredSlots = stats.queued + stats.retryReady + stats.activeProcessing + stats.expiredProcessing;
  return stats;
}

export function calculateDesiredInstances(input: {
  requiredSlots: number;
  slotsPerInstance: number;
  minInstances: number;
  maxInstances: number;
}): number {
  const slotsPerInstance = Math.max(1, Math.floor(input.slotsPerInstance));
  const minInstances = Math.max(0, Math.floor(input.minInstances));
  const maxInstances = Math.max(minInstances, Math.floor(input.maxInstances));
  const requiredSlots = Math.max(0, Math.floor(input.requiredSlots));
  const needed = Math.ceil(requiredSlots / slotsPerInstance);
  return Math.max(minInstances, Math.min(maxInstances, needed));
}

export function planPoolDesiredCapacities(pools: ScalingPool[], targetInstances: number): Map<string, number> {
  const plan = new Map<string, number>();
  let remaining = Math.max(0, Math.floor(targetInstances));

  for (const pool of pools) {
    const capacity = Math.max(0, pool.maxSize);
    const desired = Math.min(capacity, remaining);
    plan.set(pool.id, desired);
    remaining -= desired;
  }

  return plan;
}
