/** Versioned native Zino3D scene document (stored as structured data + binary assets). */
export const SCENE_SCHEMA_VERSION = 1;

export type TypedArrayName =
  | 'Float32Array'
  | 'Float64Array'
  | 'Int8Array'
  | 'Uint8Array'
  | 'Uint8ClampedArray'
  | 'Int16Array'
  | 'Uint16Array'
  | 'Int32Array'
  | 'Uint32Array';

export interface AttributeRecord {
  asset: string;
  type: TypedArrayName;
  itemSize: number;
  normalized: boolean;
  count: number;
}

export interface GeometryRecord {
  name: string;
  attributes: Record<string, AttributeRecord>;
  index?: AttributeRecord;
  groups: Array<{ start: number; count: number; materialIndex: number }>;
  morphAttributes?: Record<string, AttributeRecord[]>;
  morphTargetsRelative?: boolean;
  userData?: Record<string, unknown>;
}

export type MaterialParam = number | boolean | string | number[];

export interface MaterialRecord {
  type: string;
  name: string;
  params: Record<string, MaterialParam>;
  maps: Record<string, string>;
  userData?: Record<string, unknown>;
}

export interface TextureRecord {
  name: string;
  image: string | null;
  colorSpace: string;
  flipY: boolean;
  wrapS: number;
  wrapT: number;
  magFilter: number;
  minFilter: number;
  anisotropy: number;
  repeat: [number, number];
  offset: [number, number];
  center: [number, number];
  rotation: number;
  channel: number;
  generateMipmaps: boolean;
}

export interface ImageRecord {
  asset: string;
  mimeType: string;
  width: number;
  height: number;
}

export type NodeKind =
  | 'group'
  | 'object'
  | 'mesh'
  | 'instancedMesh'
  | 'line'
  | 'lineSegments'
  | 'lineLoop'
  | 'points'
  | 'light'
  | 'camera'
  | 'bone';

export interface LightRecord {
  type: 'DirectionalLight' | 'PointLight' | 'SpotLight' | 'AmbientLight' | 'HemisphereLight';
  color: number[];
  intensity: number;
  groundColor?: number[];
  distance?: number;
  decay?: number;
  angle?: number;
  penumbra?: number;
  castShadow?: boolean;
  /** index in children of the light's target object (glTF lights use a child target) */
  targetChild?: number;
}

export interface CameraRecord {
  type: 'PerspectiveCamera' | 'OrthographicCamera';
  near: number;
  far: number;
  zoom: number;
  fov?: number;
  aspect?: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export interface NodeRecord {
  id: string;
  name: string;
  kind: NodeKind;
  matrix: number[];
  visible: boolean;
  userData: Record<string, unknown>;
  geometry?: string;
  material?: string | string[];
  castShadow?: boolean;
  receiveShadow?: boolean;
  renderOrder?: number;
  frustumCulled?: boolean;
  light?: LightRecord;
  camera?: CameraRecord;
  instances?: { count: number; matrices: AttributeRecord; colors?: AttributeRecord };
  children: NodeRecord[];
}

export interface EditorStateRecord {
  cursor?: [number, number, number];
  settings?: Record<string, unknown>;
  camera?: { position: number[]; target: number[]; projection: 'perspective' | 'orthographic' };
}

export interface SceneDocument {
  schemaVersion: number;
  nodes: NodeRecord[];
  geometries: Record<string, GeometryRecord>;
  materials: Record<string, MaterialRecord>;
  textures: Record<string, TextureRecord>;
  images: Record<string, ImageRecord>;
  editor?: EditorStateRecord;
}

export class SchemaError extends Error {}

/** Lightweight structural validation; throws SchemaError with a readable message. */
export function validateSceneDocument(doc: unknown): SceneDocument {
  if (!doc || typeof doc !== 'object') throw new SchemaError('Scene document is missing.');
  const d = doc as Partial<SceneDocument>;
  if (typeof d.schemaVersion !== 'number') throw new SchemaError('Scene document has no schema version.');
  if (d.schemaVersion > SCENE_SCHEMA_VERSION) {
    throw new SchemaError(
      `This project was saved by a newer Zino3D (schema ${d.schemaVersion}). Please update the app.`,
    );
  }
  if (!Array.isArray(d.nodes)) throw new SchemaError('Scene document has no node list.');
  for (const key of ['geometries', 'materials', 'textures', 'images'] as const) {
    if (!d[key] || typeof d[key] !== 'object') throw new SchemaError(`Scene document is missing "${key}".`);
  }
  const checkNode = (n: NodeRecord) => {
    if (
      typeof n.id !== 'string' ||
      !Array.isArray(n.matrix) ||
      n.matrix.length !== 16 ||
      !Array.isArray(n.children)
    ) {
      throw new SchemaError(`Invalid node "${String(n?.name)}".`);
    }
    if (n.geometry && !d.geometries![n.geometry])
      throw new SchemaError(`Node "${n.name}" references a missing geometry.`);
    n.children.forEach(checkNode);
  };
  d.nodes.forEach(checkNode);
  return d as SceneDocument;
}

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migration hooks keyed by the version they upgrade FROM. Version 0 represents pre-release documents
 * that lacked `images`/`editor`; future schema changes add entries here.
 */
export const migrations: Record<number, Migration> = {
  0: (doc) => ({ ...doc, images: doc.images ?? {}, textures: doc.textures ?? {}, schemaVersion: 1 }),
};

export function migrateSceneDocument(input: unknown): SceneDocument {
  if (!input || typeof input !== 'object') throw new SchemaError('Scene document is missing.');
  let doc = { ...(input as Record<string, unknown>) };
  let version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 0;
  while (version < SCENE_SCHEMA_VERSION) {
    const m = migrations[version];
    if (!m) throw new SchemaError(`No migration available from schema ${version}.`);
    doc = m(doc);
    const next = doc.schemaVersion as number;
    if (next <= version) throw new SchemaError(`Migration from ${version} did not advance the schema.`);
    version = next;
  }
  return validateSceneDocument(doc);
}
