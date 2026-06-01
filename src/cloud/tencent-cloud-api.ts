import { createHash, createHmac } from 'crypto';
import { createTencentCredentialProvider, type TencentCredentialProvider } from './tencent-credentials';

interface TencentCloudApiClientOptions {
  host: string;
  service: string;
  version: string;
  region: string;
  credentialProvider?: TencentCredentialProvider;
  fetchImpl?: typeof fetch;
}

interface TencentApiResponse<T> {
  Response?: T & {
    Error?: {
      Code?: string;
      Message?: string;
    };
  };
}

export class TencentCloudApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly credentialProvider: TencentCredentialProvider;

  constructor(private readonly options: TencentCloudApiClientOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.credentialProvider = options.credentialProvider || createTencentCredentialProvider();
  }

  async request<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    const credentials = await this.credentialProvider.getCredentials();
    if (!credentials.secretId || !credentials.secretKey) {
      throw new Error(`Tencent ${this.options.service} API requires Tencent credentials.`);
    }

    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${this.options.host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(body)].join('\n');
    const credentialScope = `${date}/${this.options.service}/tc3_request`;
    const stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope, sha256Hex(canonicalRequest)].join('\n');
    const secretDate = hmac(`TC3${credentials.secretKey}`, date);
    const secretService = hmac(secretDate, this.options.service);
    const secretSigning = hmac(secretService, 'tc3_request');
    const signature = hmac(secretSigning, stringToSign, 'hex');
    const authorization = `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await this.fetchImpl(`https://${this.options.host}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: this.options.host,
        'X-TC-Action': action,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': this.options.version,
        'X-TC-Region': this.options.region,
        ...(credentials.token ? { 'X-TC-Token': credentials.token } : {}),
      },
      body,
    });
    const data = (await response.json()) as TencentApiResponse<T>;
    if (!response.ok || data.Response?.Error) {
      const error = data.Response?.Error;
      throw new Error(`${action} failed: ${error?.Code ?? response.status}: ${error?.Message ?? JSON.stringify(data)}`);
    }
    if (!data.Response) throw new Error(`${action} returned an empty Tencent response`);
    return data.Response as T;
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer;
function hmac(key: string | Buffer, value: string, encoding: 'hex'): string;
function hmac(key: string | Buffer, value: string, encoding?: 'hex'): Buffer | string {
  const digest = createHmac('sha256', key).update(value);
  return encoding ? digest.digest(encoding) : digest.digest();
}
