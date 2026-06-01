/**
 * Optimization Options Validator
 *
 * Validates and clamps optimization options to safe ranges.
 */

import {
  DEFAULT_EXTENSION_OPTIONS,
  OptimizationOptions,
  SIMPLIFY_RATIO_RANGE,
  DRACO_COMPRESSION_LEVEL_RANGE,
  TEXTURE_MODES,
} from '../models/options';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitized: OptimizationOptions;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function validateOptions(raw: OptimizationOptions): ValidationResult {
  const errors: string[] = [];
  const sanitized: OptimizationOptions = { ...raw };

  if (sanitized.extensions) {
    sanitized.extensions = {
      ...DEFAULT_EXTENSION_OPTIONS,
      ...sanitized.extensions,
      preserveUnlit: sanitized.extensions.preserveUnlit !== false,
    };
  }

  // Simplify
  if (sanitized.simplify?.enabled) {
    const s = { ...sanitized.simplify };
    if (s.targetRatio !== undefined) {
      if (typeof s.targetRatio !== 'number' || isNaN(s.targetRatio)) {
        errors.push(`simplify.targetRatio must be a number`);
        s.targetRatio = 0.5;
      } else {
        s.targetRatio = clamp(s.targetRatio, SIMPLIFY_RATIO_RANGE.min, SIMPLIFY_RATIO_RANGE.max);
      }
    }
    if (s.targetCount !== undefined) {
      if (typeof s.targetCount !== 'number' || s.targetCount < 1) {
        errors.push(`simplify.targetCount must be a positive integer`);
        s.targetCount = undefined;
      } else {
        s.targetCount = Math.round(s.targetCount);
      }
    }
    if (s.error !== undefined) {
      s.error = clamp(Number(s.error) || 0.01, 0, 1);
    }
    sanitized.simplify = s;
  }

  // Draco
  if (sanitized.draco?.enabled) {
    const d = { ...sanitized.draco };
    if (d.compressionLevel !== undefined) {
      d.compressionLevel = clamp(
        Math.round(Number(d.compressionLevel) || 7),
        DRACO_COMPRESSION_LEVEL_RANGE.min,
        DRACO_COMPRESSION_LEVEL_RANGE.max,
      );
    }
    for (const key of ['quantizePosition', 'quantizeNormal', 'quantizeTexcoord'] as const) {
      if (d[key] !== undefined) {
        d[key] = clamp(Math.round(Number(d[key]) || 10), 1, 30);
      }
    }
    sanitized.draco = d;
  }

  // Texture
  if (sanitized.texture?.enabled) {
    const t = { ...sanitized.texture };
    if (t.mode && !TEXTURE_MODES.includes(t.mode as any)) {
      errors.push(`texture.mode must be one of: ${TEXTURE_MODES.join(', ')}`);
      t.mode = 'ETC1S';
    }
    if (t.quality !== undefined) {
      const max = t.mode === 'UASTC' ? 4 : 255;
      t.quality = clamp(Math.round(Number(t.quality) || 128), 1, max);
    }
    sanitized.texture = t;
  }

  return { valid: errors.length === 0, errors, sanitized };
}
