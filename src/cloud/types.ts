/**
 * Cloud provider contracts for the future Tencent Cloud async runtime.
 *
 * These types intentionally avoid SDK-specific imports so the current local
 * optimizer can continue to build without cloud credentials or cloud packages.
 */

export type CloudProviderName = 'local' | 'tencent';

export interface CosObjectRef {
  bucket: string;
  region: string;
  key: string;
  etag?: string;
  size?: number;
}

export interface TemporaryUploadGrant {
  provider: CloudProviderName;
  object: CosObjectRef;
  tmpSecretId: string;
  tmpSecretKey: string;
  sessionToken: string;
  expiresAt: string;
}

export interface QueueJobMessage {
  jobId: string;
  tenantId: string;
  taskType: string;
  attempt: number;
  traceId?: string;
}

export interface WorkerSlotSnapshot {
  workerId: string;
  instanceId: string;
  slotsTotal: number;
  slotsBusy: number;
  draining: boolean;
  lastHeartbeatAt: string;
}

export interface SlotScalingDecision {
  queuedJobs: number;
  retryReadyJobs: number;
  currentSlots: number;
  busySlots: number;
  missingSlots: number;
  desiredInstances: number;
}
