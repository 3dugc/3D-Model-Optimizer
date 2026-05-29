import type {
  CreateNativePaymentInput,
  CreateWechatInvoiceApplicationInput,
  NativePaymentOrder,
  PaymentNotification,
  PaymentProvider,
  WechatInvoiceBuyer,
  WechatInvoiceFile,
  WechatInvoiceNotification,
} from './types';

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

  async parseWechatInvoiceNotification(
    _headers: Record<string, unknown>,
    rawBody: Buffer | string
  ): Promise<WechatInvoiceNotification> {
    const body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody) as WechatInvoiceNotification & {
      fapiao_apply_id?: string;
      out_trade_no?: string;
    };
    return {
      eventType: body.eventType || 'MOCK_FAPIAO_TITLE_FILLED',
      dedupeKey: body.dedupeKey,
      fapiaoApplyId: body.fapiaoApplyId || body.fapiao_apply_id,
      outTradeNo: body.outTradeNo || body.out_trade_no,
      buyer: body.buyer,
      raw: body,
    };
  }

  async getWechatInvoiceUserTitle(fapiaoApplyId: string): Promise<WechatInvoiceBuyer> {
    return {
      type: 'INDIVIDUAL',
      name: `Mock buyer ${fapiaoApplyId}`,
    };
  }

  async createWechatInvoiceApplication(
    input: CreateWechatInvoiceApplicationInput
  ): Promise<{ fapiaoApplyId: string; fapiaoId?: string; status: string; raw: unknown }> {
    return {
      fapiaoApplyId: input.fapiaoApplyId,
      fapiaoId: input.fapiaoInformation[0]?.fapiaoId,
      status: 'ISSUE_ACCEPTED',
      raw: input,
    };
  }

  async getWechatInvoiceFiles(fapiaoApplyId: string, fapiaoId?: string): Promise<WechatInvoiceFile[]> {
    return [
      {
        fapiaoId,
        status: 'ISSUED',
        downloadUrl: `https://pay.weixin.qq.com/mock/fapiao/${fapiaoApplyId}.pdf`,
      },
    ];
  }
}
