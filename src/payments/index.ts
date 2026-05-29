import { config } from '../config';
import { HttpPaymentProvider } from './http-payment-provider';
import { MockPaymentProvider } from './mock-payment-provider';
import type { PaymentProvider } from './types';

export * from './types';
export * from './http-payment-provider';
export * from './mock-payment-provider';

export function createPaymentProvider(): PaymentProvider {
  if (config.billing.mode === 'wechat_native') {
    if (!config.billing.paymentServiceUrl) {
      throw new Error('PAYMENT_SERVICE_URL is required when BILLING_MODE=wechat_native.');
    }
    return new HttpPaymentProvider(config.billing.paymentServiceUrl, config.billing.paymentServiceApiKey);
  }
  return new MockPaymentProvider();
}
