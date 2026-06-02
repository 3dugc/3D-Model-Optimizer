/**
 * Optimization Options Interfaces
 *
 * This module defines all configuration interfaces for GLB model optimization.
 * Each interface corresponds to a specific optimization capability:
 * - SimplifyOptions: Mesh simplification using meshoptimizer
 * - DracoOptions: Draco geometry compression
 * - TextureOptions: Texture compression using Basis Universal (KHR_texture_basisu)
 * - QuantizeOptions: Vertex attribute quantization
 * - MergeOptions: Mesh merging for draw call reduction
 * - CleanOptions: Unused resource cleanup
 *
 * @module models/options
 */

/**
 * Mesh simplification options using meshoptimizer simplify.
 * Reduces polygon count while preserving visual quality.
 *
 * @see Requirements 2.1-2.6
 */
export interface SimplifyOptions {
  /**
   * Enable/disable mesh simplification.
   */
  enabled: boolean;

  /**
   * Target ratio for mesh simplification.
   * Value range: 0.01 - 1.0 (1% to 100% of original triangles).
   * Either targetRatio or targetCount should be specified, not both.
   *
   * @example 0.5 // Reduce to 50% of original triangles
   */
  targetRatio?: number;

  /**
   * Target triangle count after simplification.
   * Either targetRatio or targetCount should be specified, not both.
   *
   * @example 10000 // Reduce to 10,000 triangles
   */
  targetCount?: number;

  /**
   * Error threshold for simplification quality.
   * Value range: 0.0 - 1.0 (lower = higher quality, less reduction).
   * Controls how much the simplified mesh can deviate from the original.
   *
   * @default 0.01
   */
  error?: number;

  /**
   * Preserve boundary edges during simplification.
   * When true, edges at mesh boundaries will not be collapsed.
   *
   * @default false
   */
  lockBorder?: boolean;
}

/**
 * Draco geometry compression options.
 * Uses google/draco for efficient geometry data compression.
 *
 * @see Requirements 3.1-3.4
 */
export interface DracoOptions {
  /**
   * Enable/disable Draco compression.
   */
  enabled: boolean;

  /**
   * Compression level for Draco encoder.
   * Value range: 0-10 (higher = better compression, slower encoding).
   *
   * @default 7
   */
  compressionLevel?: number;

  /**
   * Quantization bits for position attributes.
   * Value range: 1-30 (higher = more precision, larger file).
   *
   * @default 14
   */
  quantizePosition?: number;

  /**
   * Quantization bits for normal attributes.
   * Value range: 1-30 (higher = more precision, larger file).
   *
   * @default 10
   */
  quantizeNormal?: number;

  /**
   * Quantization bits for texture coordinate (UV) attributes.
   * Value range: 1-30 (higher = more precision, larger file).
   *
   * @default 12
   */
  quantizeTexcoord?: number;
}

/**
 * Texture compression options using Basis Universal (KHR_texture_basisu).
 * Converts textures to GPU-friendly KTX2 format compatible with Unity and Web.
 *
 * @see Requirements 4.1-4.6
 */
export interface TextureOptions {
  /**
   * Enable/disable texture compression.
   */
  enabled: boolean;

  /**
   * Encoding mode for Basis Universal compression.
   * - 'ETC1S': Better compression ratio, suitable for most textures
   * - 'UASTC': Higher quality, larger file size, better for normal maps
   *
   * @default 'ETC1S'
   */
  mode?: 'ETC1S' | 'UASTC';

  /**
   * Quality parameter for texture compression.
   * For ETC1S: 1-255 (higher = better quality)
   * For UASTC: 0-4 (higher = better quality)
   *
   * @default 128 for ETC1S, 2 for UASTC
   */
  quality?: number;

  /**
   * Specific texture slots to compress.
   * If not specified, all textures will be compressed.
   *
   * @example ['baseColorTexture', 'normalTexture']
   */
  slots?: string[];
}

/**
 * Vertex attribute quantization options.
 * Uses gltf-transform quantize for reducing vertex data precision.
 *
 * @see Requirements 5.1-5.7
 */
export interface QuantizeOptions {
  /**
   * Enable/disable vertex quantization.
   */
  enabled: boolean;

  /**
   * Quantize position (POSITION) attributes.
   * Reduces precision of vertex positions.
   *
   * @default true
   */
  quantizePosition?: boolean;

  /**
   * Quantize normal (NORMAL) attributes.
   * Reduces precision of vertex normals.
   *
   * @default true
   */
  quantizeNormal?: boolean;

  /**
   * Quantize texture coordinate (TEXCOORD_*) attributes.
   * Reduces precision of UV coordinates.
   *
   * @default true
   */
  quantizeTexcoord?: boolean;

  /**
   * Quantize vertex color (COLOR_*) attributes.
   * Reduces precision of vertex colors.
   *
   * @default true
   */
  quantizeColor?: boolean;
}

/**
 * Mesh merge options.
 * Combines meshes with the same material to reduce draw calls.
 *
 * @see Requirements 6.1-6.3
 */
export interface MergeOptions {
  /**
   * Enable/disable mesh merging.
   */
  enabled: boolean;
}

/**
 * Resource cleanup options.
 * Removes unused nodes, materials, and textures from the model.
 *
 * @see Requirements 7.1-7.3
 */
export interface CleanOptions {
  /**
   * Enable/disable resource cleanup.
   */
  enabled: boolean;

  /**
   * Remove unused nodes from the scene graph.
   *
   * @default true
   */
  removeUnusedNodes?: boolean;

  /**
   * Remove unused materials not referenced by any mesh.
   *
   * @default true
   */
  removeUnusedMaterials?: boolean;

  /**
   * Remove unused textures not referenced by any material.
   *
   * @default true
   */
  removeUnusedTextures?: boolean;
}

/**
 * Optional glTF extension handling options.
 */
export interface ExtensionOptions {
  /**
   * Preserve KHR_materials_unlit so materials keep their original unlit rendering.
   *
   * @default true
   */
  preserveUnlit?: boolean;
}

/**
 * Complete optimization options for the GLB optimization pipeline.
 * Combines all individual optimization options into a single configuration object.
 *
 * The optimization pipeline executes in the following order:
 * 1. repair-input - Geometry repair before optimization
 * 2. clean - Resource cleanup
 * 3. merge - Mesh merging
 * 4. simplify - Mesh simplification
 * 5. quantize - Vertex quantization
 * 6. draco - Draco compression
 * 7. texture - Texture compression
 * 8. repair-output - Geometry repair after optimization
 *
 * @see Requirements 8.1-8.5
 */
export interface OptimizationOptions {
  /**
   * Optional glTF extension handling options.
   */
  extensions?: ExtensionOptions;

  /**
   * Mesh simplification options using meshoptimizer.
   * Reduces polygon count while preserving visual quality.
   */
  simplify?: SimplifyOptions;

  /**
   * Draco geometry compression options.
   * Compresses geometry data for smaller file sizes.
   */
  draco?: DracoOptions;

  /**
   * Texture compression options using Basis Universal.
   * Converts textures to GPU-friendly KTX2 format.
   */
  texture?: TextureOptions;

  /**
   * Vertex attribute quantization options.
   * Reduces vertex data precision for smaller file sizes.
   */
  quantize?: QuantizeOptions;

  /**
   * Mesh merge options.
   * Combines meshes with the same material.
   */
  merge?: MergeOptions;

  /**
   * Resource cleanup options.
   * Removes unused resources from the model.
   */
  clean?: CleanOptions;
}

/**
 * Default values for SimplifyOptions.
 */
export const DEFAULT_SIMPLIFY_OPTIONS: Partial<SimplifyOptions> = {
  error: 0.01,
  lockBorder: false,
};

/**
 * Default values for DracoOptions.
 */
export const DEFAULT_DRACO_OPTIONS: Partial<DracoOptions> = {
  compressionLevel: 7,
  quantizePosition: 14,
  quantizeNormal: 10,
  quantizeTexcoord: 12,
};

/**
 * Default values for TextureOptions.
 */
export const DEFAULT_TEXTURE_OPTIONS: Partial<TextureOptions> = {
  mode: 'ETC1S',
  quality: 128,
};

/**
 * Default values for QuantizeOptions.
 */
export const DEFAULT_QUANTIZE_OPTIONS: Partial<QuantizeOptions> = {
  quantizePosition: true,
  quantizeNormal: true,
  quantizeTexcoord: true,
  quantizeColor: true,
};

/**
 * Default values for CleanOptions.
 */
export const DEFAULT_CLEAN_OPTIONS: Partial<CleanOptions> = {
  removeUnusedNodes: true,
  removeUnusedMaterials: true,
  removeUnusedTextures: true,
};

/**
 * Default values for ExtensionOptions.
 */
export const DEFAULT_EXTENSION_OPTIONS: Required<ExtensionOptions> = {
  preserveUnlit: true,
};

/**
 * Valid range for simplify target ratio.
 */
export const SIMPLIFY_RATIO_RANGE = {
  min: 0.01,
  max: 1.0,
} as const;

/**
 * Valid range for Draco compression level.
 */
export const DRACO_COMPRESSION_LEVEL_RANGE = {
  min: 0,
  max: 10,
} as const;

/**
 * Valid texture compression modes.
 */
export const TEXTURE_MODES = ['ETC1S', 'UASTC'] as const;
export type TextureMode = (typeof TEXTURE_MODES)[number];

/**
 * Optimization presets for quick configuration.
 * Users can select a preset instead of configuring each option manually.
 */
export type PresetName = 'fast' | 'balanced' | 'maximum';

export const OPTIMIZATION_PRESETS: Record<PresetName, OptimizationOptions> = {
  /** Fast: minimal processing, quick results */
  fast: {
    extensions: { preserveUnlit: true },
    clean: { enabled: true, removeUnusedNodes: true, removeUnusedMaterials: true, removeUnusedTextures: true },
    merge: { enabled: false },
    simplify: { enabled: false },
    quantize: { enabled: false },
    draco: { enabled: true, compressionLevel: 3 },
    texture: { enabled: false },
  },
  /** Balanced: good compression with reasonable quality */
  balanced: {
    extensions: { preserveUnlit: true },
    clean: { enabled: true, removeUnusedNodes: true, removeUnusedMaterials: true, removeUnusedTextures: true },
    merge: { enabled: true },
    simplify: { enabled: true, targetRatio: 0.75, error: 0.01 },
    quantize: { enabled: false },
    draco: { enabled: true, compressionLevel: 7 },
    texture: { enabled: true, mode: 'ETC1S', quality: 128 },
  },
  /** Maximum: aggressive compression for smallest file size */
  maximum: {
    extensions: { preserveUnlit: true },
    clean: { enabled: true, removeUnusedNodes: true, removeUnusedMaterials: true, removeUnusedTextures: true },
    merge: { enabled: true },
    simplify: { enabled: true, targetRatio: 0.5, error: 0.02 },
    quantize: { enabled: false },
    draco: { enabled: true, compressionLevel: 10 },
    texture: { enabled: true, mode: 'ETC1S', quality: 80 },
  },
};
