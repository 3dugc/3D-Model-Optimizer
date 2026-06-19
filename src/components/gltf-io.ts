import { NodeIO, type Extension } from '@gltf-transform/core';
import {
  KHRDracoMeshCompression,
  KHRMaterialsUnlit,
  KHRMeshQuantization,
  KHRTextureBasisu,
} from '@gltf-transform/extensions';

import { getDracoModules } from './draco-singleton';

export interface GltfIOOptions {
  preserveUnlit?: boolean;
  includeDracoDependencies?: boolean;
}

export function getGltfExtensions(options: GltfIOOptions = {}): (typeof Extension)[] {
  const extensions: (typeof Extension)[] = [
    KHRDracoMeshCompression,
    KHRMeshQuantization,
    KHRTextureBasisu,
  ];

  if (options.preserveUnlit !== false) {
    extensions.push(KHRMaterialsUnlit);
  }

  return extensions;
}

export async function createGltfNodeIO(options: GltfIOOptions = {}): Promise<NodeIO> {
  const io = new NodeIO().registerExtensions(getGltfExtensions(options));

  if (options.includeDracoDependencies !== false) {
    io.registerDependencies(await getDracoModules());
  }

  return io;
}
