import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import type { ClaimJobInput, CloudJob, CloudJobStatus } from './types';
import { assertJobStatusTransition } from './state-machine';

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

export const jobStore = new LocalJobStore();
