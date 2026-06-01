import mysql from 'mysql2/promise';
import type {
  FieldPacket,
  Pool as MySqlPool,
  PoolConnection,
  PoolOptions,
  QueryResult,
  RowDataPacket,
} from 'mysql2/promise';
import { config } from '../config';

export interface MySqlQueryable {
  execute<T extends QueryResult = RowDataPacket[]>(sql: string, values?: any): Promise<[T, FieldPacket[]]>;
}

interface CountRow extends RowDataPacket {
  count: number;
}

let pool: MySqlPool | undefined;
let migrationPromise: Promise<void> | undefined;

export function getMySqlPool(): MySqlPool {
  if (!config.database.url) {
    throw new Error('MySQL state store requires DATABASE_URL.');
  }
  if (!pool) {
    pool = mysql.createPool(createPoolOptions(config.database.url));
  }
  return pool;
}

export async function ensureMySqlSchema(client: MySqlQueryable = getMySqlPool()): Promise<void> {
  if (client === pool && migrationPromise) return migrationPromise;
  const migration = runMigrations(client);
  if (client === pool) migrationPromise = migration;
  return migration;
}

export async function withMySqlTransaction<T>(callback: (client: PoolConnection) => Promise<T>): Promise<T> {
  const client = await getMySqlPool().getConnection();
  try {
    await ensureMySqlSchema();
    await client.beginTransaction();
    const result = await callback(client);
    await client.commit();
    return result;
  } catch (error) {
    await client.rollback();
    throw error;
  } finally {
    client.release();
  }
}

export function mysqlDateTime(value: string | Date | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (part: number, size = 2) => String(part).padStart(size, '0');
  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`,
  ].join(' ');
}

function createPoolOptions(databaseUrl: string): PoolOptions {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'mysql:' && url.protocol !== 'mysql2:') {
    throw new Error(`Unsupported MySQL DATABASE_URL protocol: ${url.protocol}`);
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    charset: 'utf8mb4',
    dateStrings: true,
    supportBigNumbers: true,
    waitForConnections: true,
    connectionLimit: 10,
    ssl: config.database.ssl
      ? {
          rejectUnauthorized: config.database.sslRejectUnauthorized,
        }
      : undefined,
  };
}

async function runMigrations(client: MySqlQueryable): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS optimizer_jobs (
      id VARCHAR(128) PRIMARY KEY,
      tenant_id VARCHAR(128) NOT NULL,
      external_job_id VARCHAR(191),
      idempotency_key VARCHAR(191),
      task_type VARCHAR(128) NOT NULL,
      status VARCHAR(64) NOT NULL,
      worker_id VARCHAR(191),
      attempts INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL,
      uploaded_at DATETIME(3),
      queued_at DATETIME(3),
      started_at DATETIME(3),
      completed_at DATETIME(3),
      job_json JSON NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY optimizer_jobs_tenant_idempotency_idx (tenant_id, idempotency_key),
      KEY optimizer_jobs_claim_idx (status, queued_at, created_at),
      KEY optimizer_jobs_tenant_status_idx (tenant_id, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS optimizer_orders (
      id VARCHAR(128) PRIMARY KEY,
      tenant_id VARCHAR(128) NOT NULL,
      job_id VARCHAR(128),
      status VARCHAR(64) NOT NULL,
      amount_cents INT NOT NULL,
      currency VARCHAR(16) NOT NULL,
      provider VARCHAR(64) NOT NULL,
      out_trade_no VARCHAR(191) NOT NULL UNIQUE,
      transaction_id VARCHAR(191),
      code_url TEXT,
      expires_at DATETIME(3),
      paid_at DATETIME(3),
      order_json JSON NOT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY optimizer_orders_tenant_status_idx (tenant_id, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS optimizer_workers (
      id VARCHAR(191) PRIMARY KEY,
      instance_id VARCHAR(191) NOT NULL,
      backend VARCHAR(64) NOT NULL DEFAULT 'docker',
      status VARCHAR(64) NOT NULL,
      slots_total INT NOT NULL,
      slots_busy INT NOT NULL,
      draining BOOLEAN NOT NULL DEFAULT FALSE,
      heartbeat_json JSON NOT NULL,
      started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      last_heartbeat DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY optimizer_workers_status_heartbeat_idx (status, last_heartbeat)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS optimizer_callback_deliveries (
      id VARCHAR(128) PRIMARY KEY,
      job_id VARCHAR(128) NOT NULL,
      event_type VARCHAR(128) NOT NULL,
      url TEXT NOT NULL,
      status VARCHAR(64) NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      last_status_code INT,
      next_retry_at DATETIME(3),
      delivery_json JSON NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY optimizer_callback_job_status_idx (job_id, status, next_retry_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS optimizer_users (
      id VARCHAR(128) PRIMARY KEY,
      tenant_id VARCHAR(128) NOT NULL,
      auth_user_id VARCHAR(191),
      wechat_openid VARCHAR(191) NOT NULL,
      wechat_unionid VARCHAR(191),
      user_json JSON NOT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY optimizer_users_auth_user_id_idx (auth_user_id),
      UNIQUE KEY optimizer_users_wechat_openid_idx (wechat_openid),
      KEY optimizer_users_tenant_idx (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await ensureMySqlColumn(client, 'optimizer_users', 'auth_user_id', 'auth_user_id VARCHAR(191)');
  await ensureMySqlIndex(
    client,
    'optimizer_users',
    'optimizer_users_auth_user_id_idx',
    'CREATE UNIQUE INDEX optimizer_users_auth_user_id_idx ON optimizer_users (auth_user_id)'
  );

  await client.execute(`
    CREATE TABLE IF NOT EXISTS optimizer_wallets (
      user_id VARCHAR(128) PRIMARY KEY,
      tenant_id VARCHAR(128) NOT NULL,
      cash_balance_cents INT NOT NULL DEFAULT 0,
      bonus_balance_cents INT NOT NULL DEFAULT 0,
      frozen_cents INT NOT NULL DEFAULT 0,
      updated_at DATETIME(3) NOT NULL,
      KEY optimizer_wallets_tenant_idx (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS optimizer_wallet_ledger (
      id VARCHAR(128) PRIMARY KEY,
      user_id VARCHAR(128) NOT NULL,
      tenant_id VARCHAR(128) NOT NULL,
      type VARCHAR(64) NOT NULL,
      cash_delta_cents INT NOT NULL DEFAULT 0,
      bonus_delta_cents INT NOT NULL DEFAULT 0,
      frozen_delta_cents INT NOT NULL DEFAULT 0,
      balance_after_cash_cents INT NOT NULL DEFAULT 0,
      frozen_after_cents INT NOT NULL DEFAULT 0,
      recharge_order_id VARCHAR(128),
      job_id VARCHAR(128),
      job_charge_id VARCHAR(128),
      ledger_json JSON NOT NULL,
      created_at DATETIME(3) NOT NULL,
      KEY optimizer_wallet_ledger_user_idx (user_id, created_at),
      KEY optimizer_wallet_ledger_job_idx (job_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS optimizer_recharge_orders (
      id VARCHAR(128) PRIMARY KEY,
      user_id VARCHAR(128) NOT NULL,
      tenant_id VARCHAR(128) NOT NULL,
      status VARCHAR(64) NOT NULL,
      amount_cents INT NOT NULL,
      currency VARCHAR(16) NOT NULL,
      provider VARCHAR(64) NOT NULL,
      out_trade_no VARCHAR(191) NOT NULL UNIQUE,
      transaction_id VARCHAR(191),
      code_url TEXT,
      expires_at DATETIME(3) NOT NULL,
      paid_at DATETIME(3),
      order_json JSON NOT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY optimizer_recharge_orders_user_status_idx (user_id, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS optimizer_job_charges (
      id VARCHAR(128) PRIMARY KEY,
      user_id VARCHAR(128) NOT NULL,
      tenant_id VARCHAR(128) NOT NULL,
      job_id VARCHAR(128) NOT NULL UNIQUE,
      amount_cents INT NOT NULL,
      status VARCHAR(64) NOT NULL,
      charge_json JSON NOT NULL,
      held_at DATETIME(3) NOT NULL,
      charged_at DATETIME(3),
      released_at DATETIME(3),
      refunded_at DATETIME(3),
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY optimizer_job_charges_user_status_idx (user_id, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureMySqlColumn(client: MySqlQueryable, tableName: string, columnName: string, definition: string): Promise<void> {
  const [rows] = await client.execute<CountRow[]>(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    `,
    [tableName, columnName]
  );
  if (Number(rows[0]?.count || 0) > 0) return;
  await client.execute(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

async function ensureMySqlIndex(client: MySqlQueryable, tableName: string, indexName: string, createSql: string): Promise<void> {
  const [rows] = await client.execute<CountRow[]>(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
    `,
    [tableName, indexName]
  );
  if (Number(rows[0]?.count || 0) > 0) return;
  await client.execute(createSql);
}
