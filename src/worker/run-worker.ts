import logger from '../utils/logger';
import { assertRuntimeConfig } from '../config';

async function main(): Promise<void> {
  assertRuntimeConfig('worker');
  const { CloudWorker, createWorkerRuntimeConfig } = await import('./cloud-worker.js');
  const worker = new CloudWorker(createWorkerRuntimeConfig());
  await worker.start();
}

main().catch((error: unknown) => {
  logger.error({ error }, 'Worker crashed');
  process.exitCode = 1;
});
