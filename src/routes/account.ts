import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { accountService } from '../accounts/account-service';
import { verifyWebUserToken } from '../accounts/token';
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

router.get('/auth/providers', (_req: Request, res: Response) => {
  res.json({
    wechat: {
      mockLoginEnabled: config.webAuth.mockLoginEnabled,
      productionLoginConfigured: false,
      requiredBeforeProduction: [
        '微信开放平台网站应用 AppID / AppSecret',
        '公众号网页授权 AppID / AppSecret（微信内浏览器）',
        'OAuth 回调域名：3dugc.com',
      ],
    },
    rechargePackagesCents: config.billing.rechargePackagesCents,
    jobPriceCents: config.billing.defaultJobPriceCents,
  });
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
    res.status(201).json({ order });
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
    if (config.billing.mode !== 'mock') {
      res.status(501).json({
        success: false,
        error: {
          code: 'WECHAT_NOTIFY_NOT_CONFIGURED',
          message: 'Wechat Pay notification verification needs merchant credentials and API v3 key.',
        },
      });
      return;
    }
    const body = req.body as MockPaidBody;
    const result = body.outTradeNo
      ? await accountService.markRechargePaidByOutTradeNo(body.outTradeNo, body.transactionId)
      : await accountService.markRechargePaid(body.orderId || '', body.transactionId);
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

