import { describe, it, expect, vi } from 'vitest';
import { Document } from '@gltf-transform/core';

function createSimplePngBuffer(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x01,
    0x08, 0x02,
    0x00, 0x00, 0x00,
    0x90, 0x77, 0x53, 0xde,
    0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ]);
}

function createDocumentWithTexture(): Document {
  const document = new Document();
  const texture = document.createTexture('fallbackTexture');
  texture.setImage(createSimplePngBuffer());
  texture.setMimeType('image/png');
  document.createMaterial('material').setBaseColorTexture(texture);
  return document;
}

describe('compressTextures toktx failures', () => {
  it('does not require KHR_texture_basisu when every toktx conversion fails', async () => {
    vi.resetModules();
    vi.doMock('child_process', () => ({
      execFile: (
        command: string,
        args: string[],
        optionsOrCallback: unknown,
        maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void
      ) => {
        const callback =
          typeof optionsOrCallback === 'function'
            ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
            : maybeCallback;

        if (!callback) throw new Error('Missing execFile callback');
        if (command === 'toktx' && args[0] === '--version') {
          callback(null, 'toktx 4.3.2', '');
        } else {
          callback(new Error('toktx conversion failed'), '', 'conversion failed');
        }

        return {} as never;
      },
    }));

    const { compressTextures } = await import('../../src/components/texture-compressor');
    const document = createDocumentWithTexture();
    const stats = await compressTextures(document, { enabled: true, mode: 'ETC1S' });
    const texture = document.getRoot().listTextures()[0];
    const extensionNames = document.getRoot().listExtensionsUsed().map((extension) => extension.extensionName);

    expect(stats.details[0].compressedSize).toBe(stats.details[0].originalSize);
    expect(texture.getMimeType()).toBe('image/png');
    expect(extensionNames).not.toContain('KHR_texture_basisu');
  });
});
