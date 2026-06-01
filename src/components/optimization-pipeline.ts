/**
 * Optimization Pipeline Component
 *
 * Coordinates the execution of all optimization components in the correct order.
 * The pipeline executes: clean → merge → simplify → quantize → draco → texture
 *
 * Features:
 * - Supports any combination of optimization options
 * - Implements failure isolation - stops on first error
 * - Collects timing and statistics for each step
 * - Returns complete optimization report
 *
 * @module components/optimization-pipeline
 * @see Requirements 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { Document, NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu } from '@gltf-transform/extensions';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { OptimizationOptions } from '../models/options';

/**
 * Progress callback type for reporting pipeline step progress.
 */
export type ProgressCallback = (event: {
  step: string;
  status: 'start' | 'done' | 'error';
  index: number;
  total: number;
  duration?: number;
  error?: string;
}) => void;
import {
  OptimizationResult,
  OptimizationStepResult,
  createSuccessStepResult,
  createFailedStepResult,
  createOptimizationResult,
} from '../models/result';
import { ERROR_CODES } from '../models/error';

// Import optimization components
import { clean } from './resource-cleaner';
import { merge } from './mesh-merger';
import { simplifyMesh } from './mesh-simplifier';
import { quantizeVertices } from './vertex-quantizer';
import { compressDraco } from './draco-compressor';
import { compressTextures } from './texture-compressor';
import { repairInput, repairOutput } from './geometry-fixer';
import { getDracoModules } from './draco-singleton';

/**
 * Optimization step names in execution order.
 *
 * @see Requirements 8.5 - Pipeline execution order
 */
export const OPTIMIZATION_ORDER = [
  'repair-input',  // 0. 输入修复 (always runs)
  'clean',         // 1. 资源清理
  'merge',         // 2. Mesh 合并
  'simplify',      // 3. 网格减面
  'quantize',      // 4. 向量量化
  'draco',         // 5. Draco 压缩
  'texture',       // 6. 纹理压缩
  'repair-output', // 7. 输出修复 (always runs)
] as const;

export type OptimizationStepName = (typeof OPTIMIZATION_ORDER)[number];

/**
 * Custom error class for pipeline errors.
 */
export class PipelineError extends Error {
  code: string;
  step?: string;
  details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    step?: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.step = step;
    this.details = details;
  }
}

/**
 * Optimization Pipeline interface.
 */
export interface OptimizationPipeline {
  /**
   * Execute the optimization pipeline.
   *
   * @param inputPath - Path to the input GLB file
   * @param outputPath - Path to save the optimized GLB file
   * @param options - Optimization options specifying which steps to execute
   * @returns Complete optimization result with statistics
   */
  execute(
    inputPath: string,
    outputPath: string,
    options: OptimizationOptions
  ): Promise<OptimizationResult>;
}

/**
 * Check if a step is enabled in the options.
 *
 * @param step - The step name to check
 * @param options - The optimization options
 * @returns True if the step is enabled
 */
function isStepEnabled(
  step: OptimizationStepName,
  options: OptimizationOptions
): boolean {
  switch (step) {
    case 'repair-input':
      return true; // always run
    case 'repair-output':
      return true; // always run
    case 'clean':
      return options.clean?.enabled ?? false;
    case 'merge':
      return options.merge?.enabled ?? false;
    case 'simplify':
      return options.simplify?.enabled ?? false;
    case 'quantize':
      return options.quantize?.enabled ?? false;
    case 'draco':
      return options.draco?.enabled ?? false;
    case 'texture':
      return options.texture?.enabled ?? false;
    default:
      return false;
  }
}

function shouldPreserveUnlit(options: OptimizationOptions): boolean {
  return options.extensions?.preserveUnlit !== false;
}

/**
 * Execute a single optimization step.
 *
 * @param step - The step name to execute
 * @param document - The gltf-transform Document
 * @param options - The optimization options
 * @returns The step result with statistics
 */
async function executeStep(
  step: OptimizationStepName,
  document: Document,
  options: OptimizationOptions
): Promise<OptimizationStepResult> {
  const startTime = Date.now();

  try {
    let stats: Record<string, unknown>;

    switch (step) {
      case 'repair-input':
        stats = { ...(await repairInput(document)) };
        break;

      case 'clean':
        stats = { ...(await clean(document, options.clean)) };
        break;

      case 'merge':
        stats = { ...(await merge(document)) };
        break;

      case 'simplify':
        if (!options.simplify) {
          throw new Error('Simplify options not provided');
        }
        stats = { ...(await simplifyMesh(document, options.simplify)) };
        break;

      case 'quantize':
        stats = { ...(await quantizeVertices(document, options.quantize)) };
        break;

      case 'draco':
        if (!options.draco) {
          throw new Error('Draco options not provided');
        }
        stats = { ...(await compressDraco(document, options.draco)) };
        break;

      case 'texture':
        if (!options.texture) {
          throw new Error('Texture options not provided');
        }
        stats = { ...(await compressTextures(document, options.texture)) };
        break;

      case 'repair-output':
        stats = { ...(await repairOutput(document)) };
        break;

      default:
        throw new Error(`Unknown optimization step: ${step}`);
    }

    const duration = Date.now() - startTime;
    return createSuccessStepResult(step, duration, stats);
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    return createFailedStepResult(step, duration, errorMessage);
  }
}

/**
 * Get the file size in bytes.
 *
 * @param filePath - Path to the file
 * @returns File size in bytes, or 0 if file doesn't exist
 */
/**
 * Get the file size in bytes (async).
 */
async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

/**
 * Execute the optimization pipeline on a GLB file.
 *
 * Reads the input GLB file, executes enabled optimization steps in order,
 * and writes the optimized result to the output path.
 *
 * @param inputPath - Path to the input GLB file
 * @param outputPath - Path to save the optimized GLB file
 * @param options - Optimization options specifying which steps to execute
 * @returns Complete optimization result with statistics
 *
 * @throws PipelineError if the input file cannot be read or output cannot be written
 *
 * @example
 * ```typescript
 * const result = await executePipeline(
 *   'input.glb',
 *   'output.glb',
 *   {
 *     clean: { enabled: true },
 *     simplify: { enabled: true, targetRatio: 0.5 },
 *     draco: { enabled: true, compressionLevel: 7 },
 *   }
 * );
 *
 * console.log(`Processing time: ${result.processingTime}ms`);
 * console.log(`Compression ratio: ${result.compressionRatio}`);
 * ```
 *
 * @see Requirements 8.1 - Execute optimization steps in order
 * @see Requirements 8.2 - Support any combination of optimization options
 * @see Requirements 8.3 - Stop on failure and report failed step
 * @see Requirements 8.4 - Return complete optimization report
 * @see Requirements 8.5 - Execute in order: clean → merge → simplify → quantize → draco → texture
 */
export async function executePipeline(
  inputPath: string,
  outputPath: string,
  options: OptimizationOptions,
  onProgress?: ProgressCallback
): Promise<OptimizationResult> {
  const taskId = uuidv4();
  const startTime = Date.now();
  const steps: OptimizationStepResult[] = [];

  // Get original file size
  const originalSize = await getFileSize(inputPath);
  if (originalSize === 0) {
    throw new PipelineError(
      ERROR_CODES.INVALID_FILE,
      `Input file not found or empty: ${inputPath}`,
      undefined,
      { inputPath }
    );
  }

  // Create NodeIO with extensions
  const registeredExtensions = shouldPreserveUnlit(options)
    ? [KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu]
    : [KHRDracoMeshCompression, KHRTextureBasisu];
  const io = new NodeIO()
    .registerExtensions(registeredExtensions)
    .registerDependencies(await getDracoModules());

  // Read the input GLB file
  let document: Document;
  try {
    document = await io.read(inputPath);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    throw new PipelineError(
      ERROR_CODES.INVALID_FILE,
      `Failed to read input file: ${errorMessage}`,
      undefined,
      { inputPath, originalError: errorMessage }
    );
  }

  // Count enabled steps for progress reporting
  const enabledSteps = OPTIMIZATION_ORDER.filter(s => isStepEnabled(s, options));
  const totalSteps = enabledSteps.length;

  // Execute enabled steps in order
  for (const step of OPTIMIZATION_ORDER) {
    if (!isStepEnabled(step, options)) {
      continue;
    }

    const stepIndex = enabledSteps.indexOf(step);
    onProgress?.({ step, status: 'start', index: stepIndex, total: totalSteps });

    const stepResult = await executeStep(step, document, options);
    steps.push(stepResult);

    if (!stepResult.success) {
      onProgress?.({ step, status: 'error', index: stepIndex, total: totalSteps, duration: stepResult.duration, error: stepResult.error });
    } else {
      onProgress?.({ step, status: 'done', index: stepIndex, total: totalSteps, duration: stepResult.duration });
    }

    // Stop on failure (Requirement 8.3)
    if (!stepResult.success) {
      const processingTime = Date.now() - startTime;
      return createOptimizationResult({
        taskId,
        success: false,
        processingTime,
        originalSize,
        optimizedSize: originalSize, // No output on failure
        steps,
      });
    }
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write the optimized GLB file
  try {
    await io.write(outputPath, document);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    throw new PipelineError(
      ERROR_CODES.OPTIMIZATION_FAILED,
      `Failed to write output file: ${errorMessage}`,
      'write',
      { outputPath, originalError: errorMessage }
    );
  }

  // Get optimized file size
  const optimizedSize = await getFileSize(outputPath);

  const processingTime = Date.now() - startTime;

  return createOptimizationResult({
    taskId,
    success: true,
    processingTime,
    originalSize,
    optimizedSize,
    steps,
  });
}

/**
 * Create an OptimizationPipeline instance.
 *
 * @returns An OptimizationPipeline instance
 */
export function createOptimizationPipeline(): OptimizationPipeline {
  return {
    execute: executePipeline,
  };
}

/**
 * Default export for convenience.
 */
export default {
  executePipeline,
  createOptimizationPipeline,
  OPTIMIZATION_ORDER,
};
