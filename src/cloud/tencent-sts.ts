import type { CosObjectRef, TemporaryUploadGrant } from './types';
import { TencentCloudApiClient } from './tencent-cloud-api';
import { config } from '../config';

interface TencentAssumeRoleResponse {
  Credentials?: {
    TmpSecretId?: string;
    TmpSecretKey?: string;
    Token?: string;
  };
  ExpiredTime?: number;
  Expiration?: string;
}

export class TencentStsUploadGrantIssuer {
  constructor(
    private readonly client: TencentCloudApiClient = new TencentCloudApiClient({
      host: 'sts.tencentcloudapi.com',
      service: 'sts',
      version: '2018-08-13',
      region: config.cloud.region,
    })
  ) {}

  async issue(object: CosObjectRef, expiresInSeconds: number): Promise<TemporaryUploadGrant> {
    if (!config.cloud.cosUploadStsRoleArn) {
      throw new Error('COS_UPLOAD_STS_ROLE_ARN is required when COS_UPLOAD_GRANT_MODE=sts.');
    }

    const allowedPrefix = prefixForObject(object);
    const response = await this.client.request<TencentAssumeRoleResponse>('AssumeRole', {
      RoleArn: config.cloud.cosUploadStsRoleArn,
      RoleSessionName: `upload-${Date.now()}`,
      DurationSeconds: expiresInSeconds,
      Policy: encodeURIComponent(JSON.stringify(buildUploadPolicy(object, allowedPrefix))),
    });

    const credentials = response.Credentials;
    if (!credentials?.TmpSecretId || !credentials.TmpSecretKey || !credentials.Token) {
      throw new Error('AssumeRole response did not include temporary upload credentials.');
    }

    return {
      provider: 'tencent',
      object,
      uri: `cos://${object.bucket}/${object.key}?region=${encodeURIComponent(object.region)}`,
      method: 'PUT',
      expiresAt: response.Expiration || new Date((response.ExpiredTime || unixNow() + expiresInSeconds) * 1000).toISOString(),
      credentials: {
        tmpSecretId: credentials.TmpSecretId,
        tmpSecretKey: credentials.TmpSecretKey,
        sessionToken: credentials.Token,
      },
      allowedActions: uploadActions(),
      allowedPrefix,
    };
  }
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function prefixForObject(object: CosObjectRef): string {
  const slash = object.key.lastIndexOf('/');
  return slash >= 0 ? object.key.slice(0, slash + 1) : object.key;
}

function buildUploadPolicy(object: CosObjectRef, allowedPrefix: string): Record<string, unknown> {
  return {
    version: '2.0',
    statement: [
      {
        effect: 'allow',
        action: uploadActions(),
        resource: [`qcs::cos:${object.region}:uid/${extractAppId(object.bucket)}:${object.bucket}/${allowedPrefix}*`],
      },
    ],
  };
}

function extractAppId(bucket: string): string {
  const match = bucket.match(/-(\d+)$/);
  if (!match) {
    throw new Error(`COS bucket must include app id suffix for STS policy resource: ${bucket}`);
  }
  return match[1];
}

function uploadActions(): string[] {
  return [
    'name/cos:PutObject',
    'name/cos:PostObject',
    'name/cos:InitiateMultipartUpload',
    'name/cos:ListMultipartUploads',
    'name/cos:ListParts',
    'name/cos:UploadPart',
    'name/cos:CompleteMultipartUpload',
    'name/cos:AbortMultipartUpload',
  ];
}
