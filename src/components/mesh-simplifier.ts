/**
 * Mesh Simplifier Component
 *
 * Reduces polygon count in GLB models using meshoptimizer simplify via @gltf-transform/functions.
 * Supports target ratio, target count, error threshold, and boundary preservation options.
 *
 * @module components/mesh-simplifier
 * @see Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import { Document } from '@gltf-transform/core';
import { simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import {
  SimplifyOptions,
  DEFAULT_SIMPLIFY_OPTIONS,
  SIMPLIFY_RATIO_RANGE,
} from '../models/options';
import { SimplifyStats } from '../models/result';
import { ERROR_CODES } from '../models/error';

/**
 * Custom error class for optimization errors.
 */
export class OptimizationError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'OptimizationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Mesh Simplifier interface for reducing polygon count in GLB models.
 */
export interface MeshSimplifier {
  /**
   * Simplify meshes in a gltf-transform Document.
   *
   * @param document - The gltf-transform Document to process
   * @param options - Simplification options
   * @returns Statistics about the simplification operation
   * @throws OptimizationError if options are invalid
   */
  simplify(document: Document, options: SimplifyOptions): Promise<SimplifyStats>;
}

/**
 * Count the total number of triangles in a document.
 *
 * @param document - The gltf-transform Document
 * @returns Total number of triangles across all meshes
 */
function countTriangles(document: Document): number {
  let totalTriangles = 0;

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      if (indices) {
        // Indexed geometry: triangle count = index count / 3
        totalTriangles += indices.getCount() / 3;
      } else {
        // Non-indexed geometry: use position accessor
        const position = primitive.getAttribute('POSITION');
        if (position) {
          totalTriangles += position.getCount() / 3;
        }
      }
    }
  }

  return Math.floor(totalTriangles);
}

/**
 * Count the number of meshes in a document.
 *
 * @param document - The gltf-transform Document
 * @returns Number of meshes
 */
function countMeshes(document: Document): number {
  return document.getRoot().listMeshes().length;
}

/**
 * Validate simplification options.
 *
 * @param options - The options to validate
 * @throws OptimizationError if options are invalid
 */
function validateOptions(options: SimplifyOptions): void {
  // Check if both targetRatio and targetCount are specified
  if (options.targetRatio !== undefined && options.targetCount !== undefined) {
    throw new OptimizationError(
      ERROR_CODES.INVALID_OPTIONS,
      'Cannot specify both targetRatio and targetCount. Use one or the other.',
      {
        field: 'targetRatio/targetCount',
        expected: 'Only one of targetRatio or targetCount',
        received: 'Both specified',
      }
    );
  }

  // Validate targetRatio range
  if (options.targetRatio !== undefined) {
    if (
      options.targetRatio <= 0 ||
      options.targetRatio > SIMPLIFY_RATIO_RANGE.max
    ) {
      throw new OptimizationError(
        ERROR_CODES.INVALID_OPTIONS,
        `Target ratio must be in range (0, ${SIMPLIFY_RATIO_RANGE.max}]`,
        {
          field: 'targetRatio',
          expected: `(0, ${SIMPLIFY_RATIO_RANGE.max}]`,
          received: String(options.targetRatio),
        }
      );
    }
  }

  // Validate targetCount
  if (options.targetCount !== undefined) {
    if (options.targetCount <= 0 || !Number.isInteger(options.targetCount)) {
      throw new OptimizationError(
        ERROR_CODES.INVALID_OPTIONS,
        'Target count must be a positive integer',
        {
          field: 'targetCount',
          expected: 'Positive integer',
          received: String(options.targetCount),
        }
      );
    }
  }

  // Validate error threshold
  if (options.error !== undefined) {
    if (options.error < 0 || options.error > 1) {
      throw new OptimizationError(
        ERROR_CODES.INVALID_OPTIONS,
        'Error threshold must be in range [0, 1]',
        {
          field: 'error',
          expected: '[0, 1]',
          received: String(options.error),
        }
      );
    }
  }
}

/**
 * Simplify meshes in a GLB document using meshoptimizer.
 *
 * Uses @gltf-transform/functions simplify() with meshoptimizer to reduce polygon count
 * while preserving visual quality. Supports target ratio, target count, error threshold,
 * and boundary edge preservation.
 *
 * @param document - The gltf-transform Document to process
 * @param options - Simplification options including:
 *   - targetRatio: Target ratio of triangles to keep (0.01 - 1.0)
 *   - targetCount: Target number of triangles
 *   - error: Error threshold for simplification quality (0.0 - 1.0)
 *   - lockBorder: Whether to preserve boundary edges
 * @returns Statistics about the simplification operation including:
 *   - originalTriangles: Number of triangles before simplification
 *   - simplifiedTriangles: Number of triangles after simplification
 *   - reductionRatio: Ratio of simplified to original triangles
 *   - meshesProcessed: Number of meshes that were processed
 *
 * @throws OptimizationError if options are invalid (e.g., targetRatio out of range)
 *
 * @example
 * ```typescript
 * import { Document } from '@gltf-transform/core';
 * import { simplifyMesh } from './mesh-simplifier';
 *
 * const document = new Document();
 * // ... load or create document ...
 *
 * const stats = await simplifyMesh(document, {
 *   enabled: true,
 *   targetRatio: 0.5,  // Reduce to 50% of original triangles
 *   error: 0.01,       // Low error threshold for high quality
 *   lockBorder: true,  // Preserve boundary edges
 * });
 *
 * console.log(`Original triangles: ${stats.originalTriangles}`);
 * console.log(`Simplified triangles: ${stats.simplifiedTriangles}`);
 * console.log(`Reduction ratio: ${stats.reductionRatio}`);
 * ```
 *
 * @see Requirements 2.1 - Simplify to target triangle count
 * @see Requirements 2.2 - Simplify to target ratio
 * @see Requirements 2.3 - Validate target ratio range
 * @see Requirements 2.4 - Support boundary edge preservation
 * @see Requirements 2.5 - Support error threshold control
 * @see Requirements 2.6 - Return simplification statistics
 */
export async function simplifyMesh(
  document: Document,
  options: SimplifyOptions
): Promise<SimplifyStats> {
  // Validate options
  validateOptions(options);

  // Merge with default options
  const mergedOptions: SimplifyOptions = {
    ...DEFAULT_SIMPLIFY_OPTIONS,
    ...options,
  };

  // Count triangles and meshes before simplification
  const originalTriangles = countTriangles(document);
  const meshesProcessed = countMeshes(document);

  // If no triangles or meshes, return early
  if (originalTriangles === 0 || meshesProcessed === 0) {
    return {
      originalTriangles: 0,
      simplifiedTriangles: 0,
      reductionRatio: 1,
      meshesProcessed: 0,
    };
  }

  // Calculate target ratio
  let targetRatio: number;
  if (mergedOptions.targetCount !== undefined) {
    // Convert target count to ratio
    targetRatio = Math.min(1, mergedOptions.targetCount / originalTriangles);
  } else if (mergedOptions.targetRatio !== undefined) {
    targetRatio = mergedOptions.targetRatio;
  } else {
    // Default to 50% if neither is specified
    targetRatio = 0.5;
  }

  // Initialize meshoptimizer
  await MeshoptSimplifier.ready;

  // First, weld vertices to ensure proper simplification
  await document.transform(weld());

  // Apply simplification transform
  await document.transform(
    simplify({
      simplifier: MeshoptSimplifier,
      ratio: targetRatio,
      error: mergedOptions.error ?? DEFAULT_SIMPLIFY_OPTIONS.error ?? 0.01,
      lockBorder: mergedOptions.lockBorder ?? DEFAULT_SIMPLIFY_OPTIONS.lockBorder ?? false,
    })
  );

  // Count triangles after simplification
  const simplifiedTriangles = countTriangles(document);

  // Calculate reduction ratio
  const reductionRatio =
    originalTriangles > 0 ? simplifiedTriangles / originalTriangles : 1;

  // Return statistics
  const stats: SimplifyStats = {
    originalTriangles,
    simplifiedTriangles,
    reductionRatio,
    meshesProcessed,
  };

  return stats;
}

/**
 * Create a MeshSimplifier instance.
 *
 * @returns A MeshSimplifier instance
 */
export function createMeshSimplifier(): MeshSimplifier {
  return {
    simplify: simplifyMesh,
  };
}

/**
 * Default export for convenience.
 */
export default {
  simplifyMesh,
  createMeshSimplifier,
};
