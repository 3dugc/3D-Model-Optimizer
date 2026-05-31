import { parseBoolean, parseCsv, parseNumber, parsePositiveNumber } from './parsers';
import type { CloudRuntimeConfig } from './types';

export function parseCloudConfig(): CloudRuntimeConfig {
  return {
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
    tenantConcurrentJobLimit: Math.max(0, parseNumber(process.env.TENANT_CONCURRENT_JOB_LIMIT, 0)),
    tenantDailyJobLimit: Math.max(0, parseNumber(process.env.TENANT_DAILY_JOB_LIMIT, 0)),
    globalMaxQueuedJobs: Math.max(0, parseNumber(process.env.GLOBAL_MAX_QUEUED_JOBS, 0)),
    globalMaxWorkerSlots: Math.max(0, parseNumber(process.env.GLOBAL_MAX_WORKER_SLOTS, 0)),
  };
}
