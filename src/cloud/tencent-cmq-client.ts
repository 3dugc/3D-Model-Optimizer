import { createHmac, randomInt } from 'crypto';
import type { QueueJobMessage } from './types';

export interface TencentCmqClientOptions {
  endpoint: string;
  queueName: string;
  secretId: string;
  secretKey: string;
  token?: string;
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
}

type TencentCmqAction = 'SendMessage' | 'ReceiveMessage' | 'DeleteMessage';

function encodeParam(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function normalizeEndpoint(endpoint: string): URL {
  const url = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`);
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/v2/index.php';
  }
  url.search = '';
  return url;
}

function createSignature(method: 'GET', url: URL, params: Record<string, string>, secretKey: string): string {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeParam(params[key])}`)
    .join('&');
  const source = `${method}${url.host}${url.pathname}?${query}`;
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

  private async request(action: TencentCmqAction, actionParams: Record<string, string>): Promise<TencentCmqResponse> {
    const params = {
      Action: action,
      Nonce: String(randomInt(1, 2_147_483_647)),
      SecretId: this.options.secretId,
      SignatureMethod: 'HmacSHA1',
      Timestamp: String(Math.floor(Date.now() / 1000)),
      ...(this.options.region ? { Region: this.options.region } : {}),
      ...(this.options.token ? { Token: this.options.token } : {}),
      ...actionParams,
    };
    const signature = createSignature('GET', this.endpointUrl, params, this.options.secretKey);
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
  encodeParam,
  normalizeEndpoint,
  createSignature,
};
