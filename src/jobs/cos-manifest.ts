import type { CosObjectRef } from '../cloud/types';
import type { ApiPrincipal } from '../middleware/auth';
import { canAccessTaskType, canAccessTenant } from '../middleware/auth';
import { config } from '../config';
import type { CreateCloudJobInput } from './types';
import { HttpError } from '../utils/http-error';

export interface CosJobManifest {
  tenantId: string;
  taskType?: string;
  input: string | (Partial<CosObjectRef> & { key: string; filename?: string });
  filename?: string;
  externalJobId?: string;
  idempotencyKey?: string;
  preset?: CreateCloudJobInput['preset'];
  options?: CreateCloudJobInput['options'];
  callbackUrl?: string;
  callbackSecretId?: string;
  callbackSigningSecret?: string;
  paymentRequired?: boolean;
}

export function isManifestObjectKey(key: string): boolean {
  const normalized = normalizeObjectKey(key);
  return normalized.endsWith('/manifest.json') || normalized.endsWith('.manifest.json');
}

export function parseCosJobManifest(
  raw: string,
  manifestObject: CosObjectRef,
  principal?: ApiPrincipal
): CreateCloudJobInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'INVALID_MANIFEST', 'COS manifest must be valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new HttpError(400, 'INVALID_MANIFEST', 'COS manifest must be a JSON object.');
  }

  const manifest = parsed as Partial<CosJobManifest>;
  const tenantId = requireTenantId(manifest.tenantId);
  assertTenantAccess(principal, tenantId);

  const taskType = manifest.taskType || config.cloud.defaultTaskType;
  assertTaskTypeAccess(principal, taskType);
  const input = resolveManifestInput(manifest, manifestObject, tenantId);

  return {
    tenantId,
    taskType,
    filename: manifest.filename || input.key.split('/').pop() || 'input.glb',
    input,
    externalJobId: stringOrUndefined(manifest.externalJobId),
    idempotencyKey:
      stringOrUndefined(manifest.idempotencyKey) ||
      `manifest:${manifestObject.bucket}:${manifestObject.region}:${manifestObject.key}:${manifestObject.etag || ''}`,
    preset: manifest.preset,
    options: manifest.options,
    callbackUrl: stringOrUndefined(manifest.callbackUrl),
    callbackSecretId: stringOrUndefined(manifest.callbackSecretId),
    callbackSigningSecret: stringOrUndefined(manifest.callbackSigningSecret),
    paymentRequired: Boolean(manifest.paymentRequired),
  };
}

export function assertTenantObjectPrefix(tenantId: string, object: CosObjectRef): void {
  const safeTenantId = requireTenantId(tenantId);
  const key = normalizeObjectKey(object.key);
  const prefix = `tenants/${safeTenantId}/`;
  if (!key.startsWith(prefix)) {
    throw new HttpError(403, 'OBJECT_PREFIX_FORBIDDEN', `COS object must be under ${prefix}.`, {
      key,
      prefix,
    });
  }
}

export function assertTenantAccess(principal: ApiPrincipal | undefined, tenantId: string): void {
  if (!canAccessTenant(principal, tenantId)) {
    throw new HttpError(403, 'TENANT_FORBIDDEN', 'API key cannot access this tenant.');
  }
}

export function assertTaskTypeAccess(principal: ApiPrincipal | undefined, taskType: string): void {
  if (!canAccessTaskType(principal, taskType)) {
    throw new HttpError(403, 'TASK_TYPE_FORBIDDEN', 'API key cannot submit this taskType.');
  }
}

export function requireTenantId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new HttpError(400, 'INVALID_TENANT', 'tenantId is required and must use a safe identifier.');
  }
  return value;
}

function resolveManifestInput(manifest: Partial<CosJobManifest>, manifestObject: CosObjectRef, tenantId: string): CosObjectRef {
  const input = manifest.input;
  if (!input) {
    throw new HttpError(400, 'INVALID_MANIFEST', 'COS manifest input is required.');
  }

  const object =
    typeof input === 'string'
      ? {
          bucket: manifestObject.bucket,
          region: manifestObject.region,
          key: input,
        }
      : {
          bucket: input.bucket || manifestObject.bucket,
          region: input.region || manifestObject.region,
          key: input.key,
          etag: input.etag,
          size: input.size,
        };

  object.key = normalizeObjectKey(object.key);
  assertTenantObjectPrefix(tenantId, object);
  assertTenantObjectPrefix(tenantId, manifestObject);
  return object;
}

function normalizeObjectKey(key: unknown): string {
  if (typeof key !== 'string') {
    throw new HttpError(400, 'INVALID_OBJECT_KEY', 'COS object key must be a string.');
  }
  const normalized = key.replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.startsWith('/')) {
    throw new HttpError(400, 'INVALID_OBJECT_KEY', 'COS object key is unsafe.');
  }
  return normalized;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
