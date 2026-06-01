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
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { getResultFilePath } from '../utils/storage';
import { createModelUpload, cleanupUploadedFile } from '../utils/model-upload';
import { decodeUploadFilename, prepareModelInput } from '../utils/model-input';
import { runPaidOptimization } from '../components/paid-optimization-runner';
import { findReusableOptimizationResult } from '../components/reusable-optimization-result';
import { OptimizationOptions, OPTIMIZATION_PRESETS, PresetName } from '../models/options';
import { OptimizationError } from '../models/error';
import { validateOptions } from '../utils/options-validator';
import {
  canonicalizeOptimizationOptions,
  describeOptimizationOptions,
  hashFile,
  hashOptimizationOptions,
  summarizeOptimizationOptions,
} from '../utils/optimization-metadata';
import { requireWebUser, requireWebUserId } from '../middleware';
import { isHttpError } from '../utils/http-error';
import logger from '../utils/logger';

const router = Router();

const upload = createModelUpload({ allowZip: true });

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
    const taskId = uuidv4();
    const tempDir = path.join('./temp', taskId);

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

      const originalFilename = decodeUploadFilename(req.file.originalname);

      sendEvent('progress', { step: 'upload', status: 'done', message: '文件上传完成' });
      sendEvent('progress', { step: 'prepare', status: 'start', message: '准备模型文件' });
      const prepared = await prepareModelInput({
        inputPath: req.file.path,
        scratchDir: tempDir,
        originalFilename,
        allowZip: true,
      });
      sendEvent('progress', {
        step: prepared.conversion.converted ? 'convert' : 'prepare',
        status: 'done',
        message: prepared.conversion.converted ? '格式转换完成' : '模型校验完成',
        duration: prepared.conversion.conversionTime,
      });

      // Parse options (preset or custom)
      let options: OptimizationOptions = {};
      const presetName = req.body.preset as PresetName | undefined;
      if (presetName) {
        if (!OPTIMIZATION_PRESETS[presetName]) {
          sendEvent('error', { code: 'INVALID_OPTIONS', message: `Unknown preset: ${presetName}` });
          res.end();
          return;
        }
        options = { ...OPTIMIZATION_PRESETS[presetName] };
      }
      if (req.body.options) {
        try {
          const custom = JSON.parse(req.body.options);
          options = presetName ? { ...options, ...custom } : custom;
        } catch {
          sendEvent('error', { code: 'INVALID_OPTIONS', message: 'Invalid options JSON' });
          res.end();
          return;
        }
      }

      const { sanitized } = validateOptions(options);
      options = sanitized;
      const canonicalOptions = canonicalizeOptimizationOptions(options);
      const inputHash = await hashFile(prepared.inputGlbPath);
      const optionsHash = hashOptimizationOptions(options);

      const reusable = await findReusableOptimizationResult({
        userId,
        inputHash,
        optionsHash,
      });
      if (reusable) {
        sendEvent('reuse', reusable);
        sendEvent('result', {
          ...reusable,
          conversion: prepared.conversion,
        });
        sendEvent('done', { taskId: reusable.taskId, success: true, reused: true });
        res.end();
        return;
      }

      const paid = await runPaidOptimization({
        taskId,
        userId,
        inputGlbPath: prepared.inputGlbPath,
        outputPath: getResultFilePath(taskId),
        options,
        metadata: {
          taskId,
          originalFilename,
          presetName,
          options: options as Record<string, unknown>,
          canonicalOptions,
          inputHash,
          optionsHash,
          conversion: prepared.conversion,
        },
        onWallet: (event) => sendEvent('wallet', event),
        onProgress: (event) => {
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
        },
      });

      sendEvent('result', {
        ...paid.result,
        conversion: prepared.conversion,
        wallet: paid.wallet,
        optionsSummary: summarizeOptimizationOptions({ presetName, options: options as Record<string, unknown> }),
        optionsDetail: describeOptimizationOptions({ presetName, options: options as Record<string, unknown> }),
        ...(paid.chargeStatus === 'released' && { chargeStatus: 'released' }),
      });
      sendEvent('done', { taskId, success: paid.result.success });
      res.end();
    } catch (error) {
      const event = toErrorEvent(error);
      logger.error({ error: event.message }, 'SSE optimize failed');
      sendEvent('error', event);
      res.end();
    } finally {
      await Promise.all([
        fs.promises.rm(tempDir, { recursive: true, force: true }),
        cleanupUploadedFile(req.file),
      ]);
    }
  }
);

export default router;
