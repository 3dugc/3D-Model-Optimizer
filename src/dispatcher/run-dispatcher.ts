import { ElasticDispatcher, createDispatcherRuntimeConfig } from './dispatcher';
import logger from '../utils/logger';

async function main(): Promise<void> {
  const dispatcher = new ElasticDispatcher(createDispatcherRuntimeConfig());
  await dispatcher.start();
}

main().catch((error: unknown) => {
  logger.error({ error }, 'Elastic dispatcher crashed');
  process.exitCode = 1;
});

