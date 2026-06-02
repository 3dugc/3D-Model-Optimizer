/**
 * Format Converter Component
 *
 * Converts various 3D model formats to GLB format.
 * Supported formats: OBJ, STL, FBX, GLTF, USDZ
 *
 * @module components/format-converter
 */

import { Document, NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import obj2gltf from 'obj2gltf';

const execFileAsync = promisify(execFile);

/**
 * Supported input formats for conversion.
 */
export const SUPPORTED_FORMATS = ['.glb', '.gltf', '.obj', '.stl', '.fbx', '.usdz', '.dae', '.step', '.stp', '.prt', '.catpart', '.catproduct', '.asm'] as const;
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

/**
 * Check if a file extension is supported.
 */
export function isSupportedFormat(ext: string): ext is SupportedFormat {
  return SUPPORTED_FORMATS.includes(ext.toLowerCase() as SupportedFormat);
}

/**
 * Get file extension from filename.
 */
export function getFileExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return ext;
}

/**
 * Conversion result interface.
 */
export interface ConversionResult {
  success: boolean;
  outputPath: string;
  originalFormat: string;
  conversionTime: number;
  error?: string;
}

/**
 * Parse binary STL file.
 */
function parseBinarySTL(buffer: Buffer): { positions: number[]; normals: number[] } {
  const positions: number[] = [];
  const normals: number[] = [];

  // Skip 80-byte header
  let offset = 80;

  // Read triangle count (uint32)
  const triangleCount = buffer.readUInt32LE(offset);
  offset += 4;

  for (let i = 0; i < triangleCount; i++) {
    // Read normal (3 floats)
    const nx = buffer.readFloatLE(offset);
    const ny = buffer.readFloatLE(offset + 4);
    const nz = buffer.readFloatLE(offset + 8);
    offset += 12;

    // Read 3 vertices (9 floats)
    for (let v = 0; v < 3; v++) {
      const x = buffer.readFloatLE(offset);
      const y = buffer.readFloatLE(offset + 4);
      const z = buffer.readFloatLE(offset + 8);
      offset += 12;

      positions.push(x, y, z);
      normals.push(nx, ny, nz);
    }

    // Skip attribute byte count (uint16)
    offset += 2;
  }

  return { positions, normals };
}

/**
 * Parse ASCII STL file.
 */
function parseAsciiSTL(content: string): { positions: number[]; normals: number[] } {
  const positions: number[] = [];
  const normals: number[] = [];

  const lines = content.split('\n');
  let currentNormal = [0, 0, 0];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('facet normal')) {
      const parts = trimmed.split(/\s+/);
      currentNormal = [parseFloat(parts[2]), parseFloat(parts[3]), parseFloat(parts[4])];
    } else if (trimmed.startsWith('vertex')) {
      const parts = trimmed.split(/\s+/);
      positions.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
      normals.push(...currentNormal);
    }
  }

  return { positions, normals };
}

/**
 * Check if STL is binary format.
 */
function isBinarySTL(buffer: Buffer): boolean {
  // Check if starts with "solid" (ASCII STL)
  const header = buffer.slice(0, 5).toString('ascii');
  if (header === 'solid') {
    // Could still be binary if "solid" appears in header
    // Check if file size matches expected binary size
    const triangleCount = buffer.readUInt32LE(80);
    const expectedSize = 80 + 4 + triangleCount * 50;
    return buffer.length === expectedSize;
  }
  return true;
}

/**
 * Convert STL to GLB.
 */
async function convertSTLtoGLB(inputPath: string, outputPath: string): Promise<void> {
  const buffer = fs.readFileSync(inputPath);

  let positions: number[];
  let normals: number[];

  if (isBinarySTL(buffer)) {
    const parsed = parseBinarySTL(buffer);
    positions = parsed.positions;
    normals = parsed.normals;
  } else {
    const content = buffer.toString('utf-8');
    const parsed = parseAsciiSTL(content);
    positions = parsed.positions;
    normals = parsed.normals;
  }

  // Create glTF document
  const document = new Document();
  const buffer_ = document.createBuffer();

  // Create accessors
  const positionAccessor = document
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(positions))
    .setBuffer(buffer_);

  const normalAccessor = document
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(normals))
    .setBuffer(buffer_);

  // Create primitive
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', positionAccessor)
    .setAttribute('NORMAL', normalAccessor);

  // Create mesh and node
  const mesh = document.createMesh().addPrimitive(primitive);
  const node = document.createNode().setMesh(mesh);
  const scene = document.createScene().addChild(node);
  document.getRoot().setDefaultScene(scene);

  // Write GLB
  const io = new NodeIO().registerExtensions([KHRMaterialsUnlit]);
  await io.write(outputPath, document);
}

/**
 * Check if COLLADA2GLTF is available.
 */
async function isCollada2gltfAvailable(): Promise<boolean> {
  try {
    await execFileAsync('which', ['COLLADA2GLTF']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert DAE (Collada) to GLB using COLLADA2GLTF.
 */
async function convertDAEtoGLB(inputPath: string, outputPath: string): Promise<void> {
  const colladaAvailable = await isCollada2gltfAvailable();
  
  if (!colladaAvailable) {
    throw new Error(
      'DAE conversion requires COLLADA2GLTF binary. ' +
      'Run in Docker or download from: https://github.com/KhronosGroup/COLLADA2GLTF/releases'
    );
  }

  // COLLADA2GLTF outputs to the same directory with .glb extension
  const outputDir = path.dirname(outputPath);
  const outputName = path.basename(outputPath, '.glb');
  const tempOutput = path.join(outputDir, `${outputName}.gltf`);
  
  await execFileAsync('COLLADA2GLTF', ['-i', inputPath, '-o', tempOutput], { timeout: 120000 });

  // Convert GLTF to GLB
  const io = new NodeIO().registerExtensions([KHRMaterialsUnlit]);
  const document = await io.read(tempOutput);
  await io.write(outputPath, document);

  // Clean up temp gltf file
  if (fs.existsSync(tempOutput)) {
    fs.unlinkSync(tempOutput);
  }
  // Also clean up .bin file if exists
  const binFile = tempOutput.replace('.gltf', '.bin');
  if (fs.existsSync(binFile)) {
    fs.unlinkSync(binFile);
  }
}

/**
 * Check if STEP conversion tools are available.
 */
async function isStepConverterAvailable(): Promise<boolean> {
  try {
    await execFileAsync('python3', ['-c', "import cadquery; import trimesh; print('ok')"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert STEP to GLB using CadQuery/OpenCASCADE tessellation and trimesh export.
 */
async function convertSTEPtoGLB(inputPath: string, outputPath: string): Promise<void> {
  const stepAvailable = await isStepConverterAvailable();
  
  if (!stepAvailable) {
    throw new Error(
      'STEP conversion requires Python trimesh + cadquery/OCP packages. ' +
      'Run in Docker or install with: pip install trimesh cadquery'
    );
  }

  // Python script to convert STEP to GLB
  const pythonScript = `
import sys
import json
import cadquery as cq
import trimesh

try:
    model = cq.importers.importStep(sys.argv[1])
    shapes = model.vals()
    meshes = []
    for shape in shapes:
        vertices, faces = shape.tessellate(0.1, 0.1)
        if not vertices or not faces:
            continue
        mesh = trimesh.Trimesh(
            vertices=[[v.x, v.y, v.z] for v in vertices],
            faces=faces,
            process=False
        )
        if len(mesh.vertices) and len(mesh.faces):
            meshes.append(mesh)
    if not meshes:
        raise RuntimeError("No tessellated geometry found in STEP file")
    scene = trimesh.Scene(meshes)
    scene.export(sys.argv[2], file_type='glb')
    print(json.dumps({"success": True}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
`;

  const result = await execFileAsync('python3', ['-c', pythonScript, inputPath, outputPath], {
    timeout: 300000,
    maxBuffer: 50 * 1024 * 1024,
  });
  
  let parseResult;
  try {
    parseResult = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Failed to parse STEP conversion result: ${result.stdout}`);
  }

  if (!parseResult.success) {
    throw new Error(parseResult.error || 'STEP conversion failed');
  }
}

/**
 * Convert CAD formats (PRT, CATProduct, CATPart, ASM) to GLB via Python trimesh/cadquery.
 * These are proprietary CAD formats that require OpenCASCADE (via cadquery/OCP) for reading.
 */
async function convertCADtoGLB(inputPath: string, outputPath: string, format: string): Promise<void> {
  const stepAvailable = await isStepConverterAvailable();

  if (!stepAvailable) {
    throw new Error(
      format.toUpperCase() + ' conversion requires Python trimesh + cadquery/OCP. ' +
      'Run in Docker or install with: pip install trimesh cadquery OCP'
    );
  }

  const pythonScript = `
import sys
import json
import cadquery as cq
import trimesh

try:
    # CadQuery/OpenCASCADE can import STEP/STP reliably. Proprietary CAD
    # formats such as CATPart/CATProduct/PRT/ASM require an external CAD
    # translator; try the OpenCASCADE import path first so STEP-like inputs
    # with nonstandard extensions still work, and return a precise error for
    # truly unsupported proprietary files.
    model = cq.importers.importStep(sys.argv[1])
    shapes = model.vals()
    meshes = []
    for shape in shapes:
        vertices, faces = shape.tessellate(0.1, 0.1)
        if not vertices or not faces:
            continue
        mesh = trimesh.Trimesh(
            vertices=[[v.x, v.y, v.z] for v in vertices],
            faces=faces,
            process=False
        )
        if len(mesh.vertices) and len(mesh.faces):
            meshes.append(mesh)
    if not meshes:
        raise RuntimeError("No tessellated geometry found in CAD file")
    scene = trimesh.Scene(meshes)
    scene.export(sys.argv[2], file_type='glb')
    print(json.dumps({"success": True}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
`;

  const result = await execFileAsync('python3', ['-c', pythonScript, inputPath, outputPath], {
    timeout: 300000,
    maxBuffer: 50 * 1024 * 1024,
  });

  let parseResult;
  try {
    parseResult = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('Failed to parse ' + format.toUpperCase() + ' conversion result: ' + result.stdout);
  }

  if (!parseResult.success) {
    throw new Error(parseResult.error || format.toUpperCase() + ' conversion failed');
  }
}

/**
 * Check if FBX2glTF is available.
 */
async function isFbx2gltfAvailable(): Promise<boolean> {
  try {
    await execFileAsync('FBX2glTF', ['--help']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert FBX to GLB using FBX2glTF.
 */
async function convertFBXtoGLB(inputPath: string, outputPath: string): Promise<void> {
  const fbxAvailable = await isFbx2gltfAvailable();
  
  if (!fbxAvailable) {
    throw new Error(
      'FBX conversion requires FBX2glTF binary. ' +
      'Run in Docker or download from: https://github.com/godotengine/FBX2glTF/releases'
    );
  }

  // FBX2glTF outputs to a file with the same name but .glb extension
  // We need to specify the output path
  const outputDir = path.dirname(outputPath);
  const outputName = path.basename(outputPath, '.glb');
  
  await execFileAsync('FBX2glTF', ['-i', inputPath, '-o', path.join(outputDir, outputName), '--binary'], {
    timeout: 120000,
  });

  // FBX2glTF adds _out suffix, rename if needed
  const expectedOutput = path.join(outputDir, `${outputName}_out.glb`);
  if (fs.existsSync(expectedOutput) && expectedOutput !== outputPath) {
    fs.renameSync(expectedOutput, outputPath);
  }
}

/**
 * Check if USD Python tools are available.
 */
async function isUsdAvailable(): Promise<boolean> {
  try {
    await execFileAsync('python3', ['-c', "from pxr import Usd; print('ok')"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert USDZ to GLB using Python USD library.
 */
async function convertUSDZtoGLB(inputPath: string, outputPath: string): Promise<void> {
  const usdAvailable = await isUsdAvailable();
  if (!usdAvailable) {
    throw new Error(
      'USDZ conversion requires usd-core Python package. ' +
      'Run in Docker or install with: pip install usd-core'
    );
  }

  // The Python script now writes GLB directly to disk and only outputs a small status JSON
  const scriptPath = path.join(__dirname, '../../scripts/usdz_to_glb.py');

  if (!fs.existsSync(scriptPath)) {
    throw new Error('USDZ conversion script not found: ' + scriptPath);
  }

  const result = await execFileAsync('python3', [scriptPath, inputPath, outputPath], {
    timeout: 300000,
    maxBuffer: 10 * 1024 * 1024,
  });

  let parseResult;
  try {
    parseResult = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Failed to parse USDZ conversion result: ${result.stdout.substring(0, 500)}`);
  }

  if (!parseResult.success) {
    throw new Error(parseResult.error || 'USDZ conversion failed');
  }

  // Verify output file exists
  if (!fs.existsSync(outputPath)) {
    throw new Error('USDZ conversion completed but output file not found');
  }
}

/**
 * Convert OBJ to GLB using obj2gltf.
 */
async function convertOBJtoGLB(inputPath: string, outputPath: string): Promise<void> {
  const glb = await obj2gltf(inputPath, {
    binary: true,
  });
  fs.writeFileSync(outputPath, glb);
}

/**
 * Convert GLTF to GLB.
 */
async function convertGLTFtoGLB(inputPath: string, outputPath: string): Promise<void> {
  const io = new NodeIO().registerExtensions([KHRMaterialsUnlit]);
  const document = await io.read(inputPath);
  await io.write(outputPath, document);
}

/**
 * Convert a 3D model file to GLB format.
 *
 * @param inputPath - Path to the input file
 * @param outputPath - Path for the output GLB file
 * @param originalFilename - Original filename to determine format
 * @returns Conversion result
 */
export async function convertToGLB(
  inputPath: string,
  outputPath: string,
  originalFilename: string
): Promise<ConversionResult> {
  const startTime = Date.now();
  const ext = getFileExtension(originalFilename);

  try {
    // If already GLB, just copy
    if (ext === '.glb') {
      fs.copyFileSync(inputPath, outputPath);
      return {
        success: true,
        outputPath,
        originalFormat: 'GLB',
        conversionTime: Date.now() - startTime,
      };
    }

    // Convert based on format
    switch (ext) {
      case '.gltf':
        await convertGLTFtoGLB(inputPath, outputPath);
        break;

      case '.obj':
        await convertOBJtoGLB(inputPath, outputPath);
        break;

      case '.stl':
        await convertSTLtoGLB(inputPath, outputPath);
        break;

      case '.fbx':
        await convertFBXtoGLB(inputPath, outputPath);
        break;

      case '.usdz':
        await convertUSDZtoGLB(inputPath, outputPath);
        break;

      case '.dae':
        await convertDAEtoGLB(inputPath, outputPath);
        break;

      case '.step':
      case '.stp':
        await convertSTEPtoGLB(inputPath, outputPath);
        break;

      case '.prt':
      case '.catpart':
      case '.catproduct':
      case '.asm':
        await convertCADtoGLB(inputPath, outputPath, ext.slice(1));
        break;

      default:
        throw new Error(`Unsupported format: ${ext}`);
    }

    return {
      success: true,
      outputPath,
      originalFormat: ext.toUpperCase().slice(1),
      conversionTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      outputPath,
      originalFormat: ext.toUpperCase().slice(1),
      conversionTime: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check if a file needs conversion (not already GLB).
 */
export function needsConversion(filename: string): boolean {
  const ext = getFileExtension(filename);
  return ext !== '.glb' && isSupportedFormat(ext);
}

export default {
  convertToGLB,
  needsConversion,
  isSupportedFormat,
  getFileExtension,
  SUPPORTED_FORMATS,
};
