import type { CreateCloudJobInput } from '../jobs/types';

export interface WebUser {
  id: string;
  tenantId: string;
  authUserId?: string;
  wechatOpenId: string;
  wechatUnionId?: string;
  nickname?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertWechatUserInput {
  openId: string;
  unionId?: string;
  nickname?: string;
  avatarUrl?: string;
}

export interface UpsertAuthServiceUserInput {
  authUserId: string;
  unionId?: string;
  nickname?: string;
  avatarUrl?: string;
}

export interface Wallet {
  userId: string;
  tenantId: string;
  cashBalanceCents: number;
  bonusBalanceCents: number;
  frozenCents: number;
  updatedAt: string;
}

export type WalletLedgerType =
  | 'recharge_paid'
  | 'job_hold'
  | 'job_charge'
  | 'job_release'
  | 'refund'
  | 'adjustment';

export interface WalletLedgerEntry {
  id: string;
  userId: string;
  tenantId: string;
  type: WalletLedgerType;
  cashDeltaCents: number;
  bonusDeltaCents: number;
  frozenDeltaCents: number;
  balanceAfterCashCents: number;
  frozenAfterCents: number;
  rechargeOrderId?: string;
  jobId?: string;
  jobChargeId?: string;
  note?: string;
  createdAt: string;
}

export type RechargeOrderStatus = 'pending_payment' | 'paid' | 'expired' | 'cancelled' | 'refunded';

export interface RechargeOrder {
  id: string;
  userId: string;
  tenantId: string;
  status: RechargeOrderStatus;
  amountCents: number;
  currency: 'CNY';
  provider: 'wechat_native';
  outTradeNo: string;
  codeUrl?: string;
  transactionId?: string;
  expiresAt: string;
  paidAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type JobChargeStatus = 'held' | 'charged' | 'released' | 'refunded';

export interface JobCharge {
  id: string;
  userId: string;
  tenantId: string;
  jobId: string;
  amountCents: number;
  status: JobChargeStatus;
  heldAt: string;
  chargedAt?: string;
  releasedAt?: string;
  refundedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRechargeOrderInput {
  userId: string;
  amountCents: number;
  description: string;
  notifyUrl: string;
}

export interface CreatePaidWebJobInput extends Omit<CreateCloudJobInput, 'tenantId' | 'paymentRequired'> {
  userId: string;
}
