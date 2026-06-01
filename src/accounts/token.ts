import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

interface WebUserTokenPayload {
  sub: string;
  tenantId: string;
  exp: number;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(value: string): string {
  return createHmac('sha256', config.webAuth.tokenSecret).update(value).digest('base64url');
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function createWebUserToken(userId: string, tenantId: string): string {
  const payload: WebUserTokenPayload = {
    sub: userId,
    tenantId,
    exp: Math.floor(Date.now() / 1000) + config.webAuth.tokenTtlSeconds,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `web_${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyWebUserToken(token: string | undefined): WebUserTokenPayload | undefined {
  if (!token?.startsWith('web_')) return undefined;
  const [encodedPayload, signature] = token.slice(4).split('.');
  if (!encodedPayload || !signature || !safeEquals(signature, sign(encodedPayload))) return undefined;
  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<WebUserTokenPayload>;
    if (!payload.sub || !payload.tenantId || !payload.exp) return undefined;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return undefined;
    return { sub: payload.sub, tenantId: payload.tenantId, exp: payload.exp };
  } catch {
    return undefined;
  }
}

