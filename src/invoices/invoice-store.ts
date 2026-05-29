import * as fs from 'fs';
import * as path from 'path';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { QueryResultRow } from 'pg';
import { config } from '../config';
import { ensureMySqlSchema, getMySqlPool, mysqlDateTime, type MySqlQueryable } from '../database/mysql';
import { ensurePostgresSchema, getPostgresPool, type SqlQueryable } from '../database/postgres';
import type { InvoiceItem, InvoiceProviderEvent, InvoiceRequest } from './types';

export interface InvoiceStore {
  createInvoiceRequest(input: {
    request: InvoiceRequest;
    item: InvoiceItem;
    event?: InvoiceProviderEvent;
  }): Promise<InvoiceRequest>;
  getInvoiceRequest(invoiceRequestId: string): Promise<InvoiceRequest | undefined>;
  findInvoiceRequestByRechargeOrderId(rechargeOrderId: string): Promise<InvoiceRequest | undefined>;
  findInvoiceRequestByOutTradeNo(outTradeNo: string): Promise<InvoiceRequest | undefined>;
  findInvoiceRequestByProviderApplyId(providerApplyId: string): Promise<InvoiceRequest | undefined>;
  listInvoiceRequestsForUser(userId: string, limit?: number): Promise<InvoiceRequest[]>;
  updateInvoiceRequest(request: InvoiceRequest): Promise<InvoiceRequest>;
  recordProviderEvent(event: InvoiceProviderEvent): Promise<{ event: InvoiceProviderEvent; duplicate: boolean }>;
}

interface InvoiceStoreFile {
  requests: InvoiceRequest[];
  items: InvoiceItem[];
  events: InvoiceProviderEvent[];
}

interface InvoiceRequestRow extends RowDataPacket {
  request_json: InvoiceRequest | string;
}

interface InvoiceProviderEventRow extends RowDataPacket {
  event_json: InvoiceProviderEvent | string;
}

interface PgInvoiceRequestRow extends QueryResultRow {
  request_json: InvoiceRequest | string;
}

interface PgInvoiceProviderEventRow extends QueryResultRow {
  event_json: InvoiceProviderEvent | string;
}

const emptyFile = (): InvoiceStoreFile => ({
  requests: [],
  items: [],
  events: [],
});

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function normalizeLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

export class LocalInvoiceStore implements InvoiceStore {
  constructor(private readonly filePath: string = config.invoice.storePath) {}

  async createInvoiceRequest(input: {
    request: InvoiceRequest;
    item: InvoiceItem;
    event?: InvoiceProviderEvent;
  }): Promise<InvoiceRequest> {
    const data = await this.read();
    if (data.requests.some((request) => request.rechargeOrderId === input.request.rechargeOrderId)) {
      throw new Error(`Invoice request already exists for recharge order: ${input.request.rechargeOrderId}`);
    }
    data.requests.push(input.request);
    data.items.push(input.item);
    if (input.event) data.events.push(input.event);
    await this.write(data);
    return input.request;
  }

  async getInvoiceRequest(invoiceRequestId: string): Promise<InvoiceRequest | undefined> {
    const data = await this.read();
    return data.requests.find((request) => request.id === invoiceRequestId);
  }

  async findInvoiceRequestByRechargeOrderId(rechargeOrderId: string): Promise<InvoiceRequest | undefined> {
    const data = await this.read();
    return data.requests.find((request) => request.rechargeOrderId === rechargeOrderId);
  }

  async findInvoiceRequestByOutTradeNo(outTradeNo: string): Promise<InvoiceRequest | undefined> {
    const data = await this.read();
    return data.requests.find((request) => request.outTradeNo === outTradeNo);
  }

  async findInvoiceRequestByProviderApplyId(providerApplyId: string): Promise<InvoiceRequest | undefined> {
    const data = await this.read();
    return data.requests.find((request) => request.providerApplyId === providerApplyId);
  }

  async listInvoiceRequestsForUser(userId: string, limit?: number): Promise<InvoiceRequest[]> {
    const data = await this.read();
    return data.requests
      .filter((request) => request.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, normalizeLimit(limit));
  }

  async updateInvoiceRequest(request: InvoiceRequest): Promise<InvoiceRequest> {
    const data = await this.read();
    const index = data.requests.findIndex((item) => item.id === request.id);
    if (index < 0) throw new Error(`Invoice request not found: ${request.id}`);
    data.requests[index] = request;
    await this.write(data);
    return request;
  }

  async recordProviderEvent(event: InvoiceProviderEvent): Promise<{ event: InvoiceProviderEvent; duplicate: boolean }> {
    const data = await this.read();
    const existing = data.events.find(
      (item) => item.provider === event.provider && item.eventType === event.eventType && item.dedupeKey === event.dedupeKey
    );
    if (existing) return { event: existing, duplicate: true };
    data.events.push(event);
    await this.write(data);
    return { event, duplicate: false };
  }

  private async read(): Promise<InvoiceStoreFile> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<InvoiceStoreFile>;
      return {
        ...emptyFile(),
        ...parsed,
        requests: Array.isArray(parsed.requests) ? parsed.requests : [],
        items: Array.isArray(parsed.items) ? parsed.items : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
      throw error;
    }
  }

  private async write(data: InvoiceStoreFile): Promise<void> {
    await ensureParentDir(this.filePath);
    const tempPath = `${this.filePath}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2));
    await fs.promises.rename(tempPath, this.filePath);
  }
}

let mysqlInvoiceSchemaPromise: Promise<void> | undefined;

async function ensureMySqlInvoiceSchema(client: MySqlQueryable = getMySqlPool()): Promise<void> {
  if (client === getMySqlPool() && mysqlInvoiceSchemaPromise) return mysqlInvoiceSchemaPromise;
  const migration = (async () => {
    await ensureMySqlSchema(client);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS optimizer_invoice_requests (
        id VARCHAR(128) PRIMARY KEY,
        user_id VARCHAR(128) NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
        recharge_order_id VARCHAR(128) NOT NULL UNIQUE,
        out_trade_no VARCHAR(191) NOT NULL,
        status VARCHAR(64) NOT NULL,
        provider VARCHAR(64) NOT NULL,
        provider_apply_id VARCHAR(191) NOT NULL,
        request_json JSON NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY optimizer_invoice_requests_user_idx (user_id, created_at),
        KEY optimizer_invoice_requests_provider_idx (provider_apply_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS optimizer_invoice_items (
        id VARCHAR(128) PRIMARY KEY,
        invoice_request_id VARCHAR(128) NOT NULL,
        recharge_order_id VARCHAR(128) NOT NULL,
        item_json JSON NOT NULL,
        created_at DATETIME(3) NOT NULL,
        KEY optimizer_invoice_items_request_idx (invoice_request_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS optimizer_invoice_provider_events (
        id VARCHAR(128) PRIMARY KEY,
        provider VARCHAR(64) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        dedupe_key VARCHAR(191) NOT NULL,
        invoice_request_id VARCHAR(128),
        recharge_order_id VARCHAR(128),
        event_json JSON NOT NULL,
        processed_at DATETIME(3),
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY optimizer_invoice_events_dedupe_idx (provider, event_type, dedupe_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  })();
  if (client === getMySqlPool()) mysqlInvoiceSchemaPromise = migration;
  return migration;
}

export class MySqlInvoiceStore implements InvoiceStore {
  constructor(private readonly client: MySqlQueryable = getMySqlPool()) {}

  async createInvoiceRequest(input: {
    request: InvoiceRequest;
    item: InvoiceItem;
    event?: InvoiceProviderEvent;
  }): Promise<InvoiceRequest> {
    await ensureMySqlInvoiceSchema(this.client);
    await this.insertInvoiceRequest(input.request);
    await this.client.execute(
      `
        INSERT INTO optimizer_invoice_items (id, invoice_request_id, recharge_order_id, item_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      [
        input.item.id,
        input.item.invoiceRequestId,
        input.item.rechargeOrderId,
        JSON.stringify(input.item),
        mysqlDateTime(input.item.createdAt),
      ]
    );
    if (input.event) await this.recordProviderEvent(input.event);
    return input.request;
  }

  async getInvoiceRequest(invoiceRequestId: string): Promise<InvoiceRequest | undefined> {
    await ensureMySqlInvoiceSchema(this.client);
    const [rows] = await this.client.execute<InvoiceRequestRow[]>(
      'SELECT request_json FROM optimizer_invoice_requests WHERE id = ?',
      [invoiceRequestId]
    );
    return rows[0] ? parseJson<InvoiceRequest>(rows[0].request_json) : undefined;
  }

  async findInvoiceRequestByRechargeOrderId(rechargeOrderId: string): Promise<InvoiceRequest | undefined> {
    await ensureMySqlInvoiceSchema(this.client);
    const [rows] = await this.client.execute<InvoiceRequestRow[]>(
      'SELECT request_json FROM optimizer_invoice_requests WHERE recharge_order_id = ?',
      [rechargeOrderId]
    );
    return rows[0] ? parseJson<InvoiceRequest>(rows[0].request_json) : undefined;
  }

  async findInvoiceRequestByOutTradeNo(outTradeNo: string): Promise<InvoiceRequest | undefined> {
    await ensureMySqlInvoiceSchema(this.client);
    const [rows] = await this.client.execute<InvoiceRequestRow[]>(
      'SELECT request_json FROM optimizer_invoice_requests WHERE out_trade_no = ?',
      [outTradeNo]
    );
    return rows[0] ? parseJson<InvoiceRequest>(rows[0].request_json) : undefined;
  }

  async findInvoiceRequestByProviderApplyId(providerApplyId: string): Promise<InvoiceRequest | undefined> {
    await ensureMySqlInvoiceSchema(this.client);
    const [rows] = await this.client.execute<InvoiceRequestRow[]>(
      'SELECT request_json FROM optimizer_invoice_requests WHERE provider_apply_id = ?',
      [providerApplyId]
    );
    return rows[0] ? parseJson<InvoiceRequest>(rows[0].request_json) : undefined;
  }

  async listInvoiceRequestsForUser(userId: string, limit?: number): Promise<InvoiceRequest[]> {
    await ensureMySqlInvoiceSchema(this.client);
    const safeLimit = normalizeLimit(limit);
    const [rows] = await this.client.execute<InvoiceRequestRow[]>(
      `SELECT request_json FROM optimizer_invoice_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
      [userId]
    );
    return rows.map((row) => parseJson<InvoiceRequest>(row.request_json));
  }

  async updateInvoiceRequest(request: InvoiceRequest): Promise<InvoiceRequest> {
    await ensureMySqlInvoiceSchema(this.client);
    const [result] = await this.client.execute<ResultSetHeader>(
      `
        UPDATE optimizer_invoice_requests SET
          status = ?,
          provider_apply_id = ?,
          request_json = ?,
          updated_at = ?
        WHERE id = ?
      `,
      [request.status, request.providerApplyId, JSON.stringify(request), mysqlDateTime(request.updatedAt), request.id]
    );
    if (result.affectedRows === 0) throw new Error(`Invoice request not found: ${request.id}`);
    return request;
  }

  async recordProviderEvent(event: InvoiceProviderEvent): Promise<{ event: InvoiceProviderEvent; duplicate: boolean }> {
    await ensureMySqlInvoiceSchema(this.client);
    const [existingRows] = await this.client.execute<InvoiceProviderEventRow[]>(
      'SELECT event_json FROM optimizer_invoice_provider_events WHERE provider = ? AND event_type = ? AND dedupe_key = ?',
      [event.provider, event.eventType, event.dedupeKey]
    );
    if (existingRows[0]) return { event: parseJson<InvoiceProviderEvent>(existingRows[0].event_json), duplicate: true };
    await this.client.execute(
      `
        INSERT INTO optimizer_invoice_provider_events (
          id, provider, event_type, dedupe_key, invoice_request_id, recharge_order_id,
          event_json, processed_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        event.id,
        event.provider,
        event.eventType,
        event.dedupeKey,
        event.invoiceRequestId || null,
        event.rechargeOrderId || null,
        JSON.stringify(event),
        mysqlDateTime(event.processedAt),
        mysqlDateTime(event.createdAt),
      ]
    );
    return { event, duplicate: false };
  }

  private async insertInvoiceRequest(request: InvoiceRequest): Promise<void> {
    await this.client.execute(
      `
        INSERT INTO optimizer_invoice_requests (
          id, user_id, tenant_id, recharge_order_id, out_trade_no, status, provider,
          provider_apply_id, request_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        request.id,
        request.userId,
        request.tenantId,
        request.rechargeOrderId,
        request.outTradeNo,
        request.status,
        request.provider,
        request.providerApplyId,
        JSON.stringify(request),
        mysqlDateTime(request.createdAt),
        mysqlDateTime(request.updatedAt),
      ]
    );
  }
}

let postgresInvoiceSchemaPromise: Promise<void> | undefined;

async function ensurePostgresInvoiceSchema(client: SqlQueryable = getPostgresPool()): Promise<void> {
  if (client === getPostgresPool() && postgresInvoiceSchemaPromise) return postgresInvoiceSchemaPromise;
  const migration = (async () => {
    await ensurePostgresSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS optimizer_invoice_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        recharge_order_id TEXT NOT NULL UNIQUE,
        out_trade_no TEXT NOT NULL,
        status TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_apply_id TEXT NOT NULL,
        request_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS optimizer_invoice_requests_user_idx
        ON optimizer_invoice_requests (user_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS optimizer_invoice_requests_provider_idx
        ON optimizer_invoice_requests (provider_apply_id)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS optimizer_invoice_items (
        id TEXT PRIMARY KEY,
        invoice_request_id TEXT NOT NULL,
        recharge_order_id TEXT NOT NULL,
        item_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS optimizer_invoice_items_request_idx
        ON optimizer_invoice_items (invoice_request_id)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS optimizer_invoice_provider_events (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event_type TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        invoice_request_id TEXT,
        recharge_order_id TEXT,
        event_json JSONB NOT NULL,
        processed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (provider, event_type, dedupe_key)
      )
    `);
  })();
  if (client === getPostgresPool()) postgresInvoiceSchemaPromise = migration;
  return migration;
}

export class PostgresInvoiceStore implements InvoiceStore {
  constructor(private readonly client: SqlQueryable = getPostgresPool()) {}

  async createInvoiceRequest(input: {
    request: InvoiceRequest;
    item: InvoiceItem;
    event?: InvoiceProviderEvent;
  }): Promise<InvoiceRequest> {
    await ensurePostgresInvoiceSchema(this.client);
    await this.insertInvoiceRequest(input.request);
    await this.client.query(
      `
        INSERT INTO optimizer_invoice_items (id, invoice_request_id, recharge_order_id, item_json, created_at)
        VALUES ($1, $2, $3, $4::jsonb, $5)
      `,
      [
        input.item.id,
        input.item.invoiceRequestId,
        input.item.rechargeOrderId,
        JSON.stringify(input.item),
        input.item.createdAt,
      ]
    );
    if (input.event) await this.recordProviderEvent(input.event);
    return input.request;
  }

  async getInvoiceRequest(invoiceRequestId: string): Promise<InvoiceRequest | undefined> {
    await ensurePostgresInvoiceSchema(this.client);
    const result = await this.client.query<PgInvoiceRequestRow>(
      'SELECT request_json FROM optimizer_invoice_requests WHERE id = $1',
      [invoiceRequestId]
    );
    return result.rows[0] ? parseJson<InvoiceRequest>(result.rows[0].request_json) : undefined;
  }

  async findInvoiceRequestByRechargeOrderId(rechargeOrderId: string): Promise<InvoiceRequest | undefined> {
    await ensurePostgresInvoiceSchema(this.client);
    const result = await this.client.query<PgInvoiceRequestRow>(
      'SELECT request_json FROM optimizer_invoice_requests WHERE recharge_order_id = $1',
      [rechargeOrderId]
    );
    return result.rows[0] ? parseJson<InvoiceRequest>(result.rows[0].request_json) : undefined;
  }

  async findInvoiceRequestByOutTradeNo(outTradeNo: string): Promise<InvoiceRequest | undefined> {
    await ensurePostgresInvoiceSchema(this.client);
    const result = await this.client.query<PgInvoiceRequestRow>(
      'SELECT request_json FROM optimizer_invoice_requests WHERE out_trade_no = $1',
      [outTradeNo]
    );
    return result.rows[0] ? parseJson<InvoiceRequest>(result.rows[0].request_json) : undefined;
  }

  async findInvoiceRequestByProviderApplyId(providerApplyId: string): Promise<InvoiceRequest | undefined> {
    await ensurePostgresInvoiceSchema(this.client);
    const result = await this.client.query<PgInvoiceRequestRow>(
      'SELECT request_json FROM optimizer_invoice_requests WHERE provider_apply_id = $1',
      [providerApplyId]
    );
    return result.rows[0] ? parseJson<InvoiceRequest>(result.rows[0].request_json) : undefined;
  }

  async listInvoiceRequestsForUser(userId: string, limit?: number): Promise<InvoiceRequest[]> {
    await ensurePostgresInvoiceSchema(this.client);
    const result = await this.client.query<PgInvoiceRequestRow>(
      'SELECT request_json FROM optimizer_invoice_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, normalizeLimit(limit)]
    );
    return result.rows.map((row) => parseJson<InvoiceRequest>(row.request_json));
  }

  async updateInvoiceRequest(request: InvoiceRequest): Promise<InvoiceRequest> {
    await ensurePostgresInvoiceSchema(this.client);
    await this.client.query(
      `
        UPDATE optimizer_invoice_requests SET
          status = $1,
          provider_apply_id = $2,
          request_json = $3::jsonb,
          updated_at = $4
        WHERE id = $5
      `,
      [request.status, request.providerApplyId, JSON.stringify(request), request.updatedAt, request.id]
    );
    return request;
  }

  async recordProviderEvent(event: InvoiceProviderEvent): Promise<{ event: InvoiceProviderEvent; duplicate: boolean }> {
    await ensurePostgresInvoiceSchema(this.client);
    const existing = await this.client.query<PgInvoiceProviderEventRow>(
      'SELECT event_json FROM optimizer_invoice_provider_events WHERE provider = $1 AND event_type = $2 AND dedupe_key = $3',
      [event.provider, event.eventType, event.dedupeKey]
    );
    if (existing.rows[0]) {
      return { event: parseJson<InvoiceProviderEvent>(existing.rows[0].event_json), duplicate: true };
    }
    await this.client.query(
      `
        INSERT INTO optimizer_invoice_provider_events (
          id, provider, event_type, dedupe_key, invoice_request_id, recharge_order_id,
          event_json, processed_at, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
      `,
      [
        event.id,
        event.provider,
        event.eventType,
        event.dedupeKey,
        event.invoiceRequestId || null,
        event.rechargeOrderId || null,
        JSON.stringify(event),
        event.processedAt || null,
        event.createdAt,
      ]
    );
    return { event, duplicate: false };
  }

  private async insertInvoiceRequest(request: InvoiceRequest): Promise<void> {
    await this.client.query(
      `
        INSERT INTO optimizer_invoice_requests (
          id, user_id, tenant_id, recharge_order_id, out_trade_no, status, provider,
          provider_apply_id, request_json, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
      `,
      [
        request.id,
        request.userId,
        request.tenantId,
        request.rechargeOrderId,
        request.outTradeNo,
        request.status,
        request.provider,
        request.providerApplyId,
        JSON.stringify(request),
        request.createdAt,
        request.updatedAt,
      ]
    );
  }
}

export function createInvoiceStore(): InvoiceStore {
  if (config.database.stateStoreProvider === 'mysql') return new MySqlInvoiceStore();
  if (config.database.stateStoreProvider === 'postgres') return new PostgresInvoiceStore();
  return new LocalInvoiceStore();
}

export const invoiceStore = createInvoiceStore();
