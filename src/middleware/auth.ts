import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../config';

export interface ApiPrincipal {
  name: string;
  scopes: string[];
  tenantIds?: string[];
  taskTypes?: string[];
  legacy?: boolean;
}

interface ApiKeyDefinition {
  name?: string;
  key: string;
  scopes?: string[];
  tenantId?: string;
  tenantIds?: string[];
  taskTypes?: string[];
}

const API_KEY_DEFINITION_FIELDS = new Set([
  'name',
  'key',
  'scopes',
  'tenantId',
  'tenantIds',
  'taskTypes',
]);
const INSECURE_API_KEY_PLACEHOLDERS = new Set(['change-me', 'replace-me', 'changeme', 'your-api-key']);

export class ApiAuthConfigurationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiAuthConfigurationError';
    this.code = code;
  }
}

declare global {
  namespace Express {
    interface Request {
      apiPrincipal?: ApiPrincipal;
    }
  }
}

export const getApiKey = (): string | undefined => {
  const key = process.env.API_KEY;
  return key && key.trim().length > 0 ? key : undefined;
};

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isAnonymousApiAllowed(): boolean {
  const value = process.env.ALLOW_ANONYMOUS_API;
  return !!value && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export const isAuthEnabled = (): boolean => {
  const key = getApiKey();
  const definitions = parseApiKeyDefinitions();
  const configured = !!key || definitions.length > 0;
  // Production remains fail-closed even when startup validation is bypassed by
  // a custom launcher. ALLOW_ANONYMOUS_API is an explicit escape hatch.
  return (isProduction() && !isAnonymousApiAllowed()) || configured;
};

function getRequestToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const [type, token] = authHeader.split(' ');
    if (type === 'Bearer' && token) return token;
  }

  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string') return headerKey;
  if (Array.isArray(headerKey) && headerKey[0]) return headerKey[0];

  if (config.allowQueryAuthTokens) {
    const queryKey = req.query.api_key;
    if (typeof queryKey === 'string') return queryKey;
  }
  return undefined;
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function parseApiKeyDefinitions(raw: string | undefined = process.env.API_KEYS): ApiKeyDefinition[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ApiAuthConfigurationError('INVALID_API_KEYS_JSON', 'API_KEYS must be valid JSON.');
  }

  if (!Array.isArray(parsed)) {
    throw new ApiAuthConfigurationError('INVALID_API_KEYS_TYPE', 'API_KEYS must be a JSON array.');
  }

  const definitions = parsed.map((value, index) => parseApiKeyDefinition(value, index));
  const uniqueKeys = new Set(definitions.map((definition) => definition.key));
  if (uniqueKeys.size !== definitions.length) {
    throw new ApiAuthConfigurationError('DUPLICATE_API_KEY', 'API_KEYS must not contain duplicate keys.');
  }
  return definitions;
}

function parseApiKeyDefinition(value: unknown, index: number): ApiKeyDefinition {
  const invalid = (message: string): never => {
    throw new ApiAuthConfigurationError('INVALID_API_KEY_DEFINITION', `API_KEYS[${index}] ${message}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('must be an object.');

  const candidate = value as Record<string, unknown>;
  const unknownField = Object.keys(candidate).find((field) => !API_KEY_DEFINITION_FIELDS.has(field));
  if (unknownField) invalid(`contains unsupported field "${unknownField}".`);
  if (typeof candidate.key !== 'string' || candidate.key.trim().length === 0) {
    invalid('key must be a non-empty string.');
  }
  if (candidate.name !== undefined && (typeof candidate.name !== 'string' || candidate.name.trim().length === 0)) {
    invalid('name must be a non-empty string when provided.');
  }
  if (candidate.tenantId !== undefined &&
      (typeof candidate.tenantId !== 'string' || candidate.tenantId.trim().length === 0)) {
    invalid('tenantId must be a non-empty string when provided.');
  }

  const scopes = parseStringArray(candidate.scopes, index, 'scopes');
  const tenantIds = parseStringArray(candidate.tenantIds, index, 'tenantIds');
  const taskTypes = parseStringArray(candidate.taskTypes, index, 'taskTypes');
  return {
    key: candidate.key as string,
    name: candidate.name as string | undefined,
    scopes,
    tenantId: candidate.tenantId as string | undefined,
    tenantIds,
    taskTypes,
  };
}

function parseStringArray(value: unknown, index: number, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new ApiAuthConfigurationError(
      'INVALID_API_KEY_DEFINITION',
      `API_KEYS[${index}] ${field} must be an array of non-empty strings.`
    );
  }
  return [...new Set(value as string[])];
}

function normalizePrincipal(definition: ApiKeyDefinition): ApiPrincipal {
  const tenantIds = [...(definition.tenantIds || []), ...(definition.tenantId ? [definition.tenantId] : [])];
  return {
    name: definition.name || 'api-key',
    scopes: definition.scopes === undefined ? ['*'] : definition.scopes,
    tenantIds:
      definition.tenantIds === undefined && definition.tenantId === undefined
        ? undefined
        : [...new Set(tenantIds)],
    taskTypes: definition.taskTypes,
  };
}

export function assertProductionApiAuthConfigured(): void {
  const definitions = parseApiKeyDefinitions();
  if (!isProduction() || isAnonymousApiAllowed()) return;
  const legacyKey = getApiKey();
  const insecureKey = [legacyKey, ...definitions.map((definition) => definition.key)]
    .filter((value): value is string => Boolean(value))
    .find((value) => INSECURE_API_KEY_PLACEHOLDERS.has(value.trim().toLowerCase()));
  if (insecureKey) {
    throw new ApiAuthConfigurationError(
      'INSECURE_API_KEY',
      'Production API authentication must not use a documented placeholder key.'
    );
  }
  if (legacyKey || definitions.length > 0) return;
  throw new ApiAuthConfigurationError(
    'API_AUTH_REQUIRED',
    'Production API authentication requires API_KEY or API_KEYS. Set ALLOW_ANONYMOUS_API=true only for an intentional public deployment.'
  );
}

export function authenticateApiKey(token: string | undefined): ApiPrincipal | undefined {
  const definitions = parseApiKeyDefinitions();
  if (!token) return undefined;

  const legacy = getApiKey();
  if (legacy && safeEquals(token, legacy)) {
    return { name: 'legacy-api-key', scopes: ['*'], legacy: true };
  }

  const definition = definitions.find((item) => safeEquals(token, item.key));
  return definition ? normalizePrincipal(definition) : undefined;
}

export function hasScope(principal: ApiPrincipal | undefined, scope: string): boolean {
  if (!principal) return false;
  return principal.scopes.includes('*') || principal.scopes.includes(scope);
}

export function canAccessTenant(principal: ApiPrincipal | undefined, tenantId: string): boolean {
  if (!principal) return false;
  return principal.tenantIds === undefined || principal.tenantIds.includes(tenantId);
}

export function canAccessTaskType(principal: ApiPrincipal | undefined, taskType: string): boolean {
  if (!principal) return false;
  return principal.taskTypes === undefined || principal.taskTypes.includes(taskType);
}

export const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  if (!isAuthEnabled()) {
    req.apiPrincipal = { name: 'anonymous', scopes: ['*'] };
    return next();
  }

  const principal = authenticateApiKey(getRequestToken(req));
  if (principal) {
    req.apiPrincipal = principal;
    return next();
  }

  res.status(401).json({
    success: false,
    error: {
      code: 'UNAUTHORIZED',
      message: config.allowQueryAuthTokens
        ? 'API key required. Use Authorization: Bearer <key>, x-api-key header, or ?api_key= query param.'
        : 'API key required. Use Authorization: Bearer <key> or x-api-key header.',
    },
  });
};

export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hasScope(req.apiPrincipal, scope)) return next();
    res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: `API key scope required: ${scope}`,
      },
    });
  };
}
