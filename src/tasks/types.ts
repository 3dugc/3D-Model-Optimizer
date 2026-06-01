export type HeavyTaskType =
  | 'model.optimize'
  | 'video.transcode'
  | 'file.convert'
  | 'texture.compress'
  | 'cad.preview'
  | 'ai.batch-infer';

export type HeavyTaskResourceClass = 'cpu-small' | 'cpu-medium' | 'cpu-large' | 'memory-large' | 'gpu';

export interface HeavyTaskDescriptor<TPayload = unknown> {
  type: HeavyTaskType | string;
  version: string;
  payload: TPayload;
  resourceClass: HeavyTaskResourceClass;
  estimatedCostCents?: number;
  estimatedTimeoutSeconds?: number;
}

export interface HeavyTaskExecutionContext {
  jobId: string;
  tenantId: string;
  taskType: HeavyTaskType | string;
  inputUri: string;
  outputUri: string;
  scratchDir: string;
  traceId?: string;
}

export interface HeavyTaskReport {
  taskType: HeavyTaskType | string;
  success: boolean;
  outputUri?: string;
  metrics?: Record<string, string | number | boolean>;
  errorCode?: string;
  errorMessage?: string;
}

export interface HeavyTaskHandler<TPayload = unknown> {
  type: HeavyTaskType | string;
  run(inputPath: string, outputPath: string, descriptor: HeavyTaskDescriptor<TPayload>): Promise<HeavyTaskReport>;
}
