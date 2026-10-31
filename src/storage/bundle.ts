import type { SceneDocument } from '../engine/serialization/schema';
import { ZinoError } from '../utils/errors';

/**
 * .zino3d project bundle: a single portable file so a project never depends solely on browser storage.
 * Layout: "ZINO3D" 0x00 0x01 | u32 LE json length | UTF-8 JSON | zero padding to 4 bytes | binary assets.
 */
const MAGIC = [0x5a, 0x49, 0x4e, 0x4f, 0x33, 0x44, 0x00, 0x01];

export interface BundleManifest {
  format: 'zino3d-bundle';
  bundleVersion: 1;
  project: { name: string; createdAt: number; updatedAt: number };
  document: SceneDocument;
  assets: Array<{ id: string; offset: number; length: number }>;
}

export function encodeBundle(
  project: BundleManifest['project'],
  document: SceneDocument,
  assets: Map<string, ArrayBuffer>,
): Blob {
  const entries: BundleManifest['assets'] = [];
  let offset = 0;
  const parts: ArrayBuffer[] = [];
  for (const [id, data] of assets) {
    entries.push({ id, offset, length: data.byteLength });
    parts.push(data);
    offset += data.byteLength;
    const pad = (4 - (data.byteLength % 4)) % 4;
    if (pad) {
      parts.push(new ArrayBuffer(pad));
      offset += pad;
    }
  }
  const manifest: BundleManifest = {
    format: 'zino3d-bundle',
    bundleVersion: 1,
    project,
    document,
    assets: entries,
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const pad = (4 - ((MAGIC.length + 4 + json.byteLength) % 4)) % 4;
  const header = new ArrayBuffer(MAGIC.length + 4);
  new Uint8Array(header).set(MAGIC);
  new DataView(header).setUint32(MAGIC.length, json.byteLength, true);
  return new Blob([header, json, new Uint8Array(pad), ...parts], { type: 'application/octet-stream' });
}

export function decodeBundle(buffer: ArrayBuffer): {
  manifest: BundleManifest;
  assets: Map<string, ArrayBuffer>;
} {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12 || !MAGIC.every((b, i) => bytes[i] === b)) {
    throw new ZinoError('bundle/invalid', 'This is not a Zino3D project file.');
  }
  const jsonLength = new DataView(buffer).getUint32(MAGIC.length, true);
  const jsonStart = MAGIC.length + 4;
  if (jsonStart + jsonLength > buffer.byteLength)
    throw new ZinoError('bundle/truncated', 'The project file is truncated.');
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(
      new TextDecoder().decode(bytes.subarray(jsonStart, jsonStart + jsonLength)),
    ) as BundleManifest;
  } catch {
    throw new ZinoError('bundle/invalid', 'The project file header is corrupted.');
  }
  if (manifest.format !== 'zino3d-bundle')
    throw new ZinoError('bundle/invalid', 'Unknown project file format.');
  if (manifest.bundleVersion > 1)
    throw new ZinoError('bundle/version', 'This project file was created by a newer Zino3D version.');
  const pad = (4 - ((jsonStart + jsonLength) % 4)) % 4;
  const dataStart = jsonStart + jsonLength + pad;
  const assets = new Map<string, ArrayBuffer>();
  for (const a of manifest.assets) {
    const start = dataStart + a.offset;
    if (start + a.length > buffer.byteLength)
      throw new ZinoError('bundle/truncated', 'The project file is missing binary data.');
    assets.set(a.id, buffer.slice(start, start + a.length));
  }
  return { manifest, assets };
}
