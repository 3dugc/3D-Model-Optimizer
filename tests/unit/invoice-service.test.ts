import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LocalAccountStore } from '../../src/accounts/account-store';
import { AccountService } from '../../src/accounts/account-service';
import { LocalJobStore } from '../../src/jobs/job-store';
import { CloudJobService } from '../../src/jobs/job-service';
import type { CloudJob } from '../../src/jobs/types';
import type { PublishOptions, QueueProvider } from '../../src/cloud/queue';
import type { QueueJobMessage } from '../../src/cloud/types';
import { InvoiceService, LocalInvoiceStore, ManualInvoiceProvider } from '../../src/invoices';

class RecordingQueue implements QueueProvider {
  readonly providerName = 'local' as const;

  async publish(_message: QueueJobMessage, _options?: PublishOptions): Promise<void> {
    return undefined;
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-invoice-service-'));
  return path.join(dir, name);
}

describe('invoice service', () => {
  it('creates one invoice request for a paid recharge order and deduplicates repeated title notifications', async () => {
    const accountStore = new LocalAccountStore(await tempFile('accounts.json'));
    const accountService = new AccountService(
      accountStore,
      new CloudJobService(new LocalJobStore(await tempFile('jobs.json')), new RecordingQueue())
    );
    const invoiceStore = new LocalInvoiceStore(await tempFile('invoices.json'));
    const invoiceService = new InvoiceService(invoiceStore, accountStore, new ManualInvoiceProvider());

    const login = await accountService.loginWithWechat({ openId: 'openid-invoice-a' });
    const order = await accountService.createRechargeOrder({
      userId: login.user.id,
      amountCents: 800,
      description: 'Recharge',
      notifyUrl: 'https://example.com/wechat/notify',
    });
    await accountService.markRechargePaid(order.id, 'wx-invoice-a');

    const created = await invoiceService.createRechargeInvoiceFromWechatTitle({
      outTradeNo: order.outTradeNo,
      fapiaoApplyId: order.outTradeNo,
      buyer: {
        type: 'ORGANIZATION',
        name: '测试公司',
        taxpayerId: '91310000MA1K000000',
      },
      eventType: 'WECHAT_FAPIAO_TITLE_FILLED',
      dedupeKey: `title:${order.outTradeNo}`,
    });
    const duplicated = await invoiceService.createRechargeInvoiceFromWechatTitle({
      outTradeNo: order.outTradeNo,
      fapiaoApplyId: order.outTradeNo,
      buyer: {
        type: 'ORGANIZATION',
        name: '测试公司',
        taxpayerId: '91310000MA1K000000',
      },
      eventType: 'WECHAT_FAPIAO_TITLE_FILLED',
      dedupeKey: `title:${order.outTradeNo}`,
    });

    expect(created.id).toBe(duplicated.id);
    expect(created.status).toBe('issuing');
    expect(created.amountCents).toBe(800);
    expect(created.titleType).toBe('company');
  });

  it('rejects invoice requests before the recharge order is paid', async () => {
    const accountStore = new LocalAccountStore(await tempFile('accounts.json'));
    const accountService = new AccountService(
      accountStore,
      new CloudJobService(new LocalJobStore(await tempFile('jobs.json')), new RecordingQueue())
    );
    const invoiceService = new InvoiceService(
      new LocalInvoiceStore(await tempFile('invoices.json')),
      accountStore,
      new ManualInvoiceProvider()
    );

    const login = await accountService.loginWithWechat({ openId: 'openid-invoice-b' });
    const order = await accountService.createRechargeOrder({
      userId: login.user.id,
      amountCents: 800,
      description: 'Recharge',
      notifyUrl: 'https://example.com/wechat/notify',
    });

    await expect(
      invoiceService.createRechargeInvoiceFromWechatTitle({
        outTradeNo: order.outTradeNo,
        buyer: {
          type: 'INDIVIDUAL',
          name: '个人用户',
        },
      })
    ).rejects.toMatchObject({ code: 'RECHARGE_ORDER_NOT_PAID' });
  });

  it('creates invoice requests directly from paid recharge orders', async () => {
    const accountStore = new LocalAccountStore(await tempFile('accounts.json'));
    const accountService = new AccountService(
      accountStore,
      new CloudJobService(new LocalJobStore(await tempFile('jobs.json')), new RecordingQueue())
    );
    const invoiceService = new InvoiceService(
      new LocalInvoiceStore(await tempFile('invoices.json')),
      accountStore,
      new ManualInvoiceProvider()
    );

    const login = await accountService.loginWithWechat({ openId: 'openid-invoice-c' });
    const order = await accountService.createRechargeOrder({
      userId: login.user.id,
      amountCents: 1800,
      description: 'Recharge',
      notifyUrl: 'https://example.com/wechat/notify',
    });
    await accountService.markRechargePaid(order.id, 'wx-invoice-c');

    const invoice = await invoiceService.createRechargeOrderInvoice(login.user.id, order.id, {
      type: 'ORGANIZATION',
      name: '上海测试科技有限公司',
      taxpayerId: '91310000MA1K000001',
    });

    expect(invoice.status).toBe('issuing');
    expect(invoice.provider).toBe('manual');
    expect(invoice.amountCents).toBe(1800);
    expect(invoice.outTradeNo).toBe(order.outTradeNo);
  });

  it('marks manually issued invoices with a download URL', async () => {
    const accountStore = new LocalAccountStore(await tempFile('accounts.json'));
    const accountService = new AccountService(
      accountStore,
      new CloudJobService(new LocalJobStore(await tempFile('jobs.json')), new RecordingQueue())
    );
    const invoiceService = new InvoiceService(
      new LocalInvoiceStore(await tempFile('invoices.json')),
      accountStore,
      new ManualInvoiceProvider()
    );

    const login = await accountService.loginWithWechat({ openId: 'openid-invoice-d' });
    const order = await accountService.createRechargeOrder({
      userId: login.user.id,
      amountCents: 800,
      description: 'Recharge',
      notifyUrl: 'https://example.com/wechat/notify',
    });
    await accountService.markRechargePaid(order.id, 'wx-invoice-d');
    const invoice = await invoiceService.createRechargeOrderInvoice(login.user.id, order.id, {
      type: 'INDIVIDUAL',
      name: '个人用户',
    });

    const issued = await invoiceService.markInvoiceIssuedManually(invoice.id, {
      invoiceNo: 'INV-001',
      downloadUrl: 'https://example.com/invoices/INV-001.pdf',
    });

    expect(issued.status).toBe('issued');
    expect(issued.invoiceNo).toBe('INV-001');
    expect(issued.downloadUrl).toBe('https://example.com/invoices/INV-001.pdf');
    expect(issued.issuedAt).toBeTruthy();
  });
});
