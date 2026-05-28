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
      amountCents: 1000,
      description: 'Recharge',
      notifyUrl: 'https://example.com/wechat/notify',
    });
    const paid = await service.markRechargePaid(order.id, 'wx-transaction-a');

    expect(paid.wallet.cashBalanceCents).toBe(1000);
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
    expect(paidJob.wallet.cashBalanceCents).toBe(900);
    expect(paidJob.wallet.frozenCents).toBe(100);
    expect(queue.messages).toHaveLength(1);

    await service.settleJobCharge(paidJob.job.id);
    const settledWallet = await service.getWallet(login.user.id);
    const ledger = await service.listLedger(login.user.id);

    expect(settledWallet.cashBalanceCents).toBe(900);
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
      amountCents: 1000,
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

    expect(wallet.cashBalanceCents).toBe(1000);
    expect(wallet.frozenCents).toBe(0);
  });
});

