import { describe, expect, it } from 'vitest';
import { TaskRegistry } from '../../src/tasks/registry';
import type { HeavyTaskDescriptor } from '../../src/tasks/types';
import { throwIfAborted } from '../../src/utils/abort';
import { JobTimeoutError, runWithJobDeadline } from '../../src/worker/job-deadline';

const descriptor: HeavyTaskDescriptor = {
  type: 'test.task',
  version: '1.0',
  payload: {},
  resourceClass: 'cpu-small',
};

describe('worker job deadlines', () => {
  it('waits for cooperative cleanup before releasing a timed-out operation', async () => {
    let cleanupFinished = false;

    const execution = runWithJobDeadline('job-timeout', 10, async (signal) => {
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      cleanupFinished = true;
      throwIfAborted(signal);
      return 'unreachable';
    });

    await expect(execution).rejects.toMatchObject({
      name: 'JobTimeoutError',
      code: 'JOB_TIMEOUT',
      jobId: 'job-timeout',
    });
    expect(cleanupFinished).toBe(true);
  });

  it('passes the deadline AbortSignal through the task registry', async () => {
    const registry = new TaskRegistry();
    let receivedSignal: AbortSignal | undefined;
    registry.register({
      type: descriptor.type,
      async run(_inputPath, _outputPath, _descriptor, execution) {
        receivedSignal = execution?.signal;
        return { taskType: descriptor.type, success: true };
      },
    });
    const controller = new AbortController();

    await expect(
      registry.run('input', 'output', descriptor, { signal: controller.signal })
    ).resolves.toMatchObject({ success: true });
    expect(receivedSignal).toBe(controller.signal);
  });

  it('uses a stable timeout error type', () => {
    const error = new JobTimeoutError('job-1', 1234);
    expect(error.code).toBe('JOB_TIMEOUT');
    expect(error.message).toContain('1234ms');
  });
});
