import * as fs from 'fs';
import * as path from 'path';
import type { RowDataPacket } from 'mysql2/promise';
import type { QueryResultRow } from 'pg';
import { config } from '../config';
import { ensureMySqlSchema, getMySqlPool } from '../database/mysql';
import { ensurePostgresSchema, getPostgresPool } from '../database/postgres';
import { createJobStore } from '../jobs/job-store';
import type { CloudJob } from '../jobs/types';
import type { WorkerHeartbeat } from '../worker/types';

export interface BusinessMonitorSnapshot {
  jobs: CloudJob[];
  workers: WorkerHeartbeat[];
}

interface JobJsonRow extends RowDataPacket, QueryResultRow {
  job_json: CloudJob | string;
}

interface WorkerJsonRow extends RowDataPacket, QueryResultRow {
  heartbeat_json: WorkerHeartbeat | string;
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

export async function readBusinessMonitorSnapshot(): Promise<BusinessMonitorSnapshot> {
  if (config.database.stateStoreProvider === 'mysql') return readMySqlSnapshot();
  if (config.database.stateStoreProvider === 'postgres') return readPostgresSnapshot();
  return readLocalSnapshot();
}

async function readMySqlSnapshot(): Promise<BusinessMonitorSnapshot> {
  const client = getMySqlPool();
  await ensureMySqlSchema(client);
  const [jobs] = await client.execute<JobJsonRow[]>(
    "SELECT job_json FROM optimizer_jobs WHERE status IN ('queued', 'retry_wait', 'processing') ORDER BY created_at DESC LIMIT 500"
  );
  const [workers] = await client.execute<WorkerJsonRow[]>(
    "SELECT heartbeat_json FROM optimizer_workers WHERE status IN ('starting', 'active', 'draining') ORDER BY last_heartbeat DESC LIMIT 500"
  );
  return {
    jobs: jobs.map((row) => parseJson<CloudJob>(row.job_json)),
    workers: workers.map((row) => parseJson<WorkerHeartbeat>(row.heartbeat_json)),
  };
}

async function readPostgresSnapshot(): Promise<BusinessMonitorSnapshot> {
  const client = getPostgresPool();
  await ensurePostgresSchema(client);
  const jobs = await client.query<JobJsonRow>(
    "SELECT job_json FROM optimizer_jobs WHERE status IN ('queued', 'retry_wait', 'processing') ORDER BY created_at DESC LIMIT 500"
  );
  const workers = await client.query<WorkerJsonRow>(
    "SELECT heartbeat_json FROM optimizer_workers WHERE status IN ('starting', 'active', 'draining') ORDER BY last_heartbeat DESC LIMIT 500"
  );
  return {
    jobs: jobs.rows.map((row) => parseJson<CloudJob>(row.job_json)),
    workers: workers.rows.map((row) => parseJson<WorkerHeartbeat>(row.heartbeat_json)),
  };
}

async function readLocalSnapshot(): Promise<BusinessMonitorSnapshot> {
  const jobs = await createJobStore().list();
  const workers = await readLocalWorkers('data/cloud/workers');
  return {
    jobs: jobs.filter((job) => ['queued', 'retry_wait', 'processing'].includes(job.status)),
    workers,
  };
}

async function readLocalWorkers(rootDir: string): Promise<WorkerHeartbeat[]> {
  try {
    const entries = await fs.promises.readdir(rootDir);
    const workers = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => JSON.parse(await fs.promises.readFile(path.join(rootDir, entry), 'utf8')) as WorkerHeartbeat)
    );
    return workers.filter((worker) => ['starting', 'active', 'draining'].includes(worker.status));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
