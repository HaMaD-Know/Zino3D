import type { Object3D, Texture } from 'three';
import { hasGeometry, isMesh, materialTextures, objectMaterials } from '../engine/scene/objectUtils';
import { triangleCount } from '../engine/geometry/attributes';

export interface SceneStats {
  objects: number;
  meshes: number;
  materials: number;
  textures: number;
  triangles: number;
  vertices: number;
  geometries: number;
  geometryBytes: number;
}

export function computeSceneStats(roots: Object3D[]): SceneStats {
  const materials = new Set<unknown>();
  const textures = new Set<Texture>();
  const geometries = new Set<unknown>();
  const stats: SceneStats = {
    objects: 0,
    meshes: 0,
    materials: 0,
    textures: 0,
    triangles: 0,
    vertices: 0,
    geometries: 0,
    geometryBytes: 0,
  };
  for (const root of roots) {
    root.traverse((o) => {
      stats.objects++;
      if (isMesh(o)) {
        stats.meshes++;
        stats.triangles += triangleCount(o.geometry);
      }
      if (hasGeometry(o)) {
        stats.vertices += o.geometry.getAttribute('position')?.count ?? 0;
        if (!geometries.has(o.geometry)) {
          geometries.add(o.geometry);
          for (const a of Object.values(o.geometry.attributes)) stats.geometryBytes += a.array.byteLength;
          if (o.geometry.index) stats.geometryBytes += o.geometry.index.array.byteLength;
        }
      }
      for (const m of objectMaterials(o)) {
        materials.add(m);
        for (const t of materialTextures(m)) textures.add(t);
      }
    });
  }
  stats.materials = materials.size;
  stats.textures = textures.size;
  stats.geometries = geometries.size;
  return stats;
}
