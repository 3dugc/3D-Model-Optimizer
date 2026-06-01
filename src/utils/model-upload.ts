import * as fs from 'fs';
import * as path from 'path';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { getFileExtension, isSupportedFormat } from '../components/format-converter';
import { ERROR_CODES, OptimizationError } from '../models/error';
import { FILE_CONSTRAINTS } from './file-validator';
import { getSupportedUploadExtensions } from './model-input';

export interface ModelUploadOptions {
  allowZip?: boolean;
}

const uploadRoot = path.join(config.tempDir, 'incoming');

export function createModelUpload(options: ModelUploadOptions = {}): multer.Multer {
  const allowZip = options.allowZip ?? true;
  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => {
      fs.mkdirSync(uploadRoot, { recursive: true });
      callback(null, uploadRoot);
    },
    filename: (_req, file, callback) => {
      const ext = getFileExtension(file.originalname) || '.upload';
      callback(null, `${Date.now()}-${uuidv4()}${ext}`);
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: FILE_CONSTRAINTS.maxSize,
    },
    fileFilter: (_req, file, callback) => {
      const ext = getFileExtension(file.originalname);
      if ((allowZip && ext === '.zip') || isSupportedFormat(ext)) {
        callback(null, true);
        return;
      }
      callback(
        new OptimizationError(ERROR_CODES.INVALID_FILE, `Unsupported file format: ${ext}`, {
          received: ext,
          expected: getSupportedUploadExtensions(allowZip).join(', '),
        })
      );
    },
  });
}

export async function cleanupUploadedFile(file: Express.Multer.File | undefined): Promise<void> {
  if (!file?.path) return;
  await fs.promises.unlink(file.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
