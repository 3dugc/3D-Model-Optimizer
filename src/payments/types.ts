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

export interface WechatInvoiceBuyer {
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

export interface WechatInvoiceNotification {
  eventType: string;
  dedupeKey?: string;
  mchId?: string;
  subMchid?: string;
  fapiaoApplyId?: string;
  outTradeNo?: string;
  buyer?: WechatInvoiceBuyer;
  raw?: unknown;
}

export interface WechatInvoiceApplicationItem {
  taxCode: string;
  goodsCategory?: string;
  goodsName: string;
  quantity: number;
  totalAmount: number;
  taxRate?: number;
  discount: boolean;
}

export interface WechatInvoiceApplicationInfo {
  fapiaoId: string;
  totalAmount: number;
  needList?: boolean;
  remark?: string;
  items: WechatInvoiceApplicationItem[];
}

export interface CreateWechatInvoiceApplicationInput {
  scene: 'WITH_WECHATPAY' | 'WITHOUT_WECHATPAY';
  fapiaoApplyId: string;
  subMchid?: string;
  buyerInformation: WechatInvoiceBuyer;
  fapiaoInformation: WechatInvoiceApplicationInfo[];
}

export interface WechatInvoiceApplicationResult {
  fapiaoApplyId?: string;
  fapiaoId?: string;
  status?: string;
  invoiceNo?: string;
  downloadUrl?: string;
  raw?: unknown;
}

export interface WechatInvoiceFile {
  fapiaoId?: string;
  downloadUrl?: string;
  status?: string;
}

export interface WechatInvoiceSubMerchantStatus {
  subMchid: string;
  available: boolean;
}

export interface PaymentProvider {
  createNativeOrder(input: CreateNativePaymentInput): Promise<NativePaymentOrder>;
  queryOrderByOutTradeNo(outTradeNo: string): Promise<PaymentNotification>;
  parsePaymentNotification(headers: Record<string, unknown>, rawBody: Buffer | string): Promise<PaymentNotification>;
  parseWechatInvoiceNotification?(
    headers: Record<string, unknown>,
    rawBody: Buffer | string
  ): Promise<WechatInvoiceNotification>;
  getWechatInvoiceUserTitle?(
    fapiaoApplyId: string,
    scene?: 'WITH_WECHATPAY' | 'WITHOUT_WECHATPAY'
  ): Promise<WechatInvoiceBuyer>;
  createWechatInvoiceApplication?(
    input: CreateWechatInvoiceApplicationInput
  ): Promise<WechatInvoiceApplicationResult>;
  getWechatInvoiceFiles?(fapiaoApplyId: string, fapiaoId?: string): Promise<WechatInvoiceFile[]>;
  checkWechatInvoiceSubMerchantStatus?(subMchid: string): Promise<WechatInvoiceSubMerchantStatus>;
}
