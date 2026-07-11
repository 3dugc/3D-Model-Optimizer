import type { ServerConfig } from './types';
import { parseCallbackSigningSecrets } from '../callbacks/callback-secrets';

export type RuntimeRole = 'api' | 'worker' | 'dispatcher' | 'monitor';

export class RuntimeConfigurationError extends Error {
  readonly code = 'INVALID_RUNTIME_CONFIGURATION';
  readonly role: RuntimeRole;
  readonly errors: string[];

  constructor(role: RuntimeRole, errors: string[]) {
    super(`Invalid ${role} runtime configuration: ${errors.join(' ')}`);
    this.name = 'RuntimeConfigurationError';
    this.role = role;
    this.errors = errors;
  }
}

export function validateConfig(current: ServerConfig): string[] {
  const warnings: string[] = [];
  if (process.env.NODE_ENV === 'production' && current.webAuth.tokenSecret === 'dev-web-auth-secret') {
    warnings.push('WEB_AUTH_SECRET is using the development default in production.');
  }
  if (process.env.NODE_ENV === 'production' && current.allowQueryAuthTokens) {
    warnings.push('ALLOW_QUERY_AUTH_TOKENS is enabled in production; keep only for legacy download links.');
  }
  if (current.billing.mode === 'wechat_native' && current.billing.paymentServiceUrl && !current.billing.paymentServiceApiKey) {
    warnings.push('PAYMENT_SERVICE_URL is configured without PAYMENT_SERVICE_API_KEY.');
  }
  if (current.cloud.globalMaxWorkerSlots > 0 && current.cloud.dispatcherSlotsPerInstance > current.cloud.globalMaxWorkerSlots) {
    warnings.push('GLOBAL_MAX_WORKER_SLOTS is lower than DISPATCHER_SLOTS_PER_INSTANCE; dispatcher may scale to zero.');
  }
  return warnings;
}

export function getRuntimeConfigErrors(role: RuntimeRole, current: ServerConfig): string[] {
  if (process.env.NODE_ENV !== 'production') return [];

  const errors: string[] = [];
  if (role === 'api') {
    if (['dev-web-auth-secret', 'change-me', 'replace-me'].includes(current.webAuth.tokenSecret.toLowerCase())) {
      errors.push('WEB_AUTH_SECRET must not use the development default in production.');
    }
    if (current.billing.mode === 'wechat_native' && current.billing.paymentServiceUrl &&
        !current.billing.paymentServiceApiKey) {
      errors.push('PAYMENT_SERVICE_API_KEY is required when PAYMENT_SERVICE_URL is used with wechat_native billing.');
    }
  }
  if (role === 'api' || role === 'worker') {
    try {
      parseCallbackSigningSecrets();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'CALLBACK_SIGNING_SECRETS is invalid.');
    }
  }

  const usesRemoteCloudRuntime = current.cloud.provider === 'tencent' || current.cloud.queueProvider === 'tdmq-cmq';
  if (usesRemoteCloudRuntime && current.database.stateStoreProvider === 'local') {
    errors.push(
      `${role} cannot use STATE_STORE_PROVIDER=local with Tencent Cloud or TDMQ-CMQ in production.`
    );
  }
  return errors;
}

export function assertRuntimeConfig(role: RuntimeRole, current: ServerConfig): void {
  const errors = getRuntimeConfigErrors(role, current);
  if (errors.length > 0) throw new RuntimeConfigurationError(role, errors);
}
