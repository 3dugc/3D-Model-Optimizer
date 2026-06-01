/**
 * Unit Tests for Optimization Pipeline
 *
 * Tests the optimization pipeline component that coordinates all optimization steps.
 * Verifies:
 * - Correct execution order (clean → merge → simplify → quantize → draco → texture)
 * - Support for any combination of optimization options
 * - Failure isolation and error reporting
 * - Complete optimization report generation
 *
 * @see Requirements 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu } from '@gltf-transform/extensions';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  executePipeline,
  createOptimizationPipeline,
  OPTIMIZATION_ORDER,
  PipelineError,
} from '../../src/components/optimization-pipeline';
import { OptimizationOptions } from '../../src/models/options';

// Test fixtures directory
const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const TEMP_DIR = path.join(os.tmpdir(), 'glb-optimizer-pipeline-tests');

/**
 * Create a simple GLB document with a mesh for testing.
 */
async function createTestDocument(): Promise<Document> {
  const document = new Document();

  // Create a simple triangle mesh
  const buffer = document.createBuffer();

  // Position data (3 vertices forming a triangle)
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0.5, 1, 0,
  ]);

  // Normal data
  const normals = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);

  // UV data
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    0.5, 1,
  ]);

  // Indices
  const indices = new Uint16Array([0, 1, 2]);

  // Create accessors
  const positionAccessor = document
    .createAccessor()
    .setType('VEC3')
    .setArray(positions)
    .setBuffer(buffer);

  const normalAccessor = document
    .createAccessor()
    .setType('VEC3')
    .setArray(normals)
    .setBuffer(buffer);

  const uvAccessor = document
    .createAccessor()
    .setType('VEC2')
    .setArray(uvs)
    .setBuffer(buffer);

  const indexAccessor = document
    .createAccessor()
    .setType('SCALAR')
    .setArray(indices)
    .setBuffer(buffer);

  // Create material
  const material = document.createMaterial('TestMaterial');

  // Create primitive
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', positionAccessor)
    .setAttribute('NORMAL', normalAccessor)
    .setAttribute('TEXCOORD_0', uvAccessor)
    .setIndices(indexAccessor)
    .setMaterial(material);

  // Create mesh
  const mesh = document.createMesh('TestMesh').addPrimitive(primitive);

  // Create node and scene
  const node = document.createNode('TestNode').setMesh(mesh);
  const scene = document.createScene('TestScene').addChild(node);
  document.getRoot().setDefaultScene(scene);

  return document;
}

/**
 * Create a test GLB file.
 */
async function createTestGlbFile(filePath: string): Promise<void> {
  const document = await createTestDocument();
  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu]);
  await io.write(filePath, document);
}

/**
 * Create a test GLB file with KHR_materials_unlit.
 */
async function createUnlitTestGlbFile(filePath: string): Promise<void> {
  const document = await createTestDocument();
  const unlitExtension = document.createExtension(KHRMaterialsUnlit);
  const material = document.getRoot().listMaterials()[0]!;
  material.setExtension(KHRMaterialsUnlit.EXTENSION_NAME, unlitExtension.createUnlit());

  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu]);
  await io.write(filePath, document);
}

/**
 * Read the JSON chunk from a GLB file.
 */
function readGlbJson(filePath: string): any {
  const buffer = fs.readFileSync(filePath);
  let offset = 12;

  while (offset < buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.toString('utf8', offset + 4, offset + 8);
    offset += 8;

    if (chunkType === 'JSON') {
      return JSON.parse(buffer.toString('utf8', offset, offset + chunkLength).trim());
    }

    offset += chunkLength;
  }

  throw new Error('GLB JSON chunk not found');
}

describe('Optimization Pipeline', () => {
  beforeAll(async () => {
    // Create temp directory
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    // Create fixtures directory if it doesn't exist
    if (!fs.existsSync(FIXTURES_DIR)) {
      fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up temp directory
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  describe('OPTIMIZATION_ORDER', () => {
    it('should define the correct execution order', () => {
      expect(OPTIMIZATION_ORDER).toEqual([
        'repair-input',
        'clean',
        'merge',
        'simplify',
        'quantize',
        'draco',
        'texture',
        'repair-output',
      ]);
    });
  });

  describe('createOptimizationPipeline', () => {
    it('should create a pipeline instance with execute method', () => {
      const pipeline = createOptimizationPipeline();
      expect(pipeline).toBeDefined();
      expect(typeof pipeline.execute).toBe('function');
    });
  });

  describe('executePipeline', () => {
    let inputPath: string;
    let outputPath: string;

    beforeEach(async () => {
      // Create unique file paths for each test
      const testId = Date.now() + Math.random().toString(36).substring(7);
      inputPath = path.join(TEMP_DIR, `input-${testId}.glb`);
      outputPath = path.join(TEMP_DIR, `output-${testId}.glb`);

      // Create test input file
      await createTestGlbFile(inputPath);
    });

    it('should return a valid result with taskId and success status', async () => {
      const options: OptimizationOptions = {
        clean: { enabled: true },
      };

      const result = await executePipeline(inputPath, outputPath, options);

      expect(result).toBeDefined();
      expect(result.taskId).toBeDefined();
      expect(typeof result.taskId).toBe('string');
      expect(result.taskId.length).toBeGreaterThan(0);
      expect(result.success).toBe(true);
    });

    it('should include processing time in the result', async () => {
      const options: OptimizationOptions = {
        clean: { enabled: true },
      };

      const result = await executePipeline(inputPath, outputPath, options);

      expect(result.processingTime).toBeDefined();
      expect(typeof result.processingTime).toBe('number');
      expect(result.processingTime).toBeGreaterThanOrEqual(0);
    });

    it('should include file size information', async () => {
      const options: OptimizationOptions = {
        clean: { enabled: true },
      };

      const result = await executePipeline(inputPath, outputPath, options);

      expect(result.originalSize).toBeGreaterThan(0);
      expect(result.optimizedSize).toBeGreaterThan(0);
      expect(result.compressionRatio).toBeDefined();
    });

    it('should include download URL in the result', async () => {
      const options: OptimizationOptions = {
        clean: { enabled: true },
      };

      const result = await executePipeline(inputPath, outputPath, options);

      expect(result.downloadUrl).toBeDefined();
      expect(result.downloadUrl).toContain('/api/download/');
      expect(result.downloadUrl).toContain(result.taskId);
    });

    it('should create the output file', async () => {
      const options: OptimizationOptions = {
        clean: { enabled: true },
      };

      await executePipeline(inputPath, outputPath, options);

      expect(fs.existsSync(outputPath)).toBe(true);
    });

    describe('Step Execution Order (Requirement 8.5)', () => {
      it('should execute steps in the correct order', async () => {
        const options: OptimizationOptions = {
          clean: { enabled: true },
          merge: { enabled: true },
          quantize: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(true);
        expect(result.steps.length).toBe(5); // repair-input + 3 user steps + repair-output

        // Verify order: repair-input → clean → merge → quantize → repair-output
        expect(result.steps[0].step).toBe('repair-input');
        expect(result.steps[1].step).toBe('clean');
        expect(result.steps[2].step).toBe('merge');
        expect(result.steps[3].step).toBe('quantize');
        expect(result.steps[4].step).toBe('repair-output');
      });

      it('should skip disabled steps', async () => {
        const options: OptimizationOptions = {
          clean: { enabled: true },
          merge: { enabled: false },
          simplify: { enabled: false },
          quantize: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(true);
        expect(result.steps.length).toBe(4); // repair-input + clean + quantize + repair-output
        expect(result.steps[0].step).toBe('repair-input');
        expect(result.steps[1].step).toBe('clean');
        expect(result.steps[2].step).toBe('quantize');
        expect(result.steps[3].step).toBe('repair-output');
      });
    });

    describe('Combination Support (Requirement 8.2)', () => {
      it('should support clean only', async () => {
        const options: OptimizationOptions = {
          clean: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(true);
        expect(result.steps.length).toBe(3); // repair-input + clean + repair-output
        expect(result.steps[1].step).toBe('clean');
      });

      it('should preserve unlit material extensions while optimizing', async () => {
        await createUnlitTestGlbFile(inputPath);
        const options: OptimizationOptions = {
          clean: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);
        const outputJson = readGlbJson(outputPath);

        expect(result.success).toBe(true);
        expect(outputJson.extensionsUsed).toContain(KHRMaterialsUnlit.EXTENSION_NAME);
        expect(outputJson.materials[0].extensions).toHaveProperty(KHRMaterialsUnlit.EXTENSION_NAME);
      });

      it('should drop unlit material extensions when explicitly disabled', async () => {
        await createUnlitTestGlbFile(inputPath);
        const options: OptimizationOptions = {
          extensions: { preserveUnlit: false },
          clean: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);
        const outputJson = readGlbJson(outputPath);

        expect(result.success).toBe(true);
        expect(outputJson.extensionsUsed || []).not.toContain(KHRMaterialsUnlit.EXTENSION_NAME);
        expect(outputJson.materials[0].extensions || {}).not.toHaveProperty(KHRMaterialsUnlit.EXTENSION_NAME);
      });

      it('should support merge only', async () => {
        const options: OptimizationOptions = {
          merge: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(true);
        expect(result.steps.length).toBe(3);
        expect(result.steps[1].step).toBe('merge');
      });

      it('should support simplify only', async () => {
        const options: OptimizationOptions = {
          simplify: { enabled: true, targetRatio: 0.5 },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(true);
        expect(result.steps.length).toBe(3);
        expect(result.steps[1].step).toBe('simplify');
      });

      it('should support quantize only', async () => {
        const options: OptimizationOptions = {
          quantize: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(true);
        expect(result.steps.length).toBe(3);
        expect(result.steps[1].step).toBe('quantize');
      });

      it('should support draco only', async () => {
        const options: OptimizationOptions = {
          draco: { enabled: true, compressionLevel: 7 },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(true);
        expect(result.steps.length).toBe(3);
        expect(result.steps[1].step).toBe('draco');
      });

      it('should support all steps enabled', async () => {
        const options: OptimizationOptions = {
          clean: { enabled: true },
          merge: { enabled: true },
          simplify: { enabled: true, targetRatio: 0.8 },
          quantize: { enabled: true },
          draco: { enabled: true, compressionLevel: 5 },
          texture: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(true);
        expect(result.steps.length).toBe(8); // repair-input + 6 user steps + repair-output

        // Verify all steps executed in order
        expect(result.steps[0].step).toBe('repair-input');
        expect(result.steps[1].step).toBe('clean');
        expect(result.steps[2].step).toBe('merge');
        expect(result.steps[3].step).toBe('simplify');
        expect(result.steps[4].step).toBe('quantize');
        expect(result.steps[5].step).toBe('draco');
        expect(result.steps[6].step).toBe('texture');
        expect(result.steps[7].step).toBe('repair-output');
      });

      it('should support no steps enabled', async () => {
        const options: OptimizationOptions = {};

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(true);
        expect(result.steps.length).toBe(2); // repair-input + repair-output always run
      });

      it('should run repair when every optimization step is explicitly disabled', async () => {
        const options: OptimizationOptions = {
          clean: { enabled: false },
          merge: { enabled: false },
          simplify: { enabled: false },
          quantize: { enabled: false },
          draco: { enabled: false },
          texture: { enabled: false },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(true);
        expect(result.steps.length).toBe(2);
        expect(result.steps[0].step).toBe('repair-input');
        expect(result.steps[1].step).toBe('repair-output');
      });
    });

    describe('Step Results (Requirement 8.4)', () => {
      it('should include duration for each step', async () => {
        const options: OptimizationOptions = {
          clean: { enabled: true },
          merge: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        for (const step of result.steps) {
          expect(step.duration).toBeDefined();
          expect(typeof step.duration).toBe('number');
          expect(step.duration).toBeGreaterThanOrEqual(0);
        }
      });

      it('should include statistics for each step', async () => {
        const options: OptimizationOptions = {
          clean: { enabled: true },
          merge: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        for (const step of result.steps) {
          expect(step.stats).toBeDefined();
          expect(typeof step.stats).toBe('object');
        }
      });

      it('should include clean statistics', async () => {
        const options: OptimizationOptions = {
          clean: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        const cleanStep = result.steps.find((s) => s.step === 'clean');
        expect(cleanStep).toBeDefined();
        expect(cleanStep!.stats).toHaveProperty('nodesRemoved');
        expect(cleanStep!.stats).toHaveProperty('materialsRemoved');
        expect(cleanStep!.stats).toHaveProperty('texturesRemoved');
      });

      it('should include merge statistics', async () => {
        const options: OptimizationOptions = {
          merge: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        const mergeStep = result.steps.find((s) => s.step === 'merge');
        expect(mergeStep).toBeDefined();
        expect(mergeStep!.stats).toHaveProperty('originalMeshCount');
        expect(mergeStep!.stats).toHaveProperty('mergedMeshCount');
        expect(mergeStep!.stats).toHaveProperty('meshesReduced');
      });

      it('should include simplify statistics', async () => {
        const options: OptimizationOptions = {
          simplify: { enabled: true, targetRatio: 0.5 },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        const simplifyStep = result.steps.find((s) => s.step === 'simplify');
        expect(simplifyStep).toBeDefined();
        expect(simplifyStep!.stats).toHaveProperty('originalTriangles');
        expect(simplifyStep!.stats).toHaveProperty('simplifiedTriangles');
        expect(simplifyStep!.stats).toHaveProperty('reductionRatio');
      });

      it('should include quantize statistics', async () => {
        const options: OptimizationOptions = {
          quantize: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        const quantizeStep = result.steps.find((s) => s.step === 'quantize');
        expect(quantizeStep).toBeDefined();
        expect(quantizeStep!.stats).toHaveProperty('attributesQuantized');
        expect(quantizeStep!.stats).toHaveProperty('originalSize');
        expect(quantizeStep!.stats).toHaveProperty('quantizedSize');
      });

      it('should include draco statistics', async () => {
        const options: OptimizationOptions = {
          draco: { enabled: true },
        };

        const result = await executePipeline(inputPath, outputPath, options);

        const dracoStep = result.steps.find((s) => s.step === 'draco');
        expect(dracoStep).toBeDefined();
        expect(dracoStep!.stats).toHaveProperty('meshesCompressed');
        expect(dracoStep!.stats).toHaveProperty('originalSize');
        expect(dracoStep!.stats).toHaveProperty('compressedSize');
      });
    });

    describe('Error Handling', () => {
      it('should throw PipelineError for non-existent input file', async () => {
        const nonExistentPath = path.join(TEMP_DIR, 'non-existent.glb');
        const options: OptimizationOptions = {
          clean: { enabled: true },
        };

        await expect(
          executePipeline(nonExistentPath, outputPath, options)
        ).rejects.toThrow(PipelineError);
      });

      it('should throw PipelineError for invalid GLB file', async () => {
        // Create an invalid file
        const invalidPath = path.join(TEMP_DIR, 'invalid.glb');
        fs.writeFileSync(invalidPath, 'not a valid glb file');

        const options: OptimizationOptions = {
          clean: { enabled: true },
        };

        await expect(
          executePipeline(invalidPath, outputPath, options)
        ).rejects.toThrow(PipelineError);
      });
    });

    describe('Failure Isolation (Requirement 8.3)', () => {
      it('should stop execution on step failure and report failed step', async () => {
        // Use invalid simplify options to trigger a failure
        const options: OptimizationOptions = {
          clean: { enabled: true },
          simplify: { enabled: true, targetRatio: -1 }, // Invalid ratio
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(false);
        expect(result.steps.length).toBe(3); // repair-input succeeded, clean succeeded, simplify failed

        // repair-input should succeed
        expect(result.steps[0].step).toBe('repair-input');
        expect(result.steps[0].success).toBe(true);

        // Clean should succeed
        expect(result.steps[1].step).toBe('clean');
        expect(result.steps[1].success).toBe(true);

        // Simplify should fail
        expect(result.steps[2].step).toBe('simplify');
        expect(result.steps[2].success).toBe(false);
        expect(result.steps[2].error).toBeDefined();
      });

      it('should not execute steps after a failure', async () => {
        const options: OptimizationOptions = {
          clean: { enabled: true },
          simplify: { enabled: true, targetRatio: -1 }, // Invalid - will fail
          quantize: { enabled: true }, // Should not execute
          draco: { enabled: true }, // Should not execute
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(false);
        expect(result.steps.length).toBe(3); // repair-input, clean, and simplify (failed)

        // Verify quantize, draco, and repair-output were not executed
        const stepNames = result.steps.map((s) => s.step);
        expect(stepNames).not.toContain('quantize');
        expect(stepNames).not.toContain('draco');
        expect(stepNames).not.toContain('repair-output');
      });

      it('should include error message in failed step result', async () => {
        const options: OptimizationOptions = {
          simplify: { enabled: true, targetRatio: 2 }, // Invalid ratio > 1
        };

        const result = await executePipeline(inputPath, outputPath, options);

        expect(result.success).toBe(false);
        const failedStep = result.steps.find((s) => !s.success);
        expect(failedStep).toBeDefined();
        expect(failedStep!.error).toBeDefined();
        expect(typeof failedStep!.error).toBe('string');
        expect(failedStep!.error!.length).toBeGreaterThan(0);
      });
    });
  });
});
