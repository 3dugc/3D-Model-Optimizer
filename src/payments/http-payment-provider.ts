import type { CreateNativePaymentInput, NativePaymentOrder, PaymentNotification, PaymentProvider } from './types';

interface PaymentServiceOrderResponse {
  order?: NativePaymentOrder;
  payment?: PaymentNotification;
  error?: {
    code?: string;
    message?: string;
  };
}

export class HttpPaymentProvider implements PaymentProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string
  ) {}

  async createNativeOrder(input: CreateNativePaymentInput): Promise<NativePaymentOrder> {
    const body = await this.request<PaymentServiceOrderResponse>('/v1/native-orders', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!body.order) throw new Error('Payment service response did not include order.');
    return body.order;
  }

  async queryOrderByOutTradeNo(outTradeNo: string): Promise<PaymentNotification> {
    const body = await this.request<PaymentServiceOrderResponse>(
      `/v1/orders/out-trade-no/${encodeURIComponent(outTradeNo)}`,
      { method: 'GET' }
    );
    if (!body.payment) throw new Error('Payment service response did not include payment.');
    return body.payment;
  }

  async parsePaymentNotification(headers: Record<string, unknown>, rawBody: Buffer | string): Promise<PaymentNotification> {
    const rawBodyBase64 = Buffer.isBuffer(rawBody)
      ? rawBody.toString('base64')
      : Buffer.from(rawBody, 'utf8').toString('base64');
    const body = await this.request<PaymentServiceOrderResponse>('/v1/notifications/wechat/parse', {
      method: 'POST',
      body: JSON.stringify({ headers, rawBodyBase64 }),
    });
    if (!body.payment) throw new Error('Payment service response did not include payment.');
    return body.payment;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    };
    if (this.apiKey) headers['x-payment-service-key'] = this.apiKey;

    const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as PaymentServiceOrderResponse) : {};
    if (!response.ok) {
      throw new Error(parsed.error?.message || `Payment service request failed: ${response.status} ${text}`);
    }
    return parsed as T;
  }
}
