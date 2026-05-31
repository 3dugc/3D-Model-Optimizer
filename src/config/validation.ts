import type { ServerConfig } from './types';

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
