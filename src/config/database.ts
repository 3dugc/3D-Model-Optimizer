import { parseBoolean } from './parsers';
import type { DatabaseConfig } from './types';

function parseStateStoreProvider(): DatabaseConfig['stateStoreProvider'] {
  const configured =
    process.env.STATE_STORE_PROVIDER || process.env.JOB_STORE_PROVIDER || process.env.ORDER_STORE_PROVIDER;
  if (configured === 'local' || configured === 'mysql' || configured === 'postgres') return configured;
  if (process.env.DATABASE_URL?.startsWith('mysql://') || process.env.DATABASE_URL?.startsWith('mysql2://')) {
    return 'mysql';
  }
  if (process.env.DATABASE_URL) return 'postgres';
  return 'local';
}

export function parseDatabaseConfig(): DatabaseConfig {
  return {
    url: process.env.DATABASE_URL,
    stateStoreProvider: parseStateStoreProvider(),
    ssl: parseBoolean(process.env.DATABASE_SSL, false),
    sslRejectUnauthorized: parseBoolean(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED, true),
  };
}
