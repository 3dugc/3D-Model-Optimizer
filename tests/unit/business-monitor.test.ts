import { describe, expect, it } from 'vitest';
import { evaluateAlerts } from '../../src/monitor/business-monitor';
import type { CloudJob } from '../../src/jobs/types';
import type { WorkerHeartbeat } from '../../src/worker/types';

function job(overrides: Partial<CloudJob>): CloudJob {
  const now = new Date('2026-05-28T00:00:00.000Z').toISOString();
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    taskType: 'model.optimize',
    task: { type: 'model.optimize', version: '1' },
    status: 'queued',
    options: {},
    inputBucket: 'input',
    inputRegion: 'ap-nanjing',
    inputKey: 'inputs/model.glb',
    paymentRequired: false,
    attempts: 0,
    maxAttempts: 3,
    createdAt: now,
    ...overrides,
  } as CloudJob;
}

function worker(overrides: Partial<WorkerHeartbeat>): WorkerHeartbeat {
  return {
    workerId: 'worker-1',
    instanceId: 'ins-1',
    status: 'active',
    slotsTotal: 1,
    slotsBusy: 0,
    draining: false,
    timestamp: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('business monitor alerts', () => {
  it('alerts when backlog has no fresh worker slots', () => {
    const alerts = evaluateAlerts(
      [job({ status: 'queued' })],
      [],
      { activeMsgNum: 1, inactiveMsgNum: 0, delayMsgNum: 0, msgCount: 1 },
      new Date('2026-05-28T00:00:00.000Z')
    );

    expect(alerts.map((alert) => alert.key)).toContain('queue-backlog-high');
    expect(alerts.map((alert) => alert.key)).toContain('backlog-without-fresh-workers');
  });

  it('does not treat scaled-to-zero idle workers as heartbeat loss', () => {
    const alerts = evaluateAlerts(
      [],
      [worker({ timestamp: '2026-05-27T23:00:00.000Z' })],
      { activeMsgNum: 0, inactiveMsgNum: 0, delayMsgNum: 0, msgCount: 0 },
      new Date('2026-05-28T00:00:00.000Z')
    );

    expect(alerts).toEqual([]);
  });

  it('alerts when a processing job is attached to a stale worker heartbeat', () => {
    const alerts = evaluateAlerts(
      [
        job({
          status: 'processing',
          workerId: 'worker-1',
          leaseExpiresAt: '2026-05-28T00:10:00.000Z',
        }),
      ],
      [worker({ workerId: 'worker-1', timestamp: '2026-05-27T23:00:00.000Z', slotsBusy: 1 })],
      { activeMsgNum: 0, inactiveMsgNum: 1, delayMsgNum: 0, msgCount: 1 },
      new Date('2026-05-28T00:00:00.000Z')
    );

    expect(alerts.map((alert) => alert.key)).toContain('worker-heartbeat-lost');
  });
});
