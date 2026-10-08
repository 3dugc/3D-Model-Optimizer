import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import sharp from 'sharp';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { executePipeline } from '../../src/components/optimization-pipeline';
import { compressTextures } from '../../src/components/texture-compressor';

// Use a real asymmetric image and a textured, indexed triangle. This catches
// serialization contracts that a MIME-only or mocked-compressor test misses.
async function fixture(mime: 'image/png' | 'image/jpeg' | 'image/webp') {
  const rgba = Buffer.from([
    250, 15, 25, 255, 10, 240, 35, 255,
    20, 30, 235, 255, 230, 210, 20, 255,
  ]);
  const image = sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } });
  const pixels = mime === 'image/png' ? await image.png().toBuffer()
    : mime === 'image/jpeg' ? await image.jpeg({ quality: 95 }).toBuffer()
    : await image.webp({ lossless: true }).toBuffer();
  const doc = new Document();
  const buffer = doc.createBuffer();
  const texture = doc.createTexture('asymmetric').setImage(pixels).setMimeType(mime);
  const material = doc.createMaterial('material').setBaseColorTexture(texture).setMetallicFactor(0);
  const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const normal = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]));
  const uv = doc.createAccessor().setType('VEC2').setBuffer(buffer)
    .setArray(new Float32Array([0.125, 0.25, 0.875, 0.25, 0.125, 0.75]));
  const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2]));
  const primitive = doc.createPrimitive().setAttribute('POSITION', position)
    .setAttribute('NORMAL', normal).setAttribute('TEXCOORD_0', uv)
    .setIndices(indices).setMaterial(material);
  const mesh = doc.createMesh().addPrimitive(primitive);
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  if (mime === 'image/webp') doc.createExtension(EXTTextureWebP).setRequired(true);
  return { doc, pixels, uv: Array.from(uv.getArray()!) };
}

function glbJSON(bytes: Uint8Array) {
  const view = Buffer.from(bytes);
  expect(view.readUInt32LE(0)).toBe(0x46546c67);
  return JSON.parse(view.subarray(20, 20 + view.readUInt32LE(12)).toString('utf8').trim());
}

// glTF-Transform cannot author optional alternative-image fallbacks. Construct
// a valid GLB container ourselves so the real pipeline reads both alternatives.
async function optionalWebPWithPngFallback(io: NodeIO) {
  const webp = await fixture('image/webp');
  const png = await fixture('image/png');
  const source = Buffer.from(await io.writeBinary(webp.doc));
  const jsonLength = source.readUInt32LE(12);
  const json = glbJSON(source);
  const binOffset = 20 + jsonLength;
  const bin = source.subarray(binOffset + 8, binOffset + 8 + source.readUInt32LE(binOffset));
  const viewIndex = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: png.pixels.length });
  const imageIndex = json.images.length;
  json.images.push({ mimeType: 'image/png', bufferView: viewIndex });
  json.textures[0].source = imageIndex;
  delete json.extensionsRequired;
  const payload = Buffer.concat([bin, png.pixels]);
  json.buffers[0].byteLength = payload.length;
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 0x20)]);
  const paddedBin = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + paddedBin.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(paddedBin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return { bytes: Buffer.concat([header, jsonHeader, paddedJson, binHeader, paddedBin]), webpPixels: webp.pixels };
}

describe('producer WebP export contract', () => {
  let directory: string;
  let previousPath: string | undefined;
  const io = new NodeIO().registerExtensions([EXTTextureWebP]);

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'optimizer-webp-contract-'));
    previousPath = process.env.PATH;
    // Exercise the actual sharp fallback deterministically, even on hosts with
    // toktx installed; image encoding still uses the real sharp library.
    process.env.PATH = directory;
  });
  afterEach(async () => {
    process.env.PATH = previousPath;
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('writes fallback WebP as required EXT_texture_webp with extension source', async () => {
    const { doc, uv } = await fixture('image/png');
    const input = path.join(directory, 'input.glb');
    const output = path.join(directory, 'output.glb');
    await io.write(input, doc);
    const result = await executePipeline(input, output, {
      texture: { enabled: true, mode: 'ETC1S', quality: 128 },
      draco: { enabled: false },
    });
    expect(result.success).toBe(true);
    const json = glbJSON(await fs.readFile(output));
    expect(json.images[0].mimeType).toBe('image/webp');
    expect(json.extensionsUsed ?? []).toContain('EXT_texture_webp');
    expect(json.extensionsRequired ?? []).toContain('EXT_texture_webp');
    expect(json.textures[0].source).toBeUndefined();
    expect(json.textures[0].extensions.EXT_texture_webp.source).toBe(0);
    const restored = await io.read(output);
    expect(restored.getRoot().listMaterials()[0].getBaseColorTexture()).toBe(restored.getRoot().listTextures()[0]);
    expect(Array.from(restored.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('TEXCOORD_0')!.getArray()!)).toEqual(uv);
    const metadata = await sharp(restored.getRoot().listTextures()[0].getImage()!).metadata();
    expect(metadata.format).toBe('webp');
    expect([metadata.width, metadata.height]).toEqual([2, 2]);
  });

  it('accepts a standards compliant WebP GLB and preserves it when texture compression is disabled', async () => {
    const { doc, pixels } = await fixture('image/webp');
    const input = path.join(directory, 'input-webp.glb');
    const output = path.join(directory, 'output-webp.glb');
    await io.write(input, doc);
    expect((await executePipeline(input, output, { texture: { enabled: false } })).success).toBe(true);
    const restored = await io.read(output);
    expect(Buffer.from(restored.getRoot().listTextures()[0].getImage()!)).toEqual(pixels);
    const json = glbJSON(await fs.readFile(output));
    expect(json.extensionsRequired).toContain('EXT_texture_webp');
    expect(json.textures[0].extensions.EXT_texture_webp.source).toBe(0);
  });

  it('marks retained WebP required when reading an optional WebP texture with a PNG fallback', async () => {
    const { bytes, webpPixels } = await optionalWebPWithPngFallback(io);
    const input = path.join(directory, 'optional-webp-png.glb');
    const output = path.join(directory, 'selected-webp.glb');
    await fs.writeFile(input, bytes);
    const before = glbJSON(bytes);
    expect(before.textures[0].source).toBe(1);
    expect(before.textures[0].extensions.EXT_texture_webp.source).toBe(0);
    expect(before.extensionsRequired ?? []).not.toContain('EXT_texture_webp');
    expect((await executePipeline(input, output, { texture: { enabled: false } })).success).toBe(true);
    const after = glbJSON(await fs.readFile(output));
    // glTF-Transform selects the WebP alternative and cannot retain the core
    // fallback. A WebP-only output must declare WebP required even when no
    // image compression step ran.
    expect(after.textures[0].source).toBeUndefined();
    expect(after.images[after.textures[0].extensions.EXT_texture_webp.source].mimeType).toBe('image/webp');
    expect(after.extensionsRequired ?? []).toContain('EXT_texture_webp');
    const restored = await io.read(output);
    expect(Buffer.from(restored.getRoot().listTextures()[0].getImage()!)).toEqual(webpPixels);
  });

  it.each(['image/jpeg', 'image/png'] as const)('preserves %s image bytes and MIME when the API disables texture compression', async (mime) => {
    const { doc, pixels, uv } = await fixture(mime);
    const input = path.join(directory, 'input.glb');
    const output = path.join(directory, 'output.glb');
    await io.write(input, doc);
    const result = await executePipeline(input, output, { texture: { enabled: false } });
    expect(result.success).toBe(true);
    expect(result.steps.some(step => step.step === 'texture')).toBe(false);
    const restored = await io.read(output);
    const texture = restored.getRoot().listTextures()[0];
    expect(texture.getMimeType()).toBe(mime);
    expect(Buffer.from(texture.getImage()!)).toEqual(pixels);
    expect(Array.from(restored.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('TEXCOORD_0')!.getArray()!)).toEqual(uv);
    expect(glbJSON(await fs.readFile(output)).extensionsUsed ?? []).not.toContain('EXT_texture_webp');
  });

  it('retains the original image and creates no WebP requirement when sharp cannot encode it', async () => {
    const { doc } = await fixture('image/png');
    const invalid = Buffer.from('invalid image, retained by failure isolation');
    const texture = doc.getRoot().listTextures()[0].setImage(invalid);
    await compressTextures(doc, { enabled: true });
    expect(texture.getMimeType()).toBe('image/png');
    expect(Buffer.from(texture.getImage()!)).toEqual(invalid);
    expect(doc.getRoot().listExtensionsRequired().map(ext => ext.extensionName)).not.toContain('EXT_texture_webp');
  });
});
