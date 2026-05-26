import type { CloudJobStatus } from './types';

const ALLOWED_JOB_TRANSITIONS: Record<CloudJobStatus, CloudJobStatus[]> = {
  waiting_upload: ['waiting_manifest', 'waiting_payment', 'queued', 'cancelled', 'failed'],
  waiting_manifest: ['waiting_payment', 'queued', 'cancelled', 'failed'],
  waiting_payment: ['queued', 'cancelled', 'failed'],
  queued: ['processing', 'cancelled', 'failed'],
  processing: ['retry_wait', 'succeeded', 'failed', 'cancelled'],
  retry_wait: ['queued', 'processing', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class InvalidJobStatusTransitionError extends Error {
  constructor(from: CloudJobStatus, to: CloudJobStatus) {
    super(`Invalid job status transition: ${from} -> ${to}`);
    this.name = 'InvalidJobStatusTransitionError';
  }
}

export function assertJobStatusTransition(from: CloudJobStatus, to: CloudJobStatus): void {
  if (from === to) return;
  if (!ALLOWED_JOB_TRANSITIONS[from].includes(to)) {
    throw new InvalidJobStatusTransitionError(from, to);
  }
}

export function isTerminalJobStatus(status: CloudJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
