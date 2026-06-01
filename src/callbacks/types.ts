export type CallbackEventType = 'job.succeeded' | 'job.failed' | 'job.cancelled';

export type CallbackDeliveryStatus = 'pending' | 'delivered' | 'retry_wait' | 'failed';

export interface CallbackPayload {
  event: CallbackEventType;
  jobId: string;
  externalJobId?: string;
  status: string;
  result?: {
    outputKey: string;
    downloadUrl?: string;
    originalSize?: number;
    optimizedSize?: number;
    compressionRatio?: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface CallbackDelivery {
  id: string;
  jobId: string;
  eventType: CallbackEventType;
  url: string;
  status: CallbackDeliveryStatus;
  attempts: number;
  lastStatusCode?: number;
  nextRetryAt?: string;
  createdAt: string;
  updatedAt: string;
}
