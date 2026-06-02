import * as path from 'path';
import * as fs from 'fs';
import { executePipeline } from '../components/optimization-pipeline';
import { prepareModelInput } from '../utils/model-input';
import { validateOptions } from '../utils/options-validator';
import { OPTIMIZATION_PRESETS, OptimizationOptions, PresetName } from '../models/options';
import type { HeavyTaskDescriptor, HeavyTaskHandler, HeavyTaskReport } from './types';

export interface ModelOptimizeTaskPayload {
  filename?: string;
  preset?: PresetName;
  options?: OptimizationOptions;
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

export const modelOptimizeTaskHandler: HeavyTaskHandler<ModelOptimizeTaskPayload> = {
  type: 'model.optimize',
  async run(
    inputPath: string,
    outputPath: string,
    descriptor: HeavyTaskDescriptor<ModelOptimizeTaskPayload>
  ): Promise<HeavyTaskReport> {
    const scratchDir = path.dirname(outputPath);
    await fs.promises.mkdir(scratchDir, { recursive: true });
    const prepared = await prepareModelInput({
      inputPath,
      scratchDir,
      originalFilename: descriptor.payload.filename || path.basename(inputPath),
      allowZip: true,
    });
    const options = resolveOptions(descriptor.payload);
    const result = await executePipeline(prepared.inputGlbPath, outputPath, options);

    return {
      taskType: descriptor.type,
      success: result.success,
      metrics: {
        processingTimeMs: result.processingTime,
        originalSize: result.originalSize,
        optimizedSize: result.optimizedSize,
        compressionRatio: result.compressionRatio,
      },
      conversion: prepared.conversion,
      errorCode: result.success ? undefined : 'OPTIMIZATION_FAILED',
      errorMessage: result.success ? undefined : 'Optimization pipeline reported failure',
    };
  },
};
