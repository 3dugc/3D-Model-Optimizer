import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { cloudJobService, type CloudJobService } from '../jobs/job-service';
import type { CloudJob } from '../jobs/types';
import { HttpError } from '../utils/http-error';
import { accountStore, type AccountStore } from './account-store';
import { createWebUserToken } from './token';
import type {
  CreatePaidWebJobInput,
  CreateRechargeOrderInput,
  RechargeOrder,
  UpsertWechatUserInput,
  Wallet,
  WalletLedgerEntry,
  WebUser,
} from './types';

function nowIso(): string {
  return new Date().toISOString();
}

function createOutTradeNo(prefix: string): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase();
  return `${prefix}${timestamp}${suffix}`.slice(0, 32);
}

function addMinutes(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

function assertRechargePackage(amountCents: number): void {
  if (!config.billing.rechargePackagesCents.includes(amountCents)) {
    throw new HttpError(
      400,
      'INVALID_RECHARGE_AMOUNT',
      `Recharge amount must be one of: ${config.billing.rechargePackagesCents.join(', ')} cents.`
    );
  }
}

export class AccountService {
  constructor(
    private readonly store: AccountStore = accountStore,
    private readonly jobs: CloudJobService = cloudJobService
  ) {}

  async loginWithWechat(input: UpsertWechatUserInput): Promise<{ user: WebUser; wallet: Wallet; token: string }> {
    const user = await this.store.upsertWechatUser(input);
    const wallet = await this.store.getWallet(user.id);
    return { user, wallet, token: createWebUserToken(user.id, user.tenantId) };
  }

  async requireUser(userId: string): Promise<WebUser> {
    const user = await this.store.getUser(userId);
    if (!user) throw new HttpError(401, 'WEB_USER_NOT_FOUND', 'Web user not found or token is no longer valid.');
    return user;
  }

  async getWallet(userId: string): Promise<Wallet> {
    return this.store.getWallet(userId);
  }

  async listLedger(userId: string, limit?: number): Promise<WalletLedgerEntry[]> {
    return this.store.listLedger(userId, limit);
  }

  async createRechargeOrder(input: CreateRechargeOrderInput): Promise<RechargeOrder> {
    if (config.billing.mode === 'disabled') {
      throw new HttpError(403, 'BILLING_DISABLED', 'Billing is disabled.');
    }
    assertRechargePackage(input.amountCents);
    const user = await this.requireUser(input.userId);
    const createdAt = nowIso();
    const order: RechargeOrder = {
      id: uuidv4(),
      userId: user.id,
      tenantId: user.tenantId,
      status: 'pending_payment',
      amountCents: input.amountCents,
      currency: 'CNY',
      provider: 'wechat_native',
      outTradeNo: createOutTradeNo('RCH'),
      codeUrl:
        config.billing.mode === 'mock'
          ? `weixin://wxpay/mock/recharge/${user.id}/${input.amountCents}`
          : undefined,
      expiresAt: addMinutes(new Date(), 30),
      createdAt,
      updatedAt: createdAt,
    };
    return this.store.createRechargeOrder(order);
  }

  async getRechargeOrder(userId: string, orderId: string): Promise<RechargeOrder> {
    const order = await this.store.getRechargeOrder(orderId);
    if (!order || order.userId !== userId) throw new HttpError(404, 'RECHARGE_ORDER_NOT_FOUND', 'Recharge order not found.');
    return order;
  }

  async markRechargePaid(orderId: string, transactionId?: string): Promise<{ order: RechargeOrder; wallet: Wallet }> {
    return this.store.markRechargePaid(orderId, transactionId);
  }

  async markRechargePaidByOutTradeNo(outTradeNo: string, transactionId?: string): Promise<{ order: RechargeOrder; wallet: Wallet }> {
    const order = await this.store.findRechargeOrderByOutTradeNo(outTradeNo);
    if (!order) throw new HttpError(404, 'RECHARGE_ORDER_NOT_FOUND', 'Recharge order not found.');
    return this.markRechargePaid(order.id, transactionId);
  }

  async createPaidWebJob(input: CreatePaidWebJobInput): Promise<{ job: CloudJob; wallet: Wallet }> {
    const user = await this.requireUser(input.userId);
    const job = await this.jobs.createJob({
      ...input,
      tenantId: user.tenantId,
      paymentRequired: true,
      userId: user.id,
    });
    try {
      const held = await this.store.holdJobCharge({
        user,
        jobId: job.id,
        amountCents: config.billing.defaultJobPriceCents,
      });
      const authorized = await this.jobs.markWalletChargeHeld(job.id, held.charge.id);
      return { job: authorized, wallet: held.wallet };
    } catch (error) {
      await this.jobs.cancelJob(job.id).catch(() => undefined);
      throw error;
    }
  }

  async settleJobCharge(jobId: string): Promise<void> {
    await this.store.settleJobCharge(jobId);
  }

  async releaseJobCharge(jobId: string, note?: string): Promise<void> {
    await this.store.releaseJobCharge(jobId, note);
  }
}

export const accountService = new AccountService();

