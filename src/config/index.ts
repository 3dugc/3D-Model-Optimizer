/**
 * Configuration
 *
 * This module exports configuration settings for the GLB Optimizer Server.
 * Configuration includes:
 * - Server settings (port, host)
 * - File constraints (max size, allowed types)
 * - Timeout settings
 * - CORS configuration
 */

/**
 * Server configuration interface.
 */
export interface ServerConfig {
  /** Server port */
  port: number;
  /** Server host */
  host: string;
  /** CORS allowed origins */
  corsOrigins: string | string[];
  /** JSON body size limit */
  jsonLimit: string;
  /** File upload timeout (ms) */
  uploadTimeout: number;
  /** Single step optimization timeout (ms) */
  stepTimeout: number;
  /** Total processing timeout (ms) */
  totalTimeout: number;
  /** Maximum file size (bytes) */
  maxFileSize: number;
  /** Temporary files directory */
  tempDir: string;
  /** Result files directory */
  resultDir: string;
  /** Cloud async runtime configuration */
  cloud: CloudRuntimeConfig;
  /** Billing and payment configuration */
  billing: BillingConfig;
}

/**
 * Cloud async runtime configuration.
 */
export interface CloudRuntimeConfig {
  provider: 'local' | 'tencent';
  queueProvider: 'local' | 'tdmq-cmq';
  jobStorePath: string;
  localObjectRoot: string;
  inputBucket: string;
  outputBucket: string;
  region: string;
  tencentSecretId?: string;
  tencentSecretKey?: string;
  tencentToken?: string;
  queueEndpoint?: string;
  queueName: string;
  queuePollingWaitSeconds: number;
  defaultTaskType: string;
  jobMaxAttempts: number;
  jobTimeoutSeconds: number;
  workerConcurrency: number;
  workerHeartbeatIntervalMs: number;
  callbackTimeoutSeconds: number;
  callbackMaxAttempts: number;
}

/**
 * Billing and payment configuration.
 */
export interface BillingConfig {
  mode: 'mock' | 'wechat_native' | 'disabled';
  orderStorePath: string;
  defaultJobPriceCents: number;
  wechatNotifyUrl?: string;
}

/**
 * Parse environment variable as number with default.
 * @param value - Environment variable value
 * @param defaultValue - Default value if not set or invalid
 * @returns Parsed number or default
 */
function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse environment variable as a positive integer.
 */
function parsePositiveNumber(value: string | undefined, defaultValue: number): number {
  const parsed = parseNumber(value, defaultValue);
  return parsed > 0 ? parsed : defaultValue;
}

/**
 * Parse CORS origins from environment variable.
 * @param value - Comma-separated origins or '*'
 * @returns Array of origins or '*'
 */
function parseCorsOrigins(value: string | undefined): string | string[] {
  if (!value || value === '*') return '*';
  return value.split(',').map((origin) => origin.trim());
}

/**
 * Server configuration loaded from environment variables.
 */
export const config: ServerConfig = {
  // Server settings
  port: parseNumber(process.env.PORT, 3000),
  host: process.env.HOST || 'localhost',

  // CORS settings
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),

  // Body parser settings
  jsonLimit: process.env.JSON_LIMIT || '1mb',

  // Timeout settings (in milliseconds)
  uploadTimeout: parseNumber(process.env.UPLOAD_TIMEOUT, 30 * 1000), // 30 seconds
  stepTimeout: parseNumber(process.env.STEP_TIMEOUT, 5 * 60 * 1000), // 5 minutes
  totalTimeout: parseNumber(process.env.TOTAL_TIMEOUT, 30 * 60 * 1000), // 30 minutes

  // File settings
  maxFileSize: parseNumber(process.env.MAX_FILE_SIZE, 100 * 1024 * 1024), // 100MB

  // Directory settings
  tempDir: process.env.TEMP_DIR || 'temp',
  resultDir: process.env.RESULT_DIR || 'results',

  // Cloud async runtime settings
  cloud: {
    provider: process.env.CLOUD_PROVIDER === 'tencent' ? 'tencent' : 'local',
    queueProvider:
      process.env.QUEUE_PROVIDER === 'tdmq-cmq' || process.env.CLOUD_PROVIDER === 'tencent'
        ? 'tdmq-cmq'
        : 'local',
    jobStorePath: process.env.JOB_STORE_PATH || 'data/cloud/jobs.json',
    localObjectRoot: process.env.CLOUD_LOCAL_OBJECT_ROOT || 'data/cloud/objects',
    inputBucket: process.env.COS_INPUT_BUCKET || 'optimizer-input',
    outputBucket: process.env.COS_OUTPUT_BUCKET || 'optimizer-output',
    region: process.env.TENCENT_REGION || process.env.COS_REGION || 'ap-nanjing',
    tencentSecretId: process.env.TENCENT_SECRET_ID,
    tencentSecretKey: process.env.TENCENT_SECRET_KEY,
    tencentToken: process.env.TENCENT_TOKEN,
    queueEndpoint: process.env.QUEUE_ENDPOINT,
    queueName: process.env.QUEUE_NAME || 'optimizer-jobs',
    queuePollingWaitSeconds: parseNumber(process.env.QUEUE_POLLING_WAIT_SECONDS, 10),
    defaultTaskType: process.env.DEFAULT_TASK_TYPE || 'model.optimize',
    jobMaxAttempts: parsePositiveNumber(process.env.JOB_MAX_ATTEMPTS, 3),
    jobTimeoutSeconds: parsePositiveNumber(process.env.JOB_TIMEOUT_SECONDS, 30 * 60),
    workerConcurrency: parsePositiveNumber(process.env.WORKER_CONCURRENCY, 1),
    workerHeartbeatIntervalMs: parsePositiveNumber(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 10 * 1000),
    callbackTimeoutSeconds: parsePositiveNumber(process.env.CALLBACK_TIMEOUT_SECONDS, 10),
    callbackMaxAttempts: parsePositiveNumber(process.env.CALLBACK_MAX_ATTEMPTS, 6),
  },

  // Billing settings
  billing: {
    mode:
      process.env.BILLING_MODE === 'wechat_native'
        ? 'wechat_native'
        : process.env.BILLING_MODE === 'disabled'
          ? 'disabled'
          : 'mock',
    orderStorePath: process.env.ORDER_STORE_PATH || 'data/cloud/orders.json',
    defaultJobPriceCents: parsePositiveNumber(process.env.DEFAULT_JOB_PRICE_CENTS, 800),
    wechatNotifyUrl: process.env.WECHAT_PAY_NOTIFY_URL,
  },
};

// Re-export swagger configuration
export { swaggerSpec, swaggerOptions } from './swagger';
