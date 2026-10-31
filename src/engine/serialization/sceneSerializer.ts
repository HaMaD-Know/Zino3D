import {
  AmbientLight,
  Bone,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  type Light,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineLoop,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  MeshPhongMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PointLight,
  Points,
  PointsMaterial,
  ShadowMaterial,
  SpotLight,
  SpriteMaterial,
  Texture,
  Vector2,
} from 'three';
import { createId } from '../../utils/ids';
import { type AnyAttribute, gatherAttribute } from '../geometry/attributes';
import { UD, getId } from '../scene/objectUtils';
import {
  type AttributeRecord,
  type CameraRecord,
  type GeometryRecord,
  type LightRecord,
  type MaterialParam,
  type MaterialRecord,
  type NodeKind,
  type NodeRecord,
  SCENE_SCHEMA_VERSION,
  type SceneDocument,
  type TextureRecord,
  type TypedArrayName,
} from './schema';
import { decodeImage, encodeTextureImage } from './imageCodec';

/** Per-project cache so autosaves only write binary assets that actually changed. */
export class AssetCache {
  attributes = new WeakMap<object, { version: number; record: AttributeRecord }>();
  images = new WeakMap<object, { asset: string; mimeType: string; width: number; height: number }>();
}

export interface SerializeResult {
  document: SceneDocument;
  /** Assets that are new in this save (asset id -> bytes). */
  newAssets: Map<string, ArrayBuffer>;
  /** Every asset referenced by the document. */
  referencedAssets: Set<string>;
  warnings: string[];
}

const NUMBER_PARAMS = [
  'opacity',
  'metalness',
  'roughness',
  'emissiveIntensity',
  'alphaTest',
  'clearcoat',
  'clearcoatRoughness',
  'transmission',
  'thickness',
  'ior',
  'sheen',
  'sheenRoughness',
  'iridescence',
  'iridescenceIOR',
  'specularIntensity',
  'envMapIntensity',
  'aoMapIntensity',
  'lightMapIntensity',
  'bumpScale',
  'displacementScale',
  'displacementBias',
  'shininess',
  'reflectivity',
  'size',
  'linewidth',
  'dispersion',
  'anisotropy',
  'anisotropyRotation',
  'attenuationDistance',
  'side',
  'blending',
  'dashSize',
  'gapSize',
  'scale',
  'refractionRatio',
  'combine',
  'alphaHash',
] as const;
const BOOLEAN_PARAMS = [
  'transparent',
  'depthWrite',
  'depthTest',
  'vertexColors',
  'flatShading',
  'wireframe',
  'toneMapped',
  'sizeAttenuation',
  'fog',
  'visible',
  'alphaToCoverage',
  'premultipliedAlpha',
] as const;
const COLOR_PARAMS = [
  'color',
  'emissive',
  'specular',
  'sheenColor',
  'attenuationColor',
  'specularColor',
] as const;
const VECTOR2_PARAMS = ['normalScale', 'clearcoatNormalScale'] as const;

const MATERIAL_TYPES: Record<string, new () => Material> = {
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  MeshBasicMaterial,
  MeshPhongMaterial,
  MeshLambertMaterial,
  MeshToonMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  LineBasicMaterial,
  LineDashedMaterial,
  PointsMaterial,
  ShadowMaterial,
  SpriteMaterial,
};

const ARRAY_TYPES: Record<
  TypedArrayName,
  new (buffer: ArrayBuffer) => ArrayLike<number> & { buffer: ArrayBufferLike }
> = {
  Float32Array,
  Float64Array,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
};

function jsonSafe(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function nodeKind(o: Object3D): NodeKind {
  const f = o as unknown as Record<string, boolean>;
  if (f.isInstancedMesh) return 'instancedMesh';
  if (f.isMesh) return 'mesh';
  if (f.isLineSegments) return 'lineSegments';
  if (f.isLineLoop) return 'lineLoop';
  if (f.isLine) return 'line';
  if (f.isPoints) return 'points';
  if (f.isLight) return 'light';
  if (f.isCamera) return 'camera';
  if (f.isBone) return 'bone';
  if (f.isGroup) return 'group';
  return 'object';
}

/** Serializes the content root's children into a scene document plus binary assets. */
export async function serializeScene(
  roots: Object3D[],
  cache: AssetCache,
  options: { decompressTexture?: (t: Texture) => Promise<Texture | null> } = {},
): Promise<SerializeResult> {
  const newAssets = new Map<string, ArrayBuffer>();
  const referenced = new Set<string>();
  const warnings = new Set<string>();
  const geometryIds = new Map<BufferGeometry, string>();
  const materialIds = new Map<Material, string>();
  const textureIds = new Map<Texture, string>();
  const imageIds = new Map<object, string>();
  const doc: SceneDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    nodes: [],
    geometries: {},
    materials: {},
    textures: {},
    images: {},
  };

  const attributeRecord = (attr: AnyAttribute): AttributeRecord => {
    const cached = cache.attributes.get(attr);
    const version = (attr as { version?: number }).version ?? 0;
    if (cached && cached.version === version) {
      referenced.add(cached.record.asset);
      return cached.record;
    }
    const plain = (attr as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute
      ? gatherAttribute(
          attr,
          Array.from({ length: attr.count }, (_, i) => i),
        )
      : (attr as BufferAttribute);
    const array = plain.array as unknown as ArrayBufferView & { constructor: { name: string } };
    const bytes = array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength) as ArrayBuffer;
    const asset = createId('bin');
    const record: AttributeRecord = {
      asset,
      type: array.constructor.name as TypedArrayName,
      itemSize: plain.itemSize,
      normalized: plain.normalized,
      count: plain.count,
    };
    newAssets.set(asset, bytes);
    referenced.add(asset);
    cache.attributes.set(attr, { version, record });
    return record;
  };

  const geometryRef = (g: BufferGeometry): string => {
    let id = geometryIds.get(g);
    if (id) return id;
    id = `g${geometryIds.size}`;
    geometryIds.set(g, id);
    const rec: GeometryRecord = {
      name: g.name,
      attributes: {},
      groups: g.groups.map((gr) => ({
        start: gr.start,
        count: gr.count,
        materialIndex: gr.materialIndex ?? 0,
      })),
      morphTargetsRelative: g.morphTargetsRelative,
      userData: jsonSafe(g.userData),
    };
    for (const [name, attr] of Object.entries(g.attributes))
      rec.attributes[name] = attributeRecord(attr as AnyAttribute);
    if (g.index) rec.index = attributeRecord(g.index);
    const morph = Object.entries(g.morphAttributes);
    if (morph.length) {
      rec.morphAttributes = {};
      for (const [name, list] of morph)
        rec.morphAttributes[name] = list.map((a) => attributeRecord(a as AnyAttribute));
    }
    doc.geometries[id] = rec;
    return id;
  };

  const imageRef = async (texture: Texture): Promise<string | null> => {
    let source: Texture | null = texture;
    if ((texture as { isCompressedTexture?: boolean }).isCompressedTexture) {
      source = options.decompressTexture ? await options.decompressTexture(texture) : null;
      if (!source) {
        warnings.add(
          `Compressed texture "${texture.name || 'unnamed'}" could not be stored in the project and will be missing after reload.`,
        );
        return null;
      }
    }
    const key = source.image as object | undefined;
    if (!key) return null;
    const existing = imageIds.get(key);
    if (existing) return existing;
    let cached = cache.images.get(key);
    if (!cached) {
      const encoded = await encodeTextureImage(source);
      if (!encoded) {
        warnings.add(
          `Texture "${texture.name || 'unnamed'}" uses an image format that cannot be stored; it will be missing after reload.`,
        );
        return null;
      }
      const asset = createId('img');
      newAssets.set(asset, encoded.bytes);
      cached = { asset, mimeType: encoded.mimeType, width: encoded.width, height: encoded.height };
      cache.images.set(key, cached);
    }
    referenced.add(cached.asset);
    const id = `i${imageIds.size}`;
    imageIds.set(key, id);
    doc.images[id] = {
      asset: cached.asset,
      mimeType: cached.mimeType,
      width: cached.width,
      height: cached.height,
    };
    return id;
  };

  const textureRef = async (t: Texture): Promise<string> => {
    let id = textureIds.get(t);
    if (id) return id;
    id = `t${textureIds.size}`;
    textureIds.set(t, id);
    const rec: TextureRecord = {
      name: t.name,
      image: await imageRef(t),
      colorSpace: t.colorSpace,
      flipY: t.flipY,
      wrapS: t.wrapS,
      wrapT: t.wrapT,
      magFilter: t.magFilter,
      minFilter: t.minFilter,
      anisotropy: t.anisotropy,
      repeat: [t.repeat.x, t.repeat.y],
      offset: [t.offset.x, t.offset.y],
      center: [t.center.x, t.center.y],
      rotation: t.rotation,
      channel: t.channel,
      generateMipmaps: t.generateMipmaps,
    };
    doc.textures[id] = rec;
    return id;
  };

  const materialRef = async (m: Material): Promise<string> => {
    let id = materialIds.get(m);
    if (id) return id;
    id = `m${materialIds.size}`;
    materialIds.set(m, id);
    if (!MATERIAL_TYPES[m.type]) warnings.add(`Material type ${m.type} is stored as a standard material.`);
    const rec: MaterialRecord = {
      type: m.type,
      name: m.name,
      params: {},
      maps: {},
      userData: jsonSafe(m.userData),
    };
    const src = m as unknown as Record<string, unknown>;
    for (const key of NUMBER_PARAMS) if (typeof src[key] === 'number') rec.params[key] = src[key] as number;
    for (const key of BOOLEAN_PARAMS)
      if (typeof src[key] === 'boolean') rec.params[key] = src[key] as boolean;
    for (const key of COLOR_PARAMS)
      if (src[key] instanceof Color) rec.params[key] = (src[key] as Color).toArray();
    for (const key of VECTOR2_PARAMS)
      if (src[key] instanceof Vector2) rec.params[key] = (src[key] as Vector2).toArray();
    if (Array.isArray(src.iridescenceThicknessRange))
      rec.params.iridescenceThicknessRange = src.iridescenceThicknessRange as number[];
    for (const [key, value] of Object.entries(src)) {
      if (value instanceof Texture && (key === 'map' || key.endsWith('Map')))
        rec.maps[key] = await textureRef(value);
    }
    doc.materials[id] = rec;
    return id;
  };

  const serializeNode = async (o: Object3D): Promise<NodeRecord> => {
    o.updateMatrix();
    const kind = nodeKind(o);
    const rec: NodeRecord = {
      id: getId(o) ?? createId('obj'),
      name: o.name,
      kind,
      matrix: o.matrix.toArray(),
      visible: o.visible,
      userData: jsonSafe(o.userData),
      castShadow: o.castShadow,
      receiveShadow: o.receiveShadow,
      renderOrder: o.renderOrder,
      frustumCulled: o.frustumCulled,
      children: [],
    };
    const withGeo = o as unknown as { geometry?: BufferGeometry; material?: Material | Material[] };
    if (withGeo.geometry?.isBufferGeometry) rec.geometry = geometryRef(withGeo.geometry);
    if (withGeo.material) {
      rec.material = Array.isArray(withGeo.material)
        ? await Promise.all(withGeo.material.map(materialRef))
        : await materialRef(withGeo.material);
    }
    if ((o as { isSkinnedMesh?: boolean }).isSkinnedMesh)
      warnings.add('Skinned meshes are saved as static meshes (skin bindings are not stored).');
    if (kind === 'instancedMesh') {
      const im = o as InstancedMesh;
      rec.instances = { count: im.count, matrices: attributeRecord(im.instanceMatrix) };
      if (im.instanceColor) rec.instances.colors = attributeRecord(im.instanceColor);
    }
    if (kind === 'light') {
      const l = o as Light & Record<string, unknown>;
      const type = l.type as LightRecord['type'];
      if (
        !['DirectionalLight', 'PointLight', 'SpotLight', 'AmbientLight', 'HemisphereLight'].includes(type)
      ) {
        warnings.add(`Light type ${type} is not stored.`);
        rec.kind = 'object';
      } else {
        const lr: LightRecord = {
          type,
          color: l.color.toArray(),
          intensity: l.intensity,
          castShadow: l.castShadow,
        };
        if (l.groundColor instanceof Color) lr.groundColor = l.groundColor.toArray();
        for (const key of ['distance', 'decay', 'angle', 'penumbra'] as const)
          if (typeof l[key] === 'number') lr[key] = l[key] as number;
        const target = l.target as Object3D | undefined;
        if (target && target.parent === o) lr.targetChild = o.children.indexOf(target);
        rec.light = lr;
      }
    }
    if (kind === 'camera') {
      const c = o as Camera & Record<string, number>;
      if ((o as PerspectiveCamera).isPerspectiveCamera) {
        rec.camera = {
          type: 'PerspectiveCamera',
          near: c.near,
          far: c.far,
          zoom: c.zoom,
          fov: c.fov,
          aspect: c.aspect,
        };
      } else if ((o as OrthographicCamera).isOrthographicCamera) {
        rec.camera = {
          type: 'OrthographicCamera',
          near: c.near,
          far: c.far,
          zoom: c.zoom,
          left: c.left,
          right: c.right,
          top: c.top,
          bottom: c.bottom,
        };
      } else rec.kind = 'object';
    }
    for (const child of o.children) rec.children.push(await serializeNode(child));
    return rec;
  };

  for (const r of roots) doc.nodes.push(await serializeNode(r));
  return { document: doc, newAssets, referencedAssets: referenced, warnings: [...warnings] };
}

export type AssetReader = (assetId: string) => Promise<ArrayBuffer | undefined>;

/** Rebuilds three.js objects from a validated scene document. */
export async function deserializeScene(
  doc: SceneDocument,
  readAsset: AssetReader,
  /** When given, loaded buffers/images are registered so the next save does not rewrite them. */
  cache?: AssetCache,
): Promise<{ objects: Object3D[]; warnings: string[] }> {
  const warnings = new Set<string>();
  const attrCache = new Map<string, BufferAttribute>();

  const loadAttribute = async (rec: AttributeRecord, instanced = false): Promise<BufferAttribute> => {
    const key = `${rec.asset}:${instanced}`;
    const cached = attrCache.get(key);
    if (cached) return cached;
    const bytes = await readAsset(rec.asset);
    if (!bytes) throw new Error(`Binary asset ${rec.asset} is missing from storage.`);
    const Ctor = ARRAY_TYPES[rec.type];
    if (!Ctor) throw new Error(`Unknown array type ${rec.type}.`);
    const array = new Ctor(bytes) as unknown as Float32Array;
    const attr = instanced
      ? new InstancedBufferAttribute(array, rec.itemSize, rec.normalized)
      : new BufferAttribute(array, rec.itemSize, rec.normalized);
    if (attr.count !== rec.count) throw new Error(`Binary asset ${rec.asset} has the wrong size.`);
    attrCache.set(key, attr);
    cache?.attributes.set(attr, { version: attr.version, record: rec });
    return attr;
  };

  const images = new Map<string, { image: unknown; flipY: boolean } | null>();
  for (const [id, rec] of Object.entries(doc.images)) {
    const bytes = await readAsset(rec.asset);
    const decoded = bytes ? await decodeImage(bytes, rec.mimeType, false) : null;
    if (!decoded) warnings.add('Some textures could not be restored on this device.');
    else if (decoded.image && typeof decoded.image === 'object') {
      cache?.images.set(decoded.image as object, {
        asset: rec.asset,
        mimeType: rec.mimeType,
        width: rec.width,
        height: rec.height,
      });
    }
    images.set(id, decoded);
  }

  const textures = new Map<string, Texture>();
  for (const [id, rec] of Object.entries(doc.textures)) {
    const t = new Texture();
    t.name = rec.name;
    const imgRec = rec.image ? images.get(rec.image) : null;
    if (rec.image && imgRec) {
      if (rec.flipY && typeof createImageBitmap === 'function' && imgRec.image instanceof ImageBitmap) {
        // Re-decode flipped: ImageBitmaps cannot be flipped by WebGL at upload time.
        const bytes = await readAsset(doc.images[rec.image].asset);
        const flipped = bytes ? await decodeImage(bytes, doc.images[rec.image].mimeType, true) : null;
        t.image = flipped?.image ?? imgRec.image;
        // The flipped bitmap is intentionally not registered in the cache: it is re-encoded (already
        // flipped, with flipY=false) on the next save, which renders identically.
        t.flipY = flipped ? flipped.flipY : false;
      } else {
        t.image = imgRec.image;
        t.flipY = rec.flipY && !(typeof ImageBitmap !== 'undefined' && imgRec.image instanceof ImageBitmap);
      }
      t.needsUpdate = true;
    }
    t.colorSpace = rec.colorSpace as Texture['colorSpace'];
    t.wrapS = rec.wrapS as Texture['wrapS'];
    t.wrapT = rec.wrapT as Texture['wrapT'];
    t.magFilter = rec.magFilter as Texture['magFilter'];
    t.minFilter = rec.minFilter as Texture['minFilter'];
    t.anisotropy = rec.anisotropy;
    t.repeat.fromArray(rec.repeat);
    t.offset.fromArray(rec.offset);
    t.center.fromArray(rec.center);
    t.rotation = rec.rotation;
    t.channel = rec.channel;
    t.generateMipmaps = rec.generateMipmaps;
    textures.set(id, t);
  }

  const materials = new Map<string, Material>();
  for (const [id, rec] of Object.entries(doc.materials)) {
    const Ctor = MATERIAL_TYPES[rec.type] ?? MeshStandardMaterial;
    const m = new Ctor();
    m.name = rec.name;
    m.userData = rec.userData ?? {};
    const target = m as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(rec.params) as Array<[string, MaterialParam]>) {
      if (!(key in target)) continue;
      const current = target[key];
      if (current instanceof Color && Array.isArray(value)) current.fromArray(value);
      else if (current instanceof Vector2 && Array.isArray(value)) current.fromArray(value);
      else target[key] = value;
    }
    for (const [key, texId] of Object.entries(rec.maps)) {
      const t = textures.get(texId);
      if (t && t.image && key in target) target[key] = t;
    }
    m.needsUpdate = true;
    materials.set(id, m);
  }

  const geometries = new Map<string, BufferGeometry>();
  for (const [id, rec] of Object.entries(doc.geometries)) {
    const g = new BufferGeometry();
    g.name = rec.name;
    for (const [name, a] of Object.entries(rec.attributes)) g.setAttribute(name, await loadAttribute(a));
    if (rec.index) g.setIndex(await loadAttribute(rec.index));
    for (const gr of rec.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    if (rec.morphAttributes) {
      for (const [name, list] of Object.entries(rec.morphAttributes)) {
        (g.morphAttributes as Record<string, BufferAttribute[]>)[name] = await Promise.all(
          list.map((a) => loadAttribute(a)),
        );
      }
    }
    g.morphTargetsRelative = rec.morphTargetsRelative ?? false;
    g.userData = rec.userData ?? {};
    g.computeBoundingBox();
    g.computeBoundingSphere();
    geometries.set(id, g);
  }

  const resolveMaterial = (ref: string | string[] | undefined): Material | Material[] => {
    if (Array.isArray(ref)) return ref.map((r) => materials.get(r) ?? new MeshStandardMaterial());
    return (ref && materials.get(ref)) || new MeshStandardMaterial();
  };

  const build = async (rec: NodeRecord): Promise<Object3D> => {
    let o: Object3D;
    const geometry = rec.geometry ? geometries.get(rec.geometry)! : new BufferGeometry();
    switch (rec.kind) {
      case 'mesh':
        o = new Mesh(geometry, resolveMaterial(rec.material));
        break;
      case 'instancedMesh': {
        const count = rec.instances?.count ?? 0;
        const im = new InstancedMesh(geometry, resolveMaterial(rec.material), count);
        if (rec.instances) {
          im.instanceMatrix = (await loadAttribute(rec.instances.matrices, true)) as InstancedBufferAttribute;
          if (rec.instances.colors)
            im.instanceColor = (await loadAttribute(rec.instances.colors, true)) as InstancedBufferAttribute;
        }
        o = im;
        break;
      }
      case 'line':
        o = new Line(geometry, resolveMaterial(rec.material));
        break;
      case 'lineSegments':
        o = new LineSegments(geometry, resolveMaterial(rec.material));
        break;
      case 'lineLoop':
        o = new LineLoop(geometry, resolveMaterial(rec.material));
        break;
      case 'points':
        o = new Points(geometry, resolveMaterial(rec.material));
        break;
      case 'light':
        o = buildLight(rec.light!);
        break;
      case 'camera':
        o = buildCamera(rec.camera!);
        break;
      case 'bone':
        o = new Bone();
        break;
      case 'group':
        o = new Group();
        break;
      default:
        o = new Object3D();
    }
    o.name = rec.name;
    o.userData = { ...rec.userData, [UD.id]: rec.id };
    new Matrix4().fromArray(rec.matrix).decompose(o.position, o.quaternion, o.scale);
    o.visible = rec.visible;
    o.castShadow = rec.castShadow ?? false;
    o.receiveShadow = rec.receiveShadow ?? false;
    o.renderOrder = rec.renderOrder ?? 0;
    o.frustumCulled = rec.frustumCulled ?? true;
    for (const child of rec.children) o.add(await build(child));
    if (rec.light?.targetChild !== undefined && 'target' in o) {
      const target = o.children[rec.light.targetChild];
      if (target) (o as DirectionalLight).target = target;
    }
    return o;
  };

  const objects: Object3D[] = [];
  for (const rec of doc.nodes) objects.push(await build(rec));
  return { objects, warnings: [...warnings] };
}

function buildLight(rec: LightRecord): Light {
  const color = new Color().fromArray(rec.color);
  let l: Light;
  switch (rec.type) {
    case 'DirectionalLight':
      l = new DirectionalLight(color, rec.intensity);
      break;
    case 'PointLight':
      l = new PointLight(color, rec.intensity, rec.distance ?? 0, rec.decay ?? 2);
      break;
    case 'SpotLight':
      l = new SpotLight(
        color,
        rec.intensity,
        rec.distance ?? 0,
        rec.angle ?? Math.PI / 3,
        rec.penumbra ?? 0,
        rec.decay ?? 2,
      );
      break;
    case 'HemisphereLight':
      l = new HemisphereLight(color, new Color().fromArray(rec.groundColor ?? [0, 0, 0]), rec.intensity);
      break;
    default:
      l = new AmbientLight(color, rec.intensity);
  }
  l.castShadow = rec.castShadow ?? false;
  return l;
}

function buildCamera(rec: CameraRecord): Camera {
  if (rec.type === 'OrthographicCamera') {
    const c = new OrthographicCamera(rec.left, rec.right, rec.top, rec.bottom, rec.near, rec.far);
    c.zoom = rec.zoom;
    c.updateProjectionMatrix();
    return c;
  }
  const c = new PerspectiveCamera(rec.fov, rec.aspect, rec.near, rec.far);
  c.zoom = rec.zoom;
  c.updateProjectionMatrix();
  return c;
}
