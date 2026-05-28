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
  /** Shared database configuration */
  database: DatabaseConfig;
  /** Billing and payment configuration */
  billing: BillingConfig;
  /** Web user authentication configuration */
  webAuth: WebAuthConfig;
}

/**
 * Shared database configuration.
 */
export interface DatabaseConfig {
  url?: string;
  stateStoreProvider: 'local' | 'mysql' | 'postgres';
  ssl: boolean;
  sslRejectUnauthorized: boolean;
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
  cosUploadCredentialTtlSeconds: number;
  cosDownloadUrlTtlSeconds: number;
  cosUploadGrantMode: 'signed-url' | 'sts';
  cosUploadStsRoleArn?: string;
  tencentSecretId?: string;
  tencentSecretKey?: string;
  tencentToken?: string;
  tencentCvmRoleName?: string;
  tencentCvmRoleMetadataUrl?: string;
  queueEndpoint?: string;
  queueName: string;
  queuePollingWaitSeconds: number;
  defaultTaskType: string;
  jobMaxAttempts: number;
  jobTimeoutSeconds: number;
  jobLeaseSeconds: number;
  expiredJobRecoveryIntervalSeconds: number;
  workerConcurrency: number;
  workerHeartbeatIntervalMs: number;
  workerIdleExitSeconds: number;
  workerSpotTerminationCheckUrl?: string;
  workerSpotTerminationPollMs: number;
  callbackTimeoutSeconds: number;
  callbackMaxAttempts: number;
  dispatcherProvider: 'local' | 'tencent-as';
  dispatcherIntervalSeconds: number;
  dispatcherDryRun: boolean;
  dispatcherTaskType?: string;
  dispatcherAsGroupIds: string[];
  dispatcherSlotsPerInstance: number;
  dispatcherMinInstances: number;
  dispatcherMaxInstances: number;
  monitorIntervalSeconds: number;
  monitorQueueBacklogThreshold: number;
  monitorWorkerHeartbeatStaleSeconds: number;
  monitorAlarmCooldownSeconds: number;
  monitorTencentCustomAlarmEnabled: boolean;
  monitorAlarmTitlePrefix: string;
}

/**
 * Billing and payment configuration.
 */
export interface BillingConfig {
  mode: 'mock' | 'wechat_native' | 'disabled';
  orderStorePath: string;
  accountStorePath: string;
  defaultJobPriceCents: number;
  rechargePackagesCents: number[];
  wechatNotifyUrl?: string;
}

/**
 * Web user authentication configuration.
 */
export interface WebAuthConfig {
  tokenSecret: string;
  tokenTtlSeconds: number;
  mockLoginEnabled: boolean;
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

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveNumberCsv(value: string | undefined, defaultValue: number[]): number[] {
  const parsed = parseCsv(value)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.floor(item));
  return parsed.length ? parsed : defaultValue;
}

function parseStateStoreProvider(): 'local' | 'mysql' | 'postgres' {
  const configured =
    process.env.STATE_STORE_PROVIDER || process.env.JOB_STORE_PROVIDER || process.env.ORDER_STORE_PROVIDER;
  if (configured === 'local' || configured === 'mysql' || configured === 'postgres') return configured;
  if (process.env.DATABASE_URL?.startsWith('mysql://') || process.env.DATABASE_URL?.startsWith('mysql2://')) {
    return 'mysql';
  }
  if (process.env.DATABASE_URL) return 'postgres';
  return 'local';
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
    cosUploadCredentialTtlSeconds: parsePositiveNumber(process.env.COS_UPLOAD_CREDENTIAL_TTL_SECONDS, 30 * 60),
    cosDownloadUrlTtlSeconds: parsePositiveNumber(process.env.COS_DOWNLOAD_URL_TTL_SECONDS, 15 * 60),
    cosUploadGrantMode: process.env.COS_UPLOAD_GRANT_MODE === 'sts' ? 'sts' : 'signed-url',
    cosUploadStsRoleArn: process.env.COS_UPLOAD_STS_ROLE_ARN,
    tencentSecretId: process.env.TENCENT_SECRET_ID,
    tencentSecretKey: process.env.TENCENT_SECRET_KEY,
    tencentToken: process.env.TENCENT_TOKEN,
    tencentCvmRoleName: process.env.TENCENT_CVM_ROLE_NAME,
    tencentCvmRoleMetadataUrl: process.env.TENCENT_CVM_ROLE_METADATA_URL,
    queueEndpoint: process.env.QUEUE_ENDPOINT,
    queueName: process.env.QUEUE_NAME || 'optimizer-jobs',
    queuePollingWaitSeconds: parseNumber(process.env.QUEUE_POLLING_WAIT_SECONDS, 10),
    defaultTaskType: process.env.DEFAULT_TASK_TYPE || 'model.optimize',
    jobMaxAttempts: parsePositiveNumber(process.env.JOB_MAX_ATTEMPTS, 3),
    jobTimeoutSeconds: parsePositiveNumber(process.env.JOB_TIMEOUT_SECONDS, 30 * 60),
    jobLeaseSeconds: parsePositiveNumber(process.env.JOB_LEASE_SECONDS, 5 * 60),
    expiredJobRecoveryIntervalSeconds: parsePositiveNumber(process.env.EXPIRED_JOB_RECOVERY_INTERVAL_SECONDS, 30),
    workerConcurrency: parsePositiveNumber(process.env.WORKER_CONCURRENCY, 1),
    workerHeartbeatIntervalMs: parsePositiveNumber(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 10 * 1000),
    workerIdleExitSeconds: Math.max(0, parseNumber(process.env.WORKER_IDLE_EXIT_SECONDS, 0)),
    workerSpotTerminationCheckUrl:
      process.env.WORKER_SPOT_TERMINATION_CHECK_URL ||
      (process.env.CLOUD_PROVIDER === 'tencent'
        ? 'http://metadata.tencentyun.com/latest/meta-data/spot/termination-time'
        : undefined),
    workerSpotTerminationPollMs: parsePositiveNumber(process.env.WORKER_SPOT_TERMINATION_POLL_MS, 5 * 1000),
    callbackTimeoutSeconds: parsePositiveNumber(process.env.CALLBACK_TIMEOUT_SECONDS, 10),
    callbackMaxAttempts: parsePositiveNumber(process.env.CALLBACK_MAX_ATTEMPTS, 6),
    dispatcherProvider:
      process.env.DISPATCHER_PROVIDER === 'tencent-as' || process.env.CLOUD_PROVIDER === 'tencent'
        ? 'tencent-as'
        : 'local',
    dispatcherIntervalSeconds: parsePositiveNumber(process.env.DISPATCHER_INTERVAL_SECONDS, 30),
    dispatcherDryRun: parseBoolean(process.env.DISPATCHER_DRY_RUN, false),
    dispatcherTaskType: process.env.DISPATCHER_TASK_TYPE || undefined,
    dispatcherAsGroupIds: parseCsv(process.env.DISPATCHER_AS_GROUP_IDS || process.env.DISPATCHER_AS_GROUP_ID),
    dispatcherSlotsPerInstance: parsePositiveNumber(process.env.DISPATCHER_SLOTS_PER_INSTANCE, 1),
    dispatcherMinInstances: Math.max(0, parseNumber(process.env.DISPATCHER_MIN_INSTANCES, 0)),
    dispatcherMaxInstances: Math.max(0, parseNumber(process.env.DISPATCHER_MAX_INSTANCES, 3)),
    monitorIntervalSeconds: parsePositiveNumber(process.env.MONITOR_INTERVAL_SECONDS, 60),
    monitorQueueBacklogThreshold: Math.max(1, parseNumber(process.env.MONITOR_QUEUE_BACKLOG_THRESHOLD, 1)),
    monitorWorkerHeartbeatStaleSeconds: parsePositiveNumber(process.env.MONITOR_WORKER_HEARTBEAT_STALE_SECONDS, 180),
    monitorAlarmCooldownSeconds: parsePositiveNumber(process.env.MONITOR_ALARM_COOLDOWN_SECONDS, 900),
    monitorTencentCustomAlarmEnabled: parseBoolean(process.env.MONITOR_TENCENT_CUSTOM_ALARM_ENABLED, false),
    monitorAlarmTitlePrefix: process.env.MONITOR_ALARM_TITLE_PREFIX || 'model-optimizer',
  },

  // Shared state store
  database: {
    url: process.env.DATABASE_URL,
    stateStoreProvider: parseStateStoreProvider(),
    ssl: parseBoolean(process.env.DATABASE_SSL, false),
    sslRejectUnauthorized: parseBoolean(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED, true),
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
    accountStorePath: process.env.ACCOUNT_STORE_PATH || 'data/cloud/accounts.json',
    defaultJobPriceCents: parsePositiveNumber(process.env.DEFAULT_JOB_PRICE_CENTS, 100),
    rechargePackagesCents: parsePositiveNumberCsv(process.env.RECHARGE_PACKAGES_CENTS, [1000, 3000, 5000, 10000]),
    wechatNotifyUrl: process.env.WECHAT_PAY_NOTIFY_URL,
  },

  // Web user auth settings
  webAuth: {
    tokenSecret: process.env.WEB_AUTH_SECRET || process.env.API_KEY || 'dev-web-auth-secret',
    tokenTtlSeconds: parsePositiveNumber(process.env.WEB_AUTH_TOKEN_TTL_SECONDS, 30 * 24 * 60 * 60),
    mockLoginEnabled: parseBoolean(process.env.WEB_AUTH_MOCK_LOGIN_ENABLED, false),
  },
};

// Re-export swagger configuration
export { swaggerSpec, swaggerOptions } from './swagger';
