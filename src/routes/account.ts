import { Router, Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { accountService } from '../accounts/account-service';
import {
  exchangeAuthServiceAuthorizationCode,
  fetchAuthServiceWechatWidgetConfig,
  getAuthServiceRuntimeConfig,
  isAuthServiceConfigured,
  pollAuthServiceWechatScan,
} from '../accounts/auth-service';
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
import { createObjectStorageProvider } from '../cloud/object-storage';
import type { CosObjectRef } from '../cloud/types';
import type { CloudJob } from '../jobs/types';
import type { OptimizationOptions, PresetName } from '../models/options';
import { OPTIMIZATION_PRESETS } from '../models/options';
import { requireWebUser, requireWebUserId } from '../middleware';
import { HttpError } from '../utils/http-error';
import { createModelUpload, cleanupUploadedFile } from '../utils/model-upload';
import { decodeUploadFilename } from '../utils/model-input';
import { validateOptions } from '../utils/options-validator';
import {
  canonicalizeOptimizationOptions,
  describeOptimizationOptions,
  hashFile,
  hashOptimizationOptions,
  summarizeOptimizationOptions,
} from '../utils/optimization-metadata';
import { invoiceService } from '../invoices';

const router = Router();
const optimizeUpload = createModelUpload({ allowZip: true });
const objectStorage = createObjectStorageProvider();

interface AuthServiceCallbackBody {
  code?: string;
  codeVerifier?: string;
}

interface AuthServiceWidgetConfigBody {
  state?: string;
  codeChallenge?: string;
  returnTo?: string;
}

interface AuthServiceScanStatusBody {
  token?: string;
  state?: string;
}

interface CreateRechargeOrderBody {
  amountCents?: number;
  description?: string;
}

interface SyncRechargeOrderBody {
  outTradeNo?: string;
}

interface WebOptimizeJobBody {
  preset?: string;
  options?: string | OptimizationOptions;
}

interface CreateRechargeInvoiceBody {
  buyer?: {
    type?: 'INDIVIDUAL' | 'ORGANIZATION';
    name?: string;
    taxpayerId?: string;
    address?: string;
    telephone?: string;
    bankName?: string;
    bankAccount?: string;
    phoneMasked?: string;
    emailMasked?: string;
  };
}

interface ModelOptimizeReport {
  success?: boolean;
  metrics?: {
    processingTimeMs?: number;
    originalSize?: number;
    optimizedSize?: number;
    compressionRatio?: number;
  };
  conversion?: {
    converted: boolean;
    originalFormat: string;
    conversionTime?: number;
  };
  errorMessage?: string;
}

function buildRelativeRedirectUrl(returnTo: string, params: Record<string, string>): string {
  const url = new URL(normalizeWechatOAuthReturnTo(returnTo), 'https://3dugc.com');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function parseWebOptimizeOptions(body: WebOptimizeJobBody): OptimizationOptions {
  if (!body.options) return {};
  let raw: unknown;
  try {
    raw = typeof body.options === 'string' ? JSON.parse(body.options) : body.options;
  } catch {
    throw new HttpError(400, 'INVALID_OPTIONS', 'Invalid options JSON format.');
  }
  const { sanitized } = validateOptions(raw as OptimizationOptions);
  return sanitized;
}

function parsePresetName(value: string | undefined): PresetName | undefined {
  if (!value) return undefined;
  if (!OPTIMIZATION_PRESETS[value as PresetName]) {
    throw new HttpError(400, 'INVALID_OPTIONS', `Unknown preset: ${value}`);
  }
  return value as PresetName;
}

function buildEffectiveOptimizeOptions(preset: PresetName | undefined, options: OptimizationOptions): OptimizationOptions {
  if (!preset) return options;
  const { sanitized } = validateOptions({ ...OPTIMIZATION_PRESETS[preset], ...options });
  return sanitized;
}

function normalizePresetName(value: string | undefined): PresetName | undefined {
  return value && OPTIMIZATION_PRESETS[value as PresetName] ? value as PresetName : undefined;
}

function jobOutputObject(job: CloudJob): CosObjectRef {
  if (!job.outputBucket || !job.outputRegion || !job.outputKey) {
    throw new HttpError(409, 'RESULT_NOT_READY', 'Result is not ready.');
  }
  return {
    bucket: job.outputBucket,
    region: job.outputRegion,
    key: job.outputKey,
  };
}

function jobReportObject(job: CloudJob): CosObjectRef {
  if (!job.outputBucket || !job.outputRegion || !job.reportKey) {
    throw new HttpError(409, 'RESULT_NOT_READY', 'Result report is not ready.');
  }
  return {
    bucket: job.outputBucket,
    region: job.outputRegion,
    key: job.reportKey,
  };
}

function jobRetentionMs(job: CloudJob, now = Date.now()): { optimizedAt: string; expiresAt: string; remainingMs: number } {
  const optimizedAt = job.completedAt || job.startedAt || job.createdAt;
  const optimizedAtMs = Date.parse(optimizedAt) || Date.parse(job.createdAt) || now;
  const expiresAtMs = optimizedAtMs + config.fileRetentionMs;
  return {
    optimizedAt: new Date(optimizedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    remainingMs: Math.max(0, expiresAtMs - now),
  };
}

function jobPayloadFilename(job: CloudJob): string | undefined {
  const payload = job.task.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const filename = (payload as { filename?: unknown }).filename;
  return typeof filename === 'string' ? filename : undefined;
}

function normalizedFileExtension(filename: string | undefined): string {
  return filename ? path.extname(filename).toLowerCase() : '';
}

function jobOriginalExtension(job: CloudJob): string {
  return normalizedFileExtension(job.originalFilename || jobPayloadFilename(job));
}

async function cloudOutputExists(job: CloudJob): Promise<boolean> {
  try {
    return await objectStorage.objectExists(jobOutputObject(job));
  } catch {
    return false;
  }
}

function jobOptionsHash(job: CloudJob): string {
  return hashOptimizationOptions(buildEffectiveOptimizeOptions(normalizePresetName(job.preset), job.options || {}));
}

async function matchesWebOptimizeJob(job: CloudJob, input: {
  inputHash: string;
  inputExtension: string;
  optionsHash: string;
}): Promise<boolean> {
  const optionsHash = job.optionsHash || jobOptionsHash(job);
  if (optionsHash !== input.optionsHash) return false;
  if (jobOriginalExtension(job) !== input.inputExtension) return false;
  return job.inputHashKind === 'raw-upload' && job.inputHash === input.inputHash;
}

interface ExistingOptimizeJob {
  job: CloudJob;
  reused: boolean;
}

async function findExistingWebOptimizeJob(input: {
  userId: string;
  inputHash: string;
  inputExtension: string;
  optionsHash: string;
}): Promise<ExistingOptimizeJob | undefined> {
  const jobs = await accountService.listPaidWebJobs(input.userId);
  const candidates: ExistingOptimizeJob[] = [];
  const now = Date.now();

  for (const job of jobs) {
    if (job.taskType !== config.cloud.defaultTaskType) continue;

    const charge = await accountService.getJobCharge(job.id);
    if (!charge || charge.userId !== input.userId) continue;

    if (job.status === 'succeeded') {
      if (charge.status !== 'charged') continue;
      if (jobRetentionMs(job, now).remainingMs <= 0) continue;
      if (!(await cloudOutputExists(job))) continue;
      if (!(await matchesWebOptimizeJob(job, input))) continue;
      candidates.push({ job, reused: true });
      continue;
    }

    if (['queued', 'processing', 'retry_wait'].includes(job.status) && charge.status === 'held') {
      if (!(await matchesWebOptimizeJob(job, input))) continue;
      candidates.push({ job, reused: false });
    }
  }

  return candidates.sort((left, right) => {
    if (left.reused !== right.reused) return left.reused ? -1 : 1;
    return (Date.parse(right.job.completedAt || right.job.createdAt) || 0)
      - (Date.parse(left.job.completedAt || left.job.createdAt) || 0);
  })[0];
}

async function readModelOptimizeReport(job: CloudJob): Promise<ModelOptimizeReport | undefined> {
  if (job.status !== 'succeeded') return undefined;
  try {
    return JSON.parse(await objectStorage.readObjectText(jobReportObject(job))) as ModelOptimizeReport;
  } catch {
    return undefined;
  }
}

async function buildWebOptimizeResult(job: CloudJob): Promise<Record<string, unknown> | undefined> {
  if (job.status !== 'succeeded') return undefined;
  const report = await readModelOptimizeReport(job);
  const metrics = report?.metrics || {};
  const originalSize = metrics.originalSize || 0;
  const optimizedSize = metrics.optimizedSize || 0;
  const compressionRatio = metrics.compressionRatio ?? (originalSize > 0 ? optimizedSize / originalSize : 1);
  const optionsMetadata = { presetName: job.preset, options: job.options as Record<string, unknown> };
  const retention = jobRetentionMs(job);

  return {
    taskId: job.id,
    success: true,
    processingTime: metrics.processingTimeMs || 0,
    originalSize,
    optimizedSize,
    compressionRatio,
    downloadUrl: `/api/v1/account/wallet/jobs/${job.id}/result-file`,
    originalFilename: job.originalFilename || jobPayloadFilename(job),
    optimizedAt: retention.optimizedAt,
    expiresAt: retention.expiresAt,
    remainingMs: retention.remainingMs,
    downloadReady: true,
    conversion: job.conversion || report?.conversion,
    optionsSummary: summarizeOptimizationOptions(optionsMetadata),
    optionsDetail: describeOptimizationOptions(optionsMetadata),
    steps: [],
  };
}

function buildWechatAccountHint(unionId: string | undefined, openId: string | undefined): string | undefined {
  if (unionId) return `微信 UnionID 后8位 ${unionId.slice(-8)}`;
  if (openId) return `微信 OpenID 后8位 ${openId.slice(-8)}`;
  return undefined;
}

function normalizeHost(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
  if (trimmed === '::1' || trimmed.startsWith('::ffff:')) return trimmed;
  if ((trimmed.match(/:/g) || []).length > 1) return trimmed;
  return trimmed.split(':')[0];
}

function isLoopbackValue(value: string | undefined): boolean {
  const normalized = normalizeHost(value).replace(/^::ffff:/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isLocalDevRequest(req: Request): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  const localTestFlag = process.env.LOCAL_TEST_ACCOUNT_ENABLED?.toLowerCase();
  if (localTestFlag === '0' || localTestFlag === 'false' || localTestFlag === 'off') return false;
  const host = req.hostname || req.get('host');
  const remoteAddress = req.ip || req.socket.remoteAddress;
  return isLoopbackValue(host) && isLoopbackValue(remoteAddress);
}

router.get('/auth/providers', (req: Request, res: Response) => {
  const authServiceRuntime = getAuthServiceRuntimeConfig();
  const authServiceConfigured = Boolean(authServiceRuntime);
  const wechatPaymentConfigured = Boolean(config.billing.paymentServiceUrl);
  const localTestAccountEnabled = isLocalDevRequest(req);
  res.json({
    localTestAccount: {
      enabled: localTestAccountEnabled,
      label: localTestAccountEnabled ? '本地测试账户（已充值）' : undefined,
    },
    authService: {
      configured: authServiceConfigured,
      baseUrl: authServiceRuntime?.baseUrl,
      loginUrl: authServiceRuntime?.loginUrl,
      widgetConfigPath: authServiceConfigured ? '/api/v1/account/auth/service/widget-config' : undefined,
      clientId: authServiceRuntime?.clientId,
      redirectUri: authServiceRuntime?.redirectUri,
    },
    wechat: {
      oauthConfigured: authServiceConfigured || isWechatOAuthConfigured(),
      oauthMode: authServiceConfigured ? 'auth_service' : config.webAuth.wechatOAuthMode,
      oauthAppIdConfigured: Boolean(config.webAuth.wechatOAuthAppId),
      oauthAppSecretConfigured: Boolean(config.webAuth.wechatOAuthAppSecret),
      oauthRedirectUrlConfigured: Boolean(config.webAuth.wechatOAuthRedirectUrl),
      productionLoginConfigured: authServiceConfigured || isWechatOAuthConfigured(),
      nativePaymentConfigured: config.billing.mode === 'wechat_native',
      wechatPaymentConfigured,
      unionIdSupported: true,
      requiredBeforeProduction: [
        '统一登录中心：https://auth.bujiaban.com/login/3dugc',
        '业务 OAuth 回调地址：https://3dugc.com/auth/callback',
        '业务后端用 code + code_verifier 换取 userinfo 后绑定 auth_user_id',
      ],
    },
    rechargePackagesCents: config.billing.rechargePackagesCents,
    jobPriceCents: config.billing.defaultJobPriceCents,
  });
});

router.post('/auth/dev-login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isLocalDevRequest(req)) {
      throw new HttpError(404, 'LOCAL_TEST_ACCOUNT_UNAVAILABLE', 'Local test account is only available from localhost in non-production runs.');
    }
    const login = await accountService.loginWithLocalTestAccount();
    res.status(201).json(login);
  } catch (error) {
    next(error);
  }
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
      accountHint: buildWechatAccountHint(profile.unionId, profile.openId),
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

router.post('/auth/service/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isAuthServiceConfigured()) {
      throw new HttpError(503, 'AUTH_SERVICE_NOT_CONFIGURED', 'Unified auth service is not configured.');
    }
    const body = req.body as AuthServiceCallbackBody;
    const code = body.code?.trim();
    const codeVerifier = body.codeVerifier?.trim();
    if (!code) throw new HttpError(400, 'AUTH_SERVICE_CODE_REQUIRED', 'Auth service authorization code is required.');
    if (!codeVerifier) {
      throw new HttpError(400, 'AUTH_SERVICE_CODE_VERIFIER_REQUIRED', 'Auth service PKCE code verifier is required.');
    }

    const profile = await exchangeAuthServiceAuthorizationCode(code, codeVerifier);
    const login = await accountService.loginWithAuthService({
      authUserId: profile.authUserId,
      unionId: profile.unionId,
      accountHint: profile.accountHint,
      nickname: profile.nickname || '微信用户',
      avatarUrl: profile.avatarUrl,
    });
    res.status(201).json(login);
  } catch (error) {
    next(error);
  }
});

router.post('/auth/service/widget-config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isAuthServiceConfigured()) {
      throw new HttpError(503, 'AUTH_SERVICE_NOT_CONFIGURED', 'Unified auth service is not configured.');
    }
    const body = req.body as AuthServiceWidgetConfigBody;
    const state = body.state?.trim();
    const codeChallenge = body.codeChallenge?.trim();
    const returnTo = body.returnTo?.trim();
    if (!state) throw new HttpError(400, 'AUTH_SERVICE_STATE_REQUIRED', 'Auth service state is required.');
    if (!codeChallenge) {
      throw new HttpError(400, 'AUTH_SERVICE_CODE_CHALLENGE_REQUIRED', 'Auth service PKCE code challenge is required.');
    }

    const widgetConfig = await fetchAuthServiceWechatWidgetConfig({ state, codeChallenge, returnTo });
    res.json(widgetConfig);
  } catch (error) {
    next(error);
  }
});

router.post('/auth/service/scan-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isAuthServiceConfigured()) {
      throw new HttpError(503, 'AUTH_SERVICE_NOT_CONFIGURED', 'Unified auth service is not configured.');
    }
    const body = req.body as AuthServiceScanStatusBody;
    const token = body.token?.trim();
    const state = body.state?.trim();
    if (!token) throw new HttpError(400, 'AUTH_SERVICE_SCAN_TOKEN_REQUIRED', 'Auth service scan token is required.');
    if (!state) throw new HttpError(400, 'AUTH_SERVICE_STATE_REQUIRED', 'Auth service state is required.');

    const status = await pollAuthServiceWechatScan({ token, state });
    res.json(status);
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
    if (config.billing.mode !== 'wechat_native') {
      throw new HttpError(503, 'WECHAT_PAYMENT_NOT_CONFIGURED', '微信支付未配置，暂时不能充值。');
    }
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

router.get('/wallet/recharge-orders/:orderId/invoice', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invoice = await invoiceService.getRechargeOrderInvoice(requireWebUserId(req), req.params.orderId);
    res.json({ invoice });
  } catch (error) {
    next(error);
  }
});

router.post('/wallet/recharge-orders/:orderId/invoice', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!config.invoice.enabled) {
      throw new HttpError(503, 'INVOICE_DISABLED', 'Invoice integration is disabled.');
    }
    const body = req.body as CreateRechargeInvoiceBody;
    if (!body.buyer?.type || !body.buyer.name) {
      throw new HttpError(400, 'INVOICE_BUYER_REQUIRED', 'Invoice buyer information is required.');
    }
    const invoice = await invoiceService.createRechargeOrderInvoice(requireWebUserId(req), req.params.orderId, {
      type: body.buyer.type,
      name: body.buyer.name,
      taxpayerId: body.buyer.taxpayerId,
      address: body.buyer.address,
      telephone: body.buyer.telephone,
      bankName: body.buyer.bankName,
      bankAccount: body.buyer.bankAccount,
      phoneMasked: body.buyer.phoneMasked,
      emailMasked: body.buyer.emailMasked,
    });
    res.status(201).json({ invoice });
  } catch (error) {
    next(error);
  }
});

router.get(
  '/wallet/recharge-orders/:orderId/invoice/download-url',
  requireWebUser,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await invoiceService.getRechargeOrderInvoiceDownloadUrl(requireWebUserId(req), req.params.orderId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.post('/wallet/wechat/notify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (config.billing.mode !== 'wechat_native') {
      throw new HttpError(503, 'WECHAT_PAYMENT_NOT_CONFIGURED', '微信支付未配置，暂时不能处理支付回调。');
    }
    const result = await accountService.handlePaymentNotification(
      req.headers,
      req.rawBody || Buffer.from(JSON.stringify(req.body))
    );
    res.json({ code: 'SUCCESS', message: '成功', ...result });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/wallet/optimize-jobs',
  requireWebUser,
  optimizeUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = requireWebUserId(req);
    let createdJobId: string | undefined;

    try {
      if (!req.file) {
        throw new HttpError(400, 'INVALID_FILE', 'No file uploaded.');
      }

      const originalFilename = decodeUploadFilename(req.file.originalname);
      const body = req.body as WebOptimizeJobBody;
      const preset = parsePresetName(body.preset);
      const options = parseWebOptimizeOptions(body);
      const effectiveOptions = buildEffectiveOptimizeOptions(preset, options);
      const inputHash = await hashFile(req.file.path);
      const inputExtension = normalizedFileExtension(originalFilename);
      const optionsHash = hashOptimizationOptions(effectiveOptions);
      const existing = await findExistingWebOptimizeJob({ userId, inputHash, inputExtension, optionsHash });
      if (existing) {
        const wallet = await accountService.getWallet(userId);
        const result = existing.reused ? await buildWebOptimizeResult(existing.job) : undefined;
        res.status(existing.reused ? 200 : 202).json({
          job: existing.job,
          wallet,
          existing: true,
          reused: existing.reused,
          ...(result && {
            result: {
              ...result,
              reused: true,
              duplicateOfTaskId: existing.job.id,
              message: '已找到相同模型和相同优化参数的历史结果，未重新优化、未重复扣费，可直接下载上一个模型。',
            },
          }),
        });
        return;
      }

      const paid = await accountService.createPaidWebJob({
        userId,
        filename: originalFilename,
        taskType: config.cloud.defaultTaskType,
        preset,
        options,
        originalFilename,
        inputHash,
        inputHashKind: 'raw-upload',
        optionsHash,
        canonicalOptions: canonicalizeOptimizationOptions(effectiveOptions),
      });
      createdJobId = paid.job.id;

      await objectStorage.uploadObject(req.file.path, {
        bucket: paid.job.inputBucket,
        region: paid.job.inputRegion,
        key: paid.job.inputKey,
      });
      const queued = await accountService.completePaidWebJobUpload(userId, paid.job.id);
      res.status(202).json({ job: queued, wallet: paid.wallet });
    } catch (error) {
      if (createdJobId) {
        await accountService.cancelPaidWebJob(userId, createdJobId).catch(() => undefined);
      }
      next(error);
    } finally {
      await cleanupUploadedFile(req.file);
    }
  }
);

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

router.get('/wallet/jobs/:jobId', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireWebUserId(req);
    const job = await accountService.getPaidWebJob(userId, req.params.jobId);
    const wallet = await accountService.getWallet(userId);
    const result = await buildWebOptimizeResult(job);
    res.json({ job, wallet, result });
  } catch (error) {
    next(error);
  }
});

router.post('/wallet/jobs/:jobId/complete-upload', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await accountService.completePaidWebJobUpload(requireWebUserId(req), req.params.jobId);
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

router.get('/wallet/jobs/:jobId/result-file', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  let tempPath: string | undefined;
  try {
    const job = await accountService.getPaidWebJob(requireWebUserId(req), req.params.jobId);
    if (job.status !== 'succeeded') {
      throw new HttpError(409, 'RESULT_NOT_READY', 'Result is not ready.');
    }

    tempPath = path.join(os.tmpdir(), 'optimizer-cloud-results', `${job.id}-${uuidv4()}.glb`);
    await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
    await objectStorage.downloadObject(jobOutputObject(job), tempPath);
    res.download(tempPath, `optimized-${job.id}.glb`, (error) => {
      if (tempPath) fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    if (tempPath) await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    next(error);
  }
});

router.post('/wallet/jobs/:jobId/cancel', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await accountService.cancelPaidWebJob(requireWebUserId(req), req.params.jobId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
