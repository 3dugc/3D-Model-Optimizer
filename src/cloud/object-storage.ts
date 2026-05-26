import * as fs from 'fs';
import * as path from 'path';
import COS from 'cos-nodejs-sdk-v5';
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

function requireTencentCosClient(): COS {
  if (!config.cloud.tencentSecretId || !config.cloud.tencentSecretKey) {
    throw new Error('Tencent COS requires TENCENT_SECRET_ID and TENCENT_SECRET_KEY.');
  }

  return new COS({
    SecretId: config.cloud.tencentSecretId,
    SecretKey: config.cloud.tencentSecretKey,
    SecurityToken: config.cloud.tencentToken,
  });
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

  constructor(private readonly cos: COS = requireTencentCosClient()) {}

  toUri(object: CosObjectRef): string {
    return `cos://${object.bucket}/${sanitizeObjectKey(object.key)}?region=${encodeURIComponent(object.region)}`;
  }

  async downloadObject(object: CosObjectRef, destinationPath: string): Promise<void> {
    const safeKey = sanitizeObjectKey(object.key);
    await ensureDirForFile(destinationPath);
    const output = fs.createWriteStream(destinationPath);
    try {
      await this.cos.getObject({
        Bucket: object.bucket,
        Region: object.region,
        Key: safeKey,
        Output: output,
      });
    } catch (error) {
      output.destroy();
      throw error;
    }
  }

  async uploadObject(sourcePath: string, object: CosObjectRef): Promise<void> {
    await this.cos.uploadFile({
      Bucket: object.bucket,
      Region: object.region,
      Key: sanitizeObjectKey(object.key),
      FilePath: sourcePath,
      SliceSize: 8 * 1024 * 1024,
    });
  }

  async objectExists(object: CosObjectRef): Promise<boolean> {
    try {
      await this.cos.headObject({
        Bucket: object.bucket,
        Region: object.region,
        Key: sanitizeObjectKey(object.key),
      });
      return true;
    } catch (error) {
      const cosError = error as COS.CosSdkError;
      if (cosError.statusCode === 404 || cosError.code === 'NoSuchKey' || cosError.code === 'NoSuchBucket') {
        return false;
      }
      throw error;
    }
  }
}

export function createObjectStorageProvider(): ObjectStorageProvider {
  return config.cloud.provider === 'tencent'
    ? new TencentCosObjectStorageProvider()
    : new LocalObjectStorageProvider();
}
