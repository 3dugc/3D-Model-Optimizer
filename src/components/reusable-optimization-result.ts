import * as fs from 'fs';
import { config } from '../config';
import { accountService } from '../accounts/account-service';
import type { OptimizationResult } from '../models/result';
import {
  getResultFilePath,
  getResultMetadata,
  listResultTasks,
  refreshResultRetention,
  type ResultMetadata,
} from '../utils/storage';
import {
  describeOptimizationOptions,
  summarizeOptimizationOptions,
} from '../utils/optimization-metadata';

export interface ReusedOptimizationResult extends OptimizationResult {
  reused: true;
  duplicateOfTaskId: string;
  message: string;
  optimizedAt: string;
  expiresAt: string;
  remainingMs: number;
  optionsSummary: string;
  optionsDetail: string;
}

export interface FindReusableOptimizationInput {
  userId: string;
  inputHash: string;
  optionsHash: string;
}

interface ReuseCandidate {
  taskId: string;
  metadata: ResultMetadata;
  stats: fs.Stats;
  chargeUpdatedAt: number;
}

function buildResult(candidate: ReuseCandidate, expiresAt: Date): ReusedOptimizationResult {
  const metadata = candidate.metadata;
  const originalSize = metadata.originalSize || candidate.stats.size;
  const optimizedSize = metadata.optimizedSize || candidate.stats.size;
  return {
    taskId: candidate.taskId,
    success: true,
    reused: true,
    duplicateOfTaskId: candidate.taskId,
    message: '已找到相同模型和相同优化参数的历史结果，已延长该结果的保留时间，可直接下载上一个模型。',
    downloadUrl: `/api/download/${candidate.taskId}`,
    processingTime: 0,
    originalSize,
    optimizedSize,
    compressionRatio: metadata.compressionRatio ?? (originalSize > 0 ? optimizedSize / originalSize : 1),
    steps: [],
    optimizedAt: metadata.optimizedAt || candidate.stats.mtime.toISOString(),
    expiresAt: expiresAt.toISOString(),
    remainingMs: config.fileRetentionMs,
    optionsSummary: summarizeOptimizationOptions(metadata),
    optionsDetail: describeOptimizationOptions(metadata),
  };
}

export async function findReusableOptimizationResult(
  input: FindReusableOptimizationInput
): Promise<ReusedOptimizationResult | undefined> {
  const taskIds = await listResultTasks();
  const candidates: ReuseCandidate[] = [];

  for (const taskId of taskIds) {
    const metadata = await getResultMetadata(taskId);
    if (metadata?.inputHash !== input.inputHash || metadata.optionsHash !== input.optionsHash) {
      continue;
    }

    const charge = await accountService.getJobCharge(taskId);
    if (!charge || charge.userId !== input.userId || charge.status !== 'charged') {
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(getResultFilePath(taskId));
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;

    candidates.push({
      taskId,
      metadata,
      stats,
      chargeUpdatedAt: Date.parse(charge.updatedAt) || 0,
    });
  }

  const candidate = candidates.sort((left, right) => {
    const mtimeDelta = right.stats.mtimeMs - left.stats.mtimeMs;
    return mtimeDelta || right.chargeUpdatedAt - left.chargeUpdatedAt;
  })[0];
  if (!candidate) return undefined;

  const refreshedAt = new Date();
  await refreshResultRetention(candidate.taskId, refreshedAt);
  const expiresAt = new Date(refreshedAt.getTime() + config.fileRetentionMs);
  return buildResult(candidate, expiresAt);
}
