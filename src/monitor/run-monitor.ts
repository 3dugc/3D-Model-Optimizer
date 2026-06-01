import { BusinessMonitor } from './business-monitor';
import logger from '../utils/logger';

async function main(): Promise<void> {
  const monitor = new BusinessMonitor();
  const stop = () => {
    logger.info('Business monitor stopping');
    monitor.stop();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await monitor.start();
}

main().catch((error: unknown) => {
  logger.error({ error }, 'Business monitor crashed');
  process.exit(1);
});
