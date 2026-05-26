export type BillingMode = 'per_job_wechat_native' | 'prepaid_balance' | 'monthly_invoice';

export type OrderStatus =
  | 'created'
  | 'pending_payment'
  | 'paid'
  | 'expired'
  | 'cancelled'
  | 'refunded';

export interface BillingOrder {
  id: string;
  tenantId: string;
  jobId?: string;
  status: OrderStatus;
  amountCents: number;
  currency: 'CNY';
  provider: 'wechat_native';
  outTradeNo: string;
  transactionId?: string;
  codeUrl?: string;
  expiresAt?: string;
  paidAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWechatNativeOrderInput {
  tenantId: string;
  jobId: string;
  amountCents: number;
  description: string;
  notifyUrl: string;
}
