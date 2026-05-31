import { parseBillingConfig } from './billing';
import { parseCloudConfig } from './cloud';
import { parseDatabaseConfig } from './database';
import { parseInvoiceConfig } from './invoice';
import { parseServerConfig } from './server';
import type { ServerConfig } from './types';
import { validateConfig as validateParsedConfig } from './validation';
import { parseWebAuthConfig } from './web-auth';

/**
 * Configuration
 *
 * This module keeps the public `config` export stable while splitting parsing
 * into smaller domain modules.
 */
export const config: ServerConfig = {
  ...parseServerConfig(),
  cloud: parseCloudConfig(),
  database: parseDatabaseConfig(),
  billing: parseBillingConfig(),
  invoice: parseInvoiceConfig(),
  webAuth: parseWebAuthConfig(),
};

export function validateConfig(current: ServerConfig = config): string[] {
  return validateParsedConfig(current);
}

export type { BillingConfig, CloudRuntimeConfig, DatabaseConfig, InvoiceConfig, ServerConfig, WebAuthConfig } from './types';

// Re-export swagger configuration
export { swaggerSpec, swaggerOptions } from './swagger';
