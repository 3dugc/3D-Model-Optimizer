import { accountService } from '../accounts/account-service';
import type { Wallet } from '../accounts/types';
import type { OptimizationOptions } from '../models/options';
import type { OptimizationResult } from '../models/result';
import { executePipeline, type ProgressCallback } from './optimization-pipeline';
import { saveResultMetadata, type ResultMetadata } from '../utils/storage';
import { config } from '../config';
import logger from '../utils/logger';

export type WalletChargeStatus = 'held' | 'charged' | 'released';

export interface WalletChargeEvent {
  wallet: Wallet;
  priceCents: number;
  status: WalletChargeStatus;
}

export interface PaidOptimizationResult {
  result: OptimizationResult;
  wallet: Wallet;
  chargeStatus: 'charged' | 'released';
}

export interface PaidOptimizationInput {
  taskId: string;
  userId: string;
  inputGlbPath: string;
  outputPath: string;
  options: OptimizationOptions;
  metadata: Omit<ResultMetadata, 'originalSize' | 'optimizedSize' | 'compressionRatio' | 'optimizedAt'>;
  onProgress?: ProgressCallback;
  onWallet?: (event: WalletChargeEvent) => void;
}

function getOptimizationFailureNote(result: { steps?: Array<{ success: boolean; error?: string }> }): string {
  return result.steps?.find((step) => !step.success)?.error || 'Optimization failed';
}

export async function runPaidOptimization(input: PaidOptimizationInput): Promise<PaidOptimizationResult> {
  let chargeHeld = false;
  let chargeSettled = false;

  const releaseHeldCharge = async (note = 'Optimization failed'): Promise<void> => {
    if (!chargeHeld || chargeSettled) return;
    await accountService.releaseJobCharge(input.taskId, note).catch((releaseError) => {
      logger.warn({ taskId: input.taskId, userId: input.userId, error: releaseError }, 'Failed to release optimization charge');
    });
  };

  try {
    const held = await accountService.holdOptimizationCharge(input.userId, input.taskId);
    chargeHeld = true;
    input.onWallet?.({
      wallet: held.wallet,
      priceCents: config.billing.defaultJobPriceCents,
      status: 'held',
    });

    const result = await executePipeline(input.inputGlbPath, input.outputPath, input.options, input.onProgress);
    result.taskId = input.taskId;
    result.downloadUrl = `/api/download/${input.taskId}`;

    if (!result.success) {
      await accountService.releaseJobCharge(input.taskId, getOptimizationFailureNote(result));
      chargeSettled = true;
      const wallet = await accountService.getWallet(input.userId);
      input.onWallet?.({
        wallet,
        priceCents: config.billing.defaultJobPriceCents,
        status: 'released',
      });
      logger.warn({ taskId: input.taskId, userId: input.userId }, 'Optimization failed and wallet charge was released');
      return { result, wallet, chargeStatus: 'released' };
    }

    await saveResultMetadata({
      ...input.metadata,
      originalSize: result.originalSize,
      optimizedSize: result.optimizedSize,
      compressionRatio: result.compressionRatio,
      optimizedAt: new Date().toISOString(),
    });

    await accountService.settleJobCharge(input.taskId);
    chargeSettled = true;
    const wallet = await accountService.getWallet(input.userId);
    input.onWallet?.({
      wallet,
      priceCents: config.billing.defaultJobPriceCents,
      status: 'charged',
    });
    logger.info(
      {
        taskId: input.taskId,
        userId: input.userId,
        durationMs: result.processingTime,
        originalSize: result.originalSize,
        optimizedSize: result.optimizedSize,
      },
      'Paid optimization completed'
    );

    return { result, wallet, chargeStatus: 'charged' };
  } catch (error) {
    await releaseHeldCharge(error instanceof Error ? error.message : 'Optimization failed');
    throw error;
  }
}
