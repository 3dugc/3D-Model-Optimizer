import { parseBoolean, parseCorsOrigins, parseNumber, parsePositiveNumber } from './parsers';
import type { ServerConfig } from './types';

type ServerSettings = Omit<ServerConfig, 'cloud' | 'database' | 'billing' | 'invoice' | 'webAuth'>;

export function parseServerConfig(): ServerSettings {
  return {
    port: parseNumber(process.env.PORT, 3000),
    host: process.env.HOST || 'localhost',
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
    jsonLimit: process.env.JSON_LIMIT || '1mb',
    uploadTimeout: parseNumber(process.env.UPLOAD_TIMEOUT, 30 * 1000),
    stepTimeout: parseNumber(process.env.STEP_TIMEOUT, 5 * 60 * 1000),
    totalTimeout: parseNumber(process.env.TOTAL_TIMEOUT, 30 * 60 * 1000),
    maxFileSize: parseNumber(process.env.MAX_FILE_SIZE, 100 * 1024 * 1024),
    tempDir: process.env.TEMP_DIR || 'temp',
    resultDir: process.env.RESULT_DIR || 'results',
    fileRetentionMs: parsePositiveNumber(
      process.env.FILE_RETENTION_MS || process.env.RESULT_FILE_RETENTION_MS,
      60 * 60 * 1000
    ),
    cleanupIntervalMs: parsePositiveNumber(process.env.CLEANUP_INTERVAL_MS, 10 * 60 * 1000),
    allowQueryAuthTokens: parseBoolean(process.env.ALLOW_QUERY_AUTH_TOKENS, true),
  };
}
