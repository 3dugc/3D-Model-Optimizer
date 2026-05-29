export type InvoiceRequestStatus = 'submitted' | 'issuing' | 'issued' | 'failed' | 'reverse_pending' | 'reversed';
export type InvoiceProviderName = 'manual' | 'wechat_fapiao';
export type InvoiceTitleType = 'personal' | 'company';

export interface InvoiceBuyer {
  type: 'INDIVIDUAL' | 'ORGANIZATION';
  name: string;
  taxpayerId?: string;
  address?: string;
  telephone?: string;
  bankName?: string;
  bankAccount?: string;
  phoneMasked?: string;
  emailMasked?: string;
}

export interface InvoiceRequest {
  id: string;
  userId: string;
  tenantId: string;
  rechargeOrderId: string;
  outTradeNo: string;
  amountCents: number;
  currency: 'CNY';
  status: InvoiceRequestStatus;
  invoiceType: 'digital_normal';
  titleType: InvoiceTitleType;
  title: string;
  taxNo?: string;
  buyer: InvoiceBuyer;
  provider: InvoiceProviderName;
  providerApplyId: string;
  providerInvoiceId?: string;
  invoiceNo?: string;
  downloadUrl?: string;
  failureReason?: string;
  createdAt: string;
  submittedAt: string;
  issuedAt?: string;
  reversedAt?: string;
  updatedAt: string;
}

export interface InvoiceItem {
  id: string;
  invoiceRequestId: string;
  rechargeOrderId: string;
  description: string;
  amountCents: number;
  createdAt: string;
}

export interface InvoiceProviderEvent {
  id: string;
  provider: InvoiceProviderName | 'wechat_pay';
  eventType: string;
  dedupeKey: string;
  invoiceRequestId?: string;
  rechargeOrderId?: string;
  resourceId?: string;
  payload?: unknown;
  processedAt?: string;
  createdAt: string;
}

export interface CreateRechargeInvoiceFromWechatTitleInput {
  outTradeNo: string;
  fapiaoApplyId?: string;
  buyer?: InvoiceBuyer;
  eventType?: string;
  dedupeKey?: string;
  rawEvent?: unknown;
}

export interface MarkInvoiceIssuedInput {
  providerApplyId?: string;
  outTradeNo?: string;
  providerInvoiceId?: string;
  invoiceNo?: string;
  downloadUrl?: string;
  rawEvent?: unknown;
  eventType?: string;
  dedupeKey?: string;
}

export interface MarkInvoiceIssuedManuallyInput {
  providerInvoiceId?: string;
  invoiceNo?: string;
  downloadUrl: string;
}
