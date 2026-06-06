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
  /** File retention period before cleanup (ms) */
  fileRetentionMs: number;
  /** Cleanup interval for expired files (ms) */
  cleanupIntervalMs: number;
  /** Whether API/web tokens may be accepted from query strings for legacy links */
  allowQueryAuthTokens: boolean;
  /** Whether Swagger/OpenAPI documentation endpoints are enabled */
  apiDocsEnabled: boolean;
  /** Cloud async runtime configuration */
  cloud: CloudRuntimeConfig;
  /** Shared database configuration */
  database: DatabaseConfig;
  /** Billing and payment configuration */
  billing: BillingConfig;
  /** Recharge invoice configuration */
  invoice: InvoiceConfig;
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
  tenantConcurrentJobLimit: number;
  tenantDailyJobLimit: number;
  globalMaxQueuedJobs: number;
  globalMaxWorkerSlots: number;
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
  paymentServiceUrl?: string;
  paymentServiceApiKey?: string;
  wechatNotifyUrl?: string;
  wechatAppId?: string;
  wechatMchId?: string;
  wechatPrivateKey?: string;
  wechatPrivateKeyPath?: string;
  wechatCertSerialNo?: string;
  wechatApiV3Key?: string;
  wechatPlatformPublicKey?: string;
  wechatPlatformPublicKeyPath?: string;
  wechatPlatformCertificate?: string;
  wechatPlatformCertificatePath?: string;
  wechatApiBaseUrl: string;
  wechatSupportFapiao: boolean;
}

/**
 * Invoice configuration.
 */
export interface InvoiceConfig {
  enabled: boolean;
  provider: 'manual' | 'wechat_fapiao';
  storePath: string;
  itemName: string;
  subMchId?: string;
  taxCode?: string;
  goodsCategory?: string;
  taxRateBps?: number;
  remark?: string;
}

/**
 * Web user authentication configuration.
 */
export interface WebAuthConfig {
  tokenSecret: string;
  tokenTtlSeconds: number;
  authServiceEnabled: boolean;
  authServiceBaseUrl: string;
  authServiceLoginPath: string;
  authServiceClientId: string;
  authServiceRedirectUri: string;
  wechatOAuthMode: 'offiaccount' | 'website';
  wechatOAuthAppId?: string;
  wechatOAuthAppSecret?: string;
  wechatOAuthRedirectUrl?: string;
  wechatOAuthScope: string;
  wechatOAuthAuthorizeBaseUrl: string;
  wechatOAuthApiBaseUrl: string;
  wechatOAuthStateTtlSeconds: number;
}
