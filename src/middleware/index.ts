/**
 * Middleware
 *
 * This module exports middleware functions for the GLB Optimizer Server.
 * Middleware includes:
 * - ErrorHandler - Unified error response handling
 * - NotFoundHandler - 404 route handling
 * - AuthMiddleware - Optional API key authentication
 */

export { errorHandler, notFoundHandler } from './error-handler';
export { authMiddleware, isAuthEnabled, getApiKey, requireScope } from './auth';
export type { ApiPrincipal } from './auth';
