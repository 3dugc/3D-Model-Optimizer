import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { PublishOptions, QueueProvider } from '../../src/cloud/queue';
import type { QueueJobMessage } from '../../src/cloud/types';
import { LocalAccountStore } from '../../src/accounts/account-store';
import { AccountService } from '../../src/accounts/account-service';
import { LocalJobStore } from '../../src/jobs/job-store';
import { CloudJobService } from '../../src/jobs/job-service';
import type { CloudJob } from '../../src/jobs/types';
import type { CreateNativePaymentInput, PaymentNotification, PaymentProvider } from '../../src/payments';

class RecordingQueue implements QueueProvider {
  readonly providerName = 'local' as const;
  readonly messages: QueueJobMessage[] = [];

  async publish(message: QueueJobMessage, _options?: PublishOptions): Promise<void> {
    this.messages.push(message);
  }

  async claimNext(): Promise<CloudJob | undefined> {
    return undefined;
  }

  async complete(): Promise<void> {
    return undefined;
  }

  async release(): Promise<void> {
    return undefined;
  }
}

class PaidPaymentProvider implements PaymentProvider {
  readonly outTradeNos: string[] = [];

  async createNativeOrder(input: CreateNativePaymentInput): Promise<{ codeUrl: string }> {
    this.outTradeNos.push(input.outTradeNo);
    return { codeUrl: `weixin://wxpay/test/${input.outTradeNo}` };
  }

  async queryOrderByOutTradeNo(outTradeNo: string): Promise<PaymentNotification> {
    return {
      outTradeNo,
      transactionId: `wx-${outTradeNo}`,
      tradeState: 'SUCCESS',
      amountCents: 800,
    };
  }

  async parsePaymentNotification(): Promise<PaymentNotification> {
    throw new Error('Not used in this test.');
  }
}

async function tempFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-account-wallet-'));
  return path.join(dir, name);
}

describe('account wallet billing', () => {
  it('recharges a wallet and holds one yuan before queueing a paid web job', async () => {
    const accountStore = new LocalAccountStore(await tempFile('accounts.json'));
    const jobStore = new LocalJobStore(await tempFile('jobs.json'));
    const queue = new RecordingQueue();
    const jobService = new CloudJobService(jobStore, queue);
    const service = new AccountService(accountStore, jobService);

    const login = await service.loginWithWechat({
      openId: 'openid-a',
      unionId: 'union-a',
      nickname: '测试用户',
    });

    const order = await service.createRechargeOrder({
      userId: login.user.id,
      amountCents: 800,
      description: 'Recharge',
      notifyUrl: 'https://example.com/wechat/notify',
    });
    const paid = await service.markRechargePaid(order.id, 'wx-transaction-a');

    expect(paid.wallet.cashBalanceCents).toBe(800);
    expect(paid.wallet.frozenCents).toBe(0);

    const paidJob = await service.createPaidWebJob({
      userId: login.user.id,
      taskType: 'model.optimize',
      input: {
        bucket: 'optimizer-input',
        region: 'ap-nanjing',
        key: `tenants/${login.user.tenantId}/incoming/source.glb`,
      },
    });

    expect(paidJob.job.status).toBe('queued');
    expect(paidJob.wallet.cashBalanceCents).toBe(700);
    expect(paidJob.wallet.frozenCents).toBe(100);
    expect(queue.messages).toHaveLength(1);

    await service.settleJobCharge(paidJob.job.id);
    const settledWallet = await service.getWallet(login.user.id);
    const ledger = await service.listLedger(login.user.id);

    expect(settledWallet.cashBalanceCents).toBe(700);
    expect(settledWallet.frozenCents).toBe(0);
    expect(ledger.map((entry) => entry.type)).toEqual(['job_charge', 'job_hold', 'recharge_paid']);
  });

  it('releases held balance when a paid job fails before completion', async () => {
    const accountStore = new LocalAccountStore(await tempFile('accounts.json'));
    const jobStore = new LocalJobStore(await tempFile('jobs.json'));
    const queue = new RecordingQueue();
    const service = new AccountService(accountStore, new CloudJobService(jobStore, queue));

    const login = await service.loginWithWechat({ openId: 'openid-b' });
    const order = await service.createRechargeOrder({
      userId: login.user.id,
      amountCents: 800,
      description: 'Recharge',
      notifyUrl: 'https://example.com/wechat/notify',
    });
    await service.markRechargePaid(order.id, 'wx-transaction-b');

    const paidJob = await service.createPaidWebJob({
      userId: login.user.id,
      filename: 'source.glb',
    });
    await service.releaseJobCharge(paidJob.job.id, 'test release');
    const wallet = await service.getWallet(login.user.id);

    expect(wallet.cashBalanceCents).toBe(800);
    expect(wallet.frozenCents).toBe(0);
  });

  it('syncs a paid WeChat recharge order by querying the provider', async () => {
    const accountStore = new LocalAccountStore(await tempFile('accounts.json'));
    const payments = new PaidPaymentProvider();
    const service = new AccountService(accountStore, new CloudJobService(new LocalJobStore(await tempFile('jobs.json')), new RecordingQueue()), payments);
    const login = await service.loginWithWechat({ openId: 'openid-c' });

    const order = await service.createRechargeOrder({
      userId: login.user.id,
      amountCents: 800,
      description: 'Recharge',
      notifyUrl: 'https://example.com/wechat/notify',
    });
    const synced = await service.syncRechargeOrderByOutTradeNo(login.user.id, order.outTradeNo);

    expect(payments.outTradeNos).toContain(order.outTradeNo);
    expect(synced.order.status).toBe('paid');
    expect(synced.order.transactionId).toBe(`wx-${order.outTradeNo}`);
    expect(synced.wallet.cashBalanceCents).toBe(800);
  });

  it('holds and settles one yuan for a direct web optimization', async () => {
    const accountStore = new LocalAccountStore(await tempFile('accounts.json'));
    const service = new AccountService(accountStore, new CloudJobService(new LocalJobStore(await tempFile('jobs.json')), new RecordingQueue()));
    const login = await service.loginWithWechat({ openId: 'openid-direct' });
    const order = await service.createRechargeOrder({
      userId: login.user.id,
      amountCents: 800,
      description: 'Recharge',
      notifyUrl: 'https://example.com/wechat/notify',
    });
    await service.markRechargePaid(order.id, 'wx-transaction-direct');

    const held = await service.holdOptimizationCharge(login.user.id, 'direct-task-id');
    expect(held.wallet.cashBalanceCents).toBe(700);
    expect(held.wallet.frozenCents).toBe(100);

    await service.settleJobCharge('direct-task-id');
    const settledWallet = await service.getWallet(login.user.id);
    expect(settledWallet.cashBalanceCents).toBe(700);
    expect(settledWallet.frozenCents).toBe(0);
  });

  it('binds unified auth users by auth user id and merges later WeChat unionid logins', async () => {
    const accountStore = new LocalAccountStore(await tempFile('accounts.json'));
    const service = new AccountService(accountStore, new CloudJobService(new LocalJobStore(await tempFile('jobs.json')), new RecordingQueue()));

    const authLogin = await service.loginWithAuthService({
      authUserId: 'auth-user-a',
      unionId: 'union-shared-a',
      nickname: '统一登录用户',
    });
    const repeatedAuthLogin = await service.loginWithAuthService({
      authUserId: 'auth-user-a',
      nickname: '统一登录用户二次登录',
    });
    const wechatLogin = await service.loginWithWechat({
      openId: 'openid-shared-a',
      unionId: 'union-shared-a',
      nickname: '微信用户',
    });

    expect(repeatedAuthLogin.user.id).toBe(authLogin.user.id);
    expect(wechatLogin.user.id).toBe(authLogin.user.id);
    expect(wechatLogin.user.authUserId).toBe('auth-user-a');
    expect(wechatLogin.user.wechatOpenId).toBe('openid-shared-a');
    expect(wechatLogin.wallet.userId).toBe(authLogin.user.id);
  });
});
