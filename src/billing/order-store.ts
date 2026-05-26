import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
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

export const orderStore = new LocalOrderStore();
