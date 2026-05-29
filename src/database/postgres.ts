import pg from 'pg';
import type { Pool as PgPool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';

const { Pool } = pg;

export interface SqlQueryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

let pool: PgPool | undefined;
let migrationPromise: Promise<void> | undefined;

export function getPostgresPool(): PgPool {
  if (!config.database.url) {
    throw new Error('Postgres state store requires DATABASE_URL.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.database.url,
      ssl: config.database.ssl
        ? {
            rejectUnauthorized: config.database.sslRejectUnauthorized,
          }
        : undefined,
    });
  }
  return pool;
}

export async function ensurePostgresSchema(client: SqlQueryable = getPostgresPool()): Promise<void> {
  if (client === pool && migrationPromise) return migrationPromise;
  const migration = runMigrations(client);
  if (client === pool) migrationPromise = migration;
  return migration;
}

export async function withPostgresTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    await ensurePostgresSchema();
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runMigrations(client: SqlQueryable): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS optimizer_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      external_job_id TEXT,
      idempotency_key TEXT,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      worker_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL,
      uploaded_at TIMESTAMPTZ,
      queued_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      job_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS optimizer_jobs_tenant_idempotency_idx
      ON optimizer_jobs (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS optimizer_jobs_claim_idx
      ON optimizer_jobs (status, queued_at, created_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS optimizer_jobs_tenant_status_idx
      ON optimizer_jobs (tenant_id, status, created_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS optimizer_orders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      job_id TEXT,
      status TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      provider TEXT NOT NULL,
      out_trade_no TEXT NOT NULL UNIQUE,
      transaction_id TEXT,
      code_url TEXT,
      expires_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      order_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS optimizer_orders_tenant_status_idx
      ON optimizer_orders (tenant_id, status, created_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS optimizer_workers (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      backend TEXT NOT NULL DEFAULT 'docker',
      status TEXT NOT NULL,
      slots_total INTEGER NOT NULL,
      slots_busy INTEGER NOT NULL,
      draining BOOLEAN NOT NULL DEFAULT FALSE,
      heartbeat_json JSONB NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_heartbeat TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS optimizer_workers_status_heartbeat_idx
      ON optimizer_workers (status, last_heartbeat DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS optimizer_callback_deliveries (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_status_code INTEGER,
      next_retry_at TIMESTAMPTZ,
      delivery_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS optimizer_callback_job_status_idx
      ON optimizer_callback_deliveries (job_id, status, next_retry_at)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS optimizer_users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      auth_user_id TEXT,
      wechat_openid TEXT NOT NULL UNIQUE,
      wechat_unionid TEXT,
      user_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query(`
    ALTER TABLE optimizer_users
      ADD COLUMN IF NOT EXISTS auth_user_id TEXT
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS optimizer_users_auth_user_id_idx
      ON optimizer_users (auth_user_id)
      WHERE auth_user_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS optimizer_users_tenant_idx
      ON optimizer_users (tenant_id)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS optimizer_wallets (
      user_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      cash_balance_cents INTEGER NOT NULL DEFAULT 0,
      bonus_balance_cents INTEGER NOT NULL DEFAULT 0,
      frozen_cents INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS optimizer_wallets_tenant_idx
      ON optimizer_wallets (tenant_id)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS optimizer_wallet_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      cash_delta_cents INTEGER NOT NULL DEFAULT 0,
      bonus_delta_cents INTEGER NOT NULL DEFAULT 0,
      frozen_delta_cents INTEGER NOT NULL DEFAULT 0,
      balance_after_cash_cents INTEGER NOT NULL DEFAULT 0,
      frozen_after_cents INTEGER NOT NULL DEFAULT 0,
      recharge_order_id TEXT,
      job_id TEXT,
      job_charge_id TEXT,
      ledger_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS optimizer_wallet_ledger_user_idx
      ON optimizer_wallet_ledger (user_id, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS optimizer_wallet_ledger_job_idx
      ON optimizer_wallet_ledger (job_id)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS optimizer_recharge_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      provider TEXT NOT NULL,
      out_trade_no TEXT NOT NULL UNIQUE,
      transaction_id TEXT,
      code_url TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      paid_at TIMESTAMPTZ,
      order_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS optimizer_recharge_orders_user_status_idx
      ON optimizer_recharge_orders (user_id, status, created_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS optimizer_job_charges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      job_id TEXT NOT NULL UNIQUE,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      charge_json JSONB NOT NULL,
      held_at TIMESTAMPTZ NOT NULL,
      charged_at TIMESTAMPTZ,
      released_at TIMESTAMPTZ,
      refunded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS optimizer_job_charges_user_status_idx
      ON optimizer_job_charges (user_id, status, created_at DESC)
  `);
}
