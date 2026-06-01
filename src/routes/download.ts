/**
 * Download Route
 *
 * Handles optimized GLB file download requests.
 * Implements GET /api/download/:taskId endpoint.
 *
 * @module routes/download
 */

import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { getResultFilePath, getResultMetadata, listResultTasks, resultFileExists } from '../utils/storage';
import { describeOptimizationOptions, summarizeOptimizationOptions } from '../utils/optimization-metadata';
import { OptimizationError, ERROR_CODES } from '../models/error';
import { accountService } from '../accounts/account-service';
import { requireWebUser, requireWebUserId } from '../middleware';
import { HttpError } from '../utils/http-error';
import * as fs from 'fs';

const router = Router();
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RetainedDownloadFile {
  taskId: string;
  downloadUrl: string;
  size: number;
  originalFilename?: string;
  optimizedAt: string;
  expiresAt: string;
  remainingMs: number;
  optionsSummary: string;
  optionsDetail: string;
}

/**
 * @openapi
 * /api/download:
 *   get:
 *     summary: List retained optimized files for the current user
 *     tags:
 *       - Download
 *     responses:
 *       200:
 *         description: Retained optimized files with download links and expiration metadata
 */
router.get('/', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireWebUserId(req);
    const taskIds = await listResultTasks();
    const now = Date.now();
    const files: RetainedDownloadFile[] = [];

    for (const taskId of taskIds) {
      if (!uuidRegex.test(taskId)) continue;

      const charge = await accountService.getJobCharge(taskId);
      if (!charge || charge.userId !== userId) continue;

      const filePath = getResultFilePath(taskId);
      const metadata = await getResultMetadata(taskId);
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(filePath);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;

      const optimizedAtMs = stats.mtimeMs;
      const expiresAtMs = optimizedAtMs + config.fileRetentionMs;
      files.push({
        taskId,
        downloadUrl: `/api/download/${taskId}`,
        size: stats.size,
        originalFilename: metadata?.originalFilename,
        optimizedAt: metadata?.optimizedAt || new Date(optimizedAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        remainingMs: Math.max(0, expiresAtMs - now),
        optionsSummary: summarizeOptimizationOptions(metadata),
        optionsDetail: describeOptimizationOptions(metadata),
      });
    }

    files.sort((left, right) => (
      right.expiresAt.localeCompare(left.expiresAt) || right.optimizedAt.localeCompare(left.optimizedAt)
    ));

    res.json({
      success: true,
      retentionMs: config.fileRetentionMs,
      cleanupIntervalMs: config.cleanupIntervalMs,
      files,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/download/{taskId}:
 *   get:
 *     summary: Download optimized GLB file
 *     description: |
 *       Download the optimized GLB file for a completed optimization task.
 *       The taskId is returned from the /api/optimize endpoint.
 *     tags:
 *       - Download
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The task ID returned from the optimize endpoint
 *     responses:
 *       200:
 *         description: Optimized GLB file
 *         content:
 *           model/gltf-binary:
 *             schema:
 *               type: string
 *               format: binary
 *         headers:
 *           Content-Disposition:
 *             schema:
 *               type: string
 *             description: Attachment filename
 *           Content-Type:
 *             schema:
 *               type: string
 *             description: model/gltf-binary
 *       404:
 *         description: Task not found or file not available
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:taskId', requireWebUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { taskId } = req.params;
    const userId = requireWebUserId(req);

    // Validate taskId format (basic UUID check)
    if (!uuidRegex.test(taskId)) {
      throw new OptimizationError(
        ERROR_CODES.TASK_NOT_FOUND,
        'Invalid task ID format',
        { taskId }
      );
    }

    // Check if result file exists
    const exists = await resultFileExists(taskId);
    if (!exists) {
      throw new OptimizationError(
        ERROR_CODES.TASK_NOT_FOUND,
        'Task not found or optimization not completed',
        { taskId }
      );
    }

    const charge = await accountService.getJobCharge(taskId);
    if (charge && charge.userId !== userId) {
      throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this optimized file.');
    }

    // Get file path
    const filePath = getResultFilePath(taskId);

    // Get file stats for Content-Length
    const stats = fs.statSync(filePath);

    // Set response headers
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Length', stats.size);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="optimized-${taskId}.glb"`
    );

    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      next(new OptimizationError(
        ERROR_CODES.INTERNAL_ERROR,
        'Error reading file',
        { taskId, error: error.message }
      ));
    });
  } catch (error) {
    next(error);
  }
});

export default router;
