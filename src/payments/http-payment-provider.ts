import type {
  CreateNativePaymentInput,
  CreateWechatInvoiceApplicationInput,
  NativePaymentOrder,
  PaymentNotification,
  PaymentProvider,
  WechatInvoiceApplicationResult,
  WechatInvoiceBuyer,
  WechatInvoiceFile,
  WechatInvoiceNotification,
  WechatInvoiceSubMerchantStatus,
} from './types';

interface PaymentServiceOrderResponse {
  order?: NativePaymentOrder;
  payment?: PaymentNotification;
  invoiceEvent?: WechatInvoiceNotification;
  buyer?: WechatInvoiceBuyer;
  invoiceApplication?: WechatInvoiceApplicationResult;
  files?: WechatInvoiceFile[];
  subMerchantStatus?: WechatInvoiceSubMerchantStatus;
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

  async parseWechatInvoiceNotification(
    headers: Record<string, unknown>,
    rawBody: Buffer | string
  ): Promise<WechatInvoiceNotification> {
    const rawBodyBase64 = Buffer.isBuffer(rawBody)
      ? rawBody.toString('base64')
      : Buffer.from(rawBody, 'utf8').toString('base64');
    const body = await this.request<PaymentServiceOrderResponse>('/v1/fapiao/notifications/parse', {
      method: 'POST',
      body: JSON.stringify({ headers, rawBodyBase64 }),
    });
    if (!body.invoiceEvent) throw new Error('Payment service response did not include invoiceEvent.');
    return body.invoiceEvent;
  }

  async getWechatInvoiceUserTitle(
    fapiaoApplyId: string,
    scene: 'WITH_WECHATPAY' | 'WITHOUT_WECHATPAY' = 'WITH_WECHATPAY'
  ): Promise<WechatInvoiceBuyer> {
    const path = `/v1/fapiao/user-title/${encodeURIComponent(fapiaoApplyId)}?scene=${encodeURIComponent(scene)}`;
    const body = await this.request<PaymentServiceOrderResponse>(path, { method: 'GET' });
    if (!body.buyer) throw new Error('Payment service response did not include buyer.');
    return body.buyer;
  }

  async createWechatInvoiceApplication(
    input: CreateWechatInvoiceApplicationInput
  ): Promise<WechatInvoiceApplicationResult> {
    const body = await this.request<PaymentServiceOrderResponse>('/v1/fapiao/applications', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!body.invoiceApplication) throw new Error('Payment service response did not include invoiceApplication.');
    return body.invoiceApplication;
  }

  async getWechatInvoiceFiles(fapiaoApplyId: string, fapiaoId?: string): Promise<WechatInvoiceFile[]> {
    const path = `/v1/fapiao/applications/${encodeURIComponent(fapiaoApplyId)}/files${
      fapiaoId ? `?fapiaoId=${encodeURIComponent(fapiaoId)}` : ''
    }`;
    const body = await this.request<PaymentServiceOrderResponse>(path, { method: 'GET' });
    return body.files || [];
  }

  async checkWechatInvoiceSubMerchantStatus(subMchid: string): Promise<WechatInvoiceSubMerchantStatus> {
    const body = await this.request<PaymentServiceOrderResponse>(
      `/v1/fapiao/merchant/${encodeURIComponent(subMchid)}/check`,
      { method: 'POST' }
    );
    if (!body.subMerchantStatus) throw new Error('Payment service response did not include subMerchantStatus.');
    return body.subMerchantStatus;
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
