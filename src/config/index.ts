import { parseBillingConfig } from './billing';
import { parseCloudConfig } from './cloud';
import { parseDatabaseConfig } from './database';
import { parseInvoiceConfig } from './invoice';
import { parseServerConfig } from './server';
import type { ServerConfig } from './types';
import {
  assertRuntimeConfig as assertParsedRuntimeConfig,
  getRuntimeConfigErrors as getParsedRuntimeConfigErrors,
  validateConfig as validateParsedConfig,
} from './validation';
import type { RuntimeRole } from './validation';
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

export function getRuntimeConfigErrors(role: RuntimeRole, current: ServerConfig = config): string[] {
  return getParsedRuntimeConfigErrors(role, current);
}

export function assertRuntimeConfig(role: RuntimeRole, current: ServerConfig = config): void {
  assertParsedRuntimeConfig(role, current);
}

export type { BillingConfig, CloudRuntimeConfig, DatabaseConfig, InvoiceConfig, ServerConfig, WebAuthConfig } from './types';
export { RuntimeConfigurationError } from './validation';
export type { RuntimeRole } from './validation';

// Re-export swagger configuration
export { swaggerSpec, swaggerOptions } from './swagger';
