/**
 * Storage Manager Unit Tests
 * 
 * Tests for the file storage management utility.
 * 
 * Requirements: 1.1, 1.4
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  StorageManager,
  saveUploadedFile,
  saveResultFile,
  saveResultMetadata,
  getResultMetadata,
  refreshResultRetention,
  getUploadedFile,
  getResultFile,
  deleteTaskFiles,
  cleanupOldFiles,
} from '../../src/utils/storage';
import {
  describeOptimizationOptions,
  hashOptimizationOptions,
  summarizeOptimizationOptions,
} from '../../src/utils/optimization-metadata';

describe('StorageManager', () => {
  const testBaseDir = './temp-test';
  let storageManager: StorageManager;

  beforeEach(async () => {
    // Create a fresh storage manager with test directory
    storageManager = new StorageManager({
      baseDir: testBaseDir,
      uploadsDir: 'uploads',
      resultsDir: 'results',
    });
    await storageManager.initialize();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.promises.rm(testBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initialize', () => {
    it('should create uploads and results directories', async () => {
      const uploadsPath = path.join(testBaseDir, 'uploads');
      const resultsPath = path.join(testBaseDir, 'results');

      const uploadsExists = await fs.promises.access(uploadsPath).then(() => true).catch(() => false);
      const resultsExists = await fs.promises.access(resultsPath).then(() => true).catch(() => false);

      expect(uploadsExists).toBe(true);
      expect(resultsExists).toBe(true);
    });
  });

  describe('saveUploadedFile', () => {
    it('should save a file and return the file path', async () => {
      const taskId = 'test-task-1';
      const buffer = Buffer.from('test GLB content');

      const filePath = await storageManager.saveUploadedFile(taskId, buffer);

      expect(filePath).toContain(taskId);
      expect(filePath).toContain('.glb');

      const savedContent = await fs.promises.readFile(filePath);
      expect(savedContent.toString()).toBe('test GLB content');
    });

    it('should overwrite existing file with same task ID', async () => {
      const taskId = 'test-task-2';
      const buffer1 = Buffer.from('first content');
      const buffer2 = Buffer.from('second content');

      await storageManager.saveUploadedFile(taskId, buffer1);
      await storageManager.saveUploadedFile(taskId, buffer2);

      const savedContent = await storageManager.getUploadedFile(taskId);
      expect(savedContent?.toString()).toBe('second content');
    });
  });

  describe('saveResultFile', () => {
    it('should save a result file and return the file path', async () => {
      const taskId = 'test-task-3';
      const buffer = Buffer.from('optimized GLB content');

      const filePath = await storageManager.saveResultFile(taskId, buffer);

      expect(filePath).toContain(taskId);
      expect(filePath).toContain('.glb');

      const savedContent = await fs.promises.readFile(filePath);
      expect(savedContent.toString()).toBe('optimized GLB content');
    });

    it('should refresh result and metadata retention timestamps', async () => {
      const taskId = 'test-task-refresh';
      await storageManager.saveResultFile(taskId, Buffer.from('optimized GLB content'));
      await storageManager.saveResultMetadata({
        taskId,
        optimizedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        options: { draco: { enabled: true, compressionLevel: 7 } },
      });

      const oldDate = new Date('2026-01-01T00:00:00.000Z');
      await fs.promises.utimes(storageManager.getResultFilePath(taskId), oldDate, oldDate);
      await fs.promises.utimes(storageManager.getResultMetadataPath(taskId), oldDate, oldDate);

      const refreshedAt = new Date('2026-01-01T00:10:00.000Z');
      await storageManager.refreshResultRetention(taskId, refreshedAt);

      const resultStats = await fs.promises.stat(storageManager.getResultFilePath(taskId));
      const metadataStats = await fs.promises.stat(storageManager.getResultMetadataPath(taskId));
      expect(Math.round(resultStats.mtimeMs)).toBe(refreshedAt.getTime());
      expect(Math.round(metadataStats.mtimeMs)).toBe(refreshedAt.getTime());
    });
  });

  describe('getUploadedFile', () => {
    it('should retrieve a saved uploaded file', async () => {
      const taskId = 'test-task-4';
      const buffer = Buffer.from('uploaded content');

      await storageManager.saveUploadedFile(taskId, buffer);
      const retrieved = await storageManager.getUploadedFile(taskId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.toString()).toBe('uploaded content');
    });

    it('should return null for non-existent file', async () => {
      const retrieved = await storageManager.getUploadedFile('non-existent-task');
      expect(retrieved).toBeNull();
    });
  });

  describe('getResultFile', () => {
    it('should retrieve a saved result file', async () => {
      const taskId = 'test-task-5';
      const buffer = Buffer.from('result content');

      await storageManager.saveResultFile(taskId, buffer);
      const retrieved = await storageManager.getResultFile(taskId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.toString()).toBe('result content');
    });

    it('should return null for non-existent file', async () => {
      const retrieved = await storageManager.getResultFile('non-existent-task');
      expect(retrieved).toBeNull();
    });
  });

  describe('uploadedFileExists', () => {
    it('should return true for existing file', async () => {
      const taskId = 'test-task-6';
      await storageManager.saveUploadedFile(taskId, Buffer.from('content'));

      const exists = await storageManager.uploadedFileExists(taskId);
      expect(exists).toBe(true);
    });

    it('should return false for non-existent file', async () => {
      const exists = await storageManager.uploadedFileExists('non-existent');
      expect(exists).toBe(false);
    });
  });

  describe('resultFileExists', () => {
    it('should return true for existing file', async () => {
      const taskId = 'test-task-7';
      await storageManager.saveResultFile(taskId, Buffer.from('content'));

      const exists = await storageManager.resultFileExists(taskId);
      expect(exists).toBe(true);
    });

    it('should return false for non-existent file', async () => {
      const exists = await storageManager.resultFileExists('non-existent');
      expect(exists).toBe(false);
    });
  });

  describe('getUploadedFilePath', () => {
    it('should return correct path for task ID', () => {
      const taskId = 'test-task-8';
      const filePath = storageManager.getUploadedFilePath(taskId);

      expect(filePath).toBe(path.join(testBaseDir, 'uploads', `${taskId}.glb`));
    });
  });

  describe('getResultFilePath', () => {
    it('should return correct path for task ID', () => {
      const taskId = 'test-task-9';
      const filePath = storageManager.getResultFilePath(taskId);

      expect(filePath).toBe(path.join(testBaseDir, 'results', `${taskId}.glb`));
    });
  });

  describe('getUploadedFileMetadata', () => {
    it('should return metadata for existing file', async () => {
      const taskId = 'test-task-10';
      const buffer = Buffer.from('metadata test content');
      await storageManager.saveUploadedFile(taskId, buffer);

      const metadata = await storageManager.getUploadedFileMetadata(taskId);

      expect(metadata).not.toBeNull();
      expect(metadata?.taskId).toBe(taskId);
      expect(metadata?.size).toBe(buffer.length);
      expect(metadata?.createdAt).toBeInstanceOf(Date);
    });

    it('should return null for non-existent file', async () => {
      const metadata = await storageManager.getUploadedFileMetadata('non-existent');
      expect(metadata).toBeNull();
    });
  });

  describe('getResultFileMetadata', () => {
    it('should return metadata for existing file', async () => {
      const taskId = 'test-task-11';
      const buffer = Buffer.from('result metadata test');
      await storageManager.saveResultFile(taskId, buffer);

      const metadata = await storageManager.getResultFileMetadata(taskId);

      expect(metadata).not.toBeNull();
      expect(metadata?.taskId).toBe(taskId);
      expect(metadata?.size).toBe(buffer.length);
    });
  });

  describe('deleteTaskFiles', () => {
    it('should delete both uploaded and result files', async () => {
      const taskId = 'test-task-12';
      await storageManager.saveUploadedFile(taskId, Buffer.from('upload'));
      await storageManager.saveResultFile(taskId, Buffer.from('result'));

      const result = await storageManager.deleteTaskFiles(taskId);

      expect(result.uploadDeleted).toBe(true);
      expect(result.resultDeleted).toBe(true);

      const uploadExists = await storageManager.uploadedFileExists(taskId);
      const resultExists = await storageManager.resultFileExists(taskId);
      expect(uploadExists).toBe(false);
      expect(resultExists).toBe(false);
    });

    it('should handle non-existent files gracefully', async () => {
      const result = await storageManager.deleteTaskFiles('non-existent-task');

      expect(result.uploadDeleted).toBe(false);
      expect(result.resultDeleted).toBe(false);
    });

    it('should delete only existing files', async () => {
      const taskId = 'test-task-13';
      await storageManager.saveUploadedFile(taskId, Buffer.from('upload only'));

      const result = await storageManager.deleteTaskFiles(taskId);

      expect(result.uploadDeleted).toBe(true);
      expect(result.resultDeleted).toBe(false);
    });
  });

  describe('cleanupOldFiles', () => {
    it('should delete files older than max age', async () => {
      const taskId = 'old-task';
      await storageManager.saveUploadedFile(taskId, Buffer.from('old content'));
      await storageManager.saveResultFile(taskId, Buffer.from('old result'));

      // Wait a bit and then cleanup with 0ms max age (delete all)
      await new Promise(resolve => setTimeout(resolve, 50));
      const result = await storageManager.cleanupOldFiles(10);

      expect(result.uploadsDeleted).toBeGreaterThanOrEqual(1);
      expect(result.resultsDeleted).toBeGreaterThanOrEqual(1);
    });

    it('should not delete recent files', async () => {
      const taskId = 'recent-task';
      await storageManager.saveUploadedFile(taskId, Buffer.from('recent content'));

      // Cleanup with very long max age
      const result = await storageManager.cleanupOldFiles(1000 * 60 * 60); // 1 hour

      expect(result.uploadsDeleted).toBe(0);

      const exists = await storageManager.uploadedFileExists(taskId);
      expect(exists).toBe(true);
    });
  });

  describe('listUploadedTasks', () => {
    it('should list all task IDs with uploaded files', async () => {
      await storageManager.saveUploadedFile('task-a', Buffer.from('a'));
      await storageManager.saveUploadedFile('task-b', Buffer.from('b'));
      await storageManager.saveUploadedFile('task-c', Buffer.from('c'));

      const tasks = await storageManager.listUploadedTasks();

      expect(tasks).toHaveLength(3);
      expect(tasks).toContain('task-a');
      expect(tasks).toContain('task-b');
      expect(tasks).toContain('task-c');
    });

    it('should return empty array when no files exist', async () => {
      const tasks = await storageManager.listUploadedTasks();
      expect(tasks).toHaveLength(0);
    });
  });

  describe('listResultTasks', () => {
    it('should list all task IDs with result files', async () => {
      await storageManager.saveResultFile('result-a', Buffer.from('a'));
      await storageManager.saveResultFile('result-b', Buffer.from('b'));

      const tasks = await storageManager.listResultTasks();

      expect(tasks).toHaveLength(2);
      expect(tasks).toContain('result-a');
      expect(tasks).toContain('result-b');
    });
  });

  describe('getStorageStats', () => {
    it('should return correct storage statistics', async () => {
      await storageManager.saveUploadedFile('stats-1', Buffer.from('upload1'));
      await storageManager.saveUploadedFile('stats-2', Buffer.from('upload22'));
      await storageManager.saveResultFile('stats-1', Buffer.from('result1'));

      const stats = await storageManager.getStorageStats();

      expect(stats.uploadsCount).toBe(2);
      expect(stats.resultsCount).toBe(1);
      expect(stats.totalUploadsSize).toBe(15); // 'upload1' (7) + 'upload22' (8)
      expect(stats.totalResultsSize).toBe(7); // 'result1' (7)
    });

    it('should return zeros when no files exist', async () => {
      const stats = await storageManager.getStorageStats();

      expect(stats.uploadsCount).toBe(0);
      expect(stats.resultsCount).toBe(0);
      expect(stats.totalUploadsSize).toBe(0);
      expect(stats.totalResultsSize).toBe(0);
    });
  });
});

// Test convenience functions (using default storage instance)
describe('Storage convenience functions', () => {
  const testDir = './temp-convenience-test';

  beforeEach(async () => {
    // Create test directories
    await fs.promises.mkdir(path.join(testDir, 'uploads'), { recursive: true });
    await fs.promises.mkdir(path.join(testDir, 'results'), { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
      await fs.promises.rm('./temp', { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('saveUploadedFile should save file using default storage', async () => {
    const taskId = 'convenience-test-1';
    const buffer = Buffer.from('convenience test');

    const filePath = await saveUploadedFile(taskId, buffer);

    expect(filePath).toContain(taskId);
    const content = await getUploadedFile(taskId);
    expect(content?.toString()).toBe('convenience test');

    // Cleanup
    await deleteTaskFiles(taskId);
  });

  it('saveResultFile should save file using default storage', async () => {
    const taskId = 'convenience-test-2';
    const buffer = Buffer.from('result convenience test');

    const filePath = await saveResultFile(taskId, buffer);

    expect(filePath).toContain(taskId);
    const content = await getResultFile(taskId);
    expect(content?.toString()).toBe('result convenience test');

    // Cleanup
    await deleteTaskFiles(taskId);
  });

  it('result metadata should preserve optimization options and support retention refresh', async () => {
    const taskId = 'convenience-test-metadata';
    await saveResultFile(taskId, Buffer.from('result convenience test'));
    await saveResultMetadata({
      taskId,
      optimizedAt: new Date().toISOString(),
      options: {
        draco: { enabled: true, compressionLevel: 7 },
        texture: { enabled: true, mode: 'ETC1S' },
      },
    });

    await refreshResultRetention(taskId, new Date());
    const metadata = await getResultMetadata(taskId);

    expect(metadata?.options?.draco).toEqual({ enabled: true, compressionLevel: 7 });
    expect(summarizeOptimizationOptions(metadata)).toContain('Draco 压缩 7');
    expect(describeOptimizationOptions(metadata)).toContain('纹理压缩：开启');

    // Cleanup
    await deleteTaskFiles(taskId);
  });

  it('deleteTaskFiles should delete files using default storage', async () => {
    const taskId = 'convenience-test-3';
    await saveUploadedFile(taskId, Buffer.from('to delete'));

    const result = await deleteTaskFiles(taskId);

    expect(result.uploadDeleted).toBe(true);
  });

  it('cleanupOldFiles should cleanup using default storage', async () => {
    const taskId = 'convenience-test-4';
    await saveUploadedFile(taskId, Buffer.from('old file'));

    await new Promise(resolve => setTimeout(resolve, 50));
    const result = await cleanupOldFiles(10);

    expect(result.uploadsDeleted).toBeGreaterThanOrEqual(1);
  });
});

describe('optimization metadata helpers', () => {
  it('should hash equivalent option objects consistently', () => {
    const left = hashOptimizationOptions({
      draco: { enabled: true, compressionLevel: 7 },
      clean: { enabled: true, removeUnusedMaterials: true },
    });
    const right = hashOptimizationOptions({
      clean: { removeUnusedMaterials: true, enabled: true },
      draco: { compressionLevel: 7, enabled: true },
    });

    expect(left).toBe(right);
  });
});
