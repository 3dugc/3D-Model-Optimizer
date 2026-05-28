import { createHmac, randomInt } from 'crypto';
import type { QueueJobMessage } from './types';
import type { TencentCredentialProvider } from './tencent-credentials';

export interface TencentCmqClientOptions {
  endpoint: string;
  queueName: string;
  secretId?: string;
  secretKey?: string;
  token?: string;
  credentialProvider?: TencentCredentialProvider;
  region?: string;
  fetchImpl?: typeof fetch;
}

export interface TencentCmqReceivedMessage {
  body: QueueJobMessage;
  receiptHandle: string;
  msgId?: string;
}

interface TencentCmqResponse {
  code?: number;
  message?: string;
  requestId?: string;
  msgBody?: string;
  msgId?: string;
  receiptHandle?: string;
  activeMsgNum?: number;
  inactiveMsgNum?: number;
  delayMsgNum?: number;
  msgCount?: number;
}

export interface TencentCmqQueueAttributes {
  activeMsgNum: number;
  inactiveMsgNum: number;
  delayMsgNum: number;
  msgCount: number;
}

type TencentCmqAction = 'SendMessage' | 'ReceiveMessage' | 'DeleteMessage' | 'GetQueueAttributes';

function normalizeEndpoint(endpoint: string): URL {
  const url = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`);
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/v2/index.php';
  }
  url.search = '';
  return url;
}

function createSignatureSource(method: 'GET', url: URL, params: Record<string, string>): string {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key.replace(/_/g, '.')}=${params[key]}`)
    .join('&');
  return `${method}${url.host}${url.pathname}?${query}`;
}

function createSignature(method: 'GET', url: URL, params: Record<string, string>, secretKey: string): string {
  const source = createSignatureSource(method, url, params);
  return createHmac('sha1', secretKey).update(source).digest('base64');
}

function isEmptyQueueResponse(response: TencentCmqResponse): boolean {
  if (response.code === 7000) return true;
  return /no message|message not exist|not exist|empty|没有消息|消息不存在/i.test(response.message || '');
}

export class TencentCmqClient {
  private readonly endpointUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TencentCmqClientOptions) {
    this.endpointUrl = normalizeEndpoint(options.endpoint);
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async sendMessage(message: QueueJobMessage, delaySeconds?: number): Promise<void> {
    await this.request('SendMessage', {
      queueName: this.options.queueName,
      msgBody: JSON.stringify(message),
      ...(delaySeconds && delaySeconds > 0 ? { delaySeconds: String(delaySeconds) } : {}),
    });
  }

  async receiveMessage(): Promise<TencentCmqReceivedMessage | undefined> {
    const response = await this.request('ReceiveMessage', {
      queueName: this.options.queueName,
    });
    if (!response.msgBody || !response.receiptHandle) return undefined;
    return {
      body: JSON.parse(response.msgBody) as QueueJobMessage,
      receiptHandle: response.receiptHandle,
      msgId: response.msgId,
    };
  }

  async deleteMessage(receiptHandle: string): Promise<void> {
    await this.request('DeleteMessage', {
      queueName: this.options.queueName,
      receiptHandle,
    });
  }

  async getQueueAttributes(): Promise<TencentCmqQueueAttributes> {
    const response = await this.request('GetQueueAttributes', {
      queueName: this.options.queueName,
    });
    return {
      activeMsgNum: response.activeMsgNum ?? 0,
      inactiveMsgNum: response.inactiveMsgNum ?? 0,
      delayMsgNum: response.delayMsgNum ?? 0,
      msgCount: response.msgCount ?? 0,
    };
  }

  private async request(action: TencentCmqAction, actionParams: Record<string, string>): Promise<TencentCmqResponse> {
    const credentials = this.options.credentialProvider
      ? await this.options.credentialProvider.getCredentials()
      : {
          secretId: this.options.secretId,
          secretKey: this.options.secretKey,
          token: this.options.token,
        };
    if (!credentials.secretId || !credentials.secretKey) {
      throw new Error('Tencent CMQ requires Tencent credentials.');
    }
    const params = {
      Action: action,
      Nonce: String(randomInt(1, 2_147_483_647)),
      SecretId: credentials.secretId,
      SignatureMethod: 'HmacSHA1',
      Timestamp: String(Math.floor(Date.now() / 1000)),
      ...(this.options.region ? { Region: this.options.region } : {}),
      ...(credentials.token ? { Token: credentials.token } : {}),
      ...actionParams,
    };
    const signature = createSignature('GET', this.endpointUrl, params, credentials.secretKey);
    const url = new URL(this.endpointUrl.toString());
    for (const [key, value] of Object.entries({ ...params, Signature: signature })) {
      url.searchParams.set(key, value);
    }

    const response = await this.fetchImpl(url, { method: 'GET' });
    const payload = (await response.json()) as TencentCmqResponse;
    if (payload.code && payload.code !== 0) {
      if (action === 'ReceiveMessage' && isEmptyQueueResponse(payload)) {
        return payload;
      }
      throw new Error(`Tencent CMQ ${action} failed: ${payload.code} ${payload.message || ''}`.trim());
    }
    return payload;
  }
}

export const cmqInternals = {
  normalizeEndpoint,
  createSignatureSource,
  createSignature,
};
