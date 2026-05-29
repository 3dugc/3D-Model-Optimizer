import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { invoiceService } from '../invoices';
import { authMiddleware, requireScope } from '../middleware';
import { HttpError } from '../utils/http-error';

const router = Router();

interface MarkIssuedBody {
  providerInvoiceId?: string;
  invoiceNo?: string;
  downloadUrl?: string;
}

function assertInvoiceEnabled(): void {
  if (!config.invoice.enabled) {
    throw new HttpError(503, 'INVOICE_DISABLED', 'Invoice integration is disabled.');
  }
}

router.post('/wechat/title-notify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertInvoiceEnabled();
    const invoiceRequest = await invoiceService.handleWechatTitleNotification(
      req.headers,
      req.rawBody || Buffer.from(JSON.stringify(req.body))
    );
    res.json({ code: 'SUCCESS', message: '成功', invoiceRequest });
  } catch (error) {
    next(error);
  }
});

router.post('/wechat/notify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertInvoiceEnabled();
    const invoiceRequest = await invoiceService.handleWechatNotification(
      req.headers,
      req.rawBody || Buffer.from(JSON.stringify(req.body))
    );
    res.json({ code: 'SUCCESS', message: '成功', invoiceRequest });
  } catch (error) {
    next(error);
  }
});

router.post('/wechat/issued-notify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertInvoiceEnabled();
    const invoiceRequest = await invoiceService.handleWechatIssuedNotification(
      req.headers,
      req.rawBody || Buffer.from(JSON.stringify(req.body))
    );
    res.json({ code: 'SUCCESS', message: '成功', invoiceRequest });
  } catch (error) {
    next(error);
  }
});

router.post('/wechat/reverse-notify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertInvoiceEnabled();
    const invoiceRequest = await invoiceService.handleWechatReverseNotification(
      req.headers,
      req.rawBody || Buffer.from(JSON.stringify(req.body))
    );
    res.json({ code: 'SUCCESS', message: '成功', invoiceRequest });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/admin/requests/:invoiceRequestId/mark-issued',
  authMiddleware,
  requireScope('invoices:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertInvoiceEnabled();
      const body = req.body as MarkIssuedBody;
      if (!body.downloadUrl) {
        throw new HttpError(400, 'INVOICE_DOWNLOAD_URL_REQUIRED', 'downloadUrl is required.');
      }
      const invoiceRequest = await invoiceService.markInvoiceIssuedManually(req.params.invoiceRequestId, {
        providerInvoiceId: body.providerInvoiceId,
        invoiceNo: body.invoiceNo,
        downloadUrl: body.downloadUrl,
      });
      res.json({ invoiceRequest });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
