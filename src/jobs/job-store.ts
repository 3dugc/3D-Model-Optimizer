import * as fs from 'fs';
import * as path from 'path';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { QueryResultRow } from 'pg';
import { config } from '../config';
import type { ClaimJobInput, CloudJob, CloudJobStatus } from './types';
import { assertJobStatusTransition } from './state-machine';
import { ensureMySqlSchema, getMySqlPool, mysqlDateTime, withMySqlTransaction, type MySqlQueryable } from '../database/mysql';
import { ensurePostgresSchema, getPostgresPool, withPostgresTransaction, type SqlQueryable } from '../database/postgres';

export interface JobStore {
  create(job: CloudJob): Promise<CloudJob>;
  get(jobId: string): Promise<CloudJob | undefined>;
  findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<CloudJob | undefined>;
  update(jobId: string, updates: Partial<CloudJob>): Promise<CloudJob>;
  transition(jobId: string, status: CloudJobStatus, updates?: Partial<CloudJob>): Promise<CloudJob>;
  claim(jobId: string, input: ClaimJobInput): Promise<CloudJob | undefined>;
  claimNext(input: ClaimJobInput): Promise<CloudJob | undefined>;
  list(): Promise<CloudJob[]>;
}

interface JobStoreFile {
  jobs: CloudJob[];
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

export class LocalJobStore implements JobStore {
  constructor(private readonly filePath: string = config.cloud.jobStorePath) {}

  async create(job: CloudJob): Promise<CloudJob> {
    const data = await this.read();
    if (data.jobs.some((item) => item.id === job.id)) {
      throw new Error(`Job already exists: ${job.id}`);
    }
    data.jobs.push(job);
    await this.write(data);
    return job;
  }

  async get(jobId: string): Promise<CloudJob | undefined> {
    const data = await this.read();
    return data.jobs.find((job) => job.id === jobId);
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<CloudJob | undefined> {
    const data = await this.read();
    return data.jobs.find((job) => job.tenantId === tenantId && job.idempotencyKey === idempotencyKey);
  }

  async update(jobId: string, updates: Partial<CloudJob>): Promise<CloudJob> {
    const data = await this.read();
    const index = data.jobs.findIndex((job) => job.id === jobId);
    if (index < 0) {
      throw new Error(`Job not found: ${jobId}`);
    }
    const updated = { ...data.jobs[index], ...updates };
    data.jobs[index] = updated;
    await this.write(data);
    return updated;
  }

  async transition(jobId: string, status: CloudJobStatus, updates: Partial<CloudJob> = {}): Promise<CloudJob> {
    const data = await this.read();
    const index = data.jobs.findIndex((job) => job.id === jobId);
    if (index < 0) {
      throw new Error(`Job not found: ${jobId}`);
    }
    const current = data.jobs[index];
    assertJobStatusTransition(current.status, status);
    const updated = { ...current, ...updates, status };
    data.jobs[index] = updated;
    await this.write(data);
    return updated;
  }

  async claim(jobId: string, input: ClaimJobInput): Promise<CloudJob | undefined> {
    const data = await this.read();
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const index = data.jobs.findIndex((job) => job.id === jobId);
    if (index < 0) return undefined;

    const current = data.jobs[index];
    if (current.status !== 'queued' && current.status !== 'retry_wait') return undefined;
    if (current.status === 'retry_wait' && current.queuedAt && new Date(current.queuedAt).getTime() > now.getTime()) {
      return undefined;
    }

    assertJobStatusTransition(current.status, 'processing');
    const updated: CloudJob = {
      ...current,
      status: 'processing',
      workerId: input.workerId,
      attempts: current.attempts + 1,
      startedAt: nowIso,
    };
    data.jobs[index] = updated;
    await this.write(data);
    return updated;
  }

  async claimNext(input: ClaimJobInput): Promise<CloudJob | undefined> {
    const data = await this.read();
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const index = data.jobs.findIndex((job) => {
      if (job.status === 'queued') return true;
      if (job.status !== 'retry_wait') return false;
      if (!job.queuedAt) return true;
      return new Date(job.queuedAt).getTime() <= now.getTime();
    });
    if (index < 0) return undefined;

    const current = data.jobs[index];
    assertJobStatusTransition(current.status, 'processing');
    const updated: CloudJob = {
      ...current,
      status: 'processing',
      workerId: input.workerId,
      attempts: current.attempts + 1,
      startedAt: nowIso,
    };
    data.jobs[index] = updated;
    await this.write(data);
    return updated;
  }

  async list(): Promise<CloudJob[]> {
    const data = await this.read();
    return [...data.jobs];
  }

  private async read(): Promise<JobStoreFile> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as JobStoreFile;
      return { jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { jobs: [] };
      }
      throw error;
    }
  }

  private async write(data: JobStoreFile): Promise<void> {
    await ensureParentDir(this.filePath);
    const tempPath = `${this.filePath}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2));
    await fs.promises.rename(tempPath, this.filePath);
  }
}

interface JobRow extends QueryResultRow {
  job_json: CloudJob | string;
}

function jobFromRow(row: JobRow): CloudJob {
  return typeof row.job_json === 'string' ? (JSON.parse(row.job_json) as CloudJob) : row.job_json;
}

function nullableTimestamp(value: string | undefined): string | null {
  return value || null;
}

async function upsertJobRow(client: SqlQueryable, job: CloudJob): Promise<CloudJob> {
  await client.query(
    `
      INSERT INTO optimizer_jobs (
        id, tenant_id, external_job_id, idempotency_key, task_type, status,
        worker_id, attempts, max_attempts, created_at, uploaded_at, queued_at,
        started_at, completed_at, job_json, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        external_job_id = EXCLUDED.external_job_id,
        idempotency_key = EXCLUDED.idempotency_key,
        task_type = EXCLUDED.task_type,
        status = EXCLUDED.status,
        worker_id = EXCLUDED.worker_id,
        attempts = EXCLUDED.attempts,
        max_attempts = EXCLUDED.max_attempts,
        created_at = EXCLUDED.created_at,
        uploaded_at = EXCLUDED.uploaded_at,
        queued_at = EXCLUDED.queued_at,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        job_json = EXCLUDED.job_json,
        updated_at = NOW()
    `,
    [
      job.id,
      job.tenantId,
      job.externalJobId || null,
      job.idempotencyKey || null,
      job.taskType,
      job.status,
      job.workerId || null,
      job.attempts,
      job.maxAttempts,
      job.createdAt,
      nullableTimestamp(job.uploadedAt),
      nullableTimestamp(job.queuedAt),
      nullableTimestamp(job.startedAt),
      nullableTimestamp(job.completedAt),
      JSON.stringify(job),
    ]
  );
  return job;
}

export class PostgresJobStore implements JobStore {
  constructor(private readonly client: SqlQueryable = getPostgresPool()) {}

  async create(job: CloudJob): Promise<CloudJob> {
    await ensurePostgresSchema(this.client);
    try {
      await this.client.query(
        `
          INSERT INTO optimizer_jobs (
            id, tenant_id, external_job_id, idempotency_key, task_type, status,
            worker_id, attempts, max_attempts, created_at, uploaded_at, queued_at,
            started_at, completed_at, job_json, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, NOW())
        `,
        [
          job.id,
          job.tenantId,
          job.externalJobId || null,
          job.idempotencyKey || null,
          job.taskType,
          job.status,
          job.workerId || null,
          job.attempts,
          job.maxAttempts,
          job.createdAt,
          nullableTimestamp(job.uploadedAt),
          nullableTimestamp(job.queuedAt),
          nullableTimestamp(job.startedAt),
          nullableTimestamp(job.completedAt),
          JSON.stringify(job),
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new Error(`Job already exists: ${job.id}`);
      }
      throw error;
    }
    return job;
  }

  async get(jobId: string): Promise<CloudJob | undefined> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<JobRow>('SELECT job_json FROM optimizer_jobs WHERE id = $1', [jobId]);
    return result.rows[0] ? jobFromRow(result.rows[0]) : undefined;
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<CloudJob | undefined> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<JobRow>(
      'SELECT job_json FROM optimizer_jobs WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantId, idempotencyKey]
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : undefined;
  }

  async update(jobId: string, updates: Partial<CloudJob>): Promise<CloudJob> {
    return withPostgresTransaction(async (client) => {
      const result = await client.query<JobRow>('SELECT job_json FROM optimizer_jobs WHERE id = $1 FOR UPDATE', [
        jobId,
      ]);
      if (!result.rows[0]) {
        throw new Error(`Job not found: ${jobId}`);
      }
      const updated = { ...jobFromRow(result.rows[0]), ...updates };
      return upsertJobRow(client, updated);
    });
  }

  async transition(jobId: string, status: CloudJobStatus, updates: Partial<CloudJob> = {}): Promise<CloudJob> {
    return withPostgresTransaction(async (client) => {
      const result = await client.query<JobRow>('SELECT job_json FROM optimizer_jobs WHERE id = $1 FOR UPDATE', [
        jobId,
      ]);
      if (!result.rows[0]) {
        throw new Error(`Job not found: ${jobId}`);
      }
      const current = jobFromRow(result.rows[0]);
      assertJobStatusTransition(current.status, status);
      const updated = { ...current, ...updates, status };
      return upsertJobRow(client, updated);
    });
  }

  async claim(jobId: string, input: ClaimJobInput): Promise<CloudJob | undefined> {
    return withPostgresTransaction(async (client) => {
      const now = input.now ?? new Date();
      const nowIso = now.toISOString();
      const result = await client.query<JobRow>('SELECT job_json FROM optimizer_jobs WHERE id = $1 FOR UPDATE', [
        jobId,
      ]);
      if (!result.rows[0]) return undefined;

      const current = jobFromRow(result.rows[0]);
      if (current.status !== 'queued' && current.status !== 'retry_wait') return undefined;
      if (current.status === 'retry_wait' && current.queuedAt && new Date(current.queuedAt).getTime() > now.getTime()) {
        return undefined;
      }

      assertJobStatusTransition(current.status, 'processing');
      const updated: CloudJob = {
        ...current,
        status: 'processing',
        workerId: input.workerId,
        attempts: current.attempts + 1,
        startedAt: nowIso,
      };
      return upsertJobRow(client, updated);
    });
  }

  async claimNext(input: ClaimJobInput): Promise<CloudJob | undefined> {
    return withPostgresTransaction(async (client) => {
      const now = input.now ?? new Date();
      const nowIso = now.toISOString();
      const result = await client.query<JobRow>(
        `
          SELECT job_json
          FROM optimizer_jobs
          WHERE status = 'queued'
            OR (status = 'retry_wait' AND (queued_at IS NULL OR queued_at <= $1))
          ORDER BY COALESCE(queued_at, created_at), created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `,
        [nowIso]
      );
      if (!result.rows[0]) return undefined;

      const current = jobFromRow(result.rows[0]);
      assertJobStatusTransition(current.status, 'processing');
      const updated: CloudJob = {
        ...current,
        status: 'processing',
        workerId: input.workerId,
        attempts: current.attempts + 1,
        startedAt: nowIso,
      };
      return upsertJobRow(client, updated);
    });
  }

  async list(): Promise<CloudJob[]> {
    await ensurePostgresSchema(this.client);
    const result = await this.client.query<JobRow>(
      'SELECT job_json FROM optimizer_jobs ORDER BY created_at DESC, id DESC'
    );
    return result.rows.map(jobFromRow);
  }
}

interface MySqlJobRow extends RowDataPacket {
  job_json: CloudJob | string;
}

function mysqlJobFromRow(row: MySqlJobRow): CloudJob {
  return typeof row.job_json === 'string' ? (JSON.parse(row.job_json) as CloudJob) : row.job_json;
}

async function updateMySqlJobRow(client: MySqlQueryable, job: CloudJob): Promise<CloudJob> {
  const [result] = await client.execute<ResultSetHeader>(
    `
      UPDATE optimizer_jobs SET
        tenant_id = ?,
        external_job_id = ?,
        idempotency_key = ?,
        task_type = ?,
        status = ?,
        worker_id = ?,
        attempts = ?,
        max_attempts = ?,
        created_at = ?,
        uploaded_at = ?,
        queued_at = ?,
        started_at = ?,
        completed_at = ?,
        job_json = ?,
        updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?
    `,
    [
      job.tenantId,
      job.externalJobId || null,
      job.idempotencyKey || null,
      job.taskType,
      job.status,
      job.workerId || null,
      job.attempts,
      job.maxAttempts,
      mysqlDateTime(job.createdAt),
      mysqlDateTime(job.uploadedAt),
      mysqlDateTime(job.queuedAt),
      mysqlDateTime(job.startedAt),
      mysqlDateTime(job.completedAt),
      JSON.stringify(job),
      job.id,
    ]
  );
  if (result.affectedRows === 0) {
    throw new Error(`Job not found: ${job.id}`);
  }
  return job;
}

export class MySqlJobStore implements JobStore {
  constructor(private readonly client: MySqlQueryable = getMySqlPool()) {}

  async create(job: CloudJob): Promise<CloudJob> {
    await ensureMySqlSchema(this.client);
    try {
      await this.client.execute(
        `
          INSERT INTO optimizer_jobs (
            id, tenant_id, external_job_id, idempotency_key, task_type, status,
            worker_id, attempts, max_attempts, created_at, uploaded_at, queued_at,
            started_at, completed_at, job_json, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))
        `,
        [
          job.id,
          job.tenantId,
          job.externalJobId || null,
          job.idempotencyKey || null,
          job.taskType,
          job.status,
          job.workerId || null,
          job.attempts,
          job.maxAttempts,
          mysqlDateTime(job.createdAt),
          mysqlDateTime(job.uploadedAt),
          mysqlDateTime(job.queuedAt),
          mysqlDateTime(job.startedAt),
          mysqlDateTime(job.completedAt),
          JSON.stringify(job),
        ]
      );
    } catch (error) {
      if ((error as { code?: string; errno?: number }).code === 'ER_DUP_ENTRY') {
        throw new Error(`Job already exists: ${job.id}`);
      }
      throw error;
    }
    return job;
  }

  async get(jobId: string): Promise<CloudJob | undefined> {
    await ensureMySqlSchema(this.client);
    const [rows] = await this.client.execute<MySqlJobRow[]>('SELECT job_json FROM optimizer_jobs WHERE id = ?', [
      jobId,
    ]);
    return rows[0] ? mysqlJobFromRow(rows[0]) : undefined;
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<CloudJob | undefined> {
    await ensureMySqlSchema(this.client);
    const [rows] = await this.client.execute<MySqlJobRow[]>(
      'SELECT job_json FROM optimizer_jobs WHERE tenant_id = ? AND idempotency_key = ?',
      [tenantId, idempotencyKey]
    );
    return rows[0] ? mysqlJobFromRow(rows[0]) : undefined;
  }

  async update(jobId: string, updates: Partial<CloudJob>): Promise<CloudJob> {
    return withMySqlTransaction(async (client) => {
      const [rows] = await client.execute<MySqlJobRow[]>('SELECT job_json FROM optimizer_jobs WHERE id = ? FOR UPDATE', [
        jobId,
      ]);
      if (!rows[0]) {
        throw new Error(`Job not found: ${jobId}`);
      }
      const updated = { ...mysqlJobFromRow(rows[0]), ...updates };
      return updateMySqlJobRow(client, updated);
    });
  }

  async transition(jobId: string, status: CloudJobStatus, updates: Partial<CloudJob> = {}): Promise<CloudJob> {
    return withMySqlTransaction(async (client) => {
      const [rows] = await client.execute<MySqlJobRow[]>('SELECT job_json FROM optimizer_jobs WHERE id = ? FOR UPDATE', [
        jobId,
      ]);
      if (!rows[0]) {
        throw new Error(`Job not found: ${jobId}`);
      }
      const current = mysqlJobFromRow(rows[0]);
      assertJobStatusTransition(current.status, status);
      const updated = { ...current, ...updates, status };
      return updateMySqlJobRow(client, updated);
    });
  }

  async claim(jobId: string, input: ClaimJobInput): Promise<CloudJob | undefined> {
    return withMySqlTransaction(async (client) => {
      const now = input.now ?? new Date();
      const nowIso = now.toISOString();
      const [rows] = await client.execute<MySqlJobRow[]>('SELECT job_json FROM optimizer_jobs WHERE id = ? FOR UPDATE', [
        jobId,
      ]);
      if (!rows[0]) return undefined;

      const current = mysqlJobFromRow(rows[0]);
      if (current.status !== 'queued' && current.status !== 'retry_wait') return undefined;
      if (current.status === 'retry_wait' && current.queuedAt && new Date(current.queuedAt).getTime() > now.getTime()) {
        return undefined;
      }

      assertJobStatusTransition(current.status, 'processing');
      const updated: CloudJob = {
        ...current,
        status: 'processing',
        workerId: input.workerId,
        attempts: current.attempts + 1,
        startedAt: nowIso,
      };
      return updateMySqlJobRow(client, updated);
    });
  }

  async claimNext(input: ClaimJobInput): Promise<CloudJob | undefined> {
    return withMySqlTransaction(async (client) => {
      const now = input.now ?? new Date();
      const nowIso = now.toISOString();
      const [rows] = await client.execute<MySqlJobRow[]>(
        `
          SELECT job_json
          FROM optimizer_jobs
          WHERE status = 'queued'
            OR (status = 'retry_wait' AND (queued_at IS NULL OR queued_at <= ?))
          ORDER BY COALESCE(queued_at, created_at), created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
        [mysqlDateTime(nowIso)]
      );
      if (!rows[0]) return undefined;

      const current = mysqlJobFromRow(rows[0]);
      assertJobStatusTransition(current.status, 'processing');
      const updated: CloudJob = {
        ...current,
        status: 'processing',
        workerId: input.workerId,
        attempts: current.attempts + 1,
        startedAt: nowIso,
      };
      return updateMySqlJobRow(client, updated);
    });
  }

  async list(): Promise<CloudJob[]> {
    await ensureMySqlSchema(this.client);
    const [rows] = await this.client.execute<MySqlJobRow[]>(
      'SELECT job_json FROM optimizer_jobs ORDER BY created_at DESC, id DESC'
    );
    return rows.map(mysqlJobFromRow);
  }
}

export function createJobStore(): JobStore {
  if (config.database.stateStoreProvider === 'mysql') return new MySqlJobStore();
  if (config.database.stateStoreProvider === 'postgres') return new PostgresJobStore();
  return new LocalJobStore();
}

export const jobStore = createJobStore();
