import { parseBoolean, parsePositiveNumber, parsePositiveNumberCsv } from './parsers';
import type { BillingConfig } from './types';

export function parseBillingConfig(): BillingConfig {
  return {
    mode:
      process.env.BILLING_MODE === 'wechat_native'
        ? 'wechat_native'
        : process.env.BILLING_MODE === 'disabled'
          ? 'disabled'
          : 'mock',
    orderStorePath: process.env.ORDER_STORE_PATH || 'data/cloud/orders.json',
    accountStorePath: process.env.ACCOUNT_STORE_PATH || 'data/cloud/accounts.json',
    defaultJobPriceCents: parsePositiveNumber(process.env.DEFAULT_JOB_PRICE_CENTS, 100),
    rechargePackagesCents: parsePositiveNumberCsv(process.env.RECHARGE_PACKAGES_CENTS, [800, 1800, 3800, 8800]),
    paymentServiceUrl: process.env.PAYMENT_SERVICE_URL,
    paymentServiceApiKey: process.env.PAYMENT_SERVICE_API_KEY,
    wechatNotifyUrl: process.env.WECHAT_PAY_NOTIFY_URL,
    wechatAppId: process.env.WECHAT_PAY_APP_ID,
    wechatMchId: process.env.WECHAT_PAY_MCH_ID,
    wechatPrivateKey: process.env.WECHAT_PAY_PRIVATE_KEY,
    wechatPrivateKeyPath: process.env.WECHAT_PAY_PRIVATE_KEY_PATH,
    wechatCertSerialNo: process.env.WECHAT_PAY_CERT_SERIAL_NO,
    wechatApiV3Key: process.env.WECHAT_PAY_API_V3_KEY,
    wechatPlatformPublicKey: process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY,
    wechatPlatformPublicKeyPath: process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH,
    wechatPlatformCertificate: process.env.WECHAT_PAY_PLATFORM_CERT,
    wechatPlatformCertificatePath: process.env.WECHAT_PAY_PLATFORM_CERT_PATH,
    wechatApiBaseUrl: process.env.WECHAT_PAY_API_BASE_URL || 'https://api.mch.weixin.qq.com',
    wechatSupportFapiao: parseBoolean(process.env.WECHAT_PAY_SUPPORT_FAPIAO, false),
  };
}
