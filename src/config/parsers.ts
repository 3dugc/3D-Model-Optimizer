/**
 * Parse environment variable as number with default.
 * @param value - Environment variable value
 * @param defaultValue - Default value if not set or invalid
 * @returns Parsed number or default
 */
export function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse environment variable as a positive integer.
 */
export function parsePositiveNumber(value: string | undefined, defaultValue: number): number {
  const parsed = parseNumber(value, defaultValue);
  return parsed > 0 ? parsed : defaultValue;
}

/**
 * Parse CORS origins from environment variable.
 * @param value - Comma-separated origins or '*'
 * @returns Array of origins or '*'
 */
export function parseCorsOrigins(value: string | undefined): string | string[] {
  if (!value || value === '*') return '*';
  return value.split(',').map((origin) => origin.trim());
}

export function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parsePositiveNumberCsv(value: string | undefined, defaultValue: number[]): number[] {
  const parsed = parseCsv(value)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.floor(item));
  return parsed.length ? parsed : defaultValue;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
