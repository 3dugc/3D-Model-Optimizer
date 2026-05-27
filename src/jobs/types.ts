import type { OptimizationOptions } from '../models/options';
import type { HeavyTaskDescriptor } from '../tasks/types';
import type { CosObjectRef } from '../cloud/types';

export type CloudJobStatus =
  | 'waiting_upload'
  | 'waiting_manifest'
  | 'waiting_payment'
  | 'queued'
  | 'processing'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface CloudJob {
  id: string;
  tenantId: string;
  externalJobId?: string;
  idempotencyKey?: string;
  taskType: string;
  task: HeavyTaskDescriptor;
  status: CloudJobStatus;
  preset?: string;
  options: OptimizationOptions;
  inputBucket: string;
  inputRegion: string;
  inputKey: string;
  inputEtag?: string;
  outputBucket?: string;
  outputRegion?: string;
  outputKey?: string;
  reportKey?: string;
  callbackUrl?: string;
  callbackSecretId?: string;
  callbackSigningSecret?: string;
  paymentRequired: boolean;
  orderId?: string;
  workerId?: string;
  leaseExpiresAt?: string;
  lastHeartbeatAt?: string;
  attempts: number;
  maxAttempts: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  uploadedAt?: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CreateCloudJobInput {
  tenantId: string;
  filename?: string;
  input?: CosObjectRef;
  taskType?: string;
  task?: HeavyTaskDescriptor;
  externalJobId?: string;
  idempotencyKey?: string;
  preset?: string;
  options?: OptimizationOptions;
  callbackUrl?: string;
  callbackSecretId?: string;
  callbackSigningSecret?: string;
  paymentRequired?: boolean;
}

export interface ClaimJobInput {
  workerId: string;
  now?: Date;
  leaseDurationMs?: number;
}

export interface RenewJobLeaseInput {
  workerId: string;
  now?: Date;
  leaseDurationMs?: number;
}

export interface RecoverExpiredJobLeasesInput {
  now?: Date;
  limit?: number;
  reason?: string;
}
