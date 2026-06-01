import { describe, expect, it } from 'vitest';
import {
  buildWechatOAuthAuthorizeUrl,
  createWechatOAuthState,
  normalizeWechatOAuthReturnTo,
  verifyWechatOAuthState,
  type WechatOAuthRuntimeConfig,
} from '../../src/accounts/wechat-oauth';

const runtimeConfig: WechatOAuthRuntimeConfig = {
  mode: 'offiaccount',
  appId: 'wx-test-app',
  appSecret: 'secret',
  redirectUrl: 'https://3dugc.com/api/v1/account/auth/wechat/callback',
  scope: 'snsapi_userinfo',
  authorizeBaseUrl: 'https://open.weixin.qq.com/connect/oauth2/authorize',
  apiBaseUrl: 'https://api.weixin.qq.com',
};

describe('WeChat OAuth helpers', () => {
  it('signs and verifies OAuth state with a safe relative return URL', () => {
    const state = createWechatOAuthState('/?from=account', {
      secret: 'state-secret',
      ttlSeconds: 60,
      nowMs: 1_700_000_000_000,
    });

    expect(
      verifyWechatOAuthState(state, {
        secret: 'state-secret',
        nowMs: 1_700_000_010_000,
      })
    ).toEqual({ returnTo: '/?from=account' });
  });

  it('rejects tampered, expired, and external return URLs', () => {
    const state = createWechatOAuthState('https://evil.example/phish', {
      secret: 'state-secret',
      ttlSeconds: 60,
      nowMs: 1_700_000_000_000,
    });
    const tamperedState = `${state.slice(0, -2)}xx`;

    expect(verifyWechatOAuthState(tamperedState, { secret: 'state-secret' })).toBeUndefined();
    expect(
      verifyWechatOAuthState(state, {
        secret: 'state-secret',
        nowMs: 1_700_000_061_000,
      })
    ).toBeUndefined();
    expect(
      verifyWechatOAuthState(state, {
        secret: 'state-secret',
        nowMs: 1_700_000_010_000,
      })
    ).toEqual({ returnTo: '/' });
  });

  it('builds the official account OAuth authorize URL', () => {
    const url = buildWechatOAuthAuthorizeUrl(runtimeConfig, 'signed-state');

    expect(url).toContain('https://open.weixin.qq.com/connect/oauth2/authorize?');
    expect(url).toContain('appid=wx-test-app');
    expect(url).toContain('redirect_uri=https%3A%2F%2F3dugc.com%2Fapi%2Fv1%2Faccount%2Fauth%2Fwechat%2Fcallback');
    expect(url).toContain('response_type=code');
    expect(url).toContain('scope=snsapi_userinfo');
    expect(url).toContain('state=signed-state');
    expect(url).toContain('#wechat_redirect');
  });

  it('normalizes unsafe return URLs to the site root', () => {
    expect(normalizeWechatOAuthReturnTo('/dashboard?tab=wallet')).toBe('/dashboard?tab=wallet');
    expect(normalizeWechatOAuthReturnTo('//evil.example')).toBe('/');
    expect(normalizeWechatOAuthReturnTo('https://evil.example')).toBe('/');
    expect(normalizeWechatOAuthReturnTo('/bad\nheader')).toBe('/');
  });
});
