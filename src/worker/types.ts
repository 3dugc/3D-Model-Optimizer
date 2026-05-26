export type WorkerStatus = 'starting' | 'active' | 'draining' | 'terminated' | 'lost';

export interface WorkerRuntimeConfig {
  workerId: string;
  instanceId: string;
  concurrency: number;
  heartbeatIntervalMs: number;
  jobTimeoutMs: number;
}

export interface WorkerHeartbeat {
  workerId: string;
  instanceId: string;
  status: WorkerStatus;
  slotsTotal: number;
  slotsBusy: number;
  draining: boolean;
  timestamp: string;
}

export interface WorkerExecutionResult {
  jobId: string;
  taskType: string;
  success: boolean;
  outputKey?: string;
  reportKey?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
}
