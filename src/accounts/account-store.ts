import * as fs from 'fs';
import * as path from 'path';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { QueryResultRow } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { ensureMySqlSchema, getMySqlPool, mysqlDateTime, withMySqlTransaction, type MySqlQueryable } from '../database/mysql';
import { ensurePostgresSchema, getPostgresPool, withPostgresTransaction, type SqlQueryable } from '../database/postgres';
import type {
  JobCharge,
  RechargeOrder,
  UpsertAuthServiceUserInput,
  UpsertWechatUserInput,
  Wallet,
  WalletLedgerEntry,
  WebUser,
} from './types';

export interface AccountStore {
  upsertWechatUser(input: UpsertWechatUserInput): Promise<WebUser>;
  upsertAuthServiceUser(input: UpsertAuthServiceUserInput): Promise<WebUser>;
  getUser(userId: string): Promise<WebUser | undefined>;
  findUserByWechat(openId: string): Promise<WebUser | undefined>;
  getWallet(userId: string): Promise<Wallet>;
  listLedger(userId: string, limit?: number): Promise<WalletLedgerEntry[]>;
  createRechargeOrder(order: RechargeOrder): Promise<RechargeOrder>;
  getRechargeOrder(orderId: string): Promise<RechargeOrder | undefined>;
  findRechargeOrderByOutTradeNo(outTradeNo: string): Promise<RechargeOrder | undefined>;
  markRechargePaid(orderId: string, transactionId?: string): Promise<{ order: RechargeOrder; wallet: Wallet }>;
  holdJobCharge(input: { user: WebUser; jobId: string; amountCents: number }): Promise<{ charge: JobCharge; wallet: Wallet }>;
  settleJobCharge(jobId: string): Promise<JobCharge | undefined>;
  releaseJobCharge(jobId: string, note?: string): Promise<JobCharge | undefined>;
  getJobCharge(jobId: string): Promise<JobCharge | undefined>;
}

interface AccountStoreFile {
  users: WebUser[];
  wallets: Wallet[];
  ledger: WalletLedgerEntry[];
  rechargeOrders: RechargeOrder[];
  jobCharges: JobCharge[];
}

const emptyFile = (): AccountStoreFile => ({
  users: [],
  wallets: [],
  ledger: [],
  rechargeOrders: [],
  jobCharges: [],
});

function nowIso(): string {
  return new Date().toISOString();
}

function createWebTenantId(userId: string): string {
  return `web-${userId}`;
}

function createAuthServiceWechatOpenId(authUserId: string): string {
  return `auth:${authUserId}`;
}

function createWallet(user: WebUser, now: string = nowIso()): Wallet {
  return {
    userId: user.id,
    tenantId: user.tenantId,
    cashBalanceCents: 0,
    bonusBalanceCents: 0,
    frozenCents: 0,
    updatedAt: now,
  };
}

function createLedgerEntry(input: Omit<WalletLedgerEntry, 'id' | 'createdAt'>): WalletLedgerEntry {
  return {
    id: uuidv4(),
    createdAt: nowIso(),
    ...input,
  };
}

function normalizeLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

export class LocalAccountStore implements AccountStore {
  constructor(private readonly filePath: string = config.billing.accountStorePath) {}

  async upsertWechatUser(input: UpsertWechatUserInput): Promise<WebUser> {
    const data = await this.read();
    const existingIndex = data.users.findIndex(
      (user) => user.wechatOpenId === input.openId || Boolean(input.unionId && user.wechatUnionId === input.unionId)
    );
    const now = nowIso();
    if (existingIndex >= 0) {
      const updated: WebUser = {
        ...data.users[existingIndex],
        wechatOpenId: input.openId,
        wechatUnionId: input.unionId || data.users[existingIndex].wechatUnionId,
        wechatAccountHint: input.accountHint || data.users[existingIndex].wechatAccountHint,
        nickname: input.nickname || data.users[existingIndex].nickname,
        avatarUrl: input.avatarUrl || data.users[existingIndex].avatarUrl,
        updatedAt: now,
      };
      data.users[existingIndex] = updated;
      await this.write(data);
      return updated;
    }

    const id = uuidv4();
    const user: WebUser = {
      id,
      tenantId: createWebTenantId(id),
      wechatOpenId: input.openId,
      wechatUnionId: input.unionId,
      wechatAccountHint: input.accountHint,
      nickname: input.nickname,
      avatarUrl: input.avatarUrl,
      createdAt: now,
      updatedAt: now,
    };
    data.users.push(user);
    data.wallets.push(createWallet(user, now));
    await this.write(data);
    return user;
  }

  async upsertAuthServiceUser(input: UpsertAuthServiceUserInput): Promise<WebUser> {
    const data = await this.read();
    const fallbackOpenId = createAuthServiceWechatOpenId(input.authUserId);
    const existingIndex = data.users.findIndex(
      (user) =>
        user.authUserId === input.authUserId ||
        user.wechatOpenId === fallbackOpenId ||
        Boolean(input.unionId && user.wechatUnionId === input.unionId)
    );
    const now = nowIso();
    if (existingIndex >= 0) {
      const current = data.users[existingIndex];
      const updated: WebUser = {
        ...current,
        authUserId: input.authUserId,
        wechatUnionId: input.unionId || current.wechatUnionId,
        wechatAccountHint: input.accountHint || current.wechatAccountHint,
        nickname: input.nickname || current.nickname,
        avatarUrl: input.avatarUrl || current.avatarUrl,
        updatedAt: now,
      };
      data.users[existingIndex] = updated;
      await this.write(data);
      return updated;
    }

    const id = uuidv4();
    const user: WebUser = {
      id,
      tenantId: createWebTenantId(id),
      authUserId: input.authUserId,
      wechatOpenId: fallbackOpenId,
      wechatUnionId: input.unionId,
      wechatAccountHint: input.accountHint,
      nickname: input.nickname,
      avatarUrl: input.avatarUrl,
      createdAt: now,
      updatedAt: now,
    };
    data.users.push(user);
    data.wallets.push(createWallet(user, now));
    await this.write(data);
    return user;
  }

  async getUser(userId: string): Promise<WebUser | undefined> {
    const data = await this.read();
    return data.users.find((user) => user.id === userId);
  }

  async findUserByWechat(openId: string): Promise<WebUser | undefined> {
    const data = await this.read();
    return data.users.find((user) => user.wechatOpenId === openId);
  }

  async getWallet(userId: string): Promise<Wallet> {
    const data = await this.read();
    const wallet = data.wallets.find((item) => item.userId === userId);
    if (!wallet) throw new Error(`Wallet not found for user: ${userId}`);
    return wallet;
  }

  async listLedger(userId: string, limit?: number): Promise<WalletLedgerEntry[]> {
    const data = await this.read();
    return data.ledger
      .filter((entry) => entry.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, normalizeLimit(limit));
  }

  async createRechargeOrder(order: RechargeOrder): Promise<RechargeOrder> {
    const data = await this.read();
    if (data.rechargeOrders.some((item) => item.id === order.id || item.outTradeNo === order.outTradeNo)) {
      throw new Error(`Recharge order already exists: ${order.id}`);
    }
    data.rechargeOrders.push(order);
    await this.write(data);
    return order;
  }

  async getRechargeOrder(orderId: string): Promise<RechargeOrder | undefined> {
    const data = await this.read();
    return data.rechargeOrders.find((order) => order.id === orderId);
  }

  async findRechargeOrderByOutTradeNo(outTradeNo: string): Promise<RechargeOrder | undefined> {
    const data = await this.read();
    return data.rechargeOrders.find((order) => order.outTradeNo === outTradeNo);
  }

  async markRechargePaid(orderId: string, transactionId?: string): Promise<{ order: RechargeOrder; wallet: Wallet }> {
    const data = await this.read();
    const orderIndex = data.rechargeOrders.findIndex((order) => order.id === orderId);
    if (orderIndex < 0) throw new Error(`Recharge order not found: ${orderId}`);
    const current = data.rechargeOrders[orderIndex];
    const walletIndex = data.wallets.findIndex((wallet) => wallet.userId === current.userId);
    if (walletIndex < 0) throw new Error(`Wallet not found for user: ${current.userId}`);
    if (current.status === 'paid') return { order: current, wallet: data.wallets[walletIndex] };
    if (current.status !== 'pending_payment') {
      throw new Error(`Cannot pay recharge order ${orderId} from ${current.status}`);
    }

    const now = nowIso();
    const wallet: Wallet = {
      ...data.wallets[walletIndex],
      cashBalanceCents: data.wallets[walletIndex].cashBalanceCents + current.amountCents,
      updatedAt: now,
    };
    const order: RechargeOrder = {
      ...current,
      status: 'paid',
      transactionId,
      paidAt: now,
      updatedAt: now,
    };
    data.wallets[walletIndex] = wallet;
    data.rechargeOrders[orderIndex] = order;
    data.ledger.push(
      createLedgerEntry({
        userId: wallet.userId,
        tenantId: wallet.tenantId,
        type: 'recharge_paid',
        cashDeltaCents: current.amountCents,
        bonusDeltaCents: 0,
        frozenDeltaCents: 0,
        balanceAfterCashCents: wallet.cashBalanceCents,
        frozenAfterCents: wallet.frozenCents,
        rechargeOrderId: order.id,
        note: 'Wechat recharge paid',
      })
    );
    await this.write(data);
    return { order, wallet };
  }

  async holdJobCharge(input: { user: WebUser; jobId: string; amountCents: number }): Promise<{ charge: JobCharge; wallet: Wallet }> {
    const data = await this.read();
    const existing = data.jobCharges.find((charge) => charge.jobId === input.jobId);
    if (existing) return { charge: existing, wallet: await this.getWallet(input.user.id) };
    const walletIndex = data.wallets.findIndex((wallet) => wallet.userId === input.user.id);
    if (walletIndex < 0) throw new Error(`Wallet not found for user: ${input.user.id}`);
    const currentWallet = data.wallets[walletIndex];
    if (currentWallet.cashBalanceCents < input.amountCents) {
      throw new Error('Insufficient wallet balance');
    }

    const now = nowIso();
    const wallet: Wallet = {
      ...currentWallet,
      cashBalanceCents: currentWallet.cashBalanceCents - input.amountCents,
      frozenCents: currentWallet.frozenCents + input.amountCents,
      updatedAt: now,
    };
    const charge: JobCharge = {
      id: uuidv4(),
      userId: input.user.id,
      tenantId: input.user.tenantId,
      jobId: input.jobId,
      amountCents: input.amountCents,
      status: 'held',
      heldAt: now,
      createdAt: now,
      updatedAt: now,
    };
    data.wallets[walletIndex] = wallet;
    data.jobCharges.push(charge);
    data.ledger.push(
      createLedgerEntry({
        userId: input.user.id,
        tenantId: input.user.tenantId,
        type: 'job_hold',
        cashDeltaCents: -input.amountCents,
        bonusDeltaCents: 0,
        frozenDeltaCents: input.amountCents,
        balanceAfterCashCents: wallet.cashBalanceCents,
        frozenAfterCents: wallet.frozenCents,
        jobId: input.jobId,
        jobChargeId: charge.id,
        note: 'Job fee held',
      })
    );
    await this.write(data);
    return { charge, wallet };
  }

  async settleJobCharge(jobId: string): Promise<JobCharge | undefined> {
    return this.finishJobCharge(jobId, 'charged');
  }

  async releaseJobCharge(jobId: string, note = 'Job fee released'): Promise<JobCharge | undefined> {
    return this.finishJobCharge(jobId, 'released', note);
  }

  async getJobCharge(jobId: string): Promise<JobCharge | undefined> {
    const data = await this.read();
    return data.jobCharges.find((charge) => charge.jobId === jobId);
  }

  private async finishJobCharge(jobId: string, status: 'charged' | 'released', note?: string): Promise<JobCharge | undefined> {
    const data = await this.read();
    const chargeIndex = data.jobCharges.findIndex((charge) => charge.jobId === jobId);
    if (chargeIndex < 0) return undefined;
    const current = data.jobCharges[chargeIndex];
    if (current.status !== 'held') return current;
    const walletIndex = data.wallets.findIndex((wallet) => wallet.userId === current.userId);
    if (walletIndex < 0) throw new Error(`Wallet not found for user: ${current.userId}`);

    const now = nowIso();
    const wallet =
      status === 'released'
        ? {
            ...data.wallets[walletIndex],
            cashBalanceCents: data.wallets[walletIndex].cashBalanceCents + current.amountCents,
            frozenCents: Math.max(0, data.wallets[walletIndex].frozenCents - current.amountCents),
            updatedAt: now,
          }
        : {
            ...data.wallets[walletIndex],
            frozenCents: Math.max(0, data.wallets[walletIndex].frozenCents - current.amountCents),
            updatedAt: now,
          };
    const charge: JobCharge = {
      ...current,
      status,
      chargedAt: status === 'charged' ? now : current.chargedAt,
      releasedAt: status === 'released' ? now : current.releasedAt,
      updatedAt: now,
    };
    data.wallets[walletIndex] = wallet;
    data.jobCharges[chargeIndex] = charge;
    data.ledger.push(
      createLedgerEntry({
        userId: charge.userId,
        tenantId: charge.tenantId,
        type: status === 'charged' ? 'job_charge' : 'job_release',
        cashDeltaCents: status === 'released' ? charge.amountCents : 0,
        bonusDeltaCents: 0,
        frozenDeltaCents: -charge.amountCents,
        balanceAfterCashCents: wallet.cashBalanceCents,
        frozenAfterCents: wallet.frozenCents,
        jobId,
        jobChargeId: charge.id,
        note: note || 'Job fee charged',
      })
    );
    await this.write(data);
    return charge;
  }

  private async read(): Promise<AccountStoreFile> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AccountStoreFile>;
      return {
        ...emptyFile(),
        ...parsed,
        users: Array.isArray(parsed.users) ? parsed.users : [],
        wallets: Array.isArray(parsed.wallets) ? parsed.wallets : [],
        ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
        rechargeOrders: Array.isArray(parsed.rechargeOrders) ? parsed.rechargeOrders : [],
        jobCharges: Array.isArray(parsed.jobCharges) ? parsed.jobCharges : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
      throw error;
    }
  }

  private async write(data: AccountStoreFile): Promise<void> {
    await ensureParentDir(this.filePath);
    const tempPath = `${this.filePath}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2));
    await fs.promises.rename(tempPath, this.filePath);
  }
}

interface UserRow extends RowDataPacket {
  user_json: WebUser | string;
}

interface WalletRow extends RowDataPacket {
  user_id: string;
  tenant_id: string;
  cash_balance_cents: number;
  bonus_balance_cents: number;
  frozen_cents: number;
  updated_at: string;
}

interface LedgerRow extends RowDataPacket {
  ledger_json: WalletLedgerEntry | string;
}

interface RechargeOrderRow extends RowDataPacket {
  order_json: RechargeOrder | string;
}

interface JobChargeRow extends RowDataPacket {
  charge_json: JobCharge | string;
}

function walletFromMySqlRow(row: WalletRow): Wallet {
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    cashBalanceCents: Number(row.cash_balance_cents),
    bonusBalanceCents: Number(row.bonus_balance_cents),
    frozenCents: Number(row.frozen_cents),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class MySqlAccountStore implements AccountStore {
  constructor(private readonly client: MySqlQueryable = getMySqlPool()) {}

  async upsertWechatUser(input: UpsertWechatUserInput): Promise<WebUser> {
    return withMySqlTransaction(async (client) => {
      await ensureMySqlSchema(client);
      const [existingRows] = input.unionId
        ? await client.execute<UserRow[]>(
            'SELECT user_json FROM optimizer_users WHERE wechat_openid = ? OR wechat_unionid = ? LIMIT 1 FOR UPDATE',
            [input.openId, input.unionId]
          )
        : await client.execute<UserRow[]>('SELECT user_json FROM optimizer_users WHERE wechat_openid = ? FOR UPDATE', [
            input.openId,
          ]);
      const now = nowIso();
      if (existingRows[0]) {
        const current = parseJson<WebUser>(existingRows[0].user_json);
        const updated: WebUser = {
          ...current,
          wechatOpenId: input.openId,
          wechatUnionId: input.unionId || current.wechatUnionId,
          wechatAccountHint: input.accountHint || current.wechatAccountHint,
          nickname: input.nickname || current.nickname,
          avatarUrl: input.avatarUrl || current.avatarUrl,
          updatedAt: now,
        };
        await this.updateUserRow(client, updated);
        return updated;
      }

      const id = uuidv4();
      const user: WebUser = {
        id,
        tenantId: createWebTenantId(id),
        wechatOpenId: input.openId,
        wechatUnionId: input.unionId,
        wechatAccountHint: input.accountHint,
        nickname: input.nickname,
        avatarUrl: input.avatarUrl,
        createdAt: now,
        updatedAt: now,
      };
      await client.execute(
        `
          INSERT INTO optimizer_users (
            id, tenant_id, auth_user_id, wechat_openid, wechat_unionid, user_json, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          user.id,
          user.tenantId,
          user.authUserId || null,
          user.wechatOpenId,
          user.wechatUnionId || null,
          JSON.stringify(user),
          mysqlDateTime(user.createdAt),
          mysqlDateTime(user.updatedAt),
        ]
      );
      await this.insertWalletRow(client, createWallet(user, now));
      return user;
    });
  }

  async upsertAuthServiceUser(input: UpsertAuthServiceUserInput): Promise<WebUser> {
    return withMySqlTransaction(async (client) => {
      await ensureMySqlSchema(client);
      const fallbackOpenId = createAuthServiceWechatOpenId(input.authUserId);
      const [existingRows] = input.unionId
        ? await client.execute<UserRow[]>(
            'SELECT user_json FROM optimizer_users WHERE auth_user_id = ? OR wechat_openid = ? OR wechat_unionid = ? LIMIT 1 FOR UPDATE',
            [input.authUserId, fallbackOpenId, input.unionId]
          )
        : await client.execute<UserRow[]>(
            'SELECT user_json FROM optimizer_users WHERE auth_user_id = ? OR wechat_openid = ? LIMIT 1 FOR UPDATE',
            [input.authUserId, fallbackOpenId]
          );
      const now = nowIso();
      if (existingRows[0]) {
        const current = parseJson<WebUser>(existingRows[0].user_json);
        const updated: WebUser = {
          ...current,
          authUserId: input.authUserId,
          wechatUnionId: input.unionId || current.wechatUnionId,
          wechatAccountHint: input.accountHint || current.wechatAccountHint,
          nickname: input.nickname || current.nickname,
          avatarUrl: input.avatarUrl || current.avatarUrl,
          updatedAt: now,
        };
        await this.updateUserRow(client, updated);
        return updated;
      }

      const id = uuidv4();
      const user: WebUser = {
        id,
        tenantId: createWebTenantId(id),
        authUserId: input.authUserId,
        wechatOpenId: fallbackOpenId,
        wechatUnionId: input.unionId,
        wechatAccountHint: input.accountHint,
        nickname: input.nickname,
        avatarUrl: input.avatarUrl,
        createdAt: now,
        updatedAt: now,
      };
      await client.execute(
        `
          INSERT INTO optimizer_users (
            id, tenant_id, auth_user_id, wechat_openid, wechat_unionid, user_json, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          user.id,
          user.tenantId,
          input.authUserId,
          user.wechatOpenId,
          user.wechatUnionId || null,
          JSON.stringify(user),
          mysqlDateTime(user.createdAt),
          mysqlDateTime(user.updatedAt),
        ]
      );
      await this.insertWalletRow(client, createWallet(user, now));
      return user;
    });
  }

  async getUser(userId: string): Promise<WebUser | undefined> {
    await ensureMySqlSchema(this.client);
    const [rows] = await this.client.execute<UserRow[]>('SELECT user_json FROM optimizer_users WHERE id = ?', [userId]);
    return rows[0] ? parseJson<WebUser>(rows[0].user_json) : undefined;
  }

  async findUserByWechat(openId: string): Promise<WebUser | undefined> {
    await ensureMySqlSchema(this.client);
    const [rows] = await this.client.execute<UserRow[]>('SELECT user_json FROM optimizer_users WHERE wechat_openid = ?', [
      openId,
    ]);
    return rows[0] ? parseJson<WebUser>(rows[0].user_json) : undefined;
  }

  async getWallet(userId: string): Promise<Wallet> {
    await ensureMySqlSchema(this.client);
    const [rows] = await this.client.execute<WalletRow[]>('SELECT * FROM optimizer_wallets WHERE user_id = ?', [userId]);
    if (!rows[0]) throw new Error(`Wallet not found for user: ${userId}`);
    return walletFromMySqlRow(rows[0]);
  }

  async listLedger(userId: string, limit?: number): Promise<WalletLedgerEntry[]> {
    await ensureMySqlSchema(this.client);
    const safeLimit = normalizeLimit(limit);
    const [rows] = await this.client.execute<LedgerRow[]>(
      `SELECT ledger_json FROM optimizer_wallet_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
      [userId]
    );
    return rows.map((row) => parseJson<WalletLedgerEntry>(row.ledger_json));
  }

  async createRechargeOrder(order: RechargeOrder): Promise<RechargeOrder> {
    await ensureMySqlSchema(this.client);
    await this.insertRechargeOrderRow(this.client, order);
    return order;
  }

  async getRechargeOrder(orderId: string): Promise<RechargeOrder | undefined> {
    await ensureMySqlSchema(this.client);
    const [rows] = await this.client.execute<RechargeOrderRow[]>(
      'SELECT order_json FROM optimizer_recharge_orders WHERE id = ?',
      [orderId]
    );
    return rows[0] ? parseJson<RechargeOrder>(rows[0].order_json) : undefined;
  }

  async findRechargeOrderByOutTradeNo(outTradeNo: string): Promise<RechargeOrder | undefined> {
    await ensureMySqlSchema(this.client);
    const [rows] = await this.client.execute<RechargeOrderRow[]>(
      'SELECT order_json FROM optimizer_recharge_orders WHERE out_trade_no = ?',
      [outTradeNo]
    );
    return rows[0] ? parseJson<RechargeOrder>(rows[0].order_json) : undefined;
  }

  async markRechargePaid(orderId: string, transactionId?: string): Promise<{ order: RechargeOrder; wallet: Wallet }> {
    return withMySqlTransaction(async (client) => {
      await ensureMySqlSchema(client);
      const [rows] = await client.execute<RechargeOrderRow[]>(
        'SELECT order_json FROM optimizer_recharge_orders WHERE id = ? FOR UPDATE',
        [orderId]
      );
      if (!rows[0]) throw new Error(`Recharge order not found: ${orderId}`);
      const current = parseJson<RechargeOrder>(rows[0].order_json);
      const wallet = await this.lockWallet(client, current.userId);
      if (current.status === 'paid') return { order: current, wallet };
      if (current.status !== 'pending_payment') {
        throw new Error(`Cannot pay recharge order ${orderId} from ${current.status}`);
      }
      const now = nowIso();
      const nextWallet: Wallet = {
        ...wallet,
        cashBalanceCents: wallet.cashBalanceCents + current.amountCents,
        updatedAt: now,
      };
      const order: RechargeOrder = {
        ...current,
        status: 'paid',
        transactionId,
        paidAt: now,
        updatedAt: now,
      };
      await this.updateWalletRow(client, nextWallet);
      await this.updateRechargeOrderRow(client, order);
      await this.insertLedgerRow(
        client,
        createLedgerEntry({
          userId: order.userId,
          tenantId: order.tenantId,
          type: 'recharge_paid',
          cashDeltaCents: order.amountCents,
          bonusDeltaCents: 0,
          frozenDeltaCents: 0,
          balanceAfterCashCents: nextWallet.cashBalanceCents,
          frozenAfterCents: nextWallet.frozenCents,
          rechargeOrderId: order.id,
          note: 'Wechat recharge paid',
        })
      );
      return { order, wallet: nextWallet };
    });
  }

  async holdJobCharge(input: { user: WebUser; jobId: string; amountCents: number }): Promise<{ charge: JobCharge; wallet: Wallet }> {
    return withMySqlTransaction(async (client) => {
      await ensureMySqlSchema(client);
      const [existingRows] = await client.execute<JobChargeRow[]>(
        'SELECT charge_json FROM optimizer_job_charges WHERE job_id = ? FOR UPDATE',
        [input.jobId]
      );
      const wallet = await this.lockWallet(client, input.user.id);
      if (existingRows[0]) return { charge: parseJson<JobCharge>(existingRows[0].charge_json), wallet };
      if (wallet.cashBalanceCents < input.amountCents) throw new Error('Insufficient wallet balance');
      const now = nowIso();
      const nextWallet: Wallet = {
        ...wallet,
        cashBalanceCents: wallet.cashBalanceCents - input.amountCents,
        frozenCents: wallet.frozenCents + input.amountCents,
        updatedAt: now,
      };
      const charge: JobCharge = {
        id: uuidv4(),
        userId: input.user.id,
        tenantId: input.user.tenantId,
        jobId: input.jobId,
        amountCents: input.amountCents,
        status: 'held',
        heldAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await this.updateWalletRow(client, nextWallet);
      await this.insertJobChargeRow(client, charge);
      await this.insertLedgerRow(
        client,
        createLedgerEntry({
          userId: charge.userId,
          tenantId: charge.tenantId,
          type: 'job_hold',
          cashDeltaCents: -charge.amountCents,
          bonusDeltaCents: 0,
          frozenDeltaCents: charge.amountCents,
          balanceAfterCashCents: nextWallet.cashBalanceCents,
          frozenAfterCents: nextWallet.frozenCents,
          jobId: charge.jobId,
          jobChargeId: charge.id,
          note: 'Job fee held',
        })
      );
      return { charge, wallet: nextWallet };
    });
  }

  async settleJobCharge(jobId: string): Promise<JobCharge | undefined> {
    return this.finishJobCharge(jobId, 'charged');
  }

  async releaseJobCharge(jobId: string, note?: string): Promise<JobCharge | undefined> {
    return this.finishJobCharge(jobId, 'released', note);
  }

  async getJobCharge(jobId: string): Promise<JobCharge | undefined> {
    await ensureMySqlSchema(this.client);
    const [rows] = await this.client.execute<JobChargeRow[]>(
      'SELECT charge_json FROM optimizer_job_charges WHERE job_id = ?',
      [jobId]
    );
    return rows[0] ? parseJson<JobCharge>(rows[0].charge_json) : undefined;
  }

  private async finishJobCharge(jobId: string, status: 'charged' | 'released', note?: string): Promise<JobCharge | undefined> {
    return withMySqlTransaction(async (client) => {
      await ensureMySqlSchema(client);
      const [rows] = await client.execute<JobChargeRow[]>(
        'SELECT charge_json FROM optimizer_job_charges WHERE job_id = ? FOR UPDATE',
        [jobId]
      );
      if (!rows[0]) return undefined;
      const current = parseJson<JobCharge>(rows[0].charge_json);
      const wallet = await this.lockWallet(client, current.userId);
      if (current.status !== 'held') return current;
      const now = nowIso();
      const nextWallet: Wallet =
        status === 'released'
          ? {
              ...wallet,
              cashBalanceCents: wallet.cashBalanceCents + current.amountCents,
              frozenCents: Math.max(0, wallet.frozenCents - current.amountCents),
              updatedAt: now,
            }
          : {
              ...wallet,
              frozenCents: Math.max(0, wallet.frozenCents - current.amountCents),
              updatedAt: now,
            };
      const charge: JobCharge = {
        ...current,
        status,
        chargedAt: status === 'charged' ? now : current.chargedAt,
        releasedAt: status === 'released' ? now : current.releasedAt,
        updatedAt: now,
      };
      await this.updateWalletRow(client, nextWallet);
      await this.updateJobChargeRow(client, charge);
      await this.insertLedgerRow(
        client,
        createLedgerEntry({
          userId: charge.userId,
          tenantId: charge.tenantId,
          type: status === 'charged' ? 'job_charge' : 'job_release',
          cashDeltaCents: status === 'released' ? charge.amountCents : 0,
          bonusDeltaCents: 0,
          frozenDeltaCents: -charge.amountCents,
          balanceAfterCashCents: nextWallet.cashBalanceCents,
          frozenAfterCents: nextWallet.frozenCents,
          jobId: charge.jobId,
          jobChargeId: charge.id,
          note: note || 'Job fee charged',
        })
      );
      return charge;
    });
  }

  private async updateUserRow(client: MySqlQueryable, user: WebUser): Promise<void> {
    await client.execute(
      `
        UPDATE optimizer_users SET
          tenant_id = ?,
          auth_user_id = ?,
          wechat_openid = ?,
          wechat_unionid = ?,
          user_json = ?,
          updated_at = ?
        WHERE id = ?
      `,
      [
        user.tenantId,
        user.authUserId || null,
        user.wechatOpenId,
        user.wechatUnionId || null,
        JSON.stringify(user),
        mysqlDateTime(user.updatedAt),
        user.id,
      ]
    );
  }

  private async insertWalletRow(client: MySqlQueryable, wallet: Wallet): Promise<void> {
    await client.execute(
      `
        INSERT INTO optimizer_wallets (
          user_id, tenant_id, cash_balance_cents, bonus_balance_cents, frozen_cents, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        wallet.userId,
        wallet.tenantId,
        wallet.cashBalanceCents,
        wallet.bonusBalanceCents,
        wallet.frozenCents,
        mysqlDateTime(wallet.updatedAt),
      ]
    );
  }

  private async lockWallet(client: MySqlQueryable, userId: string): Promise<Wallet> {
    const [rows] = await client.execute<WalletRow[]>('SELECT * FROM optimizer_wallets WHERE user_id = ? FOR UPDATE', [userId]);
    if (!rows[0]) throw new Error(`Wallet not found for user: ${userId}`);
    return walletFromMySqlRow(rows[0]);
  }

  private async updateWalletRow(client: MySqlQueryable, wallet: Wallet): Promise<void> {
    const [result] = await client.execute<ResultSetHeader>(
      `
        UPDATE optimizer_wallets SET
          cash_balance_cents = ?,
          bonus_balance_cents = ?,
          frozen_cents = ?,
          updated_at = ?
        WHERE user_id = ?
      `,
      [
        wallet.cashBalanceCents,
        wallet.bonusBalanceCents,
        wallet.frozenCents,
        mysqlDateTime(wallet.updatedAt),
        wallet.userId,
      ]
    );
    if (result.affectedRows === 0) throw new Error(`Wallet not found for user: ${wallet.userId}`);
  }

  private async insertLedgerRow(client: MySqlQueryable, entry: WalletLedgerEntry): Promise<void> {
    await client.execute(
      `
        INSERT INTO optimizer_wallet_ledger (
          id, user_id, tenant_id, type, cash_delta_cents, bonus_delta_cents,
          frozen_delta_cents, balance_after_cash_cents, frozen_after_cents,
          recharge_order_id, job_id, job_charge_id, ledger_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        entry.id,
        entry.userId,
        entry.tenantId,
        entry.type,
        entry.cashDeltaCents,
        entry.bonusDeltaCents,
        entry.frozenDeltaCents,
        entry.balanceAfterCashCents,
        entry.frozenAfterCents,
        entry.rechargeOrderId || null,
        entry.jobId || null,
        entry.jobChargeId || null,
        JSON.stringify(entry),
        mysqlDateTime(entry.createdAt),
      ]
    );
  }

  private async insertRechargeOrderRow(client: MySqlQueryable, order: RechargeOrder): Promise<void> {
    await client.execute(
      `
        INSERT INTO optimizer_recharge_orders (
          id, user_id, tenant_id, status, amount_cents, currency, provider,
          out_trade_no, transaction_id, code_url, expires_at, paid_at,
          order_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        order.id,
        order.userId,
        order.tenantId,
        order.status,
        order.amountCents,
        order.currency,
        order.provider,
        order.outTradeNo,
        order.transactionId || null,
        order.codeUrl || null,
        mysqlDateTime(order.expiresAt),
        mysqlDateTime(order.paidAt),
        JSON.stringify(order),
        mysqlDateTime(order.createdAt),
        mysqlDateTime(order.updatedAt),
      ]
    );
  }

  private async updateRechargeOrderRow(client: MySqlQueryable, order: RechargeOrder): Promise<void> {
    await client.execute(
      `
        UPDATE optimizer_recharge_orders SET
          status = ?,
          transaction_id = ?,
          code_url = ?,
          expires_at = ?,
          paid_at = ?,
          order_json = ?,
          updated_at = ?
        WHERE id = ?
      `,
      [
        order.status,
        order.transactionId || null,
        order.codeUrl || null,
        mysqlDateTime(order.expiresAt),
        mysqlDateTime(order.paidAt),
        JSON.stringify(order),
        mysqlDateTime(order.updatedAt),
        order.id,
      ]
    );
  }

  private async insertJobChargeRow(client: MySqlQueryable, charge: JobCharge): Promise<void> {
    await client.execute(
      `
        INSERT INTO optimizer_job_charges (
          id, user_id, tenant_id, job_id, amount_cents, status, charge_json,
          held_at, charged_at, released_at, refunded_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        charge.id,
        charge.userId,
        charge.tenantId,
        charge.jobId,
        charge.amountCents,
        charge.status,
        JSON.stringify(charge),
        mysqlDateTime(charge.heldAt),
        mysqlDateTime(charge.chargedAt),
        mysqlDateTime(charge.releasedAt),
        mysqlDateTime(charge.refundedAt),
        mysqlDateTime(charge.createdAt),
        mysqlDateTime(charge.updatedAt),
      ]
    );
  }

  private async updateJobChargeRow(client: MySqlQueryable, charge: JobCharge): Promise<void> {
    await client.execute(
      `
        UPDATE optimizer_job_charges SET
          status = ?,
          charge_json = ?,
          charged_at = ?,
          released_at = ?,
          refunded_at = ?,
          updated_at = ?
        WHERE id = ?
      `,
      [
        charge.status,
        JSON.stringify(charge),
        mysqlDateTime(charge.chargedAt),
        mysqlDateTime(charge.releasedAt),
        mysqlDateTime(charge.refundedAt),
        mysqlDateTime(charge.updatedAt),
        charge.id,
      ]
    );
  }
}

interface PgUserRow extends QueryResultRow {
  user_json: WebUser | string;
}

interface PgWalletRow extends QueryResultRow {
  user_id: string;
  tenant_id: string;
  cash_balance_cents: number;
  bonus_balance_cents: number;
  frozen_cents: number;
  updated_at: string;
}

interface PgLedgerRow extends QueryResultRow {
  ledger_json: WalletLedgerEntry | string;
}

interface PgRechargeOrderRow extends QueryResultRow {
  order_json: RechargeOrder | string;
}

interface PgJobChargeRow extends QueryResultRow {
  charge_json: JobCharge | string;
}

function walletFromPgRow(row: PgWalletRow): Wallet {
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    cashBalanceCents: Number(row.cash_balance_cents),
    bonusBalanceCents: Number(row.bonus_balance_cents),
    frozenCents: Number(row.frozen_cents),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PostgresAccountStore implements AccountStore {
  constructor(private readonly client: SqlQueryable = getPostgresPool()) {}

  async upsertWechatUser(input: UpsertWechatUserInput): Promise<WebUser> {
    return withPostgresTransaction(async (client) => {
      await ensurePostgresSchema(client);
      const result = input.unionId
        ? await client.query<PgUserRow>(
            'SELECT user_json FROM optimizer_users WHERE wechat_openid = $1 OR wechat_unionid = $2 LIMIT 1 FOR UPDATE',
            [input.openId, input.unionId]
          )
        : await client.query<PgUserRow>('SELECT user_json FROM optimizer_users WHERE wechat_openid = $1 FOR UPDATE', [
            input.openId,
          ]);
      const now = nowIso();
      if (result.rows[0]) {
        const current = parseJson<WebUser>(result.rows[0].user_json);
        const updated: WebUser = {
          ...current,
          wechatOpenId: input.openId,
          wechatUnionId: input.unionId || current.wechatUnionId,
          wechatAccountHint: input.accountHint || current.wechatAccountHint,
          nickname: input.nickname || current.nickname,
          avatarUrl: input.avatarUrl || current.avatarUrl,
          updatedAt: now,
        };
        await this.updateUserRow(client, updated);
        return updated;
      }

      const id = uuidv4();
      const user: WebUser = {
        id,
        tenantId: createWebTenantId(id),
        wechatOpenId: input.openId,
        wechatUnionId: input.unionId,
        wechatAccountHint: input.accountHint,
        nickname: input.nickname,
        avatarUrl: input.avatarUrl,
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        `
          INSERT INTO optimizer_users (
            id, tenant_id, auth_user_id, wechat_openid, wechat_unionid, user_json, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        `,
        [
          user.id,
          user.tenantId,
          user.authUserId || null,
          user.wechatOpenId,
          user.wechatUnionId || null,
          JSON.stringify(user),
          user.createdAt,
          user.updatedAt,
        ]
      );
      await this.insertWalletRow(client, createWallet(user, now));
      return user;
    });
  }

  async upsertAuthServiceUser(input: UpsertAuthServiceUserInput): Promise<WebUser> {
    return withPostgresTransaction(async (client) => {
      await ensurePostgresSchema(client);
      const fallbackOpenId = createAuthServiceWechatOpenId(input.authUserId);
      const result = input.unionId
        ? await client.query<PgUserRow>(
            'SELECT user_json FROM optimizer_users WHERE auth_user_id = $1 OR wechat_openid = $2 OR wechat_unionid = $3 LIMIT 1 FOR UPDATE',
            [input.authUserId, fallbackOpenId, input.unionId]
          )
        : await client.query<PgUserRow>(
            'SELECT user_json FROM optimizer_users WHERE auth_user_id = $1 OR wechat_openid = $2 LIMIT 1 FOR UPDATE',
            [input.authUserId, fallbackOpenId]
          );
      const now = nowIso();
      if (result.rows[0]) {
        const current = parseJson<WebUser>(result.rows[0].user_json);
        const updated: WebUser = {
          ...current,
          authUserId: input.authUserId,
          wechatUnionId: input.unionId || current.wechatUnionId,
          wechatAccountHint: input.accountHint || current.wechatAccountHint,
          nickname: input.nickname || current.nickname,
          avatarUrl: input.avatarUrl || current.avatarUrl,
          updatedAt: now,
        };
        await this.updateUserRow(client, updated);
        return updated;
      }

      const id = uuidv4();
      const user: WebUser = {
        id,
        tenantId: createWebTenantId(id),
        authUserId: input.authUserId,
        wechatOpenId: fallbackOpenId,
        wechatUnionId: input.unionId,
        wechatAccountHint: input.accountHint,
        nickname: input.nickname,
        avatarUrl: input.avatarUrl,
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        `
          INSERT INTO optimizer_users (
            id, tenant_id, auth_user_id, wechat_openid, wechat_unionid, user_json, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        `,
        [
          user.id,
          user.tenantId,
          input.authUserId,
          user.wechatOpenId,
          user.wechatUnionId || null,
          JSON.stringify(user),
          user.createdAt,
          user.updatedAt,
        ]
      );
      await this.insertWalletRow(client, createWallet(user, now));
      return user;
    });
  }

  async getUser(userId: string): Promise<WebUser | undefined> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<PgUserRow>('SELECT user_json FROM optimizer_users WHERE id = $1', [userId]);
    return result.rows[0] ? parseJson<WebUser>(result.rows[0].user_json) : undefined;
  }

  async findUserByWechat(openId: string): Promise<WebUser | undefined> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<PgUserRow>('SELECT user_json FROM optimizer_users WHERE wechat_openid = $1', [
      openId,
    ]);
    return result.rows[0] ? parseJson<WebUser>(result.rows[0].user_json) : undefined;
  }

  async getWallet(userId: string): Promise<Wallet> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<PgWalletRow>('SELECT * FROM optimizer_wallets WHERE user_id = $1', [userId]);
    if (!result.rows[0]) throw new Error(`Wallet not found for user: ${userId}`);
    return walletFromPgRow(result.rows[0]);
  }

  async listLedger(userId: string, limit?: number): Promise<WalletLedgerEntry[]> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<PgLedgerRow>(
      'SELECT ledger_json FROM optimizer_wallet_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, normalizeLimit(limit)]
    );
    return result.rows.map((row) => parseJson<WalletLedgerEntry>(row.ledger_json));
  }

  async createRechargeOrder(order: RechargeOrder): Promise<RechargeOrder> {
    await ensurePostgresSchema(this.client);
    await this.insertRechargeOrderRow(this.client, order);
    return order;
  }

  async getRechargeOrder(orderId: string): Promise<RechargeOrder | undefined> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<PgRechargeOrderRow>(
      'SELECT order_json FROM optimizer_recharge_orders WHERE id = $1',
      [orderId]
    );
    return result.rows[0] ? parseJson<RechargeOrder>(result.rows[0].order_json) : undefined;
  }

  async findRechargeOrderByOutTradeNo(outTradeNo: string): Promise<RechargeOrder | undefined> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<PgRechargeOrderRow>(
      'SELECT order_json FROM optimizer_recharge_orders WHERE out_trade_no = $1',
      [outTradeNo]
    );
    return result.rows[0] ? parseJson<RechargeOrder>(result.rows[0].order_json) : undefined;
  }

  async markRechargePaid(orderId: string, transactionId?: string): Promise<{ order: RechargeOrder; wallet: Wallet }> {
    return withPostgresTransaction(async (client) => {
      await ensurePostgresSchema(client);
      const result = await client.query<PgRechargeOrderRow>(
        'SELECT order_json FROM optimizer_recharge_orders WHERE id = $1 FOR UPDATE',
        [orderId]
      );
      if (!result.rows[0]) throw new Error(`Recharge order not found: ${orderId}`);
      const current = parseJson<RechargeOrder>(result.rows[0].order_json);
      const wallet = await this.lockWallet(client, current.userId);
      if (current.status === 'paid') return { order: current, wallet };
      if (current.status !== 'pending_payment') {
        throw new Error(`Cannot pay recharge order ${orderId} from ${current.status}`);
      }
      const now = nowIso();
      const nextWallet: Wallet = { ...wallet, cashBalanceCents: wallet.cashBalanceCents + current.amountCents, updatedAt: now };
      const order: RechargeOrder = { ...current, status: 'paid', transactionId, paidAt: now, updatedAt: now };
      await this.updateWalletRow(client, nextWallet);
      await this.updateRechargeOrderRow(client, order);
      await this.insertLedgerRow(
        client,
        createLedgerEntry({
          userId: order.userId,
          tenantId: order.tenantId,
          type: 'recharge_paid',
          cashDeltaCents: order.amountCents,
          bonusDeltaCents: 0,
          frozenDeltaCents: 0,
          balanceAfterCashCents: nextWallet.cashBalanceCents,
          frozenAfterCents: nextWallet.frozenCents,
          rechargeOrderId: order.id,
          note: 'Wechat recharge paid',
        })
      );
      return { order, wallet: nextWallet };
    });
  }

  async holdJobCharge(input: { user: WebUser; jobId: string; amountCents: number }): Promise<{ charge: JobCharge; wallet: Wallet }> {
    return withPostgresTransaction(async (client) => {
      await ensurePostgresSchema(client);
      const existing = await client.query<PgJobChargeRow>(
        'SELECT charge_json FROM optimizer_job_charges WHERE job_id = $1 FOR UPDATE',
        [input.jobId]
      );
      const wallet = await this.lockWallet(client, input.user.id);
      if (existing.rows[0]) return { charge: parseJson<JobCharge>(existing.rows[0].charge_json), wallet };
      if (wallet.cashBalanceCents < input.amountCents) throw new Error('Insufficient wallet balance');
      const now = nowIso();
      const nextWallet: Wallet = {
        ...wallet,
        cashBalanceCents: wallet.cashBalanceCents - input.amountCents,
        frozenCents: wallet.frozenCents + input.amountCents,
        updatedAt: now,
      };
      const charge: JobCharge = {
        id: uuidv4(),
        userId: input.user.id,
        tenantId: input.user.tenantId,
        jobId: input.jobId,
        amountCents: input.amountCents,
        status: 'held',
        heldAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await this.updateWalletRow(client, nextWallet);
      await this.insertJobChargeRow(client, charge);
      await this.insertLedgerRow(
        client,
        createLedgerEntry({
          userId: charge.userId,
          tenantId: charge.tenantId,
          type: 'job_hold',
          cashDeltaCents: -charge.amountCents,
          bonusDeltaCents: 0,
          frozenDeltaCents: charge.amountCents,
          balanceAfterCashCents: nextWallet.cashBalanceCents,
          frozenAfterCents: nextWallet.frozenCents,
          jobId: charge.jobId,
          jobChargeId: charge.id,
          note: 'Job fee held',
        })
      );
      return { charge, wallet: nextWallet };
    });
  }

  async settleJobCharge(jobId: string): Promise<JobCharge | undefined> {
    return this.finishJobCharge(jobId, 'charged');
  }

  async releaseJobCharge(jobId: string, note?: string): Promise<JobCharge | undefined> {
    return this.finishJobCharge(jobId, 'released', note);
  }

  async getJobCharge(jobId: string): Promise<JobCharge | undefined> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<PgJobChargeRow>(
      'SELECT charge_json FROM optimizer_job_charges WHERE job_id = $1',
      [jobId]
    );
    return result.rows[0] ? parseJson<JobCharge>(result.rows[0].charge_json) : undefined;
  }

  private async finishJobCharge(jobId: string, status: 'charged' | 'released', note?: string): Promise<JobCharge | undefined> {
    return withPostgresTransaction(async (client) => {
      await ensurePostgresSchema(client);
      const result = await client.query<PgJobChargeRow>(
        'SELECT charge_json FROM optimizer_job_charges WHERE job_id = $1 FOR UPDATE',
        [jobId]
      );
      if (!result.rows[0]) return undefined;
      const current = parseJson<JobCharge>(result.rows[0].charge_json);
      const wallet = await this.lockWallet(client, current.userId);
      if (current.status !== 'held') return current;
      const now = nowIso();
      const nextWallet: Wallet =
        status === 'released'
          ? {
              ...wallet,
              cashBalanceCents: wallet.cashBalanceCents + current.amountCents,
              frozenCents: Math.max(0, wallet.frozenCents - current.amountCents),
              updatedAt: now,
            }
          : { ...wallet, frozenCents: Math.max(0, wallet.frozenCents - current.amountCents), updatedAt: now };
      const charge: JobCharge = {
        ...current,
        status,
        chargedAt: status === 'charged' ? now : current.chargedAt,
        releasedAt: status === 'released' ? now : current.releasedAt,
        updatedAt: now,
      };
      await this.updateWalletRow(client, nextWallet);
      await this.updateJobChargeRow(client, charge);
      await this.insertLedgerRow(
        client,
        createLedgerEntry({
          userId: charge.userId,
          tenantId: charge.tenantId,
          type: status === 'charged' ? 'job_charge' : 'job_release',
          cashDeltaCents: status === 'released' ? charge.amountCents : 0,
          bonusDeltaCents: 0,
          frozenDeltaCents: -charge.amountCents,
          balanceAfterCashCents: nextWallet.cashBalanceCents,
          frozenAfterCents: nextWallet.frozenCents,
          jobId: charge.jobId,
          jobChargeId: charge.id,
          note: note || 'Job fee charged',
        })
      );
      return charge;
    });
  }

  private async updateUserRow(client: SqlQueryable, user: WebUser): Promise<void> {
    await client.query(
      `
        UPDATE optimizer_users SET
          tenant_id = $1,
          auth_user_id = $2,
          wechat_openid = $3,
          wechat_unionid = $4,
          user_json = $5::jsonb,
          updated_at = $6
        WHERE id = $7
      `,
      [user.tenantId, user.authUserId || null, user.wechatOpenId, user.wechatUnionId || null, JSON.stringify(user), user.updatedAt, user.id]
    );
  }

  private async insertWalletRow(client: SqlQueryable, wallet: Wallet): Promise<void> {
    await client.query(
      `
        INSERT INTO optimizer_wallets (
          user_id, tenant_id, cash_balance_cents, bonus_balance_cents, frozen_cents, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [wallet.userId, wallet.tenantId, wallet.cashBalanceCents, wallet.bonusBalanceCents, wallet.frozenCents, wallet.updatedAt]
    );
  }

  private async lockWallet(client: SqlQueryable, userId: string): Promise<Wallet> {
    const result = await client.query<PgWalletRow>('SELECT * FROM optimizer_wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    if (!result.rows[0]) throw new Error(`Wallet not found for user: ${userId}`);
    return walletFromPgRow(result.rows[0]);
  }

  private async updateWalletRow(client: SqlQueryable, wallet: Wallet): Promise<void> {
    await client.query(
      `
        UPDATE optimizer_wallets SET
          cash_balance_cents = $1,
          bonus_balance_cents = $2,
          frozen_cents = $3,
          updated_at = $4
        WHERE user_id = $5
      `,
      [wallet.cashBalanceCents, wallet.bonusBalanceCents, wallet.frozenCents, wallet.updatedAt, wallet.userId]
    );
  }

  private async insertLedgerRow(client: SqlQueryable, entry: WalletLedgerEntry): Promise<void> {
    await client.query(
      `
        INSERT INTO optimizer_wallet_ledger (
          id, user_id, tenant_id, type, cash_delta_cents, bonus_delta_cents,
          frozen_delta_cents, balance_after_cash_cents, frozen_after_cents,
          recharge_order_id, job_id, job_charge_id, ledger_json, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
      `,
      [
        entry.id,
        entry.userId,
        entry.tenantId,
        entry.type,
        entry.cashDeltaCents,
        entry.bonusDeltaCents,
        entry.frozenDeltaCents,
        entry.balanceAfterCashCents,
        entry.frozenAfterCents,
        entry.rechargeOrderId || null,
        entry.jobId || null,
        entry.jobChargeId || null,
        JSON.stringify(entry),
        entry.createdAt,
      ]
    );
  }

  private async insertRechargeOrderRow(client: SqlQueryable, order: RechargeOrder): Promise<void> {
    await client.query(
      `
        INSERT INTO optimizer_recharge_orders (
          id, user_id, tenant_id, status, amount_cents, currency, provider,
          out_trade_no, transaction_id, code_url, expires_at, paid_at,
          order_json, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
      `,
      [
        order.id,
        order.userId,
        order.tenantId,
        order.status,
        order.amountCents,
        order.currency,
        order.provider,
        order.outTradeNo,
        order.transactionId || null,
        order.codeUrl || null,
        order.expiresAt,
        order.paidAt || null,
        JSON.stringify(order),
        order.createdAt,
        order.updatedAt,
      ]
    );
  }

  private async updateRechargeOrderRow(client: SqlQueryable, order: RechargeOrder): Promise<void> {
    await client.query(
      `
        UPDATE optimizer_recharge_orders SET
          status = $1,
          transaction_id = $2,
          code_url = $3,
          expires_at = $4,
          paid_at = $5,
          order_json = $6::jsonb,
          updated_at = $7
        WHERE id = $8
      `,
      [
        order.status,
        order.transactionId || null,
        order.codeUrl || null,
        order.expiresAt,
        order.paidAt || null,
        JSON.stringify(order),
        order.updatedAt,
        order.id,
      ]
    );
  }

  private async insertJobChargeRow(client: SqlQueryable, charge: JobCharge): Promise<void> {
    await client.query(
      `
        INSERT INTO optimizer_job_charges (
          id, user_id, tenant_id, job_id, amount_cents, status, charge_json,
          held_at, charged_at, released_at, refunded_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)
      `,
      [
        charge.id,
        charge.userId,
        charge.tenantId,
        charge.jobId,
        charge.amountCents,
        charge.status,
        JSON.stringify(charge),
        charge.heldAt,
        charge.chargedAt || null,
        charge.releasedAt || null,
        charge.refundedAt || null,
        charge.createdAt,
        charge.updatedAt,
      ]
    );
  }

  private async updateJobChargeRow(client: SqlQueryable, charge: JobCharge): Promise<void> {
    await client.query(
      `
        UPDATE optimizer_job_charges SET
          status = $1,
          charge_json = $2::jsonb,
          charged_at = $3,
          released_at = $4,
          refunded_at = $5,
          updated_at = $6
        WHERE id = $7
      `,
      [
        charge.status,
        JSON.stringify(charge),
        charge.chargedAt || null,
        charge.releasedAt || null,
        charge.refundedAt || null,
        charge.updatedAt,
        charge.id,
      ]
    );
  }
}

export function createAccountStore(): AccountStore {
  if (config.database.stateStoreProvider === 'mysql') return new MySqlAccountStore();
  if (config.database.stateStoreProvider === 'postgres') return new PostgresAccountStore();
  return new LocalAccountStore();
}

export const accountStore = createAccountStore();
