/**
 * Throw the original abort reason when possible.
 *
 * Keeping this check explicit lets CPU-bound code cooperate with a deadline
 * between stages, while child-process based stages can receive the same
 * AbortSignal and terminate immediately.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;

  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  throw error;
}
