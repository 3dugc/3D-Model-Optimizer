import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { config } from '../config';
import { HttpError } from '../utils/http-error';

export interface WechatOAuthRuntimeConfig {
  mode: 'offiaccount' | 'website';
  appId: string;
  appSecret: string;
  redirectUrl: string;
  scope: string;
  authorizeBaseUrl: string;
  apiBaseUrl: string;
}

export interface VerifiedWechatOAuthState {
  returnTo: string;
}

export interface WechatOAuthProfile {
  openId: string;
  unionId?: string;
  nickname?: string;
  avatarUrl?: string;
}

interface WechatOAuthStatePayload {
  returnTo: string;
  nonce: string;
  exp: number;
}

interface WechatOAuthAccessTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  openid?: string;
  scope?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

interface WechatOAuthUserInfoResponse {
  openid?: string;
  nickname?: string;
  headimgurl?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

interface SignedStateOptions {
  secret?: string;
  ttlSeconds?: number;
  nowMs?: number;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signState(value: string, secret = config.webAuth.tokenSecret): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function nowSeconds(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000);
}

export function normalizeWechatOAuthReturnTo(returnTo: string | undefined): string {
  const candidate = returnTo?.trim() || '/';
  if (candidate.length > 512) return '/';
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  if (candidate.includes('\r') || candidate.includes('\n')) return '/';
  return candidate;
}

export function createWechatOAuthState(returnTo: string | undefined, options: SignedStateOptions = {}): string {
  const payload: WechatOAuthStatePayload = {
    returnTo: normalizeWechatOAuthReturnTo(returnTo),
    nonce: randomBytes(16).toString('base64url'),
    exp: nowSeconds(options.nowMs) + (options.ttlSeconds || config.webAuth.wechatOAuthStateTtlSeconds),
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${signState(encodedPayload, options.secret)}`;
}

export function verifyWechatOAuthState(
  state: string | undefined,
  options: SignedStateOptions = {}
): VerifiedWechatOAuthState | undefined {
  if (!state) return undefined;
  const [encodedPayload, signature] = state.split('.');
  if (!encodedPayload || !signature || !safeEquals(signature, signState(encodedPayload, options.secret))) {
    return undefined;
  }
  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<WechatOAuthStatePayload>;
    if (!payload.exp || payload.exp <= nowSeconds(options.nowMs)) return undefined;
    return { returnTo: normalizeWechatOAuthReturnTo(payload.returnTo) };
  } catch {
    return undefined;
  }
}

export function getWechatOAuthRuntimeConfig(): WechatOAuthRuntimeConfig | undefined {
  if (!config.webAuth.wechatOAuthAppId || !config.webAuth.wechatOAuthAppSecret || !config.webAuth.wechatOAuthRedirectUrl) {
    return undefined;
  }
  return {
    mode: config.webAuth.wechatOAuthMode,
    appId: config.webAuth.wechatOAuthAppId,
    appSecret: config.webAuth.wechatOAuthAppSecret,
    redirectUrl: config.webAuth.wechatOAuthRedirectUrl,
    scope: config.webAuth.wechatOAuthScope,
    authorizeBaseUrl: config.webAuth.wechatOAuthAuthorizeBaseUrl,
    apiBaseUrl: config.webAuth.wechatOAuthApiBaseUrl,
  };
}

export function isWechatOAuthConfigured(): boolean {
  return Boolean(getWechatOAuthRuntimeConfig());
}

export function buildWechatOAuthAuthorizeUrl(runtimeConfig: WechatOAuthRuntimeConfig, state: string): string {
  const authorizeUrl = new URL(runtimeConfig.authorizeBaseUrl);
  authorizeUrl.searchParams.set('appid', runtimeConfig.appId);
  authorizeUrl.searchParams.set('redirect_uri', runtimeConfig.redirectUrl);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', runtimeConfig.scope);
  authorizeUrl.searchParams.set('state', state);
  return `${authorizeUrl.toString()}#wechat_redirect`;
}

function shouldFetchUserInfo(runtimeConfig: WechatOAuthRuntimeConfig, grantedScope?: string): boolean {
  const scopes = `${runtimeConfig.scope},${grantedScope || ''}`;
  return scopes.includes('snsapi_userinfo') || scopes.includes('snsapi_login');
}

async function fetchWechatJson<T extends { errcode?: number; errmsg?: string }>(url: URL): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T;
  if (!response.ok || (body.errcode && body.errcode !== 0)) {
    throw new HttpError(502, 'WECHAT_OAUTH_REQUEST_FAILED', body.errmsg || 'WeChat OAuth request failed.', {
      status: response.status,
      errcode: body.errcode,
    });
  }
  return body;
}

function buildWechatApiUrl(path: string, apiBaseUrl: string, params: Record<string, string>): URL {
  const url = new URL(path, apiBaseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

export async function exchangeWechatOAuthCode(
  code: string,
  runtimeConfig = getWechatOAuthRuntimeConfig()
): Promise<WechatOAuthProfile> {
  if (!runtimeConfig) {
    throw new HttpError(503, 'WECHAT_OAUTH_NOT_CONFIGURED', 'WeChat OAuth is not configured.');
  }

  const tokenResponse = await fetchWechatJson<WechatOAuthAccessTokenResponse>(
    buildWechatApiUrl('/sns/oauth2/access_token', runtimeConfig.apiBaseUrl, {
      appid: runtimeConfig.appId,
      secret: runtimeConfig.appSecret,
      code,
      grant_type: 'authorization_code',
    })
  );
  if (!tokenResponse.openid) {
    throw new HttpError(502, 'WECHAT_OAUTH_OPENID_MISSING', 'WeChat OAuth response did not include openid.');
  }

  if (tokenResponse.access_token && shouldFetchUserInfo(runtimeConfig, tokenResponse.scope)) {
    const userInfo = await fetchWechatJson<WechatOAuthUserInfoResponse>(
      buildWechatApiUrl('/sns/userinfo', runtimeConfig.apiBaseUrl, {
        access_token: tokenResponse.access_token,
        openid: tokenResponse.openid,
        lang: 'zh_CN',
      })
    );
    return {
      openId: userInfo.openid || tokenResponse.openid,
      unionId: userInfo.unionid || tokenResponse.unionid,
      nickname: userInfo.nickname,
      avatarUrl: userInfo.headimgurl,
    };
  }

  return {
    openId: tokenResponse.openid,
    unionId: tokenResponse.unionid,
  };
}
