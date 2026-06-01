import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { billingService } from '../billing/billing-service';

const router = Router();

interface CreateOrderBody {
  tenantId?: string;
  jobId?: string;
  amountCents?: number;
  description?: string;
}

interface MockPaidBody {
  orderId?: string;
  outTradeNo?: string;
  transactionId?: string;
}

function requireString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required`);
  return value;
}

router.post('/wechat/native', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as CreateOrderBody;
    const tenantId = requireString(body.tenantId || req.header('x-tenant-id') || undefined, 'tenantId');
    const jobId = requireString(body.jobId, 'jobId');
    const order = await billingService.createWechatNativeOrder({
      tenantId,
      jobId,
      amountCents: body.amountCents || config.billing.defaultJobPriceCents,
      description: body.description || '3D model optimization',
      notifyUrl: config.billing.wechatNotifyUrl || `${req.protocol}://${req.get('host')}/api/v1/payments/wechat/notify`,
    });
    res.status(201).json({ order });
  } catch (error) {
    next(error);
  }
});

router.get('/orders/:orderId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const order = await billingService.getOrder(req.params.orderId);
    if (!order) {
      res.status(404).json({ success: false, error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });
      return;
    }
    res.json({ order });
  } catch (error) {
    next(error);
  }
});

router.post('/wechat/mock-paid', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (config.billing.mode !== 'mock') {
      res.status(403).json({ success: false, error: { code: 'MOCK_PAYMENT_DISABLED', message: 'Mock payment is disabled' } });
      return;
    }
    const body = req.body as MockPaidBody;
    const order = body.outTradeNo
      ? await billingService.markPaidByOutTradeNo(body.outTradeNo, body.transactionId)
      : await billingService.markPaid(requireString(body.orderId, 'orderId'), body.transactionId);
    res.json({ order });
  } catch (error) {
    next(error);
  }
});

router.post('/wechat/notify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (config.billing.mode !== 'mock') {
      res.status(501).json({
        success: false,
        error: {
          code: 'WECHAT_NOTIFY_NOT_CONFIGURED',
          message: 'Wechat Pay notification verification requires production merchant credentials and is completed during deployment wiring.',
        },
      });
      return;
    }
    const body = req.body as MockPaidBody;
    const order = body.outTradeNo
      ? await billingService.markPaidByOutTradeNo(body.outTradeNo, body.transactionId)
      : await billingService.markPaid(requireString(body.orderId, 'orderId'), body.transactionId);
    res.json({ code: 'SUCCESS', message: '成功', order });
  } catch (error) {
    next(error);
  }
});

export default router;
