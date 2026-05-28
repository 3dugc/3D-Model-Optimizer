/**
 * API Routes
 *
 * This module exports all API route handlers for the GLB Optimizer Server.
 * Routes include:
 * - /api/optimize - File upload and optimization
 * - /api/download/:taskId - Download optimized files
 * - /api/status/:taskId - Check task status
 */

export { default as optimizeRouter } from './optimize';
export { default as downloadRouter } from './download';
export { default as statusRouter } from './status';
export { default as analyzeRouter } from './analyze';
export { default as progressRouter } from './progress';
export { default as cloudJobsRouter } from './cloud-jobs';
export { default as billingRouter } from './billing';
export { default as accountRouter } from './account';
export { storeTask, getTask, updateTask } from './status';
