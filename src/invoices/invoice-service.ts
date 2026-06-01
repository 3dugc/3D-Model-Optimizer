import { v4 as uuidv4 } from 'uuid';
import { accountStore, type AccountStore } from '../accounts/account-store';
import { config } from '../config';
import { createPaymentProvider, type PaymentProvider, type WechatInvoiceNotification } from '../payments';
import { HttpError } from '../utils/http-error';
import { invoiceStore, type InvoiceStore } from './invoice-store';
import { createInvoiceIssueProvider, type InvoiceIssueProvider } from './invoice-provider';
import type {
  CreateRechargeInvoiceFromWechatTitleInput,
  InvoiceBuyer,
  InvoiceItem,
  MarkInvoiceIssuedManuallyInput,
  InvoiceProviderEvent,
  InvoiceRequest,
  MarkInvoiceIssuedInput,
} from './types';

function nowIso(): string {
  return new Date().toISOString();
}

function maskPhone(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function maskEmail(value?: string): string | undefined {
  if (!value) return undefined;
  const [name, domain] = value.split('@');
  if (!domain) return value;
  return `${name.slice(0, 2)}***@${domain}`;
}

function normalizeBuyer(input: InvoiceBuyer): InvoiceBuyer {
  const name = input.name?.trim();
  if (!name) throw new HttpError(400, 'INVOICE_TITLE_REQUIRED', 'Invoice title is required.');
  if (input.type === 'ORGANIZATION' && !input.taxpayerId) {
    throw new HttpError(400, 'INVOICE_TAX_NO_REQUIRED', 'Company invoice requires taxpayerId.');
  }
  return {
    type: input.type,
    name,
    taxpayerId: input.taxpayerId?.trim(),
    address: input.address?.trim(),
    telephone: input.telephone?.trim(),
    bankName: input.bankName?.trim(),
    bankAccount: input.bankAccount?.trim(),
    phoneMasked: input.phoneMasked ? maskPhone(input.phoneMasked) : undefined,
    emailMasked: input.emailMasked ? maskEmail(input.emailMasked) : undefined,
  };
}

function buyerFromNotification(event: WechatInvoiceNotification): InvoiceBuyer | undefined {
  if (!event.buyer) return undefined;
  return normalizeBuyer(event.buyer);
}

function toProviderEvent(input: {
  eventType: string;
  dedupeKey: string;
  payload?: unknown;
  invoiceRequestId?: string;
  rechargeOrderId?: string;
}): InvoiceProviderEvent {
  const now = nowIso();
  return {
    id: uuidv4(),
    provider: 'wechat_pay',
    eventType: input.eventType,
    dedupeKey: input.dedupeKey,
    payload: input.payload,
    invoiceRequestId: input.invoiceRequestId,
    rechargeOrderId: input.rechargeOrderId,
    processedAt: now,
    createdAt: now,
  };
}

export class InvoiceService {
  constructor(
    private readonly store: InvoiceStore = invoiceStore,
    private readonly accounts: AccountStore = accountStore,
    private readonly issueProvider: InvoiceIssueProvider = createInvoiceIssueProvider(),
    private readonly payments: PaymentProvider = createPaymentProvider()
  ) {}

  async handleWechatTitleNotification(headers: Record<string, unknown>, rawBody: Buffer | string): Promise<InvoiceRequest> {
    const event = await this.parseWechatInvoiceEvent(headers, rawBody);
    const outTradeNo = event.outTradeNo || event.fapiaoApplyId;
    if (!outTradeNo) throw new HttpError(400, 'WECHAT_FAPIAO_OUT_TRADE_NO_REQUIRED', 'Invoice event lacks outTradeNo.');
    return this.createRechargeInvoiceFromWechatTitle({
      outTradeNo,
      fapiaoApplyId: event.fapiaoApplyId || outTradeNo,
      buyer: buyerFromNotification(event),
      eventType: event.eventType,
      dedupeKey: event.dedupeKey || `${event.eventType}:${event.fapiaoApplyId || outTradeNo}`,
      rawEvent: event.raw,
    });
  }

  async handleWechatNotification(headers: Record<string, unknown>, rawBody: Buffer | string): Promise<InvoiceRequest> {
    const event = await this.parseWechatInvoiceEvent(headers, rawBody);
    const raw = event.raw && typeof event.raw === 'object' ? (event.raw as Record<string, unknown>) : {};
    const status = typeof raw.status === 'string' ? raw.status.toUpperCase() : '';
    const eventType = event.eventType.toUpperCase();
    if (status === 'REVERSED' || eventType.includes('REVERSE')) {
      return this.markReversedFromEvent(event);
    }
    if (status === 'ISSUED' || eventType.includes('ISSUED')) {
      return this.markIssuedFromEvent(event);
    }
    const outTradeNo = event.outTradeNo || event.fapiaoApplyId;
    if (!outTradeNo) throw new HttpError(400, 'WECHAT_FAPIAO_OUT_TRADE_NO_REQUIRED', 'Invoice event lacks outTradeNo.');
    return this.createRechargeInvoiceFromWechatTitle({
      outTradeNo,
      fapiaoApplyId: event.fapiaoApplyId || outTradeNo,
      buyer: buyerFromNotification(event),
      eventType: event.eventType,
      dedupeKey: event.dedupeKey || `${event.eventType}:${event.fapiaoApplyId || outTradeNo}`,
      rawEvent: event.raw,
    });
  }

  async createRechargeInvoiceFromWechatTitle(input: CreateRechargeInvoiceFromWechatTitleInput): Promise<InvoiceRequest> {
    const order = await this.accounts.findRechargeOrderByOutTradeNo(input.outTradeNo);
    if (!order) throw new HttpError(404, 'RECHARGE_ORDER_NOT_FOUND', 'Recharge order not found for invoice.');
    if (order.status !== 'paid') {
      throw new HttpError(409, 'RECHARGE_ORDER_NOT_PAID', 'Only paid recharge orders can be invoiced.');
    }

    const existing = await this.store.findInvoiceRequestByRechargeOrderId(order.id);
    if (existing) return existing;

    const buyer = await this.resolveBuyer(input.buyer, input.fapiaoApplyId || input.outTradeNo);
    const now = nowIso();
    const providerApplyId = input.fapiaoApplyId || order.outTradeNo;
    const request: InvoiceRequest = {
      id: uuidv4(),
      userId: order.userId,
      tenantId: order.tenantId,
      rechargeOrderId: order.id,
      outTradeNo: order.outTradeNo,
      amountCents: order.amountCents,
      currency: 'CNY',
      status: 'submitted',
      invoiceType: 'digital_normal',
      titleType: buyer.type === 'ORGANIZATION' ? 'company' : 'personal',
      title: buyer.name,
      taxNo: buyer.taxpayerId,
      buyer,
      provider: this.issueProvider.providerName,
      providerApplyId,
      createdAt: now,
      submittedAt: now,
      updatedAt: now,
    };
    const item: InvoiceItem = {
      id: uuidv4(),
      invoiceRequestId: request.id,
      rechargeOrderId: order.id,
      description: config.invoice.itemName,
      amountCents: order.amountCents,
      createdAt: now,
    };
    const event = input.eventType && input.dedupeKey
      ? toProviderEvent({
          eventType: input.eventType,
          dedupeKey: input.dedupeKey,
          payload: input.rawEvent,
          invoiceRequestId: request.id,
          rechargeOrderId: order.id,
        })
      : undefined;
    await this.store.createInvoiceRequest({ request, item, event });

    try {
      const issued = await this.issueProvider.issueRechargeInvoice({ request, item });
      return this.store.updateInvoiceRequest({
        ...request,
        status: issued.status,
        providerApplyId: issued.providerApplyId || request.providerApplyId,
        providerInvoiceId: issued.providerInvoiceId,
        invoiceNo: issued.invoiceNo,
        downloadUrl: issued.downloadUrl,
        issuedAt: issued.status === 'issued' ? nowIso() : undefined,
        updatedAt: nowIso(),
      });
    } catch (error) {
      const failed = await this.store.updateInvoiceRequest({
        ...request,
        status: 'failed',
        failureReason: error instanceof Error ? error.message : String(error),
        updatedAt: nowIso(),
      });
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'INVOICE_PROVIDER_FAILED', failed.failureReason || 'Invoice provider failed.');
    }
  }

  async createRechargeOrderInvoice(userId: string, orderId: string, buyer: InvoiceBuyer): Promise<InvoiceRequest> {
    const order = await this.accounts.getRechargeOrder(orderId);
    if (!order || order.userId !== userId) {
      throw new HttpError(404, 'RECHARGE_ORDER_NOT_FOUND', 'Recharge order not found.');
    }
    return this.createRechargeInvoiceFromWechatTitle({
      outTradeNo: order.outTradeNo,
      fapiaoApplyId: order.outTradeNo,
      buyer,
    });
  }

  async markIssuedFromWechatNotification(input: MarkInvoiceIssuedInput): Promise<InvoiceRequest> {
    const request = await this.findByProviderReference(input);
    if (!request) throw new HttpError(404, 'INVOICE_REQUEST_NOT_FOUND', 'Invoice request not found.');

    if (input.eventType && input.dedupeKey) {
      const recorded = await this.store.recordProviderEvent(
        toProviderEvent({
          eventType: input.eventType,
          dedupeKey: input.dedupeKey,
          payload: input.rawEvent,
          invoiceRequestId: request.id,
          rechargeOrderId: request.rechargeOrderId,
        })
      );
      if (recorded.duplicate && request.status === 'issued') return request;
    }

    return this.store.updateInvoiceRequest({
      ...request,
      status: 'issued',
      providerInvoiceId: input.providerInvoiceId || request.providerInvoiceId,
      invoiceNo: input.invoiceNo || request.invoiceNo,
      downloadUrl: input.downloadUrl || request.downloadUrl,
      issuedAt: request.issuedAt || nowIso(),
      updatedAt: nowIso(),
    });
  }

  async handleWechatIssuedNotification(headers: Record<string, unknown>, rawBody: Buffer | string): Promise<InvoiceRequest> {
    return this.markIssuedFromEvent(await this.parseWechatInvoiceEvent(headers, rawBody));
  }

  async handleWechatReverseNotification(headers: Record<string, unknown>, rawBody: Buffer | string): Promise<InvoiceRequest> {
    return this.markReversedFromEvent(await this.parseWechatInvoiceEvent(headers, rawBody));
  }

  async markInvoiceIssuedManually(
    invoiceRequestId: string,
    input: MarkInvoiceIssuedManuallyInput
  ): Promise<InvoiceRequest> {
    const request = await this.store.getInvoiceRequest(invoiceRequestId);
    if (!request) throw new HttpError(404, 'INVOICE_REQUEST_NOT_FOUND', 'Invoice request not found.');
    const downloadUrl = input.downloadUrl.trim();
    if (!downloadUrl) throw new HttpError(400, 'INVOICE_DOWNLOAD_URL_REQUIRED', 'downloadUrl is required.');
    return this.store.updateInvoiceRequest({
      ...request,
      status: 'issued',
      providerInvoiceId: input.providerInvoiceId?.trim() || request.providerInvoiceId,
      invoiceNo: input.invoiceNo?.trim() || request.invoiceNo,
      downloadUrl,
      issuedAt: request.issuedAt || nowIso(),
      updatedAt: nowIso(),
    });
  }

  private async parseWechatInvoiceEvent(
    headers: Record<string, unknown>,
    rawBody: Buffer | string
  ): Promise<WechatInvoiceNotification> {
    if (!this.payments.parseWechatInvoiceNotification) {
      throw new HttpError(
        501,
        'WECHAT_FAPIAO_NOTIFICATION_PARSE_NOT_CONFIGURED',
        'The payment service does not expose WeChat fapiao notification parsing.'
      );
    }
    return this.payments.parseWechatInvoiceNotification(headers, rawBody);
  }

  private async markIssuedFromEvent(event: WechatInvoiceNotification): Promise<InvoiceRequest> {
    const raw = event.raw && typeof event.raw === 'object' ? (event.raw as Record<string, unknown>) : {};
    return this.markIssuedFromWechatNotification({
      providerApplyId: event.fapiaoApplyId,
      outTradeNo: event.outTradeNo,
      providerInvoiceId: typeof raw.fapiao_id === 'string' ? raw.fapiao_id : undefined,
      invoiceNo: typeof raw.invoice_no === 'string' ? raw.invoice_no : undefined,
      downloadUrl: typeof raw.download_url === 'string' ? raw.download_url : undefined,
      rawEvent: event.raw,
      eventType: event.eventType,
      dedupeKey: event.dedupeKey || `${event.eventType}:${event.fapiaoApplyId || event.outTradeNo || ''}`,
    });
  }

  private async markReversedFromEvent(event: WechatInvoiceNotification): Promise<InvoiceRequest> {
    const request = await this.findByProviderReference({
      providerApplyId: event.fapiaoApplyId,
      outTradeNo: event.outTradeNo,
    });
    if (!request) throw new HttpError(404, 'INVOICE_REQUEST_NOT_FOUND', 'Invoice request not found.');
    await this.store.recordProviderEvent(
      toProviderEvent({
        eventType: event.eventType,
        dedupeKey: event.dedupeKey || `${event.eventType}:${event.fapiaoApplyId || event.outTradeNo || ''}`,
        payload: event.raw,
        invoiceRequestId: request.id,
        rechargeOrderId: request.rechargeOrderId,
      })
    );
    return this.store.updateInvoiceRequest({
      ...request,
      status: 'reversed',
      reversedAt: request.reversedAt || nowIso(),
      updatedAt: nowIso(),
    });
  }

  async getRechargeOrderInvoice(userId: string, orderId: string): Promise<InvoiceRequest | undefined> {
    const order = await this.accounts.getRechargeOrder(orderId);
    if (!order || order.userId !== userId) throw new HttpError(404, 'RECHARGE_ORDER_NOT_FOUND', 'Recharge order not found.');
    return this.store.findInvoiceRequestByRechargeOrderId(order.id);
  }

  async getRechargeOrderInvoiceDownloadUrl(userId: string, orderId: string): Promise<{ downloadUrl: string; invoice: InvoiceRequest }> {
    const invoice = await this.getRechargeOrderInvoice(userId, orderId);
    if (!invoice) throw new HttpError(404, 'INVOICE_REQUEST_NOT_FOUND', 'Invoice request not found.');
    if (invoice.status !== 'issued') throw new HttpError(409, 'INVOICE_NOT_READY', 'Invoice is not issued yet.');
    if (invoice.downloadUrl) return { downloadUrl: invoice.downloadUrl, invoice };
    const refreshed = await this.issueProvider.refreshDownloadUrl?.(invoice);
    if (!refreshed) throw new HttpError(404, 'INVOICE_DOWNLOAD_URL_NOT_FOUND', 'Invoice download URL is not ready.');
    const updated = await this.store.updateInvoiceRequest({ ...invoice, downloadUrl: refreshed, updatedAt: nowIso() });
    return { downloadUrl: refreshed, invoice: updated };
  }

  private async resolveBuyer(input: InvoiceBuyer | undefined, fapiaoApplyId: string): Promise<InvoiceBuyer> {
    if (input) return normalizeBuyer(input);
    if (!this.payments.getWechatInvoiceUserTitle) {
      throw new HttpError(400, 'INVOICE_BUYER_REQUIRED', 'Invoice buyer information is required.');
    }
    return normalizeBuyer(await this.payments.getWechatInvoiceUserTitle(fapiaoApplyId, 'WITH_WECHATPAY'));
  }

  private async findByProviderReference(input: {
    providerApplyId?: string;
    outTradeNo?: string;
  }): Promise<InvoiceRequest | undefined> {
    if (input.providerApplyId) {
      const request = await this.store.findInvoiceRequestByProviderApplyId(input.providerApplyId);
      if (request) return request;
    }
    if (input.outTradeNo) return this.store.findInvoiceRequestByOutTradeNo(input.outTradeNo);
    return undefined;
  }
}

export const invoiceService = new InvoiceService();
