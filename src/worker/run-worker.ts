import { CloudWorker, createWorkerRuntimeConfig } from './cloud-worker';
import logger from '../utils/logger';

async function main(): Promise<void> {
  const worker = new CloudWorker(createWorkerRuntimeConfig());
  await worker.start();
}

main().catch((error: unknown) => {
  logger.error({ error }, 'Worker crashed');
  process.exitCode = 1;
});
