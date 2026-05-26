import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { ensurePostgresSchema, getPostgresPool, type SqlQueryable } from '../database/postgres';
import type { WorkerHeartbeat } from './types';

export interface WorkerHeartbeatStore {
  writeHeartbeat(heartbeat: WorkerHeartbeat): Promise<void>;
}

export class LocalWorkerHeartbeatStore implements WorkerHeartbeatStore {
  constructor(private readonly rootDir = 'data/cloud/workers') {}

  async writeHeartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
    const filePath = path.join(this.rootDir, `${heartbeat.workerId}.json`);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(heartbeat, null, 2));
  }
}

export class PostgresWorkerHeartbeatStore implements WorkerHeartbeatStore {
  constructor(private readonly client: SqlQueryable = getPostgresPool()) {}

  async writeHeartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
    await ensurePostgresSchema(this.client);
    await this.client.query(
      `
        INSERT INTO optimizer_workers (
          id, instance_id, backend, status, slots_total, slots_busy,
          draining, heartbeat_json, last_heartbeat, updated_at
        )
        VALUES ($1, $2, 'docker', $3, $4, $5, $6, $7::jsonb, $8, NOW())
        ON CONFLICT (id) DO UPDATE SET
          instance_id = EXCLUDED.instance_id,
          status = EXCLUDED.status,
          slots_total = EXCLUDED.slots_total,
          slots_busy = EXCLUDED.slots_busy,
          draining = EXCLUDED.draining,
          heartbeat_json = EXCLUDED.heartbeat_json,
          last_heartbeat = EXCLUDED.last_heartbeat,
          updated_at = NOW()
      `,
      [
        heartbeat.workerId,
        heartbeat.instanceId,
        heartbeat.status,
        heartbeat.slotsTotal,
        heartbeat.slotsBusy,
        heartbeat.draining,
        JSON.stringify(heartbeat),
        heartbeat.timestamp,
      ]
    );
  }
}

export function createWorkerHeartbeatStore(): WorkerHeartbeatStore {
  return config.database.stateStoreProvider === 'postgres'
    ? new PostgresWorkerHeartbeatStore()
    : new LocalWorkerHeartbeatStore();
}
