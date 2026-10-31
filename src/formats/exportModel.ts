import { Group, Matrix4, type Object3D } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { ZinoError } from '../utils/errors';
import { sanitizeFileName } from '../utils/format';
import { UD, isMesh } from '../engine/scene/objectUtils';
import { validateGlb } from './detect';

export type ExportFormat = 'glb' | 'gltf' | 'obj' | 'stl';

export interface ExportOptions {
  format: ExportFormat;
  /** Objects to export (top-level). Their world transforms are preserved. */
  objects: Object3D[];
  onlyVisible: boolean;
  /** Limit texture size in glTF exports (useful for mobile targets). */
  maxTextureSize?: number;
  fileName: string;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  warnings: string[];
  meshCount: number;
}

const MIME: Record<ExportFormat, string> = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain',
  stl: 'model/stl',
};

/**
 * Clones the export set (sharing geometry/materials), bakes each top-level object's world transform
 * into its clone and strips editor-only userData so deliverables contain no Zino3D internals.
 */
function prepareExportTree(
  objects: Object3D[],
  onlyVisible: boolean,
): { roots: Object3D[]; meshCount: number } {
  const roots: Object3D[] = [];
  let meshCount = 0;
  for (const o of objects) {
    if (onlyVisible && !o.visible) continue;
    o.updateWorldMatrix(true, false);
    const clone = o.clone(true);
    const world = new Matrix4().copy(o.matrixWorld);
    world.decompose(clone.position, clone.quaternion, clone.scale);
    clone.traverse((c) => {
      const ud = { ...c.userData };
      for (const key of Object.values(UD)) delete ud[key];
      c.userData = ud;
      if (isMesh(c) && (!onlyVisible || c.visible)) meshCount++;
    });
    roots.push(clone);
  }
  return { roots, meshCount };
}

export async function exportModel(options: ExportOptions): Promise<ExportResult> {
  const { roots, meshCount } = prepareExportTree(options.objects, options.onlyVisible);
  if (meshCount === 0)
    throw new ZinoError('export/empty', 'Nothing to export: the selection contains no visible meshes.');
  const warnings: string[] = [];
  const base = sanitizeFileName(options.fileName);
  let blob: Blob;
  if (options.format === 'glb' || options.format === 'gltf') {
    const exporter = new GLTFExporter();
    let result: ArrayBuffer | Record<string, unknown>;
    const originalWarn = console.warn;
    const exporterWarnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      exporterWarnings.push(args.map(String).join(' '));
      originalWarn(...args);
    };
    try {
      result = (await exporter.parseAsync(roots, {
        binary: options.format === 'glb',
        onlyVisible: options.onlyVisible,
        maxTextureSize: options.maxTextureSize ?? Infinity,
        trs: false,
      })) as ArrayBuffer | Record<string, unknown>;
    } catch (error) {
      throw new ZinoError(
        'export/gltf-failed',
        `glTF export failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { cause: error },
      );
    } finally {
      console.warn = originalWarn;
    }
    for (const w of new Set(exporterWarnings)) warnings.push(w.replace(/^THREE\.GLTFExporter:\s*/, ''));
    if (options.format === 'glb') {
      const buffer = result as ArrayBuffer;
      const v = validateGlb(buffer);
      if (!v.ok) throw new ZinoError('export/invalid', `The exported GLB failed validation: ${v.error}`);
      const exportedMeshes = v.json?.meshes?.length ?? 0;
      if (exportedMeshes === 0) throw new ZinoError('export/invalid', 'The exported GLB contains no meshes.');
      blob = new Blob([buffer], { type: MIME.glb });
    } else {
      blob = new Blob([JSON.stringify(result)], { type: MIME.gltf });
    }
  } else if (options.format === 'obj') {
    const text = roots.map((r) => new OBJExporter().parse(r)).join('\n');
    blob = new Blob([text], { type: MIME.obj });
    warnings.push(
      'OBJ export contains geometry (positions, normals, UVs) and object names only. Materials, textures and hierarchy are not included.',
    );
  } else {
    // Binary STL holds a single solid: export every root under a temporary parent.
    const parent = new Group();
    for (const r of roots) parent.add(r);
    const view = new STLExporter().parse(parent, { binary: true }) as unknown as DataView;
    blob = new Blob([view.buffer as ArrayBuffer], { type: MIME.stl });
    warnings.push(
      'STL export contains triangle geometry only. Materials, UVs, colors and hierarchy are lost.',
    );
  }
  return { blob, fileName: `${base}.${options.format}`, warnings, meshCount };
}
