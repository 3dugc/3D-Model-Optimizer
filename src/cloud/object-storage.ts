import * as fs from 'fs';
import * as path from 'path';
import type { CosObjectRef } from './types';
import { config } from '../config';

export interface ObjectStorageProvider {
  providerName: 'local' | 'tencent';
  toUri(object: CosObjectRef): string;
  downloadObject(object: CosObjectRef, destinationPath: string): Promise<void>;
  uploadObject(sourcePath: string, object: CosObjectRef): Promise<void>;
  objectExists(object: CosObjectRef): Promise<boolean>;
}

function sanitizeObjectKey(key: string): string {
  const normalized = key.replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe COS object key: ${key}`);
  }
  return normalized;
}

async function ensureDirForFile(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

export class LocalObjectStorageProvider implements ObjectStorageProvider {
  readonly providerName = 'local' as const;

  constructor(private readonly rootDir: string = config.cloud.localObjectRoot) {}

  toUri(object: CosObjectRef): string {
    return `cos://${object.bucket}/${sanitizeObjectKey(object.key)}?region=${encodeURIComponent(object.region)}`;
  }

  getLocalPath(object: CosObjectRef): string {
    const safeKey = sanitizeObjectKey(object.key);
    const fullPath = path.resolve(this.rootDir, object.region, object.bucket, safeKey);
    const rootPath = path.resolve(this.rootDir);
    if (!fullPath.startsWith(rootPath + path.sep)) {
      throw new Error(`Resolved object path escaped storage root: ${object.key}`);
    }
    return fullPath;
  }

  async downloadObject(object: CosObjectRef, destinationPath: string): Promise<void> {
    const sourcePath = this.getLocalPath(object);
    await ensureDirForFile(destinationPath);
    await fs.promises.copyFile(sourcePath, destinationPath);
  }

  async uploadObject(sourcePath: string, object: CosObjectRef): Promise<void> {
    const destinationPath = this.getLocalPath(object);
    await ensureDirForFile(destinationPath);
    await fs.promises.copyFile(sourcePath, destinationPath);
  }

  async objectExists(object: CosObjectRef): Promise<boolean> {
    try {
      await fs.promises.access(this.getLocalPath(object));
      return true;
    } catch {
      return false;
    }
  }
}

export class TencentCosObjectStorageProvider implements ObjectStorageProvider {
  readonly providerName = 'tencent' as const;

  toUri(object: CosObjectRef): string {
    return `cos://${object.bucket}/${sanitizeObjectKey(object.key)}?region=${encodeURIComponent(object.region)}`;
  }

  async downloadObject(_object: CosObjectRef, _destinationPath: string): Promise<void> {
    throw new Error('Tencent COS provider is not wired in this build. Use CLOUD_PROVIDER=local or install the Tencent COS SDK adapter before production deployment.');
  }

  async uploadObject(_sourcePath: string, _object: CosObjectRef): Promise<void> {
    throw new Error('Tencent COS provider is not wired in this build. Use CLOUD_PROVIDER=local or install the Tencent COS SDK adapter before production deployment.');
  }

  async objectExists(_object: CosObjectRef): Promise<boolean> {
    throw new Error('Tencent COS provider is not wired in this build. Use CLOUD_PROVIDER=local or install the Tencent COS SDK adapter before production deployment.');
  }
}

export function createObjectStorageProvider(): ObjectStorageProvider {
  return config.cloud.provider === 'tencent'
    ? new TencentCosObjectStorageProvider()
    : new LocalObjectStorageProvider();
}
