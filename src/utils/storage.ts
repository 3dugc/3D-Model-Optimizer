/**
 * Storage Manager
 * 
 * This module provides file storage management for the GLB Optimizer Server.
 * It handles temporary file storage for uploaded GLB files and optimized results.
 * 
 * Features:
 * - Save and retrieve uploaded files by task ID
 * - Save and retrieve optimized result files by task ID
 * - Clean up files for specific tasks
 * - Clean up old files based on age
 * 
 * @module utils/storage
 * 
 * Requirements: 1.1, 1.4
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Storage configuration
 */
export interface StorageConfig {
  /** Base directory for all storage */
  baseDir: string;
  /** Subdirectory for uploaded files */
  uploadsDir: string;
  /** Subdirectory for result files */
  resultsDir: string;
}

/**
 * File metadata interface
 */
export interface FileMetadata {
  /** Task ID associated with the file */
  taskId: string;
  /** Full path to the file */
  filePath: string;
  /** File size in bytes */
  size: number;
  /** File creation timestamp */
  createdAt: Date;
}

/**
 * Metadata saved alongside an optimized result file.
 */
export interface ResultMetadata {
  taskId: string;
  originalFilename?: string;
  presetName?: string;
  options?: Record<string, unknown>;
  canonicalOptions?: Record<string, unknown>;
  inputHash?: string;
  inputHashKind?: 'raw-upload' | 'prepared-glb';
  optionsHash?: string;
  conversion?: object;
  originalSize?: number;
  optimizedSize?: number;
  compressionRatio?: number;
  optimizedAt: string;
}

/**
 * Default storage configuration
 */
const DEFAULT_CONFIG: StorageConfig = {
  baseDir: './temp',
  uploadsDir: 'uploads',
  resultsDir: 'results',
};

/**
 * Storage Manager class
 * 
 * Manages temporary file storage for uploaded GLB files and optimized results.
 * Uses local file system storage approach.
 */
export class StorageManager {
  private config: StorageConfig;
  private uploadsPath: string;
  private resultsPath: string;

  /**
   * Creates a new StorageManager instance
   * 
   * @param config - Optional storage configuration
   */
  constructor(config: Partial<StorageConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.uploadsPath = path.join(this.config.baseDir, this.config.uploadsDir);
    this.resultsPath = path.join(this.config.baseDir, this.config.resultsDir);
  }

  /**
   * Initializes storage directories
   * Creates the uploads and results directories if they don't exist
   */
  async initialize(): Promise<void> {
    await this.ensureDirectoryExists(this.uploadsPath);
    await this.ensureDirectoryExists(this.resultsPath);
  }

  /**
   * Saves an uploaded file for a task
   * 
   * @param taskId - The task identifier
   * @param buffer - The file buffer to save
   * @returns The full path to the saved file
   * 
   * Requirements: 1.1 - Accept uploaded GLB file and return task identifier
   */
  async saveUploadedFile(taskId: string, buffer: Buffer): Promise<string> {
    await this.ensureDirectoryExists(this.uploadsPath);
    const filePath = this.getUploadedFilePath(taskId);
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
  }

  /**
   * Saves an optimized result file for a task
   * 
   * @param taskId - The task identifier
   * @param buffer - The optimized file buffer to save
   * @returns The full path to the saved file
   * 
   * Requirements: 1.4 - Provide download endpoint for optimized GLB file
   */
  async saveResultFile(taskId: string, buffer: Buffer): Promise<string> {
    await this.ensureDirectoryExists(this.resultsPath);
    const filePath = this.getResultFilePath(taskId);
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
  }

  /**
   * Retrieves an uploaded file for a task
   * 
   * @param taskId - The task identifier
   * @returns The file buffer, or null if not found
   */
  async getUploadedFile(taskId: string): Promise<Buffer | null> {
    const filePath = this.getUploadedFilePath(taskId);
    return this.readFileIfExists(filePath);
  }

  /**
   * Retrieves an optimized result file for a task
   * 
   * @param taskId - The task identifier
   * @returns The file buffer, or null if not found
   * 
   * Requirements: 1.4 - Provide download endpoint for optimized GLB file
   */
  async getResultFile(taskId: string): Promise<Buffer | null> {
    const filePath = this.getResultFilePath(taskId);
    return this.readFileIfExists(filePath);
  }

  /**
   * Saves metadata for an optimized result.
   *
   * @param metadata - Result metadata to save
   */
  async saveResultMetadata(metadata: ResultMetadata): Promise<void> {
    await this.ensureDirectoryExists(this.resultsPath);
    await fs.promises.writeFile(
      this.getResultMetadataPath(metadata.taskId),
      JSON.stringify(metadata, null, 2)
    );
  }

  /**
   * Retrieves metadata for an optimized result.
   *
   * @param taskId - The task identifier
   * @returns Result metadata, or null if not found
   */
  async getResultMetadata(taskId: string): Promise<ResultMetadata | null> {
    const file = await this.readFileIfExists(this.getResultMetadataPath(taskId));
    if (!file) return null;
    return JSON.parse(file.toString('utf8')) as ResultMetadata;
  }

  /**
   * Refreshes the filesystem retention clock for a result and its metadata.
   *
   * @param taskId - The task identifier
   * @param date - Timestamp to use for the refreshed mtime
   */
  async refreshResultRetention(taskId: string, date = new Date()): Promise<void> {
    await fs.promises.utimes(this.getResultFilePath(taskId), date, date);
    await this.touchFileIfExists(this.getResultMetadataPath(taskId), date);
  }

  /**
   * Gets the path to an uploaded file
   * 
   * @param taskId - The task identifier
   * @returns The full path to the uploaded file
   */
  getUploadedFilePath(taskId: string): string {
    return path.join(this.uploadsPath, `${taskId}.glb`);
  }

  /**
   * Gets the path to a result file
   * 
   * @param taskId - The task identifier
   * @returns The full path to the result file
   */
  getResultFilePath(taskId: string): string {
    return path.join(this.resultsPath, `${taskId}.glb`);
  }

  /**
   * Gets the path to result metadata.
   *
   * @param taskId - The task identifier
   * @returns The full path to the metadata file
   */
  getResultMetadataPath(taskId: string): string {
    return path.join(this.resultsPath, `${taskId}.json`);
  }

  /**
   * Checks if an uploaded file exists for a task
   * 
   * @param taskId - The task identifier
   * @returns true if the file exists
   */
  async uploadedFileExists(taskId: string): Promise<boolean> {
    const filePath = this.getUploadedFilePath(taskId);
    return this.fileExists(filePath);
  }

  /**
   * Checks if a result file exists for a task
   * 
   * @param taskId - The task identifier
   * @returns true if the file exists
   */
  async resultFileExists(taskId: string): Promise<boolean> {
    const filePath = this.getResultFilePath(taskId);
    return this.fileExists(filePath);
  }

  /**
   * Gets metadata for an uploaded file
   * 
   * @param taskId - The task identifier
   * @returns File metadata, or null if not found
   */
  async getUploadedFileMetadata(taskId: string): Promise<FileMetadata | null> {
    const filePath = this.getUploadedFilePath(taskId);
    return this.getFileMetadata(taskId, filePath);
  }

  /**
   * Gets metadata for a result file
   * 
   * @param taskId - The task identifier
   * @returns File metadata, or null if not found
   */
  async getResultFileMetadata(taskId: string): Promise<FileMetadata | null> {
    const filePath = this.getResultFilePath(taskId);
    return this.getFileMetadata(taskId, filePath);
  }

  /**
   * Deletes all files associated with a task
   * 
   * @param taskId - The task identifier
   * @returns Object indicating which files were deleted
   */
  async deleteTaskFiles(taskId: string): Promise<{ uploadDeleted: boolean; resultDeleted: boolean }> {
    const uploadDeleted = await this.deleteFileIfExists(this.getUploadedFilePath(taskId));
    const resultDeleted = await this.deleteFileIfExists(this.getResultFilePath(taskId));
    await this.deleteFileIfExists(this.getResultMetadataPath(taskId));
    return { uploadDeleted, resultDeleted };
  }

  /**
   * Cleans up files older than the specified age
   * 
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns Object with counts of deleted files
   */
  async cleanupOldFiles(maxAgeMs: number): Promise<{ uploadsDeleted: number; resultsDeleted: number }> {
    const now = Date.now();
    const uploadsDeleted = await this.cleanupDirectory(this.uploadsPath, now, maxAgeMs);
    const resultsDeleted = await this.cleanupDirectory(this.resultsPath, now, maxAgeMs);
    return { uploadsDeleted, resultsDeleted };
  }

  /**
   * Lists all task IDs with uploaded files
   * 
   * @returns Array of task IDs
   */
  async listUploadedTasks(): Promise<string[]> {
    return this.listTasksInDirectory(this.uploadsPath);
  }

  /**
   * Lists all task IDs with result files
   * 
   * @returns Array of task IDs
   */
  async listResultTasks(): Promise<string[]> {
    return this.listTasksInDirectory(this.resultsPath);
  }

  /**
   * Gets storage statistics
   * 
   * @returns Object with storage statistics
   */
  async getStorageStats(): Promise<{
    uploadsCount: number;
    resultsCount: number;
    totalUploadsSize: number;
    totalResultsSize: number;
  }> {
    const [uploadsStats, resultsStats] = await Promise.all([
      this.getDirectoryStats(this.uploadsPath),
      this.getDirectoryStats(this.resultsPath),
    ]);

    return {
      uploadsCount: uploadsStats.count,
      resultsCount: resultsStats.count,
      totalUploadsSize: uploadsStats.totalSize,
      totalResultsSize: resultsStats.totalSize,
    };
  }

  // Private helper methods

  /**
   * Ensures a directory exists, creating it if necessary
   */
  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.promises.access(dirPath);
    } catch {
      await fs.promises.mkdir(dirPath, { recursive: true });
    }
  }

  /**
   * Reads a file if it exists
   */
  private async readFileIfExists(filePath: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Checks if a file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gets metadata for a file
   */
  private async getFileMetadata(taskId: string, filePath: string): Promise<FileMetadata | null> {
    try {
      const stats = await fs.promises.stat(filePath);
      return {
        taskId,
        filePath,
        size: stats.size,
        createdAt: stats.birthtime,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Deletes a file if it exists
   */
  private async deleteFileIfExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Updates a file mtime when it exists.
   */
  private async touchFileIfExists(filePath: string, date: Date): Promise<boolean> {
    try {
      await fs.promises.utimes(filePath, date, date);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Cleans up old files in a directory
   */
  private async cleanupDirectory(dirPath: string, now: number, maxAgeMs: number): Promise<number> {
    let deletedCount = 0;

    try {
      const files = await fs.promises.readdir(dirPath);

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        try {
          const stats = await fs.promises.stat(filePath);
          const age = now - stats.mtimeMs;

          if (age > maxAgeMs) {
            await fs.promises.unlink(filePath);
            deletedCount++;
          }
        } catch {
          // Skip files that can't be accessed
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    return deletedCount;
  }

  /**
   * Lists task IDs from files in a directory
   */
  private async listTasksInDirectory(dirPath: string): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(dirPath);
      return files
        .filter(file => file.endsWith('.glb'))
        .map(file => file.replace('.glb', ''));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Gets statistics for a directory
   */
  private async getDirectoryStats(dirPath: string): Promise<{ count: number; totalSize: number }> {
    let count = 0;
    let totalSize = 0;

    try {
      const files = await fs.promises.readdir(dirPath);

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        try {
          const stats = await fs.promises.stat(filePath);
          if (stats.isFile()) {
            count++;
            totalSize += stats.size;
          }
        } catch {
          // Skip files that can't be accessed
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    return { count, totalSize };
  }
}

/**
 * Default storage manager instance
 * 
 * Use this singleton instance for most use cases.
 * For custom configurations, create a new StorageManager instance.
 */
export const storage = new StorageManager();

// Convenience function exports for simpler API

/**
 * Saves an uploaded file for a task
 * 
 * @param taskId - The task identifier
 * @param buffer - The file buffer to save
 * @returns The full path to the saved file
 */
export async function saveUploadedFile(taskId: string, buffer: Buffer): Promise<string> {
  return storage.saveUploadedFile(taskId, buffer);
}

/**
 * Saves an optimized result file for a task
 * 
 * @param taskId - The task identifier
 * @param buffer - The optimized file buffer to save
 * @returns The full path to the saved file
 */
export async function saveResultFile(taskId: string, buffer: Buffer): Promise<string> {
  return storage.saveResultFile(taskId, buffer);
}

/**
 * Retrieves an uploaded file for a task
 * 
 * @param taskId - The task identifier
 * @returns The file buffer, or null if not found
 */
export async function getUploadedFile(taskId: string): Promise<Buffer | null> {
  return storage.getUploadedFile(taskId);
}

/**
 * Retrieves an optimized result file for a task
 * 
 * @param taskId - The task identifier
 * @returns The file buffer, or null if not found
 */
export async function getResultFile(taskId: string): Promise<Buffer | null> {
  return storage.getResultFile(taskId);
}

/**
 * Saves metadata for an optimized result.
 *
 * @param metadata - Result metadata to save
 */
export async function saveResultMetadata(metadata: ResultMetadata): Promise<void> {
  return storage.saveResultMetadata(metadata);
}

/**
 * Retrieves metadata for an optimized result.
 *
 * @param taskId - The task identifier
 * @returns Result metadata, or null if not found
 */
export async function getResultMetadata(taskId: string): Promise<ResultMetadata | null> {
  return storage.getResultMetadata(taskId);
}

/**
 * Refreshes the retention clock for a result file and its metadata.
 *
 * @param taskId - The task identifier
 * @param date - Timestamp to use for the refreshed mtime
 */
export async function refreshResultRetention(taskId: string, date = new Date()): Promise<void> {
  return storage.refreshResultRetention(taskId, date);
}

/**
 * Deletes all files associated with a task
 * 
 * @param taskId - The task identifier
 * @returns Object indicating which files were deleted
 */
export async function deleteTaskFiles(taskId: string): Promise<{ uploadDeleted: boolean; resultDeleted: boolean }> {
  return storage.deleteTaskFiles(taskId);
}

/**
 * Cleans up files older than the specified age
 * 
 * @param maxAgeMs - Maximum age in milliseconds
 * @returns Object with counts of deleted files
 */
export async function cleanupOldFiles(maxAgeMs: number): Promise<{ uploadsDeleted: number; resultsDeleted: number }> {
  return storage.cleanupOldFiles(maxAgeMs);
}

/**
 * Lists all task IDs with result files.
 *
 * @returns Array of task IDs
 */
export async function listResultTasks(): Promise<string[]> {
  return storage.listResultTasks();
}

/**
 * Gets the path to a result file
 *
 * @param taskId - The task identifier
 * @returns The full path to the result file
 */
export function getResultFilePath(taskId: string): string {
  return storage.getResultFilePath(taskId);
}

/**
 * Checks if a result file exists for a task
 *
 * @param taskId - The task identifier
 * @returns true if the file exists
 */
export async function resultFileExists(taskId: string): Promise<boolean> {
  return storage.resultFileExists(taskId);
}

/**
 * Checks if an uploaded file exists for a task
 *
 * @param taskId - The task identifier
 * @returns true if the file exists
 */
export async function uploadedFileExists(taskId: string): Promise<boolean> {
  return storage.uploadedFileExists(taskId);
}
