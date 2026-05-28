import { Router, Request, Response, NextFunction } from 'express';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { accountService } from '../accounts/account-service';
import { verifyWebUserToken } from '../accounts/token';
import {
  buildWechatOAuthAuthorizeUrl,
  createWechatOAuthState,
  exchangeWechatOAuthCode,
  getWechatOAuthRuntimeConfig,
  isWechatOAuthConfigured,
  normalizeWechatOAuthReturnTo,
  verifyWechatOAuthState,
} from '../accounts/wechat-oauth';
import type { CreatePaidWebJobInput } from '../accounts/types';
import { HttpError } from '../utils/http-error';

const router = Router();

interface MockLoginBody {
  openId?: string;
  unionId?: string;
  nickname?: string;
  avatarUrl?: string;
}

interface CreateRechargeOrderBody {
  amountCents?: number;
  description?: string;
}

interface MockPaidBody {
  orderId?: string;
  outTradeNo?: string;
  transactionId?: string;
}

interface SyncRechargeOrderBody {
  outTradeNo?: string;
}

declare global {
  namespace Express {
    interface Request {
      webUserId?: string;
      webTenantId?: string;
    }
  }
}

function getBearerToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (!authHeader) return undefined;
  const [type, token] = authHeader.split(' ');
  return type === 'Bearer' ? token : undefined;
}

async function requireWebUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const payload = verifyWebUserToken(getBearerToken(req));
    if (!payload) throw new HttpError(401, 'WEB_AUTH_REQUIRED', 'Web user token required.');
    await accountService.requireUser(payload.sub);
    req.webUserId = payload.sub;
    req.webTenantId = payload.tenantId;
    next();
  } catch (error) {
    next(error);
  }
}

function requireWebUserId(req: Request): string {
  if (!req.webUserId) throw new HttpError(401, 'WEB_AUTH_REQUIRED', 'Web user token required.');
  return req.webUserId;
}

function buildRelativeRedirectUrl(returnTo: string, params: Record<string, string>): string {
  const url = new URL(normalizeWechatOAuthReturnTo(returnTo), 'https://3dugc.com');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

router.get('/auth/providers', (_req: Request, res: Response) => {
  const wechatPaymentConfigured = Boolean(
    config.billing.wechatAppId &&
      config.billing.wechatMchId &&
      (config.billing.wechatPrivateKey || config.billing.wechatPrivateKeyPath) &&
      config.billing.wechatCertSerialNo &&
      config.billing.wechatApiV3Key &&
      (config.billing.wechatPlatformPublicKey ||
        config.billing.wechatPlatformPublicKeyPath ||
        config.billing.wechatPlatformCertificate ||
        config.billing.wechatPlatformCertificatePath)
  );
  res.json({
    wechat: {
      mockLoginEnabled: config.webAuth.mockLoginEnabled,
      oauthConfigured: isWechatOAuthConfigured(),
      oauthMode: config.webAuth.wechatOAuthMode,
      oauthAppIdConfigured: Boolean(config.webAuth.wechatOAuthAppId),
      oauthAppSecretConfigured: Boolean(config.webAuth.wechatOAuthAppSecret),
      oauthRedirectUrlConfigured: Boolean(config.webAuth.wechatOAuthRedirectUrl),
      productionLoginConfigured: isWechatOAuthConfigured(),
      nativePaymentConfigured: config.billing.mode === 'wechat_native',
      wechatPaymentConfigured,
      unionIdSupported: true,
      requiredBeforeProduction: [
        '公众号网页授权 AppID / AppSecret（微信内浏览器）或微信开放平台网站应用 AppID / AppSecret（桌面扫码）',
        'OAuth 回调域名：3dugc.com',
        'OAuth 回调地址：https://3dugc.com/api/v1/account/auth/wechat/callback',
      ],
    },
    rechargePackagesCents: config.billing.rechargePackagesCents,
    jobPriceCents: config.billing.defaultJobPriceCents,
  });
});

router.get('/auth/wechat/authorize', (req: Request, res: Response, next: NextFunction) => {
  try {
    const runtimeConfig = getWechatOAuthRuntimeConfig();
    if (!runtimeConfig) {
      throw new HttpError(503, 'WECHAT_OAUTH_NOT_CONFIGURED', 'WeChat OAuth is not configured.');
    }
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/';
    const state = createWechatOAuthState(returnTo);
    res.redirect(302, buildWechatOAuthAuthorizeUrl(runtimeConfig, state));
  } catch (error) {
    next(error);
  }
});

router.get('/auth/wechat/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const state = verifyWechatOAuthState(typeof req.query.state === 'string' ? req.query.state : undefined);
    if (!state) {
      throw new HttpError(400, 'WECHAT_OAUTH_STATE_INVALID', 'WeChat OAuth state is invalid or expired.');
    }

    const errorCode = typeof req.query.errcode === 'string' ? req.query.errcode : undefined;
    if (errorCode) {
      res.redirect(
        302,
        buildRelativeRedirectUrl(state.returnTo, {
          login: 'failed',
          login_error: errorCode,
        })
      );
      return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    if (!code) {
      throw new HttpError(400, 'WECHAT_OAUTH_CODE_REQUIRED', 'WeChat OAuth code is required.');
    }

    const profile = await exchangeWechatOAuthCode(code);
    const login = await accountService.loginWithWechat({
      openId: profile.openId,
      unionId: profile.unionId,
      nickname: profile.nickname || '微信用户',
      avatarUrl: profile.avatarUrl,
    });
    res.redirect(
      302,
      buildRelativeRedirectUrl(state.returnTo, {
        web_token: login.token,
        login: 'success',
      })
    );
  } catch (error) {
    next(error);
  }
});

router.post('/auth/wechat/mock-login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!config.webAuth.mockLoginEnabled) {
      throw new HttpError(403, 'MOCK_WECHAT_LOGIN_DISABLED', 'Mock WeChat login is disabled.');
    }
    const body = req.body as MockLoginBody;
    const login = await accountService.loginWithWechat({
      openId: body.openId || `mock-openid-${uuidv4()}`,
      unionId: body.unionId,
      nickname: body.nickname || '微信用户',
      avatarUrl: body.avatarUrl,
    });
    res.status(201).json(login);
  } catch (error) {
    next(error);
  }
});

router.get('/me', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await accountService.requireUser(requireWebUserId(req));
    const wallet = await accountService.getWallet(user.id);
    res.json({ user, wallet });
  } catch (error) {
    next(error);
  }
});

router.get('/wallet', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const wallet = await accountService.getWallet(requireWebUserId(req));
    res.json({ wallet });
  } catch (error) {
    next(error);
  }
});

router.get('/wallet/ledger', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const ledger = await accountService.listLedger(requireWebUserId(req), limit);
    res.json({ ledger });
  } catch (error) {
    next(error);
  }
});

router.post('/wallet/recharge-orders', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as CreateRechargeOrderBody;
    if (!body.amountCents) throw new HttpError(400, 'AMOUNT_REQUIRED', 'amountCents is required.');
    const order = await accountService.createRechargeOrder({
      userId: requireWebUserId(req),
      amountCents: body.amountCents,
      description: body.description || '3D model optimizer recharge',
      notifyUrl: config.billing.wechatNotifyUrl || `${req.protocol}://${req.get('host')}/api/v1/account/wallet/wechat/notify`,
    });
    const qrCodeSvg = order.codeUrl
      ? await QRCode.toString(order.codeUrl, { type: 'svg', width: 180, margin: 1, errorCorrectionLevel: 'M' })
      : undefined;
    res.status(201).json({ order, qrCodeSvg });
  } catch (error) {
    next(error);
  }
});

router.post('/wallet/recharge-orders/sync-by-out-trade-no', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as SyncRechargeOrderBody;
    if (!body.outTradeNo) throw new HttpError(400, 'OUT_TRADE_NO_REQUIRED', 'outTradeNo is required.');
    const result = await accountService.syncRechargeOrderByOutTradeNo(requireWebUserId(req), body.outTradeNo.trim());
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/wallet/recharge-orders/:orderId/sync', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await accountService.syncRechargeOrder(requireWebUserId(req), req.params.orderId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/wallet/recharge-orders/:orderId', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const order = await accountService.getRechargeOrder(requireWebUserId(req), req.params.orderId);
    res.json({ order });
  } catch (error) {
    next(error);
  }
});

router.post('/wallet/recharge-orders/:orderId/mock-paid', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (config.billing.mode !== 'mock') {
      throw new HttpError(403, 'MOCK_PAYMENT_DISABLED', 'Mock payment is disabled.');
    }
    const body = req.body as MockPaidBody;
    const result = await accountService.markRechargePaid(req.params.orderId, body.transactionId);
    if (result.order.userId !== requireWebUserId(req)) {
      throw new HttpError(404, 'RECHARGE_ORDER_NOT_FOUND', 'Recharge order not found.');
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/wallet/wechat/notify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result =
      config.billing.mode === 'mock'
        ? await (async () => {
            const body = req.body as MockPaidBody;
            return body.outTradeNo
              ? accountService.markRechargePaidByOutTradeNo(body.outTradeNo, body.transactionId)
              : accountService.markRechargePaid(body.orderId || '', body.transactionId);
          })()
        : await accountService.handlePaymentNotification(req.headers, req.rawBody || Buffer.from(JSON.stringify(req.body)));
    res.json({ code: 'SUCCESS', message: '成功', ...result });
  } catch (error) {
    next(error);
  }
});

router.post('/wallet/jobs', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Omit<CreatePaidWebJobInput, 'userId'>;
    const result = await accountService.createPaidWebJob({
      ...body,
      userId: requireWebUserId(req),
    });
    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
