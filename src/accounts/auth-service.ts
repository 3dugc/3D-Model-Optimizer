import { config } from '../config';
import { HttpError } from '../utils/http-error';

export interface AuthServiceRuntimeConfig {
  baseUrl: string;
  loginUrl: string;
  widgetConfigUrl: string;
  clientId: string;
  redirectUri: string;
}

export interface AuthServiceProfile {
  authUserId: string;
  unionId?: string;
  nickname?: string;
  avatarUrl?: string;
}

interface AuthServiceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface AuthServiceUserInfoResponse {
  sub?: string;
  unionid?: string;
  name?: string;
  picture?: string;
  error?: string;
  error_description?: string;
}

export interface AuthServiceWechatWidgetConfig {
  provider: 'wechat_website';
  mode: 'widget' | 'mock';
  appId?: string;
  redirectUri?: string;
  scope?: 'snsapi_login';
  state?: string;
  selfRedirect?: boolean;
  callbackUrl?: string;
  error?: string;
  error_description?: string;
}

function buildAuthServiceUrl(path: string, runtimeConfig: AuthServiceRuntimeConfig): string {
  return new URL(path, runtimeConfig.baseUrl).toString();
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    throw new HttpError(502, 'AUTH_SERVICE_INVALID_RESPONSE', 'Auth service returned an invalid JSON response.', {
      status: response.status,
    });
  }
}

export function getAuthServiceRuntimeConfig(): AuthServiceRuntimeConfig | undefined {
  if (!config.webAuth.authServiceEnabled) return undefined;
  if (!config.webAuth.authServiceBaseUrl || !config.webAuth.authServiceClientId || !config.webAuth.authServiceRedirectUri) {
    return undefined;
  }
  return {
    baseUrl: config.webAuth.authServiceBaseUrl,
    loginUrl: buildAuthServiceUrl(config.webAuth.authServiceLoginPath, {
      baseUrl: config.webAuth.authServiceBaseUrl,
      loginUrl: '',
      widgetConfigUrl: '',
      clientId: config.webAuth.authServiceClientId,
      redirectUri: config.webAuth.authServiceRedirectUri,
    }),
    widgetConfigUrl: buildAuthServiceUrl(`${config.webAuth.authServiceLoginPath.replace(/\/$/, '')}/widget-config`, {
      baseUrl: config.webAuth.authServiceBaseUrl,
      loginUrl: '',
      widgetConfigUrl: '',
      clientId: config.webAuth.authServiceClientId,
      redirectUri: config.webAuth.authServiceRedirectUri,
    }),
    clientId: config.webAuth.authServiceClientId,
    redirectUri: config.webAuth.authServiceRedirectUri,
  };
}

export function isAuthServiceConfigured(): boolean {
  return Boolean(getAuthServiceRuntimeConfig());
}

export async function exchangeAuthServiceAuthorizationCode(
  code: string,
  codeVerifier: string,
  runtimeConfig = getAuthServiceRuntimeConfig()
): Promise<AuthServiceProfile> {
  if (!runtimeConfig) {
    throw new HttpError(503, 'AUTH_SERVICE_NOT_CONFIGURED', 'Unified auth service is not configured.');
  }

  const tokenResponse = await fetch(buildAuthServiceUrl('/oauth/token', runtimeConfig), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: runtimeConfig.clientId,
      redirect_uri: runtimeConfig.redirectUri,
      code,
      code_verifier: codeVerifier,
    }),
  });
  const tokenBody = await readJson<AuthServiceTokenResponse>(tokenResponse);
  if (!tokenResponse.ok || tokenBody.error) {
    throw new HttpError(
      502,
      'AUTH_SERVICE_TOKEN_EXCHANGE_FAILED',
      tokenBody.error_description || tokenBody.error || 'Auth service token exchange failed.',
      { status: tokenResponse.status }
    );
  }
  if (!tokenBody.access_token) {
    throw new HttpError(502, 'AUTH_SERVICE_ACCESS_TOKEN_MISSING', 'Auth service did not return an access token.');
  }

  const userInfoResponse = await fetch(buildAuthServiceUrl('/userinfo', runtimeConfig), {
    headers: { authorization: `Bearer ${tokenBody.access_token}` },
  });
  const userInfo = await readJson<AuthServiceUserInfoResponse>(userInfoResponse);
  if (!userInfoResponse.ok || userInfo.error) {
    throw new HttpError(
      502,
      'AUTH_SERVICE_USERINFO_FAILED',
      userInfo.error_description || userInfo.error || 'Auth service userinfo request failed.',
      { status: userInfoResponse.status }
    );
  }
  if (!userInfo.sub) {
    throw new HttpError(502, 'AUTH_SERVICE_SUB_MISSING', 'Auth service userinfo response did not include sub.');
  }

  if (tokenBody.refresh_token) {
    await revokeAuthServiceRefreshToken(tokenBody.refresh_token, runtimeConfig).catch(() => undefined);
  }

  return {
    authUserId: userInfo.sub,
    unionId: userInfo.unionid,
    nickname: userInfo.name,
    avatarUrl: userInfo.picture,
  };
}

export async function fetchAuthServiceWechatWidgetConfig(
  input: { state: string; codeChallenge: string; returnTo?: string },
  runtimeConfig = getAuthServiceRuntimeConfig()
): Promise<AuthServiceWechatWidgetConfig> {
  if (!runtimeConfig) {
    throw new HttpError(503, 'AUTH_SERVICE_NOT_CONFIGURED', 'Unified auth service is not configured.');
  }

  const url = new URL(runtimeConfig.widgetConfigUrl);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.returnTo && isSameOrigin(input.returnTo, runtimeConfig.redirectUri)) {
    url.searchParams.set('return_to', input.returnTo);
  }

  const response = await fetch(url);
  const body = await readJson<AuthServiceWechatWidgetConfig>(response);
  if (!response.ok || body.error) {
    throw new HttpError(
      502,
      'AUTH_SERVICE_WIDGET_CONFIG_FAILED',
      body.error_description || body.error || 'Auth service widget config request failed.',
      { status: response.status }
    );
  }
  return body;
}

async function revokeAuthServiceRefreshToken(token: string, runtimeConfig: AuthServiceRuntimeConfig): Promise<void> {
  await fetch(buildAuthServiceUrl('/logout', runtimeConfig), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: token }),
  });
}

function isSameOrigin(value: string, originSource: string): boolean {
  try {
    return new URL(value).origin === new URL(originSource).origin;
  } catch {
    return false;
  }
}
