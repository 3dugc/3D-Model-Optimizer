import * as fs from 'fs';
import * as path from 'path';
import type { QueryResultRow } from 'pg';
import { config } from '../config';
import { ensurePostgresSchema, getPostgresPool, withPostgresTransaction, type SqlQueryable } from '../database/postgres';
import type { BillingOrder, OrderStatus } from './types';

export interface OrderStore {
  create(order: BillingOrder): Promise<BillingOrder>;
  get(orderId: string): Promise<BillingOrder | undefined>;
  findByOutTradeNo(outTradeNo: string): Promise<BillingOrder | undefined>;
  update(orderId: string, updates: Partial<BillingOrder>): Promise<BillingOrder>;
  transition(orderId: string, status: OrderStatus, updates?: Partial<BillingOrder>): Promise<BillingOrder>;
}

interface OrderStoreFile {
  orders: BillingOrder[];
}

const TERMINAL_ORDER_STATUSES = new Set<OrderStatus>(['paid', 'expired', 'cancelled', 'refunded']);

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

export class LocalOrderStore implements OrderStore {
  constructor(private readonly filePath: string = config.billing.orderStorePath) {}

  async create(order: BillingOrder): Promise<BillingOrder> {
    const data = await this.read();
    if (data.orders.some((item) => item.id === order.id || item.outTradeNo === order.outTradeNo)) {
      throw new Error(`Order already exists: ${order.id}`);
    }
    data.orders.push(order);
    await this.write(data);
    return order;
  }

  async get(orderId: string): Promise<BillingOrder | undefined> {
    const data = await this.read();
    return data.orders.find((order) => order.id === orderId);
  }

  async findByOutTradeNo(outTradeNo: string): Promise<BillingOrder | undefined> {
    const data = await this.read();
    return data.orders.find((order) => order.outTradeNo === outTradeNo);
  }

  async update(orderId: string, updates: Partial<BillingOrder>): Promise<BillingOrder> {
    const data = await this.read();
    const index = data.orders.findIndex((order) => order.id === orderId);
    if (index < 0) throw new Error(`Order not found: ${orderId}`);
    const updated = { ...data.orders[index], ...updates, updatedAt: new Date().toISOString() };
    data.orders[index] = updated;
    await this.write(data);
    return updated;
  }

  async transition(orderId: string, status: OrderStatus, updates: Partial<BillingOrder> = {}): Promise<BillingOrder> {
    const current = await this.get(orderId);
    if (!current) throw new Error(`Order not found: ${orderId}`);
    if (current.status === status) return this.update(orderId, updates);
    if (TERMINAL_ORDER_STATUSES.has(current.status)) {
      throw new Error(`Cannot transition terminal order ${orderId} from ${current.status} to ${status}`);
    }
    return this.update(orderId, { ...updates, status });
  }

  private async read(): Promise<OrderStoreFile> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as OrderStoreFile;
      return { orders: Array.isArray(parsed.orders) ? parsed.orders : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { orders: [] };
      throw error;
    }
  }

  private async write(data: OrderStoreFile): Promise<void> {
    await ensureParentDir(this.filePath);
    const tempPath = `${this.filePath}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2));
    await fs.promises.rename(tempPath, this.filePath);
  }
}

interface OrderRow extends QueryResultRow {
  order_json: BillingOrder | string;
}

function orderFromRow(row: OrderRow): BillingOrder {
  return typeof row.order_json === 'string' ? (JSON.parse(row.order_json) as BillingOrder) : row.order_json;
}

function nullableTimestamp(value: string | undefined): string | null {
  return value || null;
}

async function upsertOrderRow(client: SqlQueryable, order: BillingOrder): Promise<BillingOrder> {
  await client.query(
    `
      INSERT INTO optimizer_orders (
        id, tenant_id, job_id, status, amount_cents, currency, provider,
        out_trade_no, transaction_id, code_url, expires_at, paid_at,
        order_json, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
      ON CONFLICT (id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        job_id = EXCLUDED.job_id,
        status = EXCLUDED.status,
        amount_cents = EXCLUDED.amount_cents,
        currency = EXCLUDED.currency,
        provider = EXCLUDED.provider,
        out_trade_no = EXCLUDED.out_trade_no,
        transaction_id = EXCLUDED.transaction_id,
        code_url = EXCLUDED.code_url,
        expires_at = EXCLUDED.expires_at,
        paid_at = EXCLUDED.paid_at,
        order_json = EXCLUDED.order_json,
        updated_at = EXCLUDED.updated_at
    `,
    [
      order.id,
      order.tenantId,
      order.jobId || null,
      order.status,
      order.amountCents,
      order.currency,
      order.provider,
      order.outTradeNo,
      order.transactionId || null,
      order.codeUrl || null,
      nullableTimestamp(order.expiresAt),
      nullableTimestamp(order.paidAt),
      JSON.stringify(order),
      order.createdAt,
      order.updatedAt,
    ]
  );
  return order;
}

export class PostgresOrderStore implements OrderStore {
  constructor(private readonly client: SqlQueryable = getPostgresPool()) {}

  async create(order: BillingOrder): Promise<BillingOrder> {
    await ensurePostgresSchema(this.client);
    try {
      await this.client.query(
        `
          INSERT INTO optimizer_orders (
            id, tenant_id, job_id, status, amount_cents, currency, provider,
            out_trade_no, transaction_id, code_url, expires_at, paid_at,
            order_json, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
        `,
        [
          order.id,
          order.tenantId,
          order.jobId || null,
          order.status,
          order.amountCents,
          order.currency,
          order.provider,
          order.outTradeNo,
          order.transactionId || null,
          order.codeUrl || null,
          nullableTimestamp(order.expiresAt),
          nullableTimestamp(order.paidAt),
          JSON.stringify(order),
          order.createdAt,
          order.updatedAt,
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new Error(`Order already exists: ${order.id}`);
      }
      throw error;
    }
    return order;
  }

  async get(orderId: string): Promise<BillingOrder | undefined> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<OrderRow>('SELECT order_json FROM optimizer_orders WHERE id = $1', [
      orderId,
    ]);
    return result.rows[0] ? orderFromRow(result.rows[0]) : undefined;
  }

  async findByOutTradeNo(outTradeNo: string): Promise<BillingOrder | undefined> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<OrderRow>(
      'SELECT order_json FROM optimizer_orders WHERE out_trade_no = $1',
      [outTradeNo]
    );
    return result.rows[0] ? orderFromRow(result.rows[0]) : undefined;
  }

  async update(orderId: string, updates: Partial<BillingOrder>): Promise<BillingOrder> {
    return withPostgresTransaction(async (client) => {
      const result = await client.query<OrderRow>('SELECT order_json FROM optimizer_orders WHERE id = $1 FOR UPDATE', [
        orderId,
      ]);
      if (!result.rows[0]) throw new Error(`Order not found: ${orderId}`);
      const updated = { ...orderFromRow(result.rows[0]), ...updates, updatedAt: new Date().toISOString() };
      return upsertOrderRow(client, updated);
    });
  }

  async transition(orderId: string, status: OrderStatus, updates: Partial<BillingOrder> = {}): Promise<BillingOrder> {
    return withPostgresTransaction(async (client) => {
      const result = await client.query<OrderRow>('SELECT order_json FROM optimizer_orders WHERE id = $1 FOR UPDATE', [
        orderId,
      ]);
      if (!result.rows[0]) throw new Error(`Order not found: ${orderId}`);
      const current = orderFromRow(result.rows[0]);
      if (current.status === status) {
        const sameStatus = { ...current, ...updates, updatedAt: new Date().toISOString() };
        return upsertOrderRow(client, sameStatus);
      }
      if (TERMINAL_ORDER_STATUSES.has(current.status)) {
        throw new Error(`Cannot transition terminal order ${orderId} from ${current.status} to ${status}`);
      }
      const updated = { ...current, ...updates, status, updatedAt: new Date().toISOString() };
      return upsertOrderRow(client, updated);
    });
  }
}

export function createOrderStore(): OrderStore {
  return config.database.stateStoreProvider === 'postgres' ? new PostgresOrderStore() : new LocalOrderStore();
}

export const orderStore = createOrderStore();
