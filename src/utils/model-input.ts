import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { convertToGLB, getFileExtension, isSupportedFormat, SUPPORTED_FORMATS } from '../components/format-converter';
import { ERROR_CODES, OptimizationError } from '../models/error';
import { validateGlbBuffer } from './file-validator';

const execFileAsync = promisify(execFile);

const MODEL_EXTENSIONS = new Set<string>(SUPPORTED_FORMATS);
const MAX_ZIP_FILES = 300;
const MAX_ZIP_BYTES = 512 * 1024 * 1024;

export interface ConversionInfo {
  converted: boolean;
  originalFormat: string;
  conversionTime?: number;
}

export interface PreparedModelInput {
  inputGlbPath: string;
  modelPath: string;
  modelExt: string;
  conversion: ConversionInfo;
}

export interface ModelInputPrepareOptions {
  inputPath: string;
  scratchDir: string;
  originalFilename?: string;
  allowZip?: boolean;
}

function assertInside(parentDir: string, candidatePath: string): void {
  const parent = path.resolve(parentDir);
  const candidate = path.resolve(candidatePath);
  if (!candidate.startsWith(parent + path.sep) && candidate !== parent) {
    throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'Archive entry escapes extraction directory.', {
      entry: candidatePath,
    });
  }
}

function assertSafeZipEntry(entryName: string): void {
  const normalized = entryName.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized === '..') {
    throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'ZIP archive contains an unsafe entry path.', {
      entry: entryName,
    });
  }
}

async function listZipEntries(zipPath: string): Promise<string[]> {
  const result = await execFileAsync('unzip', ['-Z', '-1', zipPath], { maxBuffer: 1024 * 1024 });
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function readZipUncompressedBytes(zipPath: string): Promise<number | undefined> {
  const result = await execFileAsync('unzip', ['-Z', '-t', zipPath], { maxBuffer: 1024 * 1024 });
  const match = result.stdout.match(/,\s*([0-9]+)\s+bytes uncompressed/i);
  return match ? Number(match[1]) : undefined;
}

function findModelFile(dir: string, rootDir = dir, seen = { files: 0, bytes: 0 }): string | undefined {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    assertInside(rootDir, entryPath);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      seen.files++;
      seen.bytes += stat.size;
      if (seen.files > MAX_ZIP_FILES || seen.bytes > MAX_ZIP_BYTES) {
        throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'ZIP archive exceeds safety limits.', {
          maxFiles: MAX_ZIP_FILES,
          maxBytes: MAX_ZIP_BYTES,
        });
      }
      const ext = getFileExtension(entry.name);
      if (MODEL_EXTENSIONS.has(ext)) return entryPath;
    }
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    assertInside(rootDir, entryPath);
    const stat = fs.lstatSync(entryPath);
    if (stat.isDirectory() && !entry.name.startsWith('__')) {
      const found = findModelFile(entryPath, rootDir, seen);
      if (found) return found;
    }
  }

  return undefined;
}

export async function extractZipAndFindModel(zipPath: string, scratchDir: string): Promise<string> {
  const extractDir = path.join(scratchDir, 'unzipped');
  await fs.promises.mkdir(extractDir, { recursive: true });

  const entries = await listZipEntries(zipPath);
  if (entries.length > MAX_ZIP_FILES) {
    throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'ZIP archive contains too many files.', {
      files: entries.length,
      maxFiles: MAX_ZIP_FILES,
    });
  }
  for (const entry of entries) assertSafeZipEntry(entry);
  const uncompressedBytes = await readZipUncompressedBytes(zipPath);
  if (uncompressedBytes !== undefined && uncompressedBytes > MAX_ZIP_BYTES) {
    throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'ZIP archive uncompressed size exceeds safety limit.', {
      bytes: uncompressedBytes,
      maxBytes: MAX_ZIP_BYTES,
    });
  }

  await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', extractDir], { maxBuffer: 1024 * 1024 });
  const modelPath = findModelFile(extractDir);
  if (!modelPath) {
    throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'ZIP 中未找到支持的 3D 模型文件', {
      expected: SUPPORTED_FORMATS.join(', '),
    });
  }
  return modelPath;
}

function validateGlbFile(filePath: string, originalFilename?: string): void {
  const buffer = fs.readFileSync(filePath);
  const validation = validateGlbBuffer(buffer, originalFilename?.toLowerCase().endsWith('.glb') ? originalFilename : undefined);
  if (!validation.isValid) {
    throw new OptimizationError(ERROR_CODES.INVALID_FILE, validation.errors.join('; '), {
      filename: originalFilename || path.basename(filePath),
    });
  }
}

export async function prepareModelInput(options: ModelInputPrepareOptions): Promise<PreparedModelInput> {
  const allowZip = options.allowZip ?? true;
  const originalFilename = options.originalFilename || path.basename(options.inputPath);
  const ext = getFileExtension(originalFilename);
  let modelPath = options.inputPath;
  let modelExt = ext;

  await fs.promises.mkdir(options.scratchDir, { recursive: true });

  if (ext === '.zip') {
    if (!allowZip) {
      throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'ZIP input is not supported for this endpoint.', {
        received: ext,
      });
    }
    modelPath = await extractZipAndFindModel(options.inputPath, options.scratchDir);
    modelExt = getFileExtension(modelPath);
  }

  if (!isSupportedFormat(modelExt)) {
    throw new OptimizationError(ERROR_CODES.INVALID_FILE, `Unsupported file format: ${modelExt}`, {
      received: modelExt,
      expected: [...SUPPORTED_FORMATS, allowZip ? '.zip' : undefined].filter(Boolean).join(', '),
    });
  }

  const conversion: ConversionInfo = {
    converted: false,
    originalFormat: modelExt.toUpperCase().slice(1),
  };

  if (modelExt === '.glb') {
    validateGlbFile(modelPath, path.basename(modelPath));
    return { inputGlbPath: modelPath, modelPath, modelExt, conversion };
  }

  const convertedGlbPath = path.join(options.scratchDir, 'converted.glb');
  const conversionResult = await convertToGLB(modelPath, convertedGlbPath, path.basename(modelPath));
  if (!conversionResult.success) {
    throw new OptimizationError(
      ERROR_CODES.INVALID_FILE,
      `Failed to convert ${modelExt} to GLB: ${conversionResult.error}`,
      { originalFormat: modelExt, error: conversionResult.error }
    );
  }

  return {
    inputGlbPath: convertedGlbPath,
    modelPath,
    modelExt,
    conversion: {
      converted: true,
      originalFormat: conversionResult.originalFormat,
      conversionTime: conversionResult.conversionTime,
    },
  };
}

export function decodeUploadFilename(filename: string): string {
  return Buffer.from(filename, 'latin1').toString('utf8');
}

export function getSupportedUploadExtensions(allowZip = true): string[] {
  return allowZip ? [...SUPPORTED_FORMATS, '.zip'] : [...SUPPORTED_FORMATS];
}
