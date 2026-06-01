/**
 * Swagger/OpenAPI Configuration
 * 
 * This module configures Swagger/OpenAPI documentation for the GLB Optimizer Server API.
 * It uses swagger-jsdoc to generate OpenAPI 3.0 specification from JSDoc comments.
 * 
 * Requirements: 9.1, 9.2
 */

import swaggerJsdoc from 'swagger-jsdoc';

/**
 * Swagger configuration options
 */
const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: '三维模型优化服务 API',
      version: '1.0.0',
      description: 'RESTful API for optimizing GLB 3D model files. Supports mesh simplification, Draco compression, texture compression (KTX2/Basis Universal), vertex quantization, mesh merging, and resource cleanup.',
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
      contact: {
        name: '三维模型优化服务',
      },
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Local development server',
      },
    ],
    tags: [
      {
        name: 'Optimization',
        description: 'GLB file optimization endpoints',
      },
      {
        name: 'Download',
        description: 'File download endpoints',
      },
      {
        name: 'Status',
        description: 'Task status endpoints',
      },
      {
        name: 'Async Jobs',
        description: 'Async heavy-backend job APIs for COS upload, queueing, status, and result downloads',
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
        },
      },
      schemas: {
        CosObjectRef: {
          type: 'object',
          required: ['bucket', 'region', 'key'],
          properties: {
            bucket: { type: 'string', example: 'model-optimizer-1251022382' },
            region: { type: 'string', example: 'ap-nanjing' },
            key: { type: 'string', example: 'tenants/acme/jobs/job-1/input/source.glb' },
            etag: { type: 'string' },
            size: { type: 'integer' },
          },
        },
        TemporaryUploadGrant: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['local', 'tencent'] },
            method: { type: 'string', enum: ['PUT'] },
            uri: { type: 'string' },
            putUrl: { type: 'string', format: 'uri' },
            expiresAt: { type: 'string', format: 'date-time' },
            allowedPrefix: { type: 'string' },
            allowedActions: { type: 'array', items: { type: 'string' } },
            credentials: {
              type: 'object',
              properties: {
                tmpSecretId: { type: 'string' },
                tmpSecretKey: { type: 'string' },
                sessionToken: { type: 'string' },
              },
            },
          },
        },
        CosJobManifest: {
          type: 'object',
          required: ['tenantId', 'input'],
          properties: {
            tenantId: { type: 'string', example: 'acme' },
            taskType: { type: 'string', example: 'model.optimize' },
            input: {
              oneOf: [
                { type: 'string', example: 'tenants/acme/incoming/source.glb' },
                { $ref: '#/components/schemas/CosObjectRef' },
              ],
            },
            callbackUrl: { type: 'string', format: 'uri' },
            idempotencyKey: { type: 'string' },
          },
        },
        OptimizationOptions: {
          type: 'object',
          description: 'Options for GLB optimization',
          properties: {
            simplify: {
              type: 'object',
              description: 'Mesh simplification options',
              properties: {
                enabled: { type: 'boolean', description: 'Enable mesh simplification' },
                targetRatio: { type: 'number', minimum: 0.1, maximum: 1.0, description: 'Target ratio (0.1-1.0)' },
                targetCount: { type: 'integer', description: 'Target triangle count' },
                error: { type: 'number', minimum: 0, maximum: 1, description: 'Error threshold (0.0-1.0)' },
                lockBorder: { type: 'boolean', description: 'Preserve boundary edges' },
              },
            },
            draco: {
              type: 'object',
              description: 'Draco compression options',
              properties: {
                enabled: { type: 'boolean', description: 'Enable Draco compression' },
                compressionLevel: { type: 'integer', minimum: 0, maximum: 10, default: 7, description: 'Compression level (0-10)' },
                quantizePosition: { type: 'integer', description: 'Position quantization bits' },
                quantizeNormal: { type: 'integer', description: 'Normal quantization bits' },
                quantizeTexcoord: { type: 'integer', description: 'UV quantization bits' },
              },
            },
            texture: {
              type: 'object',
              description: 'Texture compression options',
              properties: {
                enabled: { type: 'boolean', description: 'Enable texture compression' },
                mode: { type: 'string', enum: ['ETC1S', 'UASTC'], default: 'ETC1S', description: 'Encoding mode' },
                quality: { type: 'number', description: 'Quality parameter' },
                slots: { type: 'array', items: { type: 'string' }, description: 'Texture slots to compress' },
              },
            },
            quantize: {
              type: 'object',
              description: 'Vertex quantization options',
              properties: {
                enabled: { type: 'boolean', description: 'Enable vertex quantization' },
                quantizePosition: { type: 'boolean', description: 'Quantize position coordinates' },
                quantizeNormal: { type: 'boolean', description: 'Quantize normals' },
                quantizeTexcoord: { type: 'boolean', description: 'Quantize UV coordinates' },
                quantizeColor: { type: 'boolean', description: 'Quantize vertex colors' },
              },
            },
            merge: {
              type: 'object',
              description: 'Mesh merge options',
              properties: {
                enabled: { type: 'boolean', description: 'Enable mesh merging' },
              },
            },
            clean: {
              type: 'object',
              description: 'Resource cleanup options',
              properties: {
                enabled: { type: 'boolean', description: 'Enable resource cleanup' },
                removeUnusedNodes: { type: 'boolean', description: 'Remove unused nodes' },
                removeUnusedMaterials: { type: 'boolean', description: 'Remove unused materials' },
                removeUnusedTextures: { type: 'boolean', description: 'Remove unused textures' },
              },
            },
          },
        },
        OptimizationResult: {
          type: 'object',
          description: 'Result of GLB optimization',
          properties: {
            taskId: { type: 'string', format: 'uuid', description: 'Unique task identifier' },
            success: { type: 'boolean', description: 'Whether optimization succeeded' },
            downloadUrl: { type: 'string', description: 'URL to download optimized file' },
            processingTime: { type: 'number', description: 'Processing time in milliseconds' },
            originalSize: { type: 'integer', description: 'Original file size in bytes' },
            optimizedSize: { type: 'integer', description: 'Optimized file size in bytes' },
            compressionRatio: { type: 'number', description: 'Compression ratio' },
            steps: {
              type: 'array',
              items: { $ref: '#/components/schemas/OptimizationStepResult' },
              description: 'Results of each optimization step',
            },
          },
          required: ['taskId', 'success', 'processingTime'],
        },
        OptimizationStepResult: {
          type: 'object',
          description: 'Result of a single optimization step',
          properties: {
            step: { type: 'string', description: 'Step name' },
            success: { type: 'boolean', description: 'Whether step succeeded' },
            duration: { type: 'number', description: 'Step duration in milliseconds' },
            stats: { type: 'object', description: 'Step-specific statistics' },
            error: { type: 'string', description: 'Error message if step failed' },
          },
          required: ['step', 'success', 'duration'],
        },
        TaskStatus: {
          type: 'object',
          description: 'Status of an optimization task',
          properties: {
            id: { type: 'string', format: 'uuid', description: 'Task identifier' },
            status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'], description: 'Current task status' },
            createdAt: { type: 'string', format: 'date-time', description: 'Task creation time' },
            completedAt: { type: 'string', format: 'date-time', description: 'Task completion time' },
            result: { $ref: '#/components/schemas/OptimizationResult' },
            error: { type: 'string', description: 'Error message if task failed' },
          },
          required: ['id', 'status', 'createdAt'],
        },
        ErrorResponse: {
          type: 'object',
          description: 'Error response',
          properties: {
            success: { type: 'boolean', enum: [false], description: 'Always false for errors' },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', description: 'Error code' },
                message: { type: 'string', description: 'Human-readable error message' },
                details: { type: 'object', description: 'Additional error details' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  },
  apis: ['./src/routes/*.ts'], // JSDoc comments location
};

/**
 * Generated OpenAPI specification
 */
export const swaggerSpec = swaggerJsdoc(swaggerOptions);

/**
 * Export swagger options for testing
 */
export { swaggerOptions };
