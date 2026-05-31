import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { cloudJobService, type CloudJobService } from '../jobs/job-service';
import type { CloudJob } from '../jobs/types';
import { HttpError } from '../utils/http-error';
import { createPaymentProvider, type PaymentProvider } from '../payments';
import { accountStore, type AccountStore } from './account-store';
import { createWebUserToken } from './token';
import type {
  CreatePaidWebJobInput,
  CreateRechargeOrderInput,
  JobCharge,
  RechargeOrder,
  UpsertAuthServiceUserInput,
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

function selectLocalTestRechargeAmountCents(): number {
  const configured = Number(process.env.LOCAL_TEST_ACCOUNT_RECHARGE_CENTS);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return Math.max(config.billing.defaultJobPriceCents, ...config.billing.rechargePackagesCents);
}

function normalizeWalletChargeError(error: unknown): Error {
  if (error instanceof Error && error.message === 'Insufficient wallet balance') {
    return new HttpError(402, 'INSUFFICIENT_BALANCE', '余额不足，请先充值后再优化。', {
      requiredCents: config.billing.defaultJobPriceCents,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function mapPaymentTradeStateToOrderStatus(tradeState: string): 'paid' | 'expired' | 'cancelled' | 'refunded' | undefined {
  switch (tradeState) {
    case 'SUCCESS':
      return 'paid';
    case 'CLOSED':
    case 'REVOKED':
    case 'PAYERROR':
      return 'cancelled';
    case 'REFUND':
      return 'refunded';
    default:
      return undefined;
  }
}

export class AccountService {
  constructor(
    private readonly store: AccountStore = accountStore,
    private readonly jobs: CloudJobService = cloudJobService,
    private readonly payments: PaymentProvider = createPaymentProvider()
  ) {}

  async loginWithWechat(input: UpsertWechatUserInput): Promise<{ user: WebUser; wallet: Wallet; token: string }> {
    const user = await this.store.upsertWechatUser(input);
    const wallet = await this.store.getWallet(user.id);
    return { user, wallet, token: createWebUserToken(user.id, user.tenantId) };
  }

  async loginWithAuthService(input: UpsertAuthServiceUserInput): Promise<{ user: WebUser; wallet: Wallet; token: string }> {
    const user = await this.store.upsertAuthServiceUser(input);
    const wallet = await this.store.getWallet(user.id);
    return { user, wallet, token: createWebUserToken(user.id, user.tenantId) };
  }

  async loginWithLocalTestAccount(): Promise<{ user: WebUser; wallet: Wallet; token: string; rechargeOrder?: RechargeOrder }> {
    const login = await this.loginWithAuthService({
      authUserId: 'local-test-account',
      accountHint: '本地测试账户',
      nickname: '本地测试账户（已充值）',
    });
    if (login.wallet.cashBalanceCents >= config.billing.defaultJobPriceCents) return login;

    const createdAt = nowIso();
    const order: RechargeOrder = {
      id: uuidv4(),
      userId: login.user.id,
      tenantId: login.user.tenantId,
      status: 'pending_payment',
      amountCents: selectLocalTestRechargeAmountCents(),
      currency: 'CNY',
      provider: 'wechat_native',
      outTradeNo: createOutTradeNo('LCL'),
      codeUrl: 'local-test://prepaid-account',
      expiresAt: addMinutes(new Date(), 30),
      createdAt,
      updatedAt: createdAt,
    };
    const createdOrder = await this.store.createRechargeOrder(order);
    const paid = await this.store.markRechargePaid(createdOrder.id, `local-test-${createdOrder.outTradeNo}`);
    return { user: login.user, wallet: paid.wallet, token: login.token, rechargeOrder: paid.order };
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
    const expiresAt = addMinutes(new Date(), 30);
    const outTradeNo = createOutTradeNo('RCH');
    const nativePayment = await this.payments.createNativeOrder({
      amountCents: input.amountCents,
      currency: 'CNY',
      description: input.description,
      outTradeNo,
      notifyUrl: input.notifyUrl,
      expiresAt,
      attach: user.tenantId,
      supportFapiao: config.billing.wechatSupportFapiao,
    });
    const order: RechargeOrder = {
      id: uuidv4(),
      userId: user.id,
      tenantId: user.tenantId,
      status: 'pending_payment',
      amountCents: input.amountCents,
      currency: 'CNY',
      provider: 'wechat_native',
      outTradeNo,
      codeUrl: nativePayment.codeUrl,
      expiresAt,
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

  async syncRechargeOrder(userId: string, orderId: string): Promise<{ order: RechargeOrder; wallet: Wallet }> {
    const order = await this.getRechargeOrder(userId, orderId);
    const wallet = await this.getWallet(userId);
    if (order.status === 'paid') return { order, wallet };
    if (order.status !== 'pending_payment') return { order, wallet };
    if (new Date(order.expiresAt).getTime() <= Date.now()) {
      const expired = await this.store.transitionRechargeOrder(order.id, 'expired');
      return { order: expired, wallet };
    }

    const payment = await this.payments.queryOrderByOutTradeNo(order.outTradeNo);
    const nextStatus = mapPaymentTradeStateToOrderStatus(payment.tradeState);
    if (!nextStatus) return { order, wallet };
    if (nextStatus === 'expired' || nextStatus === 'cancelled' || nextStatus === 'refunded') {
      const transitioned = await this.store.transitionRechargeOrder(order.id, nextStatus);
      return { order: transitioned, wallet };
    }
    if (payment.amountCents !== undefined && payment.amountCents !== order.amountCents) {
      throw new HttpError(409, 'PAYMENT_AMOUNT_MISMATCH', 'WeChat payment amount does not match recharge order amount.');
    }
    return this.markRechargePaid(order.id, payment.transactionId);
  }

  async syncRechargeOrderByOutTradeNo(userId: string, outTradeNo: string): Promise<{ order: RechargeOrder; wallet: Wallet }> {
    const order = await this.store.findRechargeOrderByOutTradeNo(outTradeNo);
    if (!order || order.userId !== userId) {
      throw new HttpError(404, 'RECHARGE_ORDER_NOT_FOUND', 'Recharge order not found.');
    }
    return this.syncRechargeOrder(userId, order.id);
  }

  async markRechargePaid(orderId: string, transactionId?: string): Promise<{ order: RechargeOrder; wallet: Wallet }> {
    return this.store.markRechargePaid(orderId, transactionId);
  }

  async markRechargePaidByOutTradeNo(outTradeNo: string, transactionId?: string): Promise<{ order: RechargeOrder; wallet: Wallet }> {
    const order = await this.store.findRechargeOrderByOutTradeNo(outTradeNo);
    if (!order) throw new HttpError(404, 'RECHARGE_ORDER_NOT_FOUND', 'Recharge order not found.');
    return this.markRechargePaid(order.id, transactionId);
  }

  async transitionRechargeOrderByOutTradeNo(
    outTradeNo: string,
    status: 'expired' | 'cancelled' | 'refunded'
  ): Promise<{ order: RechargeOrder; wallet: Wallet }> {
    const existing = await this.store.findRechargeOrderByOutTradeNo(outTradeNo);
    if (!existing) throw new HttpError(404, 'RECHARGE_ORDER_NOT_FOUND', 'Recharge order not found.');
    const order = await this.store.transitionRechargeOrder(existing.id, status);
    const wallet = await this.getWallet(order.userId);
    return { order, wallet };
  }

  async handlePaymentNotification(headers: Record<string, unknown>, rawBody: Buffer | string): Promise<{ order: RechargeOrder; wallet: Wallet }> {
    const notification = await this.payments.parsePaymentNotification(headers, rawBody);
    const nextStatus = mapPaymentTradeStateToOrderStatus(notification.tradeState);
    if (!nextStatus) {
      throw new HttpError(409, 'PAYMENT_NOT_SUCCESS', `Payment trade state is ${notification.tradeState}.`);
    }
    if (nextStatus === 'cancelled' || nextStatus === 'refunded' || nextStatus === 'expired') {
      return this.transitionRechargeOrderByOutTradeNo(notification.outTradeNo, nextStatus);
    }
    return this.markRechargePaidByOutTradeNo(notification.outTradeNo, notification.transactionId);
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
      const held = await this.holdChargeForUser(user, job.id);
      const authorized = await this.jobs.markWalletChargeHeld(job.id, held.charge.id);
      return { job: authorized, wallet: held.wallet };
    } catch (error) {
      await this.jobs.cancelJob(job.id).catch(() => undefined);
      throw normalizeWalletChargeError(error);
    }
  }

  async holdOptimizationCharge(userId: string, jobId: string): Promise<{ charge: JobCharge; wallet: Wallet }> {
    const user = await this.requireUser(userId);
    try {
      return await this.holdChargeForUser(user, jobId);
    } catch (error) {
      throw normalizeWalletChargeError(error);
    }
  }

  async settleJobCharge(jobId: string): Promise<void> {
    await this.store.settleJobCharge(jobId);
  }

  async releaseJobCharge(jobId: string, note?: string): Promise<void> {
    await this.store.releaseJobCharge(jobId, note);
  }

  async cancelPaidWebJob(userId: string, jobId: string): Promise<{ job: CloudJob; wallet: Wallet }> {
    const job = await this.jobs.getJob(jobId);
    if (!job || job.userId !== userId) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
    if (job.status !== 'waiting_upload' && job.status !== 'waiting_payment' && job.status !== 'queued') {
      throw new HttpError(409, 'JOB_NOT_CANCELLABLE', `Job cannot be cancelled from ${job.status}.`);
    }
    const cancelled = await this.jobs.cancelJob(jobId);
    await this.releaseJobCharge(jobId, 'Job cancelled before processing started.');
    const wallet = await this.getWallet(userId);
    return { job: cancelled, wallet };
  }

  async getJobCharge(jobId: string): Promise<JobCharge | undefined> {
    return this.store.getJobCharge(jobId);
  }

  private async holdChargeForUser(user: WebUser, jobId: string): Promise<{ charge: JobCharge; wallet: Wallet }> {
    return this.store.holdJobCharge({
      user,
      jobId,
      amountCents: config.billing.defaultJobPriceCents,
    });
  }
}

export const accountService = new AccountService();
