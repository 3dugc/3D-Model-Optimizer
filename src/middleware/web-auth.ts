import { Request, Response, NextFunction } from 'express';
import { accountService } from '../accounts/account-service';
import { verifyWebUserToken } from '../accounts/token';
import { HttpError } from '../utils/http-error';

declare global {
  namespace Express {
    interface Request {
      webUserId?: string;
      webTenantId?: string;
    }
  }
}

function getWebToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const [type, token] = authHeader.split(' ');
    if (type === 'Bearer' && token) return token;
  }

  const webTokenHeader = req.headers['x-web-token'];
  if (typeof webTokenHeader === 'string') return webTokenHeader;
  if (Array.isArray(webTokenHeader) && webTokenHeader[0]) return webTokenHeader[0];

  const queryToken = req.query.web_token;
  return typeof queryToken === 'string' ? queryToken : undefined;
}

export async function requireWebUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const payload = verifyWebUserToken(getWebToken(req));
    if (!payload) throw new HttpError(401, 'WEB_AUTH_REQUIRED', '请先登录账号后再继续。');
    await accountService.requireUser(payload.sub);
    req.webUserId = payload.sub;
    req.webTenantId = payload.tenantId;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireWebUserId(req: Request): string {
  if (!req.webUserId) throw new HttpError(401, 'WEB_AUTH_REQUIRED', '请先登录账号后再继续。');
  return req.webUserId;
}
