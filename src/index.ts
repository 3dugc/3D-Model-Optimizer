/**
 * 三维模型优化服务
 *
 * A Node.js server for optimizing GLB 3D model files with RESTful API.
 *
 * Core capabilities:
 * - Mesh simplification (meshoptimizer)
 * - Draco geometry compression
 * - Texture compression (KTX2/Basis Universal)
 * - Vertex quantization
 * - Mesh merging
 * - Resource cleanup
 */

import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import {
  optimizeRouter,
  downloadRouter,
  statusRouter,
  analyzeRouter,
  progressRouter,
  cloudJobsRouter,
  billingRouter,
  accountRouter,
  invoiceRouter,
  metricsRouter,
} from './routes';
import { errorHandler, notFoundHandler, authMiddleware, isAuthEnabled } from './middleware';
import { config, validateConfig } from './config';
import { cleanupOldFiles } from './utils/storage';
import logger from './utils/logger';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      requestId?: string;
    }
  }
}

// Create Express application
const app: Express = express();

type BuildInfo = {
  version: string;
  packageVersion?: string;
  builtAtIso?: string;
  builtAtBeijing: string;
  timeZone: string;
};

function loadBuildInfo(): BuildInfo {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')) as BuildInfo;
  } catch {
    return {
      version: 'dev',
      builtAtBeijing: '开发模式',
      timeZone: 'Asia/Shanghai',
    };
  }
}

const buildInfo = loadBuildInfo();

// CORS configuration
app.use(cors({
  origin: config.corsOrigins,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-web-token'],
}));

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for static UI with CDN resources
  crossOriginEmbedderPolicy: false,
}));

// Gzip compression for all responses
app.use(compression());

app.use((req, res, next) => {
  const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : uuidv4();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});

// Request timeout (5 minutes for optimization, covers large models)
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
app.use((_req, res, next) => {
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(408).json({
        success: false,
        error: { code: 'REQUEST_TIMEOUT', message: 'Request timed out' },
      });
    }
  });
  next();
});

// Middleware configuration
// - JSON body parser with size limit
app.use(express.json({
  limit: config.jsonLimit,
  verify: (req, _res, buffer) => {
    (req as Request).rawBody = Buffer.from(buffer);
  },
}));
// - URL-encoded body parser
app.use(express.urlencoded({ extended: true, limit: config.jsonLimit }));

app.get('/build-info.js', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('application/javascript');
  res.send(`window.__APP_BUILD_INFO__ = ${JSON.stringify(buildInfo)};\n`);
});

// - Static files for test UI
app.use(express.static(path.join(__dirname, '../public')));

// Swagger UI - API Documentation (Requirements: 9.1, 9.2)
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  explorer: true,
  customSiteTitle: '三维模型优化服务 API',
}));

// OpenAPI JSON specification endpoint
app.get('/api-docs.json', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    message: '三维模型优化服务运行中',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// API Routes (with optional authentication)
app.use('/api/optimize/stream', progressRouter);
app.use('/api/optimize', optimizeRouter);
app.use('/api/download', downloadRouter);
app.use('/api/status', authMiddleware, statusRouter);
app.use('/api/analyze', analyzeRouter);
app.use('/api/v1/account', accountRouter);
app.use('/api/v1/invoices', invoiceRouter);
app.use('/api/v1/metrics', authMiddleware, metricsRouter);
app.use('/api/v1', authMiddleware, cloudJobsRouter);
app.use('/api/v1/payments', authMiddleware, billingRouter);

// Unified auth-service redirects to this route after OAuth authorization.
app.get('/auth/callback', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 404 handler for undefined routes
app.use(notFoundHandler);

// Error handling middleware (must be last)
app.use(errorHandler);

// Start server
if (require.main === module) {
  app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, '三维模型优化服务已启动');
    logger.info({ url: `http://${config.host}:${config.port}/api-docs` }, 'API documentation available');
    logger.info({ auth: isAuthEnabled() ? 'enabled' : 'disabled' }, 'Authentication status');
    for (const warning of validateConfig()) {
      logger.warn({ warning }, 'Configuration warning');
    }

    // Auto-cleanup temp files older than 1 hour, every 10 minutes
    const CLEANUP_INTERVAL = config.cleanupIntervalMs;
    const MAX_FILE_AGE = config.fileRetentionMs;
    setInterval(async () => {
      try {
        const result = await cleanupOldFiles(MAX_FILE_AGE);
        const total = result.uploadsDeleted + result.resultsDeleted;
        if (total > 0) {
          logger.info({ uploads: result.uploadsDeleted, results: result.resultsDeleted }, 'Cleaned up expired temp files');
        }
      } catch (e) {
        logger.error({ error: e }, 'Cleanup failed');
      }
    }, CLEANUP_INTERVAL);
    logger.info('Temp file auto-cleanup enabled (1h max age, 10min interval)');
  });
}

export default app;
