import * as fs from 'fs';
import * as path from 'path';
import COS from 'cos-nodejs-sdk-v5';
import type { CosObjectRef, SignedObjectUrl, TemporaryUploadGrant } from './types';
import { config } from '../config';
import { createTencentCredentialProvider } from './tencent-credentials';
import { TencentStsUploadGrantIssuer } from './tencent-sts';

export interface ObjectStorageProvider {
  providerName: 'local' | 'tencent';
  toUri(object: CosObjectRef): string;
  readObjectText(object: CosObjectRef): Promise<string>;
  downloadObject(object: CosObjectRef, destinationPath: string): Promise<void>;
  uploadObject(sourcePath: string, object: CosObjectRef): Promise<void>;
  objectExists(object: CosObjectRef): Promise<boolean>;
  createUploadGrant(object: CosObjectRef, expiresInSeconds?: number): Promise<TemporaryUploadGrant>;
  createDownloadUrl(object: CosObjectRef, expiresInSeconds?: number): Promise<SignedObjectUrl>;
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
  const credentialProvider = createTencentCredentialProvider();

  return new COS({
    ...(config.cloud.tencentSecretId && config.cloud.tencentSecretKey
      ? {
          SecretId: config.cloud.tencentSecretId,
          SecretKey: config.cloud.tencentSecretKey,
          SecurityToken: config.cloud.tencentToken,
        }
      : {
          getAuthorization: (_options, callback) => {
            credentialProvider
              .getCredentials()
              .then((credentials) =>
                callback({
                  TmpSecretId: credentials.secretId,
                  TmpSecretKey: credentials.secretKey,
                  SecurityToken: credentials.token,
                  ExpiredTime: credentials.expiredTime || Math.floor(Date.now() / 1000) + 1800,
                  StartTime: credentials.startTime || Math.floor(Date.now() / 1000) - 60,
                })
              )
              .catch(() => callback({} as never));
          },
        }),
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

  async readObjectText(object: CosObjectRef): Promise<string> {
    return fs.promises.readFile(this.getLocalPath(object), 'utf8');
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

  async createUploadGrant(object: CosObjectRef, expiresInSeconds: number = config.cloud.cosUploadCredentialTtlSeconds): Promise<TemporaryUploadGrant> {
    const allowedPrefix = prefixForObject(object.key);
    return {
      provider: 'local',
      object,
      uri: this.toUri(object),
      method: 'PUT',
      expiresAt: expiresAtIso(expiresInSeconds),
      allowedActions: ['local:write'],
      allowedPrefix,
    };
  }

  async createDownloadUrl(object: CosObjectRef, expiresInSeconds: number = config.cloud.cosDownloadUrlTtlSeconds): Promise<SignedObjectUrl> {
    return {
      provider: 'local',
      object,
      method: 'GET',
      url: this.toUri(object),
      expiresAt: expiresAtIso(expiresInSeconds),
    };
  }
}

export class TencentCosObjectStorageProvider implements ObjectStorageProvider {
  readonly providerName = 'tencent' as const;

  constructor(
    private readonly cos: COS = requireTencentCosClient(),
    private readonly stsIssuer: TencentStsUploadGrantIssuer = new TencentStsUploadGrantIssuer()
  ) {}

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

  async readObjectText(object: CosObjectRef): Promise<string> {
    const response = await this.cos.getObject({
      Bucket: object.bucket,
      Region: object.region,
      Key: sanitizeObjectKey(object.key),
    });
    if (Buffer.isBuffer(response.Body)) return response.Body.toString('utf8');
    if (typeof response.Body === 'string') return response.Body;
    throw new Error(`COS object did not include a readable body: ${object.key}`);
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

  async createUploadGrant(object: CosObjectRef, expiresInSeconds: number = config.cloud.cosUploadCredentialTtlSeconds): Promise<TemporaryUploadGrant> {
    if (config.cloud.cosUploadGrantMode === 'sts') {
      return this.stsIssuer.issue(object, expiresInSeconds);
    }

    const putUrl = await this.getObjectUrl(object, 'PUT', expiresInSeconds);
    return {
      provider: 'tencent',
      object,
      uri: this.toUri(object),
      method: 'PUT',
      putUrl,
      expiresAt: expiresAtIso(expiresInSeconds),
      allowedActions: ['name/cos:PutObject'],
      allowedPrefix: prefixForObject(object.key),
    };
  }

  async createDownloadUrl(object: CosObjectRef, expiresInSeconds: number = config.cloud.cosDownloadUrlTtlSeconds): Promise<SignedObjectUrl> {
    return {
      provider: 'tencent',
      object,
      method: 'GET',
      url: await this.getObjectUrl(object, 'GET', expiresInSeconds),
      expiresAt: expiresAtIso(expiresInSeconds),
    };
  }

  private async getObjectUrl(object: CosObjectRef, method: 'GET' | 'PUT', expiresInSeconds: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.cos.getObjectUrl(
        {
          Bucket: object.bucket,
          Region: object.region,
          Key: sanitizeObjectKey(object.key),
          Sign: true,
          Method: method,
          Expires: expiresInSeconds,
          Protocol: 'https:',
        },
        (error, data) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(data.Url);
        }
      );
    });
  }
}

export function createObjectStorageProvider(): ObjectStorageProvider {
  return config.cloud.provider === 'tencent'
    ? new TencentCosObjectStorageProvider()
    : new LocalObjectStorageProvider();
}

function expiresAtIso(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

function prefixForObject(key: string): string {
  const safeKey = sanitizeObjectKey(key);
  const slash = safeKey.lastIndexOf('/');
  return slash >= 0 ? safeKey.slice(0, slash + 1) : safeKey;
}
