import { createHash } from 'crypto';
import * as fs from 'fs';
import type { OptimizationOptions } from '../models/options';
import type { ResultMetadata } from './storage';

const presetLabels: Record<string, string> = {
  fast: '快速',
  balanced: '均衡',
  maximum: '极限',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isEnabled(options: Record<string, unknown>, key: string): boolean {
  return asRecord(options[key])?.enabled === true;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((canonical, key) => {
      if (record[key] !== undefined) {
        canonical[key] = canonicalize(record[key]);
      }
      return canonical;
    }, {});
}

export function canonicalizeOptimizationOptions(options: OptimizationOptions): Record<string, unknown> {
  return canonicalize(options) as Record<string, unknown>;
}

export function hashOptimizationOptions(options: OptimizationOptions): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeOptimizationOptions(options)))
    .digest('hex');
}

export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function summarizeOptimizationOptions(metadata: Pick<ResultMetadata, 'options' | 'presetName'> | null): string {
  if (!metadata?.options) return '历史文件，未记录优化选项';

  const options = metadata.options;
  const parts = ['几何修复'];
  if (metadata.presetName) {
    parts.push(`预设：${presetLabels[metadata.presetName] || metadata.presetName}`);
  }

  const clean = asRecord(options.clean);
  if (clean?.enabled === true) {
    const scopes = [
      clean.removeUnusedNodes !== false ? '节点' : '',
      clean.removeUnusedMaterials !== false ? '材质' : '',
      clean.removeUnusedTextures !== false ? '纹理' : '',
    ].filter(Boolean);
    parts.push(scopes.length ? `资源清理(${scopes.join('/')})` : '资源清理');
  }
  if (isEnabled(options, 'merge')) parts.push('Mesh 合并');

  const simplify = asRecord(options.simplify);
  if (simplify?.enabled === true) {
    const ratio = typeof simplify.targetRatio === 'number' ? ` ${simplify.targetRatio}` : '';
    parts.push(`网格减面${ratio}`);
  }
  if (isEnabled(options, 'quantize')) parts.push('顶点量化');

  const draco = asRecord(options.draco);
  if (draco?.enabled === true) {
    const level = typeof draco.compressionLevel === 'number' ? ` ${draco.compressionLevel}` : '';
    parts.push(`Draco 压缩${level}`);
  }

  const texture = asRecord(options.texture);
  if (texture?.enabled === true) {
    const mode = typeof texture.mode === 'string' ? ` ${texture.mode}` : '';
    parts.push(`纹理压缩${mode}`);
  }

  const extensions = asRecord(options.extensions);
  parts.push(extensions?.preserveUnlit === false ? '不保留不受光材质' : '保留不受光材质');

  return parts.join('；');
}

export function describeOptimizationOptions(metadata: Pick<ResultMetadata, 'options' | 'presetName'> | null): string {
  if (!metadata?.options) return '历史文件，未记录优化参数';

  const options = metadata.options;
  const lines: string[] = [];
  if (metadata.presetName) {
    lines.push(`预设：${presetLabels[metadata.presetName] || metadata.presetName}`);
  }

  const clean = asRecord(options.clean);
  lines.push(clean?.enabled === true
    ? `资源清理：开启（${[
      clean.removeUnusedNodes !== false ? '节点' : '',
      clean.removeUnusedMaterials !== false ? '材质' : '',
      clean.removeUnusedTextures !== false ? '纹理' : '',
    ].filter(Boolean).join('、') || '默认范围'}）`
    : '资源清理：关闭');
  lines.push(`Mesh 合并：${isEnabled(options, 'merge') ? '开启' : '关闭'}`);

  const simplify = asRecord(options.simplify);
  lines.push(simplify?.enabled === true
    ? `网格减面：开启（目标比例 ${simplify.targetRatio ?? '默认'}，保留边界 ${simplify.lockBorder === true ? '是' : '否'}）`
    : '网格减面：关闭');
  lines.push(`顶点量化：${isEnabled(options, 'quantize') ? '开启' : '关闭'}`);

  const draco = asRecord(options.draco);
  lines.push(draco?.enabled === true
    ? `Draco 压缩：开启（级别 ${draco.compressionLevel ?? '默认'}）`
    : 'Draco 压缩：关闭');

  const texture = asRecord(options.texture);
  lines.push(texture?.enabled === true
    ? `纹理压缩：开启（模式 ${texture.mode ?? '默认'}${texture.quality ? `，质量 ${texture.quality}` : ''}）`
    : '纹理压缩：关闭');

  const extensions = asRecord(options.extensions);
  lines.push(`保留不受光材质：${extensions?.preserveUnlit === false ? '否' : '是'}`);
  return lines.join('\n');
}
