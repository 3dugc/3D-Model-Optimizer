/**
 * Analyze Route
 *
 * Analyzes 3D model files and returns detailed information.
 * Implements POST /api/analyze endpoint.
 *
 * @module routes/analyze
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu } from '@gltf-transform/extensions';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getDracoModules } from '../components/draco-singleton';
import { getFileExtension } from '../components/format-converter';
import { createModelUpload, cleanupUploadedFile } from '../utils/model-upload';
import { decodeUploadFilename, prepareModelInput } from '../utils/model-input';
import { OptimizationError, ERROR_CODES } from '../models/error';
import { requireWebUser } from '../middleware';

const router = Router();

// Configure multer
const upload = createModelUpload({ allowZip: true });
const MAX_PREVIEW_GLB_BYTES = 30 * 1024 * 1024;

/**
 * Model analysis result interface.
 */
interface ModelAnalysis {
  filename: string;
  fileSize: number;
  format: string;
  converted: boolean;
  analysisAvailable: boolean;
  previewAvailable: boolean;
  previewMessage?: string;
  conversionTime?: number;
  meshes: {
    count: number;
    totalTriangles: number;
    totalVertices: number;
    details: Array<{
      name: string;
      triangles: number;
      vertices: number;
      hasDraco: boolean;
    }>;
  };
  materials: {
    count: number;
    details: Array<{
      name: string;
      hasBaseColorTexture: boolean;
      hasNormalTexture: boolean;
      hasMetallicRoughnessTexture: boolean;
      hasOcclusionTexture: boolean;
      hasEmissiveTexture: boolean;
    }>;
  };
  textures: {
    count: number;
    totalSize: number;
    details: Array<{
      name: string;
      mimeType: string;
      size: number;
      width?: number;
      height?: number;
      isKTX2: boolean;
    }>;
  };
  extensions: string[];
  hasDraco: boolean;
  hasKTX2: boolean;
  nodes: number;
  scenes: number;
  animations: number;
}

/**
 * Analyze a GLB document.
 */
async function analyzeDocument(document: Document, filename: string, fileSize: number): Promise<ModelAnalysis> {
  const root = document.getRoot();

  // Check extensions
  const extensions = root.listExtensionsUsed().map((ext) => ext.extensionName);
  const hasDraco = extensions.includes('KHR_draco_mesh_compression');
  const hasKTX2 = extensions.includes('KHR_texture_basisu');

  // Analyze meshes
  const meshes = root.listMeshes();
  let totalTriangles = 0;
  let totalVertices = 0;
  const meshDetails = meshes.map((mesh) => {
    let triangles = 0;
    let vertices = 0;
    let meshHasDraco = false;

    for (const prim of mesh.listPrimitives()) {
      const posAccessor = prim.getAttribute('POSITION');
      if (posAccessor) {
        const count = posAccessor.getCount();
        vertices += count;
        // Estimate triangles (assuming triangles mode)
        const indices = prim.getIndices();
        if (indices) {
          triangles += indices.getCount() / 3;
        } else {
          triangles += count / 3;
        }
      }
      // Check for Draco extension on primitive
      if (prim.getExtension('KHR_draco_mesh_compression')) {
        meshHasDraco = true;
      }
    }

    totalTriangles += triangles;
    totalVertices += vertices;

    return {
      name: mesh.getName() || 'unnamed',
      triangles: Math.round(triangles),
      vertices,
      hasDraco: meshHasDraco || hasDraco,
    };
  });

  // Analyze materials
  const materials = root.listMaterials();
  const materialDetails = materials.map((mat) => ({
    name: mat.getName() || 'unnamed',
    hasBaseColorTexture: !!mat.getBaseColorTexture(),
    hasNormalTexture: !!mat.getNormalTexture(),
    hasMetallicRoughnessTexture: !!mat.getMetallicRoughnessTexture(),
    hasOcclusionTexture: !!mat.getOcclusionTexture(),
    hasEmissiveTexture: !!mat.getEmissiveTexture(),
  }));

  // Analyze textures
  const textures = root.listTextures();
  let totalTextureSize = 0;
  const textureDetails = textures.map((tex) => {
    const image = tex.getImage();
    const size = image ? image.byteLength : 0;
    totalTextureSize += size;

    const mimeType = tex.getMimeType() || 'unknown';
    const isKTX2 = mimeType.includes('ktx2') || hasKTX2;

    return {
      name: tex.getName() || 'unnamed',
      mimeType,
      size,
      isKTX2,
    };
  });

  return {
    filename,
    fileSize,
    format: 'GLB',
    converted: false,
    analysisAvailable: true,
    previewAvailable: true,
    meshes: {
      count: meshes.length,
      totalTriangles: Math.round(totalTriangles),
      totalVertices,
      details: meshDetails,
    },
    materials: {
      count: materials.length,
      details: materialDetails,
    },
    textures: {
      count: textures.length,
      totalSize: totalTextureSize,
      details: textureDetails,
    },
    extensions,
    hasDraco,
    hasKTX2,
    nodes: root.listNodes().length,
    scenes: root.listScenes().length,
    animations: root.listAnimations().length,
  };
}

function isBrowserPreviewFormat(ext: string): boolean {
  return ['.glb', '.gltf', '.obj', '.stl', '.usdz', '.fbx', '.dae'].includes(ext);
}

function buildLightAnalysis(filename: string, fileSize: number, ext: string): ModelAnalysis {
  const format = ext ? ext.slice(1).toUpperCase() : 'UNKNOWN';
  const previewAvailable = isBrowserPreviewFormat(ext);
  return {
    filename,
    fileSize,
    format,
    converted: false,
    analysisAvailable: false,
    previewAvailable,
    previewMessage: previewAvailable
      ? '可尝试浏览器本地预览；深度分析将在弹性服务器优化任务中完成。'
      : '该格式暂不支持浏览器预览，需提交弹性服务器转换和优化。',
    meshes: { count: 0, totalTriangles: 0, totalVertices: 0, details: [] },
    materials: { count: 0, details: [] },
    textures: { count: 0, totalSize: 0, details: [] },
    extensions: [],
    hasDraco: false,
    hasKTX2: false,
    nodes: 0,
    scenes: 0,
    animations: 0,
  };
}

function previewFilename(originalFilename: string): string {
  const basename = path.basename(originalFilename, path.extname(originalFilename)) || 'model';
  return `${basename.replace(/[^a-z0-9._-]+/gi, '_') || 'model'}.glb`;
}

/**
 * @openapi
 * /api/analyze:
 *   post:
 *     summary: Analyze a 3D model file
 *     description: |
 *       Upload a 3D model file and get detailed analysis including mesh info,
 *       textures, materials, and compression status.
 *     tags:
 *       - Analysis
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
 *                 description: 3D model file to analyze
 *     responses:
 *       200:
 *         description: Analysis successful
 *       400:
 *         description: Invalid file
 */
router.post('/preview', requireWebUser, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  let scratchDir: string | undefined;
  try {
    if (!req.file) {
      throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'No file uploaded', { field: 'file' });
    }

    const originalFilename = decodeUploadFilename(req.file.originalname);
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-preview-'));
    const prepared = await prepareModelInput({
      inputPath: req.file.path,
      scratchDir,
      originalFilename,
      allowZip: true,
    });

    const preview = await fs.readFile(prepared.inputGlbPath);
    if (preview.byteLength > MAX_PREVIEW_GLB_BYTES) {
      throw new OptimizationError(
        ERROR_CODES.FILE_TOO_LARGE,
        `转换预览 GLB 超过 ${Math.round(MAX_PREVIEW_GLB_BYTES / 1024 / 1024)}MB，请直接提交优化。`,
        {
          bytes: preview.byteLength,
          maxBytes: MAX_PREVIEW_GLB_BYTES,
        }
      );
    }

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Length', String(preview.byteLength));
    res.setHeader('Content-Disposition', `inline; filename="${previewFilename(originalFilename)}"`);
    res.send(preview);
  } catch (error) {
    next(error);
  } finally {
    if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    await cleanupUploadedFile(req.file);
  }
});

router.post('/', requireWebUser, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  let scratchDir: string | undefined;
  try {
    if (!req.file) {
      throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'No file uploaded', { field: 'file' });
    }

    // Decode filename properly for UTF-8
    const originalFilename = decodeUploadFilename(req.file.originalname);
    const ext = getFileExtension(originalFilename);
    let inputGlbPath = req.file.path;
    let format = ext ? ext.slice(1).toUpperCase() : 'UNKNOWN';
    let converted = false;
    let conversionTime: number | undefined;
    let previewMessage: string | undefined;

    if (ext !== '.glb') {
      scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-analyze-'));
      try {
        const prepared = await prepareModelInput({
          inputPath: req.file.path,
          scratchDir,
          originalFilename,
          allowZip: true,
        });
        inputGlbPath = prepared.inputGlbPath;
        format = prepared.conversion.originalFormat || prepared.modelExt.toUpperCase().slice(1);
        converted = prepared.conversion.converted;
        conversionTime = prepared.conversion.conversionTime;
        previewMessage = converted ? '已在服务器转换为 GLB 并完成面数分析。' : undefined;
      } catch (conversionError) {
        const analysis = buildLightAnalysis(originalFilename, req.file.size, ext);
        analysis.previewMessage =
          conversionError instanceof Error
            ? `服务器暂无法完成深度分析：${conversionError.message}`
            : '服务器暂无法完成深度分析。';
        res.json({ success: true, analysis });
        return;
      }
    }

    // Read and analyze GLB
    const io = new NodeIO()
      .registerExtensions([KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu])
      .registerDependencies(await getDracoModules());

    const document = await io.read(inputGlbPath);
    const analysis = await analyzeDocument(document, originalFilename, req.file.size);
    analysis.format = converted ? `${format} → GLB` : format;
    analysis.converted = converted;
    analysis.conversionTime = conversionTime;
    analysis.previewMessage = previewMessage;

    res.json({ success: true, analysis });
  } catch (error) {
    next(error);
  } finally {
    if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    await cleanupUploadedFile(req.file);
  }
});

export default router;
