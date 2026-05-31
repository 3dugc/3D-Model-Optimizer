import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { requireScope } from '../middleware';
import { readBusinessMetricsSnapshot } from '../monitor/state-reader';
import type { CloudJob } from '../jobs/types';

const router = Router();

function countByStatus(jobs: CloudJob[]): Record<string, number> {
  return jobs.reduce<Record<string, number>>((counts, job) => {
    counts[job.status] = (counts[job.status] || 0) + 1;
    return counts;
  }, {});
}

function averageCompletedDurationMs(jobs: CloudJob[]): number | undefined {
  const durations = jobs
    .filter((job) => job.startedAt && job.completedAt)
    .map((job) => new Date(job.completedAt as string).getTime() - new Date(job.startedAt as string).getTime())
    .filter((duration) => Number.isFinite(duration) && duration >= 0);
  if (!durations.length) return undefined;
  return Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length);
}

router.get('/business', requireScope('metrics:read'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const snapshot = await readBusinessMetricsSnapshot();
    const now = Date.now();
    const staleBefore = now - config.cloud.monitorWorkerHeartbeatStaleSeconds * 1000;
    const staleWorkers = snapshot.workers.filter((worker) => new Date(worker.timestamp).getTime() < staleBefore);
    const terminalJobs = snapshot.jobs.filter((job) => ['succeeded', 'failed', 'cancelled'].includes(job.status));
    const failedJobs = terminalJobs.filter((job) => job.status === 'failed').length;
    const activeJobs = snapshot.jobs.filter((job) => ['queued', 'retry_wait', 'processing'].includes(job.status));

    res.json({
      success: true,
      generatedAt: new Date(now).toISOString(),
      jobs: {
        totalSampled: snapshot.jobs.length,
        active: activeJobs.length,
        byStatus: countByStatus(snapshot.jobs),
        failureRate: terminalJobs.length ? failedJobs / terminalJobs.length : 0,
        averageCompletedDurationMs: averageCompletedDurationMs(snapshot.jobs),
      },
      workers: {
        totalSampled: snapshot.workers.length,
        stale: staleWorkers.length,
        slotsTotal: snapshot.workers.reduce((sum, worker) => sum + worker.slotsTotal, 0),
        slotsBusy: snapshot.workers.reduce((sum, worker) => sum + worker.slotsBusy, 0),
        staleAfterSeconds: config.cloud.monitorWorkerHeartbeatStaleSeconds,
      },
      limits: {
        tenantConcurrentJobLimit: config.cloud.tenantConcurrentJobLimit,
        tenantDailyJobLimit: config.cloud.tenantDailyJobLimit,
        globalMaxQueuedJobs: config.cloud.globalMaxQueuedJobs,
        globalMaxWorkerSlots: config.cloud.globalMaxWorkerSlots,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
