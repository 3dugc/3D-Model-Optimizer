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
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
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
import { accountService } from '../accounts/account-service';
import { requireWebUser, requireWebUserId } from '../middleware';
import logger from '../utils/logger';

const router = Router();

/** File extensions recognized as 3D model entry points. */
const MODEL_EXTENSIONS = new Set(SUPPORTED_FORMATS);

// Configure multer for file uploads — accept any single file (zip or model)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: FILE_CONSTRAINTS.maxSize,
  },
  fileFilter: (_req, file, cb) => {
    const ext = getFileExtension(file.originalname);
    if (ext === '.zip' || isSupportedFormat(ext)) {
      cb(null, true);
      return;
    }
    cb(
      new OptimizationError(ERROR_CODES.INVALID_FILE, `Unsupported file format: ${ext}`, {
        received: ext,
        expected: [...SUPPORTED_FORMATS, '.zip'].join(', '),
      })
    );
  },
});

/**
 * Extract a ZIP file into tempDir using the system `unzip` command
 * and return the path to the primary 3D model file found.
 */
function extractZipAndFindModel(zipPath: string, tempDir: string): string {
  // Extract using system unzip (available in the Docker image)
  execSync(`unzip -o -q "${zipPath}" -d "${tempDir}"`);

  // Walk extracted files to find the primary 3D model
  function findModelFile(dir: string): string | null {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // First pass: look for model files in this directory
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = getFileExtension(entry.name);
        if (MODEL_EXTENSIONS.has(ext as any)) {
          return path.join(dir, entry.name);
        }
      }
    }
    // Second pass: recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('__')) {
        const found = findModelFile(path.join(dir, entry.name));
        if (found) return found;
      }
    }
    return null;
  }

  const modelPath = findModelFile(tempDir);
  if (!modelPath) {
    throw new OptimizationError(
      ERROR_CODES.INVALID_FILE,
      'ZIP 中未找到支持的 3D 模型文件',
      { expected: [...SUPPORTED_FORMATS].join(', ') }
    );
  }
  return modelPath;
}

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
    let taskId: string | undefined;
    let chargeHeld = false;
    let chargeSettled = false;

    const releaseHeldCharge = async (note = 'Optimization failed'): Promise<void> => {
      if (!taskId || !chargeHeld || chargeSettled) return;
      await accountService.releaseJobCharge(taskId, note).catch((releaseError) => {
        logger.warn({ taskId, error: releaseError }, 'Failed to release optimization charge');
      });
    };

    try {
      if (!req.file) {
        throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'No file uploaded.', {
          field: 'file',
        });
      }

      const fileBuffer = req.file.buffer;
      const originalFilename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const ext = getFileExtension(originalFilename);
      const userId = requireWebUserId(req);

      taskId = uuidv4();
      const tempDir = path.join('./temp', taskId);
      fs.mkdirSync(tempDir, { recursive: true });
      await accountService.holdOptimizationCharge(userId, taskId);
      chargeHeld = true;

      let uploadedFilePath: string;
      let modelExt: string;

      if (ext === '.zip') {
        // Save ZIP then extract and locate the 3D model inside
        const zipPath = path.join(tempDir, 'upload.zip');
        fs.writeFileSync(zipPath, fileBuffer);
        logger.info({ filename: originalFilename }, 'Extracting ZIP archive');
        uploadedFilePath = extractZipAndFindModel(zipPath, tempDir);
        modelExt = getFileExtension(uploadedFilePath);
        logger.info({ model: path.basename(uploadedFilePath), format: modelExt }, 'Found model in ZIP');
      } else {
        // Single file upload — save directly
        uploadedFilePath = path.join(tempDir, `input${ext}`);
        fs.writeFileSync(uploadedFilePath, fileBuffer);
        modelExt = ext;
      }

      const convertedGlbPath = path.join(tempDir, 'converted.glb');

      let inputGlbPath: string;
      let conversionInfo: { converted: boolean; originalFormat: string; conversionTime?: number } = {
        converted: false,
        originalFormat: modelExt.toUpperCase().slice(1),
      };

      if (modelExt !== '.glb') {
        const conversionResult = await convertToGLB(uploadedFilePath, convertedGlbPath, path.basename(uploadedFilePath));
        if (!conversionResult.success) {
          throw new OptimizationError(
            ERROR_CODES.INVALID_FILE,
            `Failed to convert ${modelExt} to GLB: ${conversionResult.error}`,
            { originalFormat: modelExt, error: conversionResult.error }
          );
        }
        inputGlbPath = convertedGlbPath;
        conversionInfo = {
          converted: true,
          originalFormat: conversionResult.originalFormat,
          conversionTime: conversionResult.conversionTime,
        };
      } else {
        const validation = validateGlbBuffer(fileBuffer);
        if (!validation.isValid) {
          throw new OptimizationError(ERROR_CODES.INVALID_FILE, validation.errors.join('; '), {
            filename: originalFilename,
          });
        }
        inputGlbPath = uploadedFilePath;
      }

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

      const outputPath = getResultFilePath(taskId);
      const result = await executePipeline(inputGlbPath, outputPath, options);

      result.taskId = taskId;
      result.downloadUrl = `/api/download/${taskId}`;

      await accountService.settleJobCharge(taskId);
      chargeSettled = true;
      const wallet = await accountService.getWallet(userId);

      res.json({ ...result, conversion: conversionInfo, wallet });
    } catch (error) {
      await releaseHeldCharge(error instanceof Error ? error.message : 'Optimization failed');
      next(error);
    }
  }
);

export default router;
