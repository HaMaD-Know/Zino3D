import { extensionOf } from '../utils/format';

export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'fbx';
export type ResourceKind = 'bin' | 'image' | 'mtl';
export type DetectedKind = ModelFormat | ResourceKind | 'zino3d' | 'unknown';

export const MODEL_EXTENSIONS: Record<ModelFormat, string[]> = {
  glb: ['glb'],
  gltf: ['gltf'],
  obj: ['obj'],
  stl: ['stl'],
  fbx: ['fbx'],
};

export const IMPORT_ACCEPT = '.glb,.gltf,.obj,.mtl,.stl,.fbx,.bin,.png,.jpg,.jpeg,.webp,.ktx2,.tga';

/** Hard limit to protect low-memory devices from accidental huge inputs. */
export const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'ktx2', 'tga', 'bmp', 'gif']);

function startsWith(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[i] !== text.charCodeAt(i)) return false;
  return true;
}

/** Determines the kind of an input file from its magic bytes, falling back to its extension. */
export function detectKind(fileName: string, head: Uint8Array): DetectedKind {
  if (startsWith(head, 'glTF')) return 'glb';
  if (startsWith(head, 'Kaydara FBX Binary')) return 'fbx';
  if (startsWith(head, 'ZINO3D')) return 'zino3d';
  const ext = extensionOf(fileName);
  if (ext === 'zino3d') return 'zino3d';
  if (ext === 'glb') return 'glb'; // will fail validation later if the magic is wrong
  if (ext === 'gltf') return 'gltf';
  if (ext === 'obj') return 'obj';
  if (ext === 'stl') return 'stl';
  if (ext === 'fbx') return 'fbx';
  if (ext === 'mtl') return 'mtl';
  if (ext === 'bin') return 'bin';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'unknown';
}

export function isModelKind(kind: DetectedKind): kind is ModelFormat {
  return kind === 'glb' || kind === 'gltf' || kind === 'obj' || kind === 'stl' || kind === 'fbx';
}

export interface GlbValidation {
  ok: boolean;
  error?: string;
  json?: {
    asset?: { version?: string; generator?: string };
    nodes?: unknown[];
    meshes?: unknown[];
    materials?: unknown[];
    images?: unknown[];
    buffers?: Array<{ uri?: string }>;
  };
}

/** Structural validation of a GLB container (header, chunk layout, JSON chunk). */
export function validateGlb(buffer: ArrayBuffer): GlbValidation {
  if (buffer.byteLength < 20) return { ok: false, error: 'File is too small to be a GLB.' };
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67)
    return { ok: false, error: 'Missing "glTF" magic header — this is not a GLB file.' };
  const version = view.getUint32(4, true);
  if (version !== 2)
    return { ok: false, error: `Unsupported glTF container version ${version} (only 2.0 is supported).` };
  const length = view.getUint32(8, true);
  if (length > buffer.byteLength)
    return {
      ok: false,
      error: `GLB header declares ${length} bytes but the file has ${buffer.byteLength} (truncated download?).`,
    };
  const chunkLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  if (chunkType !== 0x4e4f534a) return { ok: false, error: 'First GLB chunk is not JSON.' };
  if (20 + chunkLength > buffer.byteLength) return { ok: false, error: 'GLB JSON chunk is truncated.' };
  try {
    const text = new TextDecoder().decode(new Uint8Array(buffer, 20, chunkLength));
    const json = JSON.parse(text) as GlbValidation['json'];
    if (!json?.asset?.version?.startsWith('2'))
      return { ok: false, error: 'glTF asset version is missing or not 2.x.' };
    return { ok: true, json };
  } catch {
    return { ok: false, error: 'GLB JSON chunk is malformed.' };
  }
}
