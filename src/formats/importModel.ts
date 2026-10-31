import {
  Group,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ZinoError } from '../utils/errors';
import { baseName } from '../utils/format';
import { UD, materialTextures, objectMaterials } from '../engine/scene/objectUtils';
import { computeSceneStats, type SceneStats } from './sceneStats';
import {
  type DetectedKind,
  MAX_IMPORT_BYTES,
  type ModelFormat,
  detectKind,
  isModelKind,
  validateGlb,
} from './detect';

/** Anything with a name and binary content (File satisfies this). */
export interface ImportFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ImportOptions {
  /** Needed for KTX2 texture transcoding support detection; optional (tests run without WebGL). */
  renderer?: WebGLRenderer | null;
}

export interface ImportResult {
  root: Group;
  format: ModelFormat;
  fileName: string;
  fileSize: number;
  stats: SceneStats;
  warnings: string[];
  generator?: string;
}

let dracoLoader: DRACOLoader | null = null;
let ktx2Loader: KTX2Loader | null = null;

// three.js bundles the Draco and Basis decoders with the app (resolved via import.meta.url), so
// compressed files decode fully offline without any CDN.
function getDraco(): DRACOLoader {
  if (!dracoLoader) dracoLoader = new DRACOLoader();
  return dracoLoader;
}

function getKtx2(renderer: WebGLRenderer): KTX2Loader {
  if (!ktx2Loader) {
    ktx2Loader = new KTX2Loader();
    ktx2Loader.detectSupport(renderer);
  }
  return ktx2Loader;
}

function normalizeName(url: string): string {
  let clean = url.split('?')[0].split('#')[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // keep undecoded
  }
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return (slash >= 0 ? clean.slice(slash + 1) : clean).toLowerCase();
}

interface ResourceMap {
  manager: LoadingManager;
  missing: Set<string>;
  revoke(): void;
}

/** Maps relative URLs referenced by a model (textures, .bin, .mtl) to the user's selected files. */
async function createResourceMap(resources: ImportFile[]): Promise<ResourceMap> {
  const urls = new Map<string, string>();
  const created: string[] = [];
  const canCreate = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  for (const file of resources) {
    if (!canCreate) break;
    const blob = file instanceof Blob ? file : new Blob([await file.arrayBuffer()]);
    const url = URL.createObjectURL(blob);
    created.push(url);
    urls.set(file.name.toLowerCase(), url);
    urls.set(normalizeName(file.name), url);
  }
  const missing = new Set<string>();
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    const mapped = urls.get(normalizeName(url));
    if (mapped) return mapped;
    // Never fetch unmatched references from the network or the app's own origin: models are local
    // files, and a relative URL would otherwise load an unrelated app asset (or the app's index.html).
    missing.add(normalizeName(url));
    throw new Error(`Referenced file "${url}" was not provided.`);
  });
  manager.onError = (url) => {
    if (!url.startsWith('blob:') && !url.startsWith('data:')) missing.add(normalizeName(url));
  };
  return {
    manager,
    missing,
    revoke: () => created.forEach((u) => URL.revokeObjectURL(u)),
  };
}

function asGroup(root: Object3D, name: string): Group {
  let group: Group;
  if ((root as Group).isGroup && !(root as { isScene?: boolean }).isScene) {
    group = root as Group;
  } else {
    group = new Group();
    group.position.copy(root.position);
    group.quaternion.copy(root.quaternion);
    group.scale.copy(root.scale);
    for (const child of [...root.children]) group.add(child);
    group.userData = { ...root.userData };
  }
  group.name = name;
  return group;
}

function postProcess(root: Group, warnings: string[], renderer?: WebGLRenderer | null): void {
  let skinned = 0;
  const textures = new Set<Texture>();
  root.traverse((o) => {
    // GLTFLoader sanitizes node names (spaces -> "_") for animation binding and keeps the original in
    // userData.name. Zino3D does not bind animations, so the author's original name is restored.
    if (typeof o.userData.name === 'string' && o.userData.name.length > 0) {
      o.name = o.userData.name;
      delete o.userData.name;
    }
    if (o.userData[UD.hidden] === true) o.visible = false;
    if ((o as { isSkinnedMesh?: boolean }).isSkinnedMesh) skinned++;
    for (const m of objectMaterials(o)) for (const t of materialTextures(m)) textures.add(t);
  });
  if (skinned > 0) {
    warnings.push(
      `${skinned} skinned mesh(es) found. Skinning and rigs are not edited by Zino3D; skinned meshes are kept but cannot be mesh-edited, and skin bindings are not preserved in Zino3D project saves.`,
    );
  }
  const maxSize = renderer?.capabilities.maxTextureSize ?? 16384;
  for (const t of textures) {
    const img = t.image as { width?: number; height?: number } | undefined;
    if (img?.width && img.height && (img.width > maxSize || img.height > maxSize)) {
      warnings.push(
        `Texture "${t.name || 'unnamed'}" is ${img.width}×${img.height}, larger than this device supports (${maxSize}). It will be downscaled by the GPU driver or may fail to display.`,
      );
    } else if (img?.width && img.height && img.width * img.height > 4096 * 4096) {
      warnings.push(
        `Texture "${t.name || 'unnamed'}" is very large (${img.width}×${img.height}) and may use a lot of memory on mobile devices.`,
      );
    }
  }
}

function missingWarning(missing: Set<string>): string | null {
  if (missing.size === 0) return null;
  const list = [...missing].slice(0, 6).join(', ');
  return `Missing referenced file(s): ${list}${missing.size > 6 ? '…' : ''}. Select the model together with its texture/.bin/.mtl files to include them.`;
}

/**
 * Imports a model from one primary file plus optional resource files (multi-file glTF / OBJ+MTL).
 * Nothing is uploaded anywhere; files are parsed locally.
 */
export async function importModelFiles(
  files: ImportFile[],
  options: ImportOptions = {},
): Promise<ImportResult> {
  if (files.length === 0) throw new ZinoError('import/no-files', 'No files were selected.');
  const heads = await Promise.all(
    files.map(async (f) => ({
      file: f,
      kind: detectKind(f.name, new Uint8Array((await f.arrayBuffer()).slice(0, 32))) as DetectedKind,
    })),
  );
  const primary = heads.find((h) => isModelKind(h.kind));
  if (!primary) {
    const names = files.map((f) => f.name).join(', ');
    if (heads.some((h) => h.kind === 'zino3d')) {
      throw new ZinoError(
        'import/project-file',
        'This is a Zino3D project file. Use "Open project file" on the home screen instead.',
      );
    }
    throw new ZinoError(
      'import/unsupported',
      `Unsupported file type: ${names}. Supported: GLB, glTF (+ .bin/textures), OBJ (+ MTL), STL, FBX (experimental).`,
    );
  }
  const file = primary.file;
  const format = primary.kind as ModelFormat;
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ZinoError(
      'import/too-large',
      `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(0)} MB, above the ${(MAX_IMPORT_BYTES / 1024 / 1024).toFixed(0)} MB import limit.`,
    );
  }
  const resources = heads.filter((h) => h !== primary).map((h) => h.file);
  const name = baseName(file.name);
  const warnings: string[] = [];
  const map = await createResourceMap(resources);
  let root: Group;
  let generator: string | undefined;
  try {
    const data = await file.arrayBuffer();
    if (format === 'glb' || format === 'gltf') {
      if (format === 'glb') {
        const v = validateGlb(data);
        if (!v.ok) throw new ZinoError('import/invalid-glb', `"${file.name}" is not a valid GLB: ${v.error}`);
        generator = v.json?.asset?.generator;
      } else {
        try {
          const json = JSON.parse(new TextDecoder().decode(data)) as { asset?: { generator?: string } };
          generator = json.asset?.generator;
        } catch {
          throw new ZinoError('import/invalid-gltf', `"${file.name}" is not valid glTF JSON.`);
        }
      }
      const loader = new GLTFLoader(map.manager);
      loader.setDRACOLoader(getDraco());
      loader.setMeshoptDecoder(MeshoptDecoder);
      if (options.renderer) loader.setKTX2Loader(getKtx2(options.renderer));
      let gltf;
      try {
        gltf = await loader.parseAsync(data, '');
      } catch (error) {
        const miss = missingWarning(map.missing);
        throw new ZinoError(
          'import/gltf-failed',
          miss ?? `Could not read "${file.name}": ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          { cause: error },
        );
      }
      if (gltf.animations.length > 0) {
        warnings.push(
          `${gltf.animations.length} animation clip(s) found. Zino3D does not edit animations; they are not included in edited exports or project saves.`,
        );
      }
      root = asGroup(gltf.scene, name);
    } else if (format === 'obj') {
      const loader = new OBJLoader(map.manager);
      const mtlFile = resources.find((r) => r.name.toLowerCase().endsWith('.mtl'));
      const text = new TextDecoder().decode(data);
      if (mtlFile) {
        const mtl = new MTLLoader(map.manager).parse(
          new TextDecoder().decode(await mtlFile.arrayBuffer()),
          '',
        );
        mtl.preload();
        loader.setMaterials(mtl);
      } else if (/^\s*mtllib\s+/m.test(text)) {
        warnings.push(
          'This OBJ references a material library (.mtl) that was not selected; default materials are used.',
        );
      }
      root = asGroup(loader.parse(text), name);
      // OBJLoader without MTL creates Phong materials; give them a neutral PBR look.
      root.traverse((o) => {
        if ((o as Mesh).isMesh && !mtlFile) {
          const mesh = o as Mesh;
          const old = mesh.material;
          mesh.material = new MeshStandardMaterial({ color: 0xb0b4bb, roughness: 0.6, metalness: 0 });
          (Array.isArray(old) ? old : [old]).forEach((m) => m.dispose());
        }
      });
    } else if (format === 'stl') {
      const geometry = new STLLoader().parse(data);
      if (!geometry.getAttribute('position') || geometry.getAttribute('position').count === 0) {
        throw new ZinoError('import/invalid-stl', `"${file.name}" contains no triangles.`);
      }
      const hasColors = !!geometry.getAttribute('color');
      const mesh = new Mesh(
        geometry,
        new MeshStandardMaterial({
          color: hasColors ? 0xffffff : 0xb0b4bb,
          vertexColors: hasColors,
          roughness: 0.6,
        }),
      );
      mesh.name = name;
      root = new Group();
      root.name = name;
      root.add(mesh);
      warnings.push(
        'STL files contain geometry only: no materials, UVs or hierarchy. Units are unknown (assumed meters).',
      );
    } else {
      warnings.push(
        'FBX import is experimental (three.js FBXLoader). Check materials and transforms after import; animations are not edited.',
      );
      let fbxRoot: Object3D;
      try {
        fbxRoot = new FBXLoader(map.manager).parse(data, '');
      } catch (error) {
        throw new ZinoError(
          'import/fbx-failed',
          `Could not read "${file.name}" as FBX: ${error instanceof Error ? error.message : String(error)}. Older FBX versions (< 7.0) are not supported.`,
          undefined,
          { cause: error },
        );
      }
      root = asGroup(fbxRoot, name);
    }
    // Allow texture loads triggered during parsing to report their errors.
    await new Promise((r) => setTimeout(r, 0));
    const miss = missingWarning(map.missing);
    if (miss) warnings.push(miss);
    postProcess(root, warnings, options.renderer);
    root.updateMatrixWorld(true);
    const stats = computeSceneStats([root]);
    if (stats.meshes === 0) warnings.push('The file was read successfully but contains no meshes.');
    return { root, format, fileName: file.name, fileSize: file.size, stats, warnings, generator };
  } finally {
    // Textures already hold decoded images; object URLs are no longer needed once loading settles.
    setTimeout(() => map.revoke(), 30_000);
  }
}
