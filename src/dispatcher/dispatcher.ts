import { config } from '../config';
import { jobStore, type JobStore } from '../jobs/job-store';
import logger from '../utils/logger';
import { summarizeJobBacklog, calculateDesiredInstances } from './scaling';
import { TencentAsScalingBackend } from './tencent-as-client';
import type { DispatcherDecision, DispatcherRuntimeConfig, ScalingBackend, ScalingBackendSnapshot } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class LocalScalingBackend implements ScalingBackend {
  readonly providerName = 'local' as const;
  private desiredCapacity = 0;

  async describe(): Promise<ScalingBackendSnapshot> {
    return {
      pools: [
        {
          id: 'local',
          name: 'local',
          minSize: 0,
          maxSize: Number.MAX_SAFE_INTEGER,
          desiredCapacity: this.desiredCapacity,
          inService: this.desiredCapacity,
        },
      ],
      desiredCapacity: this.desiredCapacity,
      inService: this.desiredCapacity,
      maxCapacity: Number.MAX_SAFE_INTEGER,
    };
  }

  async setDesiredCapacity(targetInstances: number): Promise<ScalingBackendSnapshot> {
    this.desiredCapacity = Math.max(0, Math.floor(targetInstances));
    return this.describe();
  }
}

export class ElasticDispatcher {
  private running = false;

  constructor(
    private readonly runtime: DispatcherRuntimeConfig,
    private readonly scaler: ScalingBackend = createScalingBackend(),
    private readonly store: JobStore = jobStore
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.installSignalHandlers();
    logger.info(
      {
        provider: this.scaler.providerName,
        taskType: this.runtime.taskType,
        intervalMs: this.runtime.intervalMs,
        minInstances: this.runtime.minInstances,
        maxInstances: this.runtime.maxInstances,
        slotsPerInstance: this.runtime.slotsPerInstance,
        dryRun: this.runtime.dryRun,
      },
      'Elastic dispatcher started'
    );
    while (this.running) {
      try {
        await this.reconcileOnce();
      } catch (error) {
        logger.error({ error }, 'Elastic dispatcher reconcile failed');
      }
      await sleep(this.runtime.intervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  async reconcileOnce(now: Date = new Date()): Promise<DispatcherDecision> {
    const jobs = await this.store.list();
    const backlog = summarizeJobBacklog(jobs, now, this.runtime.taskType);
    const snapshot = await this.scaler.describe();
    const targetInstances = calculateDesiredInstances({
      requiredSlots: backlog.requiredSlots,
      slotsPerInstance: this.runtime.slotsPerInstance,
      minInstances: this.runtime.minInstances,
      maxInstances: Math.min(this.runtime.maxInstances, snapshot.maxCapacity),
    });
    const changed = snapshot.desiredCapacity !== targetInstances;

    if (changed && !this.runtime.dryRun) {
      const updated = await this.scaler.setDesiredCapacity(targetInstances);
      logger.info(
        {
          backlog,
          targetInstances,
          previousDesired: snapshot.desiredCapacity,
          currentDesired: updated.desiredCapacity,
          currentInService: updated.inService,
        },
        'Elastic dispatcher updated desired capacity'
      );
    } else {
      logger.info(
        {
          backlog,
          targetInstances,
          currentDesired: snapshot.desiredCapacity,
          currentInService: snapshot.inService,
          dryRun: this.runtime.dryRun,
        },
        changed ? 'Elastic dispatcher would update desired capacity' : 'Elastic dispatcher capacity already matches backlog'
      );
    }

    return {
      targetInstances,
      currentDesired: snapshot.desiredCapacity,
      currentInService: snapshot.inService,
      backlog,
      changed,
    };
  }

  private installSignalHandlers(): void {
    process.once('SIGTERM', () => {
      logger.info('Elastic dispatcher received SIGTERM');
      this.stop();
    });
    process.once('SIGINT', () => {
      logger.info('Elastic dispatcher received SIGINT');
      this.stop();
    });
  }
}

export function createDispatcherRuntimeConfig(): DispatcherRuntimeConfig {
  return {
    intervalMs: config.cloud.dispatcherIntervalSeconds * 1000,
    dryRun: config.cloud.dispatcherDryRun,
    taskType: config.cloud.dispatcherTaskType,
    slotsPerInstance: config.cloud.dispatcherSlotsPerInstance,
    minInstances: config.cloud.dispatcherMinInstances,
    maxInstances: config.cloud.dispatcherMaxInstances,
  };
}

export function createScalingBackend(): ScalingBackend {
  if (config.cloud.dispatcherProvider === 'tencent-as') {
    if (!config.cloud.dispatcherAsGroupIds.length) {
      throw new Error('Tencent AS dispatcher requires DISPATCHER_AS_GROUP_IDS or DISPATCHER_AS_GROUP_ID.');
    }
    return new TencentAsScalingBackend(config.cloud.dispatcherAsGroupIds);
  }
  return new LocalScalingBackend();
}

