export interface DispatcherBacklogStats {
  queued: number;
  retryReady: number;
  activeProcessing: number;
  expiredProcessing: number;
  requiredSlots: number;
}

export interface DispatcherRuntimeConfig {
  intervalMs: number;
  dryRun: boolean;
  taskType?: string;
  slotsPerInstance: number;
  minInstances: number;
  maxInstances: number;
}

export interface ScalingPool {
  id: string;
  name?: string;
  minSize: number;
  maxSize: number;
  desiredCapacity: number;
  inService: number;
}

export interface ScalingBackendSnapshot {
  pools: ScalingPool[];
  desiredCapacity: number;
  inService: number;
  maxCapacity: number;
}

export interface ScalingBackend {
  providerName: 'local' | 'tencent-as';
  describe(): Promise<ScalingBackendSnapshot>;
  setDesiredCapacity(targetInstances: number): Promise<ScalingBackendSnapshot>;
}

export interface DispatcherDecision {
  targetInstances: number;
  currentDesired: number;
  currentInService: number;
  backlog: DispatcherBacklogStats;
  changed: boolean;
}

