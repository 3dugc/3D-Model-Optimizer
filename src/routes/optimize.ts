/**
 * Legacy sync optimize route.
 *
 * Heavy conversion and optimization run on elastic workers. This endpoint is
 * intentionally kept as a clear migration response instead of doing local work.
 */

import { Router } from 'express';
import { requireWebUser } from '../middleware';

const router = Router();

router.post('/', requireWebUser, (_req, res) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'ASYNC_OPTIMIZATION_REQUIRED',
      message: '同步优化接口已停用，请使用 /api/v1/account/wallet/optimize-jobs 提交弹性 Worker 任务。',
    },
  });
});

export default router;
