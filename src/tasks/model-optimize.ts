import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { validateGlbBuffer } from '../utils/file-validator';
import { executePipeline } from '../components/optimization-pipeline';
import {
  convertToGLB,
  getFileExtension,
  isSupportedFormat,
  SUPPORTED_FORMATS,
} from '../components/format-converter';
import { validateOptions } from '../utils/options-validator';
import { OPTIMIZATION_PRESETS, OptimizationOptions, PresetName } from '../models/options';
import type { HeavyTaskDescriptor, HeavyTaskHandler, HeavyTaskReport } from './types';

const MODEL_EXTENSIONS = new Set(SUPPORTED_FORMATS);
const MAX_ZIP_FILES = 300;
const MAX_ZIP_BYTES = 512 * 1024 * 1024;

export interface ModelOptimizeTaskPayload {
  filename?: string;
  preset?: PresetName;
  options?: OptimizationOptions;
}

function assertInside(parentDir: string, candidatePath: string): void {
  const parent = path.resolve(parentDir);
  const candidate = path.resolve(candidatePath);
  if (!candidate.startsWith(parent + path.sep) && candidate !== parent) {
    throw new Error(`Unsafe archive entry path: ${candidatePath}`);
  }
}

function findModelFile(dir: string, rootDir = dir, seen = { files: 0, bytes: 0 }): string | undefined {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    assertInside(rootDir, entryPath);
    if (entry.isFile()) {
      seen.files++;
      const stat = fs.statSync(entryPath);
      seen.bytes += stat.size;
      if (seen.files > MAX_ZIP_FILES || seen.bytes > MAX_ZIP_BYTES) {
        throw new Error('ZIP archive exceeds safety limits');
      }
      const ext = getFileExtension(entry.name);
      if (MODEL_EXTENSIONS.has(ext as never)) return entryPath;
    }
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    assertInside(rootDir, entryPath);
    if (entry.isDirectory() && !entry.name.startsWith('__')) {
      const found = findModelFile(entryPath, rootDir, seen);
      if (found) return found;
    }
  }
  return undefined;
}

function extractZipAndFindModel(zipPath: string, scratchDir: string): string {
  const extractDir = path.join(scratchDir, 'unzipped');
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', extractDir], { stdio: 'pipe' });
  const modelPath = findModelFile(extractDir);
  if (!modelPath) {
    throw new Error(`ZIP did not contain a supported model file: ${[...SUPPORTED_FORMATS].join(', ')}`);
  }
  return modelPath;
}

function resolveOptions(payload: ModelOptimizeTaskPayload): OptimizationOptions {
  let options: OptimizationOptions = {};
  if (payload.preset) {
    options = { ...OPTIMIZATION_PRESETS[payload.preset] };
  }
  if (payload.options) {
    options = payload.preset ? { ...options, ...payload.options } : payload.options;
  }
  const { sanitized } = validateOptions(options);
  return sanitized;
}

async function prepareInput(inputPath: string, scratchDir: string, filename?: string): Promise<string> {
  const nameForExtension = filename || inputPath;
  const ext = getFileExtension(nameForExtension);
  let modelPath = inputPath;
  let modelExt = ext;

  if (ext === '.zip') {
    modelPath = extractZipAndFindModel(inputPath, scratchDir);
    modelExt = getFileExtension(modelPath);
  }

  if (!isSupportedFormat(modelExt)) {
    throw new Error(`Unsupported input format for model.optimize: ${modelExt}`);
  }

  if (modelExt === '.glb') {
    const buffer = await fs.promises.readFile(modelPath);
    const validation = validateGlbBuffer(buffer);
    if (!validation.isValid) {
      throw new Error(validation.errors.join('; '));
    }
    return modelPath;
  }

  const convertedPath = path.join(scratchDir, 'converted.glb');
  const result = await convertToGLB(modelPath, convertedPath, path.basename(modelPath));
  if (!result.success) {
    throw new Error(`Failed to convert ${modelExt} to GLB: ${result.error}`);
  }
  return convertedPath;
}

export const modelOptimizeTaskHandler: HeavyTaskHandler<ModelOptimizeTaskPayload> = {
  type: 'model.optimize',
  async run(
    inputPath: string,
    outputPath: string,
    descriptor: HeavyTaskDescriptor<ModelOptimizeTaskPayload>
  ): Promise<HeavyTaskReport> {
    const scratchDir = path.dirname(outputPath);
    await fs.promises.mkdir(scratchDir, { recursive: true });
    const inputGlbPath = await prepareInput(inputPath, scratchDir, descriptor.payload.filename);
    const options = resolveOptions(descriptor.payload);
    const result = await executePipeline(inputGlbPath, outputPath, options);

    return {
      taskType: descriptor.type,
      success: result.success,
      metrics: {
        processingTimeMs: result.processingTime,
        originalSize: result.originalSize,
        optimizedSize: result.optimizedSize,
        compressionRatio: result.compressionRatio,
      },
      errorCode: result.success ? undefined : 'OPTIMIZATION_FAILED',
      errorMessage: result.success ? undefined : 'Optimization pipeline reported failure',
    };
  },
};
