import { config } from '../config';
import { createPaymentProvider, type PaymentProvider } from '../payments';
import { HttpError } from '../utils/http-error';
import type { InvoiceBuyer, InvoiceItem, InvoiceProviderName, InvoiceRequest, InvoiceRequestStatus } from './types';

export interface IssueRechargeInvoiceInput {
  request: InvoiceRequest;
  item: InvoiceItem;
}

export interface IssueRechargeInvoiceResult {
  status: Extract<InvoiceRequestStatus, 'issuing' | 'issued'>;
  providerApplyId?: string;
  providerInvoiceId?: string;
  invoiceNo?: string;
  downloadUrl?: string;
}

export interface InvoiceIssueProvider {
  readonly providerName: InvoiceProviderName;
  issueRechargeInvoice(input: IssueRechargeInvoiceInput): Promise<IssueRechargeInvoiceResult>;
  refreshDownloadUrl?(request: InvoiceRequest): Promise<string | undefined>;
}

export class ManualInvoiceProvider implements InvoiceIssueProvider {
  readonly providerName = 'manual' as const;

  async issueRechargeInvoice(input: IssueRechargeInvoiceInput): Promise<IssueRechargeInvoiceResult> {
    return {
      status: 'issuing',
      providerApplyId: input.request.providerApplyId,
    };
  }
}

export class WechatFapiaoInvoiceProvider implements InvoiceIssueProvider {
  readonly providerName = 'wechat_fapiao' as const;

  constructor(private readonly payments: PaymentProvider = createPaymentProvider()) {}

  async issueRechargeInvoice(input: IssueRechargeInvoiceInput): Promise<IssueRechargeInvoiceResult> {
    if (!this.payments.createWechatInvoiceApplication) {
      throw new HttpError(
        501,
        'WECHAT_FAPIAO_PROVIDER_NOT_CONFIGURED',
        'The payment service does not expose WeChat fapiao application APIs.'
      );
    }
    if (!config.invoice.taxCode) {
      throw new HttpError(503, 'INVOICE_TAX_CODE_REQUIRED', 'WECHAT_FAPIAO_TAX_CODE is required before issuing invoices.');
    }

    const fapiaoId = createFapiaoId(input.request.id);
    const result = await this.payments.createWechatInvoiceApplication({
      scene: 'WITH_WECHATPAY',
      fapiaoApplyId: input.request.outTradeNo,
      subMchid: config.invoice.subMchId,
      buyerInformation: toWechatBuyerInformation(input.request.buyer),
      fapiaoInformation: [
        {
          fapiaoId,
          totalAmount: input.request.amountCents,
          needList: false,
          remark: config.invoice.remark,
          items: [
            {
              taxCode: config.invoice.taxCode,
              goodsCategory: config.invoice.goodsCategory,
              goodsName: config.invoice.itemName,
              quantity: 100000000,
              totalAmount: input.item.amountCents,
              taxRate: config.invoice.taxRateBps,
              discount: false,
            },
          ],
        },
      ],
    });

    return {
      status: result.status === 'ISSUED' ? 'issued' : 'issuing',
      providerApplyId: result.fapiaoApplyId || input.request.outTradeNo,
      providerInvoiceId: result.fapiaoId || fapiaoId,
      invoiceNo: result.invoiceNo,
      downloadUrl: result.downloadUrl,
    };
  }

  async refreshDownloadUrl(request: InvoiceRequest): Promise<string | undefined> {
    if (!this.payments.getWechatInvoiceFiles) return undefined;
    const files = await this.payments.getWechatInvoiceFiles(request.providerApplyId, request.providerInvoiceId);
    const issued = files.find((file) => file.status === 'ISSUED' && file.downloadUrl);
    return issued?.downloadUrl;
  }
}

function createFapiaoId(invoiceRequestId: string): string {
  return `FP${invoiceRequestId.replace(/-/g, '').slice(0, 30)}`.slice(0, 32).toUpperCase();
}

function toWechatBuyerInformation(buyer: InvoiceBuyer): {
  type: 'INDIVIDUAL' | 'ORGANIZATION';
  name: string;
  taxpayerId?: string;
  address?: string;
  telephone?: string;
  bankName?: string;
  bankAccount?: string;
} {
  return {
    type: buyer.type,
    name: buyer.name,
    taxpayerId: buyer.taxpayerId,
    address: buyer.address,
    telephone: buyer.telephone,
    bankName: buyer.bankName,
    bankAccount: buyer.bankAccount,
  };
}

export function createInvoiceIssueProvider(payments: PaymentProvider = createPaymentProvider()): InvoiceIssueProvider {
  if (config.invoice.provider === 'wechat_fapiao') return new WechatFapiaoInvoiceProvider(payments);
  return new ManualInvoiceProvider();
}
