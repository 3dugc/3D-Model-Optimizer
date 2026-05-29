import type { CreateNativePaymentInput, NativePaymentOrder, PaymentNotification, PaymentProvider } from './types';

export class MockPaymentProvider implements PaymentProvider {
  async createNativeOrder(input: CreateNativePaymentInput): Promise<NativePaymentOrder> {
    return { codeUrl: `weixin://wxpay/mock/recharge/${input.outTradeNo}/${input.amountCents}` };
  }

  async queryOrderByOutTradeNo(outTradeNo: string): Promise<PaymentNotification> {
    return {
      outTradeNo,
      tradeState: 'NOTPAY',
    };
  }

  async parsePaymentNotification(_headers: Record<string, unknown>, rawBody: Buffer | string): Promise<PaymentNotification> {
    const body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody) as {
      outTradeNo?: string;
      transactionId?: string;
      orderId?: string;
    };
    return {
      outTradeNo: body.outTradeNo || body.orderId || '',
      transactionId: body.transactionId,
      tradeState: 'SUCCESS',
    };
  }
}
