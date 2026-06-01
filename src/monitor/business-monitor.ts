import { config } from '../config';
import { TencentCmqClient, type TencentCmqQueueAttributes } from '../cloud/tencent-cmq-client';
import { createTencentCredentialProvider } from '../cloud/tencent-credentials';
import logger from '../utils/logger';
import type { CloudJob } from '../jobs/types';
import type { WorkerHeartbeat } from '../worker/types';
import { readBusinessMonitorSnapshot } from './state-reader';
import { createCustomAlarmNotifier, type CustomAlarmNotifier } from './tencent-custom-alarm';

interface BusinessAlert {
  key: string;
  title: string;
  description: string;
  fields: Record<string, number | string | boolean>;
}

interface BusinessMonitorOptions {
  now?: () => Date;
  notifier?: CustomAlarmNotifier;
  queueClient?: TencentCmqClient;
}

export class BusinessMonitor {
  private readonly now: () => Date;
  private readonly notifier: CustomAlarmNotifier;
  private readonly queueClient?: TencentCmqClient;
  private readonly lastAlarmAt = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(options: BusinessMonitorOptions = {}) {
    this.now = options.now || (() => new Date());
    this.notifier = options.notifier || createCustomAlarmNotifier();
    this.queueClient = options.queueClient || createQueueClient();
  }

  async start(): Promise<void> {
    logger.info(
      {
        intervalSeconds: config.cloud.monitorIntervalSeconds,
        queueBacklogThreshold: config.cloud.monitorQueueBacklogThreshold,
        workerHeartbeatStaleSeconds: config.cloud.monitorWorkerHeartbeatStaleSeconds,
        customAlarmEnabled: config.cloud.monitorTencentCustomAlarmEnabled,
      },
      'Business monitor started'
    );
    await this.tick();
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => logger.error({ error }, 'Business monitor tick failed'));
    }, config.cloud.monitorIntervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const [snapshot, queueAttributes] = await Promise.all([readBusinessMonitorSnapshot(), this.readQueueAttributes()]);
    const alerts = evaluateAlerts(snapshot.jobs, snapshot.workers, queueAttributes, this.now());
    logger.info(
      {
        alerts: alerts.length,
        queuedJobs: countJobs(snapshot.jobs, 'queued'),
        retryWaitJobs: countJobs(snapshot.jobs, 'retry_wait'),
        processingJobs: countJobs(snapshot.jobs, 'processing'),
        workerCount: snapshot.workers.length,
        queueAttributes,
      },
      'Business monitor snapshot'
    );
    for (const alert of alerts) {
      await this.emitAlert(alert);
    }
  }

  private async readQueueAttributes(): Promise<TencentCmqQueueAttributes | undefined> {
    if (!this.queueClient) return undefined;
    try {
      return await this.queueClient.getQueueAttributes();
    } catch (error) {
      logger.warn({ error }, 'Unable to read CMQ queue attributes for monitor snapshot');
      return undefined;
    }
  }

  private async emitAlert(alert: BusinessAlert): Promise<void> {
    const currentTime = this.now().getTime();
    const lastTime = this.lastAlarmAt.get(alert.key) || 0;
    if (currentTime - lastTime < config.cloud.monitorAlarmCooldownSeconds * 1000) {
      logger.warn({ alert }, 'Business alert suppressed by cooldown');
      return;
    }
    this.lastAlarmAt.set(alert.key, currentTime);
    const title = `[${config.cloud.monitorAlarmTitlePrefix}] ${alert.title}`;
    const description = `${alert.description}\n\n${Object.entries(alert.fields)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')}`;
    logger.warn({ alert }, 'Business alert triggered');
    await this.notifier.send(title, description);
  }
}

export function evaluateAlerts(
  jobs: CloudJob[],
  workers: WorkerHeartbeat[],
  queueAttributes: TencentCmqQueueAttributes | undefined,
  now: Date
): BusinessAlert[] {
  const pendingJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'retry_wait').length;
  const processingJobs = jobs.filter((job) => job.status === 'processing');
  const staleBefore = now.getTime() - config.cloud.monitorWorkerHeartbeatStaleSeconds * 1000;
  const freshWorkers = workers.filter((worker) => new Date(worker.timestamp).getTime() >= staleBefore);
  const staleWorkerIds = new Set(
    workers.filter((worker) => new Date(worker.timestamp).getTime() < staleBefore).map((worker) => worker.workerId)
  );
  const processingJobsOnStaleWorkers = processingJobs.filter(
    (job) => job.workerId && staleWorkerIds.has(job.workerId)
  ).length;
  const expiredProcessingJobs = processingJobs.filter(
    (job) => job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() <= now.getTime()
  ).length;
  const freshSlots = freshWorkers.reduce((sum, worker) => sum + worker.slotsTotal, 0);
  const queueBacklog = (queueAttributes?.activeMsgNum ?? 0) + pendingJobs;
  const alerts: BusinessAlert[] = [];

  if (queueBacklog >= config.cloud.monitorQueueBacklogThreshold) {
    alerts.push({
      key: 'queue-backlog-high',
      title: 'queue backlog is waiting for workers',
      description: 'The async task queue has visible backlog or pending database jobs.',
      fields: {
        queueBacklog,
        pendingJobs,
        cmqActiveMessages: queueAttributes?.activeMsgNum ?? 0,
        cmqInactiveMessages: queueAttributes?.inactiveMsgNum ?? 0,
        threshold: config.cloud.monitorQueueBacklogThreshold,
      },
    });
  }

  if (pendingJobs > 0 && freshSlots === 0) {
    alerts.push({
      key: 'backlog-without-fresh-workers',
      title: 'backlog exists but no fresh worker heartbeat',
      description: 'Tasks are waiting, but no active worker has reported a fresh heartbeat.',
      fields: {
        pendingJobs,
        freshSlots,
        freshWorkers: freshWorkers.length,
        staleWorkers: staleWorkerIds.size,
      },
    });
  }

  if (processingJobsOnStaleWorkers > 0 || expiredProcessingJobs > 0) {
    alerts.push({
      key: 'worker-heartbeat-lost',
      title: 'worker heartbeat lost while jobs are processing',
      description: 'At least one processing job is attached to a stale worker heartbeat or expired lease.',
      fields: {
        processingJobs: processingJobs.length,
        processingJobsOnStaleWorkers,
        expiredProcessingJobs,
        staleWorkers: staleWorkerIds.size,
        staleAfterSeconds: config.cloud.monitorWorkerHeartbeatStaleSeconds,
      },
    });
  }

  return alerts;
}

function createQueueClient(): TencentCmqClient | undefined {
  if (config.cloud.queueProvider !== 'tdmq-cmq' || !config.cloud.queueEndpoint) return undefined;
  return new TencentCmqClient({
    endpoint: config.cloud.queueEndpoint,
    queueName: config.cloud.queueName,
    region: config.cloud.region,
    secretId: config.cloud.tencentSecretId,
    secretKey: config.cloud.tencentSecretKey,
    token: config.cloud.tencentToken,
    credentialProvider: createTencentCredentialProvider(),
  });
}

function countJobs(jobs: CloudJob[], status: CloudJob['status']): number {
  return jobs.filter((job) => job.status === status).length;
}
