/**
 * Error Handler Middleware
 *
 * Unified error response handling for the GLB Optimizer Server.
 * Converts various error types to consistent JSON responses.
 *
 * @module middleware/error-handler
 */

import { Request, Response, NextFunction } from 'express';
import { OptimizationError, ERROR_CODES, ErrorResponse, ErrorCode } from '../models/error';
import multer from 'multer';
import logger from '../utils/logger';
import { isHttpError } from '../utils/http-error';

/**
 * HTTP status codes for different error types.
 */
const ERROR_STATUS_CODES: Record<string, number> = {
  [ERROR_CODES.INVALID_FILE]: 400,
  [ERROR_CODES.INVALID_OPTIONS]: 400,
  [ERROR_CODES.FILE_TOO_LARGE]: 413,
  [ERROR_CODES.TASK_NOT_FOUND]: 404,
  [ERROR_CODES.OPTIMIZATION_FAILED]: 500,
  [ERROR_CODES.INTERNAL_ERROR]: 500,
};

/**
 * Get HTTP status code for an error code.
 * @param errorCode - The error code
 * @returns HTTP status code
 */
function getStatusCode(errorCode: string): number {
  return ERROR_STATUS_CODES[errorCode] || 500;
}

/**
 * Create an error response object.
 * @param code - Error code
 * @param message - Error message
 * @param details - Optional error details
 * @returns ErrorResponse object
 */
function createErrorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>
): ErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details && { details }),
    },
  };
}

/**
 * Error handler middleware.
 *
 * Handles different error types and returns consistent JSON responses:
 * - OptimizationError: Custom application errors
 * - MulterError: File upload errors
 * - SyntaxError: JSON parsing errors
 * - Generic errors: Unexpected errors
 *
 * @param err - The error object
 * @param req - Express request
 * @param res - Express response
 * @param _next - Next middleware function (unused but required by Express)
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Log error for debugging
  logger.error({
    requestId: req.requestId,
    userId: req.webUserId,
    tenantId: req.webTenantId,
    apiPrincipal: req.apiPrincipal?.name,
    name: err.name,
    message: err.message,
    path: req.path,
    method: req.method,
  }, 'Request error');

  // Handle OptimizationError (custom application errors)
  if (err instanceof OptimizationError) {
    const statusCode = getStatusCode(err.code);
    const response = createErrorResponse(err.code, err.message, err.details);
    res.status(statusCode).json(response);
    return;
  }

  if (isHttpError(err)) {
    const response = createErrorResponse(err.code, err.message, err.details);
    res.status(err.statusCode).json(response);
    return;
  }

  // Handle Multer errors (file upload errors)
  if (err instanceof multer.MulterError) {
    let code: ErrorCode = ERROR_CODES.INVALID_FILE;
    let message = err.message;
    let statusCode = 400;

    if (err.code === 'LIMIT_FILE_SIZE') {
      code = ERROR_CODES.FILE_TOO_LARGE;
      message = 'File size exceeds the 100MB limit';
      statusCode = 413;
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      message = 'Unexpected file field. Use "file" as the field name.';
    }

    const response = createErrorResponse(code, message, { field: err.field });
    res.status(statusCode).json(response);
    return;
  }

  // Handle JSON parsing errors
  if (err instanceof SyntaxError && 'body' in err) {
    const response = createErrorResponse(
      ERROR_CODES.INVALID_OPTIONS,
      'Invalid JSON in request body',
      { received: (err as SyntaxError & { body: string }).body }
    );
    res.status(400).json(response);
    return;
  }

  // Handle generic errors
  const response = createErrorResponse(
    ERROR_CODES.INTERNAL_ERROR,
    'An unexpected error occurred',
    process.env.NODE_ENV === 'development' ? { error: err.message } : undefined
  );
  res.status(500).json(response);
}

/**
 * Not found handler middleware.
 *
 * Handles requests to undefined routes.
 *
 * @param req - Express request
 * @param res - Express response
 */
export function notFoundHandler(req: Request, res: Response): void {
  const response = createErrorResponse(
    ERROR_CODES.TASK_NOT_FOUND,
    `Route not found: ${req.method} ${req.path}`,
    { path: req.path, method: req.method }
  );
  res.status(404).json(response);
}

export default errorHandler;
