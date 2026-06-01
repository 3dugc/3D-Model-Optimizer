import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { prepareModelInput } from '../../src/utils/model-input';
import { OptimizationError } from '../../src/models/error';

function makeMinimalGlb(): Buffer {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt32LE(0x46546c67, 0);
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(12, 8);
  return buffer;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-model-input-'));
}

describe('prepareModelInput', () => {
  it('extracts a nested model from a ZIP archive', async () => {
    const dir = await makeTempDir();
    const zipPath = path.join(dir, 'upload.zip');
    await fs.writeFile(zipPath, createZip([{ name: 'nested/model.glb', data: makeMinimalGlb() }]));

    const prepared = await prepareModelInput({
      inputPath: zipPath,
      scratchDir: path.join(dir, 'scratch'),
      originalFilename: 'upload.zip',
    });

    expect(prepared.modelExt).toBe('.glb');
    expect(prepared.conversion.converted).toBe(false);
    await expect(fs.stat(prepared.inputGlbPath)).resolves.toBeTruthy();
  });

  it('rejects ZIP entries that escape the extraction directory', async () => {
    const dir = await makeTempDir();
    const zipPath = path.join(dir, 'evil.zip');
    await fs.writeFile(zipPath, createZip([{ name: '../escape.glb', data: makeMinimalGlb() }]));

    await expect(
      prepareModelInput({
        inputPath: zipPath,
        scratchDir: path.join(dir, 'scratch'),
        originalFilename: 'evil.zip',
      })
    ).rejects.toBeInstanceOf(OptimizationError);
  });

  it('rejects ZIP archives with too many entries before extraction', async () => {
    const dir = await makeTempDir();
    const zipPath = path.join(dir, 'too-many.zip');
    const entries = Array.from({ length: 301 }, (_item, index) => ({
      name: `files/${index}.txt`,
      data: Buffer.from('x'),
    }));
    await fs.writeFile(zipPath, createZip(entries));

    await expect(
      prepareModelInput({
        inputPath: zipPath,
        scratchDir: path.join(dir, 'scratch'),
        originalFilename: 'too-many.zip',
      })
    ).rejects.toBeInstanceOf(OptimizationError);
  });
});
