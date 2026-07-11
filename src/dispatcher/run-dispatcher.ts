import logger from '../utils/logger';
import { assertRuntimeConfig } from '../config';

async function main(): Promise<void> {
  assertRuntimeConfig('dispatcher');
  const { ElasticDispatcher, createDispatcherRuntimeConfig } = await import('./dispatcher.js');
  const dispatcher = new ElasticDispatcher(createDispatcherRuntimeConfig());
  await dispatcher.start();
}

main().catch((error: unknown) => {
  logger.error({ error }, 'Elastic dispatcher crashed');
  process.exitCode = 1;
});
