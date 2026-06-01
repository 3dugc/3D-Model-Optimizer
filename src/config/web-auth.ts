import { parseBoolean, parsePositiveNumber, stripTrailingSlash } from './parsers';
import type { WebAuthConfig } from './types';

export function parseWebAuthConfig(): WebAuthConfig {
  return {
    tokenSecret: process.env.WEB_AUTH_SECRET || process.env.API_KEY || 'dev-web-auth-secret',
    tokenTtlSeconds: parsePositiveNumber(process.env.WEB_AUTH_TOKEN_TTL_SECONDS, 30 * 24 * 60 * 60),
    authServiceEnabled: parseBoolean(process.env.AUTH_SERVICE_ENABLED, true),
    authServiceBaseUrl: stripTrailingSlash(process.env.AUTH_SERVICE_BASE_URL || 'https://auth.bujiaban.com'),
    authServiceLoginPath: process.env.AUTH_SERVICE_LOGIN_PATH || '/login/3dugc',
    authServiceClientId: process.env.AUTH_SERVICE_CLIENT_ID || '3dugc-web',
    authServiceRedirectUri: process.env.AUTH_SERVICE_REDIRECT_URI || 'https://3dugc.com/auth/callback',
    wechatOAuthMode: process.env.WECHAT_LOGIN_MODE === 'website' ? 'website' : 'offiaccount',
    wechatOAuthAppId: process.env.WECHAT_OAUTH_APP_ID || process.env.WECHAT_PAY_APP_ID,
    wechatOAuthAppSecret: process.env.WECHAT_OAUTH_APP_SECRET,
    wechatOAuthRedirectUrl: process.env.WECHAT_OAUTH_REDIRECT_URL,
    wechatOAuthScope:
      process.env.WECHAT_OAUTH_SCOPE ||
      (process.env.WECHAT_LOGIN_MODE === 'website' ? 'snsapi_login' : 'snsapi_userinfo'),
    wechatOAuthAuthorizeBaseUrl:
      process.env.WECHAT_OAUTH_AUTHORIZE_BASE_URL ||
      (process.env.WECHAT_LOGIN_MODE === 'website'
        ? 'https://open.weixin.qq.com/connect/qrconnect'
        : 'https://open.weixin.qq.com/connect/oauth2/authorize'),
    wechatOAuthApiBaseUrl: process.env.WECHAT_OAUTH_API_BASE_URL || 'https://api.weixin.qq.com',
    wechatOAuthStateTtlSeconds: parsePositiveNumber(process.env.WECHAT_OAUTH_STATE_TTL_SECONDS, 10 * 60),
  };
}
