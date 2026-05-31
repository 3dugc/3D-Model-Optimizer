/**
 * Optimize Route
 *
 * Handles 3D model file upload and optimization requests.
 * Supports multiple formats: GLB, GLTF, OBJ, STL, FBX, USDZ, ZIP
 * ZIP files are automatically extracted to find the 3D model inside.
 * Implements POST /api/optimize endpoint.
 *
 * @module routes/optimize
 */

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { getResultFilePath } from '../utils/storage';
import { createModelUpload, cleanupUploadedFile } from '../utils/model-upload';
import { decodeUploadFilename, prepareModelInput } from '../utils/model-input';
import { runPaidOptimization } from '../components/paid-optimization-runner';
import { OptimizationOptions, OPTIMIZATION_PRESETS, PresetName } from '../models/options';
import { OptimizationError, ERROR_CODES } from '../models/error';
import { validateOptions } from '../utils/options-validator';
import { requireWebUser, requireWebUserId } from '../middleware';
import logger from '../utils/logger';

const router = Router();

// Configure multer for file uploads — accept any single file (zip or model)
const upload = createModelUpload({ allowZip: true });

/**
 * @openapi
 * /api/optimize:
 *   post:
 *     summary: Upload and optimize a 3D model file
 *     description: |
 *       Upload a 3D model file (or a ZIP containing the model and its dependencies)
 *       and apply various optimizations.
 *       Supported formats: GLB, GLTF, OBJ, STL, FBX, USDZ, ZIP
 *       ZIP files are automatically extracted; the first supported 3D model found is used.
 *       This is useful for OBJ files that reference MTL and texture files.
 *     tags:
 *       - Optimization
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: 3D model file or ZIP archive (max 100MB)
 *               preset:
 *                 type: string
 *                 description: Optimization preset (fast, balanced, maximum)
 *               options:
 *                 type: string
 *                 description: JSON string of custom optimization options
 *     responses:
 *       200:
 *         description: Optimization successful
 *       400:
 *         description: Invalid file or options
 *       413:
 *         description: File too large
 *       500:
 *         description: Optimization failed
 */
router.post(
  '/',
  requireWebUser,
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    const taskId = uuidv4();
    const tempDir = path.join('./temp', taskId);

    try {
      if (!req.file) {
        throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'No file uploaded.', {
          field: 'file',
        });
      }

      const originalFilename = decodeUploadFilename(req.file.originalname);
      const userId = requireWebUserId(req);

      const prepared = await prepareModelInput({
        inputPath: req.file.path,
        scratchDir: tempDir,
        originalFilename,
        allowZip: true,
      });

      // Parse optimization options
      let options: OptimizationOptions = {};
      const presetName = req.body.preset as PresetName | undefined;
      if (presetName) {
        if (!OPTIMIZATION_PRESETS[presetName]) {
          throw new OptimizationError(ERROR_CODES.INVALID_OPTIONS, `Unknown preset: ${presetName}`, {
            field: 'preset',
            received: presetName,
            expected: Object.keys(OPTIMIZATION_PRESETS).join(', '),
          });
        }
        options = { ...OPTIMIZATION_PRESETS[presetName] };
        logger.info({ preset: presetName }, 'Using optimization preset');
      }
      if (req.body.options) {
        try {
          const customOptions = JSON.parse(req.body.options);
          options = presetName ? { ...options, ...customOptions } : customOptions;
        } catch {
          throw new OptimizationError(ERROR_CODES.INVALID_OPTIONS, 'Invalid options JSON format', {
            field: 'options',
            received: req.body.options,
          });
        }
      }

      const { errors: validationErrors, sanitized } = validateOptions(options);
      if (validationErrors.length > 0) {
        logger.warn({ errors: validationErrors }, 'Options validation warnings');
      }
      options = sanitized;

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
          conversion: prepared.conversion,
        },
      });

      res.json({
        ...paid.result,
        conversion: prepared.conversion,
        wallet: paid.wallet,
        ...(paid.chargeStatus === 'released' && { chargeStatus: 'released' }),
      });
    } catch (error) {
      next(error);
    } finally {
      await Promise.all([
        fs.promises.rm(tempDir, { recursive: true, force: true }),
        cleanupUploadedFile(req.file),
      ]);
    }
  }
);

export default router;
