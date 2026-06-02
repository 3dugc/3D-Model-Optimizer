/**
 * Texture Compressor Component
 *
 * Compresses textures in GLB models using KTX2/Basis Universal via toktx.
 * Falls back to sharp-based compression if toktx is not available.
 *
 * @module components/texture-compressor
 * @see Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { Document, Texture } from '@gltf-transform/core';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import sharp from 'sharp';
import logger from '../utils/logger';
import {
  TextureOptions,
  DEFAULT_TEXTURE_OPTIONS,
  TEXTURE_MODES,
} from '../models/options';
import { TextureStats, TextureDetail } from '../models/result';
import { ERROR_CODES } from '../models/error';

const execFileAsync = promisify(execFile);

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
 * Texture Compressor interface for compressing textures in GLB models.
 */
export interface TextureCompressor {
  compress(document: Document, options: TextureOptions): Promise<TextureStats>;
}

/**
 * Quality ranges for different encoding modes.
 */
const QUALITY_RANGES = {
  ETC1S: { min: 1, max: 255 },
  UASTC: { min: 0, max: 4 },
} as const;

/**
 * Default quality values for different encoding modes.
 */
const DEFAULT_QUALITY = {
  ETC1S: 128,
  UASTC: 2,
} as const;

const _TEXTURE_SLOTS = [
  'baseColorTexture',
  'normalTexture',
  'metallicRoughnessTexture',
  'occlusionTexture',
  'emissiveTexture',
] as const;

export { _TEXTURE_SLOTS as TEXTURE_SLOTS };

/**
 * Check if toktx is available
 */
async function isToktxAvailable(): Promise<boolean> {
  try {
    await execFileAsync('toktx', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate texture compression options.
 */
function validateOptions(options: TextureOptions): void {
  if (options.mode !== undefined && !TEXTURE_MODES.includes(options.mode)) {
    throw new OptimizationError(
      ERROR_CODES.INVALID_OPTIONS,
      `Invalid texture compression mode: ${options.mode}. Must be one of: ${TEXTURE_MODES.join(', ')}`,
      { field: 'mode', expected: TEXTURE_MODES.join(', '), received: String(options.mode) }
    );
  }

  if (options.quality !== undefined) {
    const mode = options.mode || 'ETC1S';
    const range = QUALITY_RANGES[mode];

    if (!Number.isInteger(options.quality)) {
      throw new OptimizationError(
        ERROR_CODES.INVALID_OPTIONS,
        `Quality must be an integer, received: ${options.quality}`,
        { field: 'quality', expected: 'integer', received: String(options.quality) }
      );
    }

    if (options.quality < range.min || options.quality > range.max) {
      throw new OptimizationError(
        ERROR_CODES.INVALID_OPTIONS,
        `Quality for ${mode} mode must be in range [${range.min}, ${range.max}], received: ${options.quality}`,
        { field: 'quality', expected: `[${range.min}, ${range.max}]`, received: String(options.quality) }
      );
    }
  }
}

function getTexturesToProcess(document: Document, slots?: string[]): Texture[] {
  const allTextures = document.getRoot().listTextures();
  if (!slots || slots.length === 0) return allTextures;

  const texturesToProcess = new Set<Texture>();
  const materials = document.getRoot().listMaterials();

  for (const material of materials) {
    for (const slot of slots) {
      let texture: Texture | null = null;
      switch (slot) {
        case 'baseColorTexture': texture = material.getBaseColorTexture(); break;
        case 'normalTexture': texture = material.getNormalTexture(); break;
        case 'metallicRoughnessTexture': texture = material.getMetallicRoughnessTexture(); break;
        case 'occlusionTexture': texture = material.getOcclusionTexture(); break;
        case 'emissiveTexture': texture = material.getEmissiveTexture(); break;
      }
      if (texture) texturesToProcess.add(texture);
    }
  }

  return Array.from(texturesToProcess);
}

/**
 * Compress a single texture using toktx (KTX2/Basis Universal)
 */
async function compressWithToktx(
  imageData: Uint8Array,
  mimeType: string,
  mode: 'ETC1S' | 'UASTC',
  quality: number
): Promise<Uint8Array> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ktx-'));
  const inputExt = mimeType === 'image/jpeg' ? '.jpg' : '.png';
  const inputPath = path.join(tmpDir, `input${inputExt}`);
  const outputPath = path.join(tmpDir, 'output.ktx2');

  try {
    // Write input image
    await fs.writeFile(inputPath, imageData);

    const args = ['--t2', '--encode', mode.toLowerCase()];
    
    if (mode === 'ETC1S') {
      // ETC1S quality: 1-255, map to clevel 1-5
      const clevel = Math.max(1, Math.min(5, Math.round(quality / 51)));
      args.push('--clevel', String(clevel));
    } else {
      // UASTC quality: 0-4
      args.push('--uastc_quality', String(quality));
      args.push('--zcmp', '19'); // Zstandard compression for UASTC
    }

    args.push(outputPath, inputPath);
    await execFileAsync('toktx', args, { timeout: 60000 });

    // Read compressed output
    const compressedData = await fs.readFile(outputPath);
    return new Uint8Array(compressedData);
  } finally {
    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Compress a single texture using sharp (fallback)
 */
async function compressWithSharp(
  imageData: Uint8Array,
  quality: number
): Promise<Uint8Array> {
  const image = sharp(imageData);
  const metadata = await image.metadata();

  // Resize if very large (max 2048px)
  let pipeline = image;
  if (metadata.width && metadata.width > 2048) {
    pipeline = pipeline.resize(2048, undefined, { fit: 'inside' });
  }
  if (metadata.height && metadata.height > 2048) {
    pipeline = pipeline.resize(undefined, 2048, { fit: 'inside' });
  }

  // Convert to WebP with quality setting (map ETC1S quality 1-255 to WebP 1-100)
  const webpQuality = Math.max(1, Math.min(100, Math.round(quality / 2.55)));
  const compressed = await pipeline.webp({ quality: webpQuality }).toBuffer();

  return new Uint8Array(compressed);
}

/**
 * Compress textures in a GLB document.
 */
export async function compressTextures(
  document: Document,
  options: TextureOptions
): Promise<TextureStats> {
  validateOptions(options);

  const mode = options.mode || DEFAULT_TEXTURE_OPTIONS.mode || 'ETC1S';
  const quality = options.quality ?? DEFAULT_QUALITY[mode];
  const texturesToProcess = getTexturesToProcess(document, options.slots);

  if (texturesToProcess.length === 0) {
    return {
      texturesProcessed: 0,
      originalSize: 0,
      compressedSize: 0,
      compressionRatio: 1,
      details: [],
    };
  }

  const useToktx = await isToktxAvailable();
  const details: TextureDetail[] = [];
  let originalSize = 0;
  let compressedSize = 0;

  let ktx2TexturesProcessed = 0;

  for (const texture of texturesToProcess) {
    const imageData = texture.getImage();
    if (!imageData) continue;

    const texOriginalSize = imageData.byteLength;
    originalSize += texOriginalSize;

    const detail: TextureDetail = {
      name: texture.getName() || 'unnamed',
      originalFormat: texture.getMimeType() || 'unknown',
      originalSize: texOriginalSize,
      compressedSize: 0,
    };

    try {
      let compressedData: Uint8Array;

      if (useToktx) {
        // Use toktx for real KTX2/Basis Universal compression
        compressedData = await compressWithToktx(
          imageData,
          texture.getMimeType() || 'image/png',
          mode,
          quality
        );
        if (ktx2TexturesProcessed === 0) {
          document.createExtension(KHRTextureBasisu).setRequired(true);
        }
        texture.setMimeType('image/ktx2');
        ktx2TexturesProcessed++;
      } else {
        // Fallback to sharp (WebP compression)
        compressedData = await compressWithSharp(imageData, quality);
        texture.setMimeType('image/webp');
      }

      texture.setImage(compressedData);
      detail.compressedSize = compressedData.byteLength;
      compressedSize += compressedData.byteLength;
    } catch (error) {
      // If compression fails, keep original
      logger.warn({ texture: detail.name, error }, 'Failed to compress texture');
      detail.compressedSize = texOriginalSize;
      compressedSize += texOriginalSize;
    }

    details.push(detail);
  }

  const compressionRatio = originalSize > 0 ? compressedSize / originalSize : 1;

  return {
    texturesProcessed: texturesToProcess.length,
    originalSize,
    compressedSize,
    compressionRatio,
    details,
    // @ts-ignore - Add info about compression method used
    method: ktx2TexturesProcessed > 0
      ? 'KTX2/Basis Universal (toktx)'
      : useToktx
        ? 'Original images (toktx failed)'
        : 'WebP (sharp fallback)',
  };
}

export function createTextureCompressor(): TextureCompressor {
  return { compress: compressTextures };
}

export default { compressTextures, createTextureCompressor };
