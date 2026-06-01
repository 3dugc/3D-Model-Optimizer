import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { cloudJobService, type CloudJobService } from '../jobs/job-service';
import type { BillingOrder, CreateWechatNativeOrderInput } from './types';
import { orderStore, type OrderStore } from './order-store';

function nowIso(): string {
  return new Date().toISOString();
}

function createOutTradeNo(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase();
  return `OPT${timestamp}${suffix}`.slice(0, 32);
}

function addMinutes(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

export class BillingService {
  constructor(
    private readonly store: OrderStore = orderStore,
    private readonly jobs: CloudJobService = cloudJobService
  ) {}

  async createWechatNativeOrder(input: CreateWechatNativeOrderInput): Promise<BillingOrder> {
    if (config.billing.mode === 'disabled') {
      throw new Error('Billing is disabled');
    }

    const createdAt = nowIso();
    const order: BillingOrder = {
      id: uuidv4(),
      tenantId: input.tenantId,
      jobId: input.jobId,
      status: 'pending_payment',
      amountCents: input.amountCents,
      currency: 'CNY',
      provider: 'wechat_native',
      outTradeNo: createOutTradeNo(),
      codeUrl:
        config.billing.mode === 'mock'
          ? `weixin://wxpay/mock/${input.jobId}/${input.amountCents}`
          : undefined,
      expiresAt: addMinutes(new Date(), 30),
      createdAt,
      updatedAt: createdAt,
    };

    const job = await this.jobs.getJob(input.jobId);
    if (!job) throw new Error(`Job not found: ${input.jobId}`);
    const created = await this.store.create(order);
    await this.jobs.attachOrder(input.jobId, created.id);
    return created;
  }

  async getOrder(orderId: string): Promise<BillingOrder | undefined> {
    return this.store.get(orderId);
  }

  async markPaid(orderId: string, transactionId?: string): Promise<BillingOrder> {
    const order = await this.store.get(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.status === 'paid') return order;

    const paid = await this.store.transition(orderId, 'paid', {
      transactionId,
      paidAt: nowIso(),
    });
    if (paid.jobId) {
      await this.jobs.markPaid(paid.jobId, paid.id);
    }
    return paid;
  }

  async markPaidByOutTradeNo(outTradeNo: string, transactionId?: string): Promise<BillingOrder> {
    const order = await this.store.findByOutTradeNo(outTradeNo);
    if (!order) throw new Error(`Order not found for outTradeNo: ${outTradeNo}`);
    return this.markPaid(order.id, transactionId);
  }
}

export const billingService = new BillingService();
