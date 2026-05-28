import * as fs from 'fs';
import { constants, createDecipheriv, createSign, createVerify, randomBytes, X509Certificate } from 'crypto';
import { config } from '../config';

export interface CreateNativePaymentInput {
  amountCents: number;
  currency: 'CNY';
  description: string;
  outTradeNo: string;
  notifyUrl: string;
  expiresAt?: string;
  attach?: string;
  supportFapiao?: boolean;
}

export interface NativePaymentOrder {
  codeUrl: string;
}

export interface PaymentNotification {
  outTradeNo: string;
  transactionId?: string;
  tradeState: string;
  successTime?: string;
  amountCents?: number;
}

export interface PaymentProvider {
  createNativeOrder(input: CreateNativePaymentInput): Promise<NativePaymentOrder>;
  queryOrderByOutTradeNo(outTradeNo: string): Promise<PaymentNotification>;
  parsePaymentNotification(headers: Record<string, unknown>, rawBody: Buffer | string): Promise<PaymentNotification>;
}

interface WechatEncryptedResource {
  original_type?: string;
  algorithm: string;
  ciphertext: string;
  associated_data?: string;
  nonce: string;
}

interface WechatPaymentNotifyBody {
  event_type?: string;
  resource?: WechatEncryptedResource;
}

interface WechatTransaction {
  out_trade_no: string;
  transaction_id?: string;
  trade_state: string;
  success_time?: string;
  amount?: {
    total?: number;
    currency?: string;
    payer_total?: number;
    payer_currency?: string;
  };
}

function requireConfig(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for WeChat Pay.`);
  return value;
}

function readTextFile(filePath: string | undefined, name: string): string {
  if (!filePath) throw new Error(`${name} is required for WeChat Pay.`);
  return fs.readFileSync(filePath, 'utf8');
}

function loadMerchantPrivateKey(): string {
  if (config.billing.wechatPrivateKey) {
    return config.billing.wechatPrivateKey.replace(/\\n/g, '\n');
  }
  return readTextFile(config.billing.wechatPrivateKeyPath, 'WECHAT_PAY_PRIVATE_KEY_PATH');
}

function loadWechatPayPublicKey(): string {
  if (config.billing.wechatPlatformPublicKey) {
    return config.billing.wechatPlatformPublicKey.replace(/\\n/g, '\n');
  }
  if (config.billing.wechatPlatformPublicKeyPath) {
    return readTextFile(config.billing.wechatPlatformPublicKeyPath, 'WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH');
  }
  if (config.billing.wechatPlatformCertificate) {
    const certificate = new X509Certificate(config.billing.wechatPlatformCertificate.replace(/\\n/g, '\n'));
    return certificate.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }
  if (config.billing.wechatPlatformCertificatePath) {
    const certificate = new X509Certificate(readTextFile(config.billing.wechatPlatformCertificatePath, 'WECHAT_PAY_PLATFORM_CERT_PATH'));
    return certificate.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }
  throw new Error(
    'WECHAT_PAY_PLATFORM_PUBLIC_KEY, WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH, WECHAT_PAY_PLATFORM_CERT, or WECHAT_PAY_PLATFORM_CERT_PATH is required for WeChat Pay notification verification.'
  );
}

function nonce(): string {
  return randomBytes(16).toString('hex');
}

function timestampSeconds(): string {
  return Math.floor(Date.now() / 1000).toString();
}

function normalizeHeader(headers: Record<string, unknown>, name: string): string {
  const lowerName = name.toLowerCase();
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName)?.[1];
  if (Array.isArray(found)) return String(found[0] || '');
  return typeof found === 'string' ? found : '';
}

function canonicalUrl(url: URL): string {
  return `${url.pathname}${url.search}`;
}

export function buildWechatAuthorization(input: {
  method: string;
  url: URL;
  body: string;
  mchId: string;
  serialNo: string;
  privateKey: string;
  nonceStr?: string;
  timestamp?: string;
}): string {
  const nonceStr = input.nonceStr || nonce();
  const timestamp = input.timestamp || timestampSeconds();
  const message = `${input.method}\n${canonicalUrl(input.url)}\n${timestamp}\n${nonceStr}\n${input.body}\n`;
  const signature = createSign('RSA-SHA256').update(message).sign(input.privateKey, 'base64');
  const fields = [
    `mchid="${input.mchId}"`,
    `nonce_str="${nonceStr}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${input.serialNo}"`,
    `signature="${signature}"`,
  ];
  return `WECHATPAY2-SHA256-RSA2048 ${fields.join(',')}`;
}

function toPaymentNotification(transaction: WechatTransaction): PaymentNotification {
  return {
    outTradeNo: transaction.out_trade_no,
    transactionId: transaction.transaction_id,
    tradeState: transaction.trade_state,
    successTime: transaction.success_time,
    amountCents: transaction.amount?.total,
  };
}

export function decryptWechatResource(resource: WechatEncryptedResource, apiV3Key: string): WechatTransaction {
  if (resource.algorithm !== 'AEAD_AES_256_GCM') {
    throw new Error(`Unsupported WeChat Pay resource algorithm: ${resource.algorithm}`);
  }
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) {
    throw new Error('WECHAT_PAY_API_V3_KEY must be 32 bytes for AES-256-GCM.');
  }
  const ciphertext = Buffer.from(resource.ciphertext, 'base64');
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'), {
    authTagLength: 16,
  });
  decipher.setAuthTag(authTag);
  if (resource.associated_data) {
    decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  }
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted) as WechatTransaction;
}

export class MockPaymentProvider implements PaymentProvider {
  async createNativeOrder(input: CreateNativePaymentInput): Promise<NativePaymentOrder> {
    return { codeUrl: `weixin://wxpay/mock/recharge/${input.outTradeNo}/${input.amountCents}` };
  }

  async queryOrderByOutTradeNo(outTradeNo: string): Promise<PaymentNotification> {
    return {
      outTradeNo,
      tradeState: 'NOTPAY',
    };
  }

  async parsePaymentNotification(_headers: Record<string, unknown>, rawBody: Buffer | string): Promise<PaymentNotification> {
    const body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody) as {
      outTradeNo?: string;
      transactionId?: string;
      orderId?: string;
    };
    return {
      outTradeNo: body.outTradeNo || body.orderId || '',
      transactionId: body.transactionId,
      tradeState: 'SUCCESS',
    };
  }
}

export class WechatNativePaymentProvider implements PaymentProvider {
  async createNativeOrder(input: CreateNativePaymentInput): Promise<NativePaymentOrder> {
    const appId = requireConfig(config.billing.wechatAppId, 'WECHAT_PAY_APP_ID');
    const mchId = requireConfig(config.billing.wechatMchId, 'WECHAT_PAY_MCH_ID');
    const serialNo = requireConfig(config.billing.wechatCertSerialNo, 'WECHAT_PAY_CERT_SERIAL_NO');
    const privateKey = loadMerchantPrivateKey();
    const url = new URL('/v3/pay/transactions/native', config.billing.wechatApiBaseUrl);
    const body = JSON.stringify({
      appid: appId,
      mchid: mchId,
      description: input.description,
      out_trade_no: input.outTradeNo,
      time_expire: input.expiresAt,
      notify_url: input.notifyUrl,
      attach: input.attach,
      amount: {
        total: input.amountCents,
        currency: input.currency,
      },
      support_fapiao: input.supportFapiao ?? config.billing.wechatSupportFapiao,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: buildWechatAuthorization({
          method: 'POST',
          url,
          body,
          mchId,
          serialNo,
          privateKey,
        }),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': '3d-model-optimizer/1.0',
      },
      body,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`WeChat Pay Native order failed: ${response.status} ${responseText}`);
    }
    const parsed = JSON.parse(responseText) as { code_url?: string };
    if (!parsed.code_url) throw new Error('WeChat Pay Native order response did not include code_url.');
    return { codeUrl: parsed.code_url };
  }

  async queryOrderByOutTradeNo(outTradeNo: string): Promise<PaymentNotification> {
    const mchId = requireConfig(config.billing.wechatMchId, 'WECHAT_PAY_MCH_ID');
    const serialNo = requireConfig(config.billing.wechatCertSerialNo, 'WECHAT_PAY_CERT_SERIAL_NO');
    const privateKey = loadMerchantPrivateKey();
    const url = new URL(`/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}`, config.billing.wechatApiBaseUrl);
    url.searchParams.set('mchid', mchId);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: buildWechatAuthorization({
          method: 'GET',
          url,
          body: '',
          mchId,
          serialNo,
          privateKey,
        }),
        Accept: 'application/json',
        'User-Agent': '3d-model-optimizer/1.0',
      },
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`WeChat Pay query order failed: ${response.status} ${responseText}`);
    }
    return toPaymentNotification(JSON.parse(responseText) as WechatTransaction);
  }

  async parsePaymentNotification(headers: Record<string, unknown>, rawBody: Buffer | string): Promise<PaymentNotification> {
    const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    this.verifyNotificationSignature(headers, bodyText);
    const body = JSON.parse(bodyText) as WechatPaymentNotifyBody;
    if (!body.resource) throw new Error('WeChat Pay notification missing resource.');
    const transaction = decryptWechatResource(
      body.resource,
      requireConfig(config.billing.wechatApiV3Key, 'WECHAT_PAY_API_V3_KEY')
    );
    return toPaymentNotification(transaction);
  }

  private verifyNotificationSignature(headers: Record<string, unknown>, bodyText: string): void {
    const timestamp = normalizeHeader(headers, 'Wechatpay-Timestamp');
    const nonceStr = normalizeHeader(headers, 'Wechatpay-Nonce');
    const signature = normalizeHeader(headers, 'Wechatpay-Signature');
    if (!timestamp || !nonceStr || !signature) {
      throw new Error('WeChat Pay notification signature headers are incomplete.');
    }

    const message = `${timestamp}\n${nonceStr}\n${bodyText}\n`;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(message);
    const verified = verifier.verify(
      {
        key: loadWechatPayPublicKey(),
        padding: constants.RSA_PKCS1_PADDING,
      },
      signature,
      'base64'
    );
    if (!verified) throw new Error('Invalid WeChat Pay notification signature.');
  }
}

export function createPaymentProvider(): PaymentProvider {
  if (config.billing.mode === 'wechat_native') return new WechatNativePaymentProvider();
  return new MockPaymentProvider();
}
