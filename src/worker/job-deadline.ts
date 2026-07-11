import { throwIfAborted } from '../utils/abort';

export class JobTimeoutError extends Error {
  readonly code = 'JOB_TIMEOUT';

  constructor(
    readonly jobId: string,
    readonly timeoutMs: number
  ) {
    super(`Job ${jobId} exceeded its ${timeoutMs}ms execution timeout.`);
    this.name = 'JobTimeoutError';
  }
}

/**
 * Run a cooperative operation under a deadline.
 *
 * This intentionally does not use Promise.race: Promise.race would return
 * while model conversion/optimization continued mutating files in the
 * background. Instead, the operation receives an AbortSignal and this helper
 * waits for it to stop before releasing the worker slot.
 */
export async function runWithJobDeadline<T>(
  jobId: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new JobTimeoutError(jobId, timeoutMs);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  try {
    const result = await operation(controller.signal);
    throwIfAborted(controller.signal);
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
