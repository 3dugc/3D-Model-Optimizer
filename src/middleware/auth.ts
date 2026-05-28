import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

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

declare global {
  namespace Express {
    interface Request {
      apiPrincipal?: ApiPrincipal;
    }
  }
}

export const getApiKey = (): string | undefined => process.env.API_KEY;

export const isAuthEnabled = (): boolean => {
  const key = getApiKey();
  return (!!key && key.length > 0) || parseApiKeyDefinitions().length > 0;
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

  const queryKey = req.query.api_key;
  if (typeof queryKey === 'string') return queryKey;
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
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isApiKeyDefinition);
  } catch {
    return [];
  }
}

function isApiKeyDefinition(value: unknown): value is ApiKeyDefinition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ApiKeyDefinition>;
  return typeof candidate.key === 'string' && candidate.key.length > 0;
}

function normalizePrincipal(definition: ApiKeyDefinition): ApiPrincipal {
  const tenantIds = [...(definition.tenantIds || []), ...(definition.tenantId ? [definition.tenantId] : [])];
  return {
    name: definition.name || 'api-key',
    scopes: definition.scopes?.length ? definition.scopes : ['*'],
    tenantIds: tenantIds.length ? [...new Set(tenantIds)] : undefined,
    taskTypes: definition.taskTypes?.length ? definition.taskTypes : undefined,
  };
}

export function authenticateApiKey(token: string | undefined): ApiPrincipal | undefined {
  if (!token) return undefined;

  const legacy = getApiKey();
  if (legacy && safeEquals(token, legacy)) {
    return { name: 'legacy-api-key', scopes: ['*'], legacy: true };
  }

  const definition = parseApiKeyDefinitions().find((item) => safeEquals(token, item.key));
  return definition ? normalizePrincipal(definition) : undefined;
}

export function hasScope(principal: ApiPrincipal | undefined, scope: string): boolean {
  if (!principal) return !isAuthEnabled();
  return principal.scopes.includes('*') || principal.scopes.includes(scope);
}

export function canAccessTenant(principal: ApiPrincipal | undefined, tenantId: string): boolean {
  if (!principal || principal.scopes.includes('*')) return true;
  return !principal.tenantIds?.length || principal.tenantIds.includes(tenantId);
}

export function canAccessTaskType(principal: ApiPrincipal | undefined, taskType: string): boolean {
  if (!principal || principal.scopes.includes('*')) return true;
  return !principal.taskTypes?.length || principal.taskTypes.includes(taskType);
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
      message: 'API key required. Use Authorization: Bearer <key>, x-api-key header, or ?api_key= query param.',
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
