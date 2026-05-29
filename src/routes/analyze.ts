/**
 * Analyze Route
 *
 * Analyzes 3D model files and returns detailed information.
 * Implements POST /api/analyze endpoint.
 *
 * @module routes/analyze
 */

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import { getDracoModules } from '../components/draco-singleton';
import { FILE_CONSTRAINTS } from '../utils/file-validator';
import {
  convertToGLB,
  isSupportedFormat,
  getFileExtension,
  SUPPORTED_FORMATS,
} from '../components/format-converter';
import { OptimizationError, ERROR_CODES } from '../models/error';
import { requireWebUser } from '../middleware';

const router = Router();

// Configure multer
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: FILE_CONSTRAINTS.maxSize },
  fileFilter: (_req, file, cb) => {
    const ext = getFileExtension(file.originalname);
    if (!isSupportedFormat(ext)) {
      cb(new OptimizationError(ERROR_CODES.INVALID_FILE, `Unsupported format: ${ext}`, {
        received: ext,
        expected: SUPPORTED_FORMATS.join(', '),
      }));
      return;
    }
    cb(null, true);
  },
});

/**
 * Model analysis result interface.
 */
interface ModelAnalysis {
  filename: string;
  fileSize: number;
  format: string;
  converted: boolean;
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
  const tempDir = path.join('./temp', `analyze-${uuidv4()}`);

  try {
    if (!req.file) {
      throw new OptimizationError(ERROR_CODES.INVALID_FILE, 'No file uploaded', { field: 'file' });
    }

    const fileBuffer = req.file.buffer;
    // Decode filename properly for UTF-8
    const originalFilename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const ext = getFileExtension(originalFilename);

    // Create temp directory
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Save uploaded file
    const uploadedPath = path.join(tempDir, `input${ext}`);
    fs.writeFileSync(uploadedPath, fileBuffer);

    let glbPath: string;
    let converted = false;
    let conversionTime: number | undefined;
    let originalFormat = ext.toUpperCase().slice(1);

    // Convert if needed
    if (ext !== '.glb') {
      const convertedPath = path.join(tempDir, 'converted.glb');
      const result = await convertToGLB(uploadedPath, convertedPath, originalFilename);

      if (!result.success) {
        throw new OptimizationError(ERROR_CODES.INVALID_FILE, `Conversion failed: ${result.error}`, {
          originalFormat: ext,
        });
      }

      glbPath = convertedPath;
      converted = true;
      conversionTime = result.conversionTime;
      originalFormat = result.originalFormat;
    } else {
      glbPath = uploadedPath;
    }

    // Read and analyze GLB
    const io = new NodeIO()
      .registerExtensions([KHRDracoMeshCompression, KHRTextureBasisu])
      .registerDependencies(await getDracoModules());

    const document = await io.read(glbPath);
    const analysis = await analyzeDocument(document, originalFilename, fileBuffer.length);

    // Update with conversion info
    analysis.format = originalFormat;
    analysis.converted = converted;
    if (conversionTime !== undefined) {
      analysis.conversionTime = conversionTime;
    }

    res.json({ success: true, analysis });
  } catch (error) {
    next(error);
  } finally {
    // Cleanup temp directory
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }
});

export default router;
