import {
  Color,
  type Material,
  type Mesh,
  MeshStandardMaterial,
  type Object3D,
  SRGBColorSpace,
  type Texture,
} from 'three';
import type { Editor } from './Editor';
import { ValueCommand } from '../history/commands/ValueCommand';
import { ReplaceGeometryCommand } from '../history/commands/GeometryCommands';
import { getId, isMesh, materialTextures, objectMaterials } from '../scene/objectUtils';

export interface MaterialUsage {
  material: Material;
  users: Array<{ object: Object3D; slot: number }>;
}

/** Every material in the scene with the objects (and slots) that use it. */
export function materialUsage(editor: Editor): MaterialUsage[] {
  const map = new Map<Material, MaterialUsage>();
  editor.root.traverse((o) => {
    objectMaterials(o).forEach((m, slot) => {
      let u = map.get(m);
      if (!u) {
        u = { material: m, users: [] };
        map.set(m, u);
      }
      u.users.push({ object: o, slot });
    });
  });
  return [...map.values()];
}

export function usersOf(editor: Editor, material: Material): number {
  let n = 0;
  editor.root.traverse((o) => {
    for (const m of objectMaterials(o)) if (m === material) n++;
  });
  return n;
}

export type ScalarKey =
  | 'metalness'
  | 'roughness'
  | 'opacity'
  | 'emissiveIntensity'
  | 'alphaTest'
  | 'envMapIntensity'
  | 'normalScale';
export type BoolKey = 'transparent' | 'wireframe' | 'flatShading' | 'depthWrite' | 'vertexColors';
export type ColorKey = 'color' | 'emissive';

/** Sets a material property with undo. Rapid changes to the same property merge (slider drags). */
export function setMaterialValue(
  editor: Editor,
  material: Material,
  key: string,
  value: unknown,
  label?: string,
): void {
  const target = material as unknown as Record<string, unknown>;
  if (!(key in target)) return;
  const current = target[key];
  let before: unknown;
  let apply: (v: unknown) => void;
  if (current instanceof Color) {
    before = current.getHex();
    if (before === value) return;
    apply = (v) => (current as Color).setHex(v as number);
  } else {
    before = current;
    if (before === value) return;
    apply = (v) => {
      target[key] = v;
      if (
        key === 'transparent' ||
        key === 'vertexColors' ||
        key === 'flatShading' ||
        key === 'alphaTest' ||
        key === 'side'
      )
        material.needsUpdate = true;
    };
  }
  const applyWithOpacity = (v: unknown) => {
    apply(v);
    // Lowering opacity on an opaque material would have no visible effect; enable blending for it.
    if (key === 'opacity' && typeof v === 'number' && v < 1 && !material.transparent) {
      material.transparent = true;
      material.needsUpdate = true;
    }
  };
  editor.execute(
    new ValueCommand<unknown>(
      editor,
      label ?? `Material ${key}`,
      key === 'opacity' ? applyWithOpacity : apply,
      before,
      value,
      ['material'],
      `mat:${material.uuid}:${key}`,
    ),
  );
}

export function renameMaterial(editor: Editor, material: Material, name: string): void {
  if (material.name === name) return;
  editor.execute(
    new ValueCommand<string>(editor, 'Rename material', (v) => (material.name = v), material.name, name, [
      'material',
    ]),
  );
}

export function setDoubleSided(editor: Editor, material: Material, doubleSided: boolean): void {
  setMaterialValue(
    editor,
    material,
    'side',
    doubleSided ? 2 : 0,
    doubleSided ? 'Double-sided' : 'Single-sided',
  );
}

/** Assigns a material to a mesh slot. Slot -1 assigns to every slot of the object. */
function setSlotMaterial(mesh: Mesh, slot: number, material: Material): void {
  if (Array.isArray(mesh.material)) {
    const next = [...mesh.material];
    if (slot < 0) next.fill(material);
    else next[slot] = material;
    mesh.material = next;
  } else mesh.material = material;
}

/** Makes the material in an object's slot unique by cloning it (the original stays on other users). */
export function makeMaterialUnique(editor: Editor, objectId: string, slot: number): Material | null {
  const o = editor.getObject(objectId);
  if (!isMesh(o)) return null;
  const mats = objectMaterials(o);
  const original = mats[slot];
  if (!original) return null;
  const copy = original.clone();
  copy.name = `${original.name || 'Material'}.unique`;
  const before = o.material;
  setSlotMaterial(o, slot, copy);
  const after = o.material;
  o.material = before;
  editor.execute(
    new ReplaceGeometryCommand(
      editor,
      [{ id: objectId, before: o.geometry, after: o.geometry, beforeMaterial: before, afterMaterial: after }],
      'Make material unique',
    ),
  );
  return copy;
}

export function duplicateMaterial(editor: Editor, objectId: string, slot: number): Material | null {
  return makeMaterialUnique(editor, objectId, slot);
}

/** Assigns `material` to every selected mesh (all slots). */
export function assignMaterialToSelection(editor: Editor, material: Material): void {
  const meshes = editor.selectedObjects().filter((o): o is Mesh => isMesh(o) && !editor.isLocked(o));
  if (meshes.length === 0) {
    editor.message('warning', 'Select one or more meshes to assign the material to.');
    return;
  }
  const changes = meshes.map((m) => {
    const before = m.material;
    setSlotMaterial(m, -1, material);
    const after = m.material;
    m.material = before;
    return {
      id: getId(m),
      before: m.geometry,
      after: m.geometry,
      beforeMaterial: before,
      afterMaterial: after,
    };
  });
  editor.execute(
    new ReplaceGeometryCommand(editor, changes, `Assign material "${material.name || 'Material'}"`),
  );
}

/** Creates a fresh PBR material and assigns it to the selection. */
export function createMaterialForSelection(editor: Editor): void {
  const m = new MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.5, metalness: 0 });
  m.name = 'New Material';
  assignMaterialToSelection(editor, m);
}

/** Converts a legacy (Phong/Lambert/Basic) material in a slot to MeshStandardMaterial, keeping maps and colors. */
export function convertToStandard(editor: Editor, objectId: string, slot: number): void {
  const o = editor.getObject(objectId);
  if (!isMesh(o)) return;
  const src = objectMaterials(o)[slot] as Material & Record<string, unknown>;
  if (!src || (src as unknown as MeshStandardMaterial).isMeshStandardMaterial) return;
  const m = new MeshStandardMaterial({ roughness: 0.6, metalness: 0 });
  m.name = src.name;
  if (src.color instanceof Color) m.color.copy(src.color);
  if (src.emissive instanceof Color) m.emissive.copy(src.emissive);
  for (const key of [
    'map',
    'normalMap',
    'alphaMap',
    'aoMap',
    'emissiveMap',
    'lightMap',
    'bumpMap',
  ] as const) {
    if (src[key]) (m as unknown as Record<string, unknown>)[key] = src[key];
  }
  m.opacity = src.opacity;
  m.transparent = src.transparent;
  m.side = src.side;
  m.vertexColors = src.vertexColors;
  const before = o.material;
  setSlotMaterial(o, slot, m);
  const after = o.material;
  o.material = before;
  editor.execute(
    new ReplaceGeometryCommand(
      editor,
      [{ id: objectId, before: o.geometry, after: o.geometry, beforeMaterial: before, afterMaterial: after }],
      'Convert to PBR material',
    ),
  );
}

export const TEXTURE_SLOTS = [
  { key: 'map', label: 'Base color', color: true },
  { key: 'normalMap', label: 'Normal', color: false },
  { key: 'roughnessMap', label: 'Roughness', color: false },
  { key: 'metalnessMap', label: 'Metalness', color: false },
  { key: 'aoMap', label: 'Ambient occlusion', color: false },
  { key: 'emissiveMap', label: 'Emissive', color: true },
  { key: 'alphaMap', label: 'Alpha', color: false },
] as const;

export function setTexture(editor: Editor, material: Material, key: string, texture: Texture | null): void {
  const target = material as unknown as Record<string, unknown>;
  if (!(key in target)) {
    editor.message('warning', `${material.type} has no ${key} slot.`);
    return;
  }
  const before = (target[key] as Texture | null) ?? null;
  if (before === texture) return;
  if (texture && (key === 'map' || key === 'emissiveMap')) texture.colorSpace = SRGBColorSpace;
  editor.execute(
    new ValueCommand<Texture | null>(
      editor,
      texture ? `Assign ${key}` : `Remove ${key}`,
      (v) => {
        target[key] = v;
        material.needsUpdate = true;
      },
      before,
      texture,
      ['material'],
    ),
  );
}

/**
 * Loads an image file into a texture. glTF-style UVs (the default) use flipY = false; pass
 * `flipVertically` for meshes that follow the OpenGL convention (e.g. OBJ). ImageBitmaps cannot be
 * flipped by WebGL at upload time, so the flip happens while decoding.
 */
export async function textureFromFile(
  file: Blob & { name?: string },
  flipVertically = false,
): Promise<Texture> {
  const { Texture } = await import('three');
  const bitmap = await createImageBitmap(file, {
    imageOrientation: flipVertically ? 'flipY' : 'from-image',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const t = new Texture(bitmap as unknown as HTMLImageElement);
  t.name = file.name ?? 'texture';
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

export function textureList(material: Material): Array<{ key: string; texture: Texture }> {
  const out: Array<{ key: string; texture: Texture }> = [];
  const target = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    const v = target[key];
    if (v && materialTextures(material).includes(v as Texture)) out.push({ key, texture: v as Texture });
  }
  return out;
}
