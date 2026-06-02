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
import { getDracoModules } from '../components/draco-singleton';
import { getFileExtension } from '../components/format-converter';
import { createModelUpload, cleanupUploadedFile } from '../utils/model-upload';
import { decodeUploadFilename } from '../utils/model-input';
import { OptimizationError, ERROR_CODES } from '../models/error';
import { requireWebUser } from '../middleware';

const router = Router();

// Configure multer
const upload = createModelUpload({ allowZip: true });

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
router.post('/', requireWebUser, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'No file uploaded', { field: 'file' });
    }

    // Decode filename properly for UTF-8
    const originalFilename = decodeUploadFilename(req.file.originalname);
    const ext = getFileExtension(originalFilename);
    if (ext !== '.glb') {
      res.json({ success: true, analysis: buildLightAnalysis(originalFilename, req.file.size, ext) });
      return;
    }

    // Read and analyze GLB
    const io = new NodeIO()
      .registerExtensions([KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu])
      .registerDependencies(await getDracoModules());

    const document = await io.read(req.file.path);
    const analysis = await analyzeDocument(document, originalFilename, req.file.size);

    res.json({ success: true, analysis });
  } catch (error) {
    next(error);
  } finally {
    await cleanupUploadedFile(req.file);
  }
});

export default router;
