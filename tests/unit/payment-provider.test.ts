import { createCipheriv, createVerify, generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { buildWechatAuthorization, decryptWechatResource } from '../../src/billing/payment-provider';

function extractHeaderValue(header: string, name: string): string {
  const match = header.match(new RegExp(`${name}="([^"]+)"`));
  if (!match) throw new Error(`Header field not found: ${name}`);
  return match[1];
}

describe('WeChat payment provider helpers', () => {
  it('builds a verifiable API v3 authorization header', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const url = new URL('https://api.mch.weixin.qq.com/v3/pay/transactions/native');
    const body = JSON.stringify({ out_trade_no: 'RCH123' });

    const header = buildWechatAuthorization({
      method: 'POST',
      url,
      body,
      mchId: '1900000001',
      serialNo: 'ABC123',
      privateKey: privatePem,
      nonceStr: 'nonce-for-test',
      timestamp: '1700000000',
    });

    const signature = extractHeaderValue(header, 'signature');
    const message = `POST\n/v3/pay/transactions/native\n1700000000\nnonce-for-test\n${body}\n`;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(message);

    expect(header).toContain('WECHATPAY2-SHA256-RSA2048');
    expect(header).toContain('mchid="1900000001"');
    expect(header).toContain('mchid="1900000001",nonce_str="nonce-for-test"');
    expect(header).toContain('timestamp="1700000000",serial_no="ABC123"');
    expect(verifier.verify(publicPem, signature, 'base64')).toBe(true);
  });

  it('decrypts an API v3 notification resource', () => {
    const apiV3Key = '12345678901234567890123456789012';
    const nonce = 'nonce12345678';
    const associatedData = 'transaction';
    const payload = JSON.stringify({
      out_trade_no: 'RCH123',
      transaction_id: '4200000000',
      trade_state: 'SUCCESS',
      amount: { total: 1000, currency: 'CNY' },
    });
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce), {
      authTagLength: 16,
    });
    cipher.setAAD(Buffer.from(associatedData));
    const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');

    const transaction = decryptWechatResource(
      {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext,
        associated_data: associatedData,
        nonce,
      },
      apiV3Key
    );

    expect(transaction).toMatchObject({
      out_trade_no: 'RCH123',
      transaction_id: '4200000000',
      trade_state: 'SUCCESS',
      amount: { total: 1000 },
    });
  });
});
