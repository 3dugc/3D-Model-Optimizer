/**
 * SSE Progress Route
 *
 * Server-Sent Events endpoint for real-time optimization progress.
 * Client uploads file via POST /api/optimize/stream, receives SSE events
 * for each pipeline step, then a final result event.
 *
 * @module routes/progress
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { validateGlbBuffer, FILE_CONSTRAINTS } from '../utils/file-validator';
import { getResultFilePath } from '../utils/storage';
import { executePipeline } from '../components/optimization-pipeline';
import {
  convertToGLB,
  isSupportedFormat,
  getFileExtension,
  SUPPORTED_FORMATS,
} from '../components/format-converter';
import { OptimizationOptions, OPTIMIZATION_PRESETS, PresetName } from '../models/options';
import { OptimizationError, ERROR_CODES } from '../models/error';
import { validateOptions } from '../utils/options-validator';
import { config } from '../config';
import { accountService } from '../accounts/account-service';
import { requireWebUser, requireWebUserId } from '../middleware';
import { isHttpError } from '../utils/http-error';
import logger from '../utils/logger';

const router = Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: FILE_CONSTRAINTS.maxSize },
  fileFilter: (_req, file, cb) => {
    const ext = getFileExtension(file.originalname);
    if (!isSupportedFormat(ext)) {
      cb(new OptimizationError(ERROR_CODES.INVALID_FILE, `Unsupported format: ${ext}`, {
        received: ext, expected: SUPPORTED_FORMATS.join(', '),
      }));
      return;
    }
    cb(null, true);
  },
});

/**
 * POST /api/optimize/stream
 * SSE-based optimization with real-time progress events.
 */
router.post(
  '/',
  requireWebUser,
  upload.single('file'),
  async (req: Request, res: Response) => {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const userId = requireWebUserId(req);
    let taskId: string | undefined;
    let chargeHeld = false;
    let chargeSettled = false;

    const releaseHeldCharge = async (note = 'Optimization failed'): Promise<void> => {
      if (!taskId || !chargeHeld || chargeSettled) return;
      await accountService.releaseJobCharge(taskId, note).catch((releaseError) => {
        logger.warn({ taskId, error: releaseError }, 'Failed to release optimization charge');
      });
    };

    const sendFailure = async (code: string, message: string): Promise<void> => {
      await releaseHeldCharge(message);
      sendEvent('error', { code, message });
      res.end();
    };

    const toErrorEvent = (error: unknown): { code: string; message: string } => {
      if (error instanceof OptimizationError) return { code: error.code, message: error.message };
      if (isHttpError(error)) return { code: error.code, message: error.message };
      return {
        code: 'OPTIMIZATION_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    };

    try {
      if (!req.file) {
        sendEvent('error', { code: 'INVALID_FILE', message: 'No file uploaded' });
        res.end();
        return;
      }

      const fileBuffer = req.file.buffer;
      const originalFilename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const ext = getFileExtension(originalFilename);
      taskId = uuidv4();

      const holdCharge = async (): Promise<void> => {
        if (chargeHeld || !taskId) return;
        const held = await accountService.holdOptimizationCharge(userId, taskId);
        chargeHeld = true;
        sendEvent('wallet', {
          wallet: held.wallet,
          priceCents: config.billing.defaultJobPriceCents,
          status: 'held',
        });
      };

      sendEvent('progress', { step: 'upload', status: 'done', message: '文件上传完成' });

      // Create temp directory
      const tempDir = path.join('./temp', taskId);
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

      const uploadedFilePath = path.join(tempDir, `input${ext}`);
      fs.writeFileSync(uploadedFilePath, fileBuffer);

      const convertedGlbPath = path.join(tempDir, 'converted.glb');
      let inputGlbPath: string;
      let conversionInfo = { converted: false, originalFormat: ext.toUpperCase().slice(1) } as {
        converted: boolean; originalFormat: string; conversionTime?: number;
      };

      // Convert if needed
      if (ext !== '.glb') {
        await holdCharge();
        sendEvent('progress', { step: 'convert', status: 'start', message: `转换 ${ext.toUpperCase()} → GLB` });
        const conversionResult = await convertToGLB(uploadedFilePath, convertedGlbPath, originalFilename);
        if (!conversionResult.success) {
          await sendFailure('CONVERSION_FAILED', conversionResult.error || '格式转换失败');
          return;
        }
        inputGlbPath = convertedGlbPath;
        conversionInfo = { converted: true, originalFormat: conversionResult.originalFormat, conversionTime: conversionResult.conversionTime };
        sendEvent('progress', { step: 'convert', status: 'done', message: '格式转换完成', duration: conversionResult.conversionTime });
      } else {
        const validation = validateGlbBuffer(fileBuffer);
        if (!validation.isValid) {
          await sendFailure('INVALID_FILE', validation.errors.join('; '));
          return;
        }
        await holdCharge();
        inputGlbPath = uploadedFilePath;
      }

      // Parse options (preset or custom)
      let options: OptimizationOptions = {};
      const presetName = req.body.preset as PresetName | undefined;
      if (presetName && OPTIMIZATION_PRESETS[presetName]) {
        options = { ...OPTIMIZATION_PRESETS[presetName] };
      }
      if (req.body.options) {
        try {
          const custom = JSON.parse(req.body.options);
          options = presetName ? { ...options, ...custom } : custom;
        } catch {
          await sendFailure('INVALID_OPTIONS', 'Invalid options JSON');
          return;
        }
      }

      const { sanitized } = validateOptions(options);
      options = sanitized;

      const outputPath = getResultFilePath(taskId);

      // Execute pipeline with progress callback
      const result = await executePipeline(inputGlbPath, outputPath, options, (event) => {
        const stepNames: Record<string, string> = {
          'repair-input': '输入修复',
          'clean': '资源清理',
          'merge': 'Mesh 合并',
          'simplify': '网格减面',
          'quantize': '顶点量化',
          'draco': 'Draco 压缩',
          'texture': '纹理压缩',
          'repair-output': '输出修复',
        };
        sendEvent('progress', {
          step: event.step,
          stepName: stepNames[event.step] || event.step,
          status: event.status,
          index: event.index,
          total: event.total,
          duration: event.duration,
          error: event.error,
        });
      });

      result.taskId = taskId;
      result.downloadUrl = `/api/download/${taskId}`;

      await accountService.settleJobCharge(taskId);
      chargeSettled = true;
      const wallet = await accountService.getWallet(userId);
      sendEvent('wallet', {
        wallet,
        priceCents: config.billing.defaultJobPriceCents,
        status: 'charged',
      });

      sendEvent('result', { ...result, conversion: conversionInfo, wallet });
      sendEvent('done', { taskId });
      res.end();
    } catch (error) {
      const event = toErrorEvent(error);
      logger.error({ error: event.message }, 'SSE optimize failed');
      await releaseHeldCharge(event.message);
      sendEvent('error', event);
      res.end();
    }
  }
);

export default router;
