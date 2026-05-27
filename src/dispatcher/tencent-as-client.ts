import { createHash, createHmac } from 'crypto';
import { config } from '../config';
import type { ScalingBackend, ScalingBackendSnapshot, ScalingPool } from './types';
import { planPoolDesiredCapacities } from './scaling';

interface TencentAsGroup {
  AutoScalingGroupId: string;
  AutoScalingGroupName?: string;
  MinSize?: number;
  MaxSize?: number;
  DesiredCapacity?: number;
  InServiceInstanceCount?: number;
}

interface TencentApiResponse<T> {
  Response?: T & {
    Error?: {
      Code?: string;
      Message?: string;
    };
  };
}

interface DescribeAutoScalingGroupsResponse {
  AutoScalingGroupSet?: TencentAsGroup[];
}

export interface TencentAsClientOptions {
  region: string;
  secretId: string;
  secretKey: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export class TencentAsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly host = 'as.tencentcloudapi.com';
  private readonly service = 'as';
  private readonly version = '2018-04-19';

  constructor(private readonly options: TencentAsClientOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async describeAutoScalingGroups(groupIds: string[]): Promise<ScalingPool[]> {
    const response = await this.request<DescribeAutoScalingGroupsResponse>('DescribeAutoScalingGroups', {
      AutoScalingGroupIds: groupIds,
    });
    const groups = response.AutoScalingGroupSet || [];
    const pools = groupIds
      .map((groupId) => groups.find((group) => group.AutoScalingGroupId === groupId))
      .filter((group): group is TencentAsGroup => Boolean(group))
      .map((group) => ({
        id: group.AutoScalingGroupId,
        name: group.AutoScalingGroupName,
        minSize: group.MinSize ?? 0,
        maxSize: group.MaxSize ?? 0,
        desiredCapacity: group.DesiredCapacity ?? 0,
        inService: group.InServiceInstanceCount ?? 0,
      }));
    const missingGroupIds = groupIds.filter((groupId) => !pools.some((pool) => pool.id === groupId));
    if (missingGroupIds.length) {
      throw new Error(`Tencent AS groups not found: ${missingGroupIds.join(',')}`);
    }
    return pools;
  }

  async modifyDesiredCapacity(groupId: string, desiredCapacity: number): Promise<void> {
    await this.request('ModifyDesiredCapacity', {
      AutoScalingGroupId: groupId,
      DesiredCapacity: desiredCapacity,
    });
  }

  private async request<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${this.host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(body)].join('\n');
    const credentialScope = `${date}/${this.service}/tc3_request`;
    const stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope, sha256Hex(canonicalRequest)].join('\n');
    const secretDate = hmac(`TC3${this.options.secretKey}`, date);
    const secretService = hmac(secretDate, this.service);
    const secretSigning = hmac(secretService, 'tc3_request');
    const signature = hmac(secretSigning, stringToSign, 'hex');
    const authorization = `TC3-HMAC-SHA256 Credential=${this.options.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await this.fetchImpl(`https://${this.host}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: this.host,
        'X-TC-Action': action,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': this.version,
        'X-TC-Region': this.options.region,
        ...(this.options.token ? { 'X-TC-Token': this.options.token } : {}),
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

export class TencentAsScalingBackend implements ScalingBackend {
  readonly providerName = 'tencent-as' as const;

  constructor(
    private readonly groupIds: string[],
    private readonly client: TencentAsClient = createTencentAsClient()
  ) {}

  async describe(): Promise<ScalingBackendSnapshot> {
    return snapshotFromPools(await this.client.describeAutoScalingGroups(this.groupIds));
  }

  async setDesiredCapacity(targetInstances: number): Promise<ScalingBackendSnapshot> {
    const pools = await this.client.describeAutoScalingGroups(this.groupIds);
    const plan = planPoolDesiredCapacities(pools, targetInstances);
    await Promise.all(
      pools
        .filter((pool) => pool.desiredCapacity !== (plan.get(pool.id) ?? 0))
        .map((pool) => this.client.modifyDesiredCapacity(pool.id, plan.get(pool.id) ?? 0))
    );
    return this.describe();
  }
}

function createTencentAsClient(): TencentAsClient {
  if (!config.cloud.tencentSecretId || !config.cloud.tencentSecretKey) {
    throw new Error('Tencent AS dispatcher requires TENCENT_SECRET_ID and TENCENT_SECRET_KEY.');
  }
  return new TencentAsClient({
    region: config.cloud.region,
    secretId: config.cloud.tencentSecretId,
    secretKey: config.cloud.tencentSecretKey,
    token: config.cloud.tencentToken,
  });
}

function snapshotFromPools(pools: ScalingPool[]): ScalingBackendSnapshot {
  return {
    pools,
    desiredCapacity: pools.reduce((sum, pool) => sum + pool.desiredCapacity, 0),
    inService: pools.reduce((sum, pool) => sum + pool.inService, 0),
    maxCapacity: pools.reduce((sum, pool) => sum + pool.maxSize, 0),
  };
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
