/**
 * Legacy SSE optimize route.
 *
 * Heavy conversion and optimization run on elastic workers. This endpoint is
 * intentionally kept as a clear migration response instead of doing local work.
 */

import { Router } from 'express';
import { requireWebUser } from '../middleware';

const router = Router();

router.post('/', requireWebUser, (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(`event: error\ndata: ${JSON.stringify({
    code: 'ASYNC_OPTIMIZATION_REQUIRED',
    message: '流式同步优化接口已停用，请使用 /api/v1/account/wallet/optimize-jobs 提交弹性 Worker 任务。',
  })}\n\n`);
  res.end();
});

export default router;
