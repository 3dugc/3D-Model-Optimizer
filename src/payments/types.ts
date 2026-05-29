export interface CreateNativePaymentInput {
  amountCents: number;
  currency: 'CNY';
  description: string;
  outTradeNo: string;
  notifyUrl: string;
  expiresAt?: string;
  attach?: string;
  supportFapiao?: boolean;
}

export interface NativePaymentOrder {
  codeUrl: string;
}

export interface PaymentNotification {
  outTradeNo: string;
  transactionId?: string;
  tradeState: string;
  successTime?: string;
  amountCents?: number;
}

export interface PaymentProvider {
  createNativeOrder(input: CreateNativePaymentInput): Promise<NativePaymentOrder>;
  queryOrderByOutTradeNo(outTradeNo: string): Promise<PaymentNotification>;
  parsePaymentNotification(headers: Record<string, unknown>, rawBody: Buffer | string): Promise<PaymentNotification>;
}
