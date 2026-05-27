import { config } from '../config';

export interface TencentCredentials {
  secretId: string;
  secretKey: string;
  token?: string;
  expiredTime?: number;
  startTime?: number;
}

export interface TencentCredentialProvider {
  getCredentials(): Promise<TencentCredentials>;
}

interface MetadataCredentialResponse {
  TmpSecretId?: string;
  TmpSecretKey?: string;
  SecretId?: string;
  SecretKey?: string;
  Token?: string;
  ExpiredTime?: number | string;
  Expiration?: string;
  StartTime?: number | string;
  Code?: string;
  Message?: string;
}

const DEFAULT_METADATA_BASE_URL = 'http://metadata.tencentyun.com/latest/meta-data/cam/security-credentials';
const DEFAULT_TIMEOUT_MS = 1500;
const REFRESH_SKEW_SECONDS = 5 * 60;

export class StaticTencentCredentialProvider implements TencentCredentialProvider {
  constructor(private readonly credentials: TencentCredentials) {}

  async getCredentials(): Promise<TencentCredentials> {
    return this.credentials;
  }
}

export class TencentCvmRoleCredentialProvider implements TencentCredentialProvider {
  private cached?: TencentCredentials;

  constructor(
    private readonly options: {
      roleName?: string;
      baseUrl?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    } = {}
  ) {}

  async getCredentials(): Promise<TencentCredentials> {
    if (this.cached && !this.shouldRefresh(this.cached)) {
      return this.cached;
    }

    const roleName = this.options.roleName || (await this.fetchRoleName());
    const data = await this.fetchJson<MetadataCredentialResponse>(`${this.baseUrl}/${encodeURIComponent(roleName)}`);
    if (data.Code && data.Code !== 'Success') {
      throw new Error(`Tencent CVM role credential metadata failed: ${data.Code} ${data.Message || ''}`.trim());
    }

    const secretId = data.TmpSecretId || data.SecretId;
    const secretKey = data.TmpSecretKey || data.SecretKey;
    if (!secretId || !secretKey || !data.Token) {
      throw new Error('Tencent CVM role credential metadata did not return a complete temporary credential.');
    }

    this.cached = {
      secretId,
      secretKey,
      token: data.Token,
      expiredTime: parseCredentialTimestamp(data.ExpiredTime) || parseIsoTimestamp(data.Expiration),
      startTime: parseCredentialTimestamp(data.StartTime),
    };
    return this.cached;
  }

  private get baseUrl(): string {
    return (this.options.baseUrl || DEFAULT_METADATA_BASE_URL).replace(/\/+$/, '');
  }

  private shouldRefresh(credentials: TencentCredentials): boolean {
    if (!credentials.expiredTime) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return credentials.expiredTime - nowSeconds <= REFRESH_SKEW_SECONDS;
  }

  private async fetchRoleName(): Promise<string> {
    const text = (await this.fetchText(this.baseUrl)).trim();
    const roleName = text.split(/\s+/).find(Boolean);
    if (!roleName) {
      throw new Error('Tencent CVM role credential metadata did not return a role name.');
    }
    return roleName;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const text = await this.fetchText(url);
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`Tencent CVM role credential metadata returned non-JSON: ${(error as Error).message}`);
    }
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs || DEFAULT_TIMEOUT_MS);
    try {
      const response = await (this.options.fetchImpl || fetch)(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json, text/plain' },
      });
      if (!response.ok) {
        throw new Error(`Tencent CVM role credential metadata request failed: ${response.status}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createTencentCredentialProvider(): TencentCredentialProvider {
  if (config.cloud.tencentSecretId && config.cloud.tencentSecretKey) {
    return new StaticTencentCredentialProvider({
      secretId: config.cloud.tencentSecretId,
      secretKey: config.cloud.tencentSecretKey,
      token: config.cloud.tencentToken,
    });
  }

  return new TencentCvmRoleCredentialProvider({
    roleName: config.cloud.tencentCvmRoleName,
    baseUrl: config.cloud.tencentCvmRoleMetadataUrl,
  });
}

function parseCredentialTimestamp(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

export const tencentCredentialInternals = {
  DEFAULT_METADATA_BASE_URL,
  parseCredentialTimestamp,
  parseIsoTimestamp,
};
