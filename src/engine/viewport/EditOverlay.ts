import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
} from 'three';
import type { Mesh as ThreeMesh } from 'three';
import {
  type ElementMode,
  type ElementSelection,
  type MeshTopology,
  edgeKey,
  parseEdgeKey,
  triangleCanonical,
} from '../geometry/topology';

const SELECT_COLOR = 0xff9a2e;
const WIRE_COLOR = 0x9aa4b5;

/** Edit Mode overlays drawn in the helper scene, following the target mesh's world matrix. */
export class EditOverlay {
  readonly group = new Group();
  private wire: LineSegments | null = null;
  private vertices: Points | null = null;
  private selectedFaces: Mesh | null = null;
  private selectedEdges: LineSegments | null = null;
  private selectedVertices: Points | null = null;
  private topo: MeshTopology | null = null;
  private readonly materials = {
    wire: new LineBasicMaterial({ color: WIRE_COLOR, transparent: true, opacity: 0.45, depthTest: true }),
    verts: new PointsMaterial({ color: 0xd5dbe6, size: 5, sizeAttenuation: false, depthTest: true }),
    faces: new MeshBasicMaterial({
      color: SELECT_COLOR,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: 2,
    }),
    edges: new LineBasicMaterial({ color: SELECT_COLOR, depthTest: false, transparent: true }),
    selVerts: new PointsMaterial({
      color: SELECT_COLOR,
      size: 8,
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    }),
  };

  constructor() {
    this.group.name = 'EditOverlay';
    this.group.matrixAutoUpdate = false;
    this.group.renderOrder = 10;
  }

  follow(target: ThreeMesh): void {
    target.updateWorldMatrix(true, false);
    this.group.matrix.copy(target.matrixWorld);
    this.group.matrixWorld.copy(target.matrixWorld);
  }

  /** Rebuilds the wireframe and vertex cloud (when the target geometry changes). */
  setTopology(topo: MeshTopology | null, mode: ElementMode): void {
    if (this.topo !== topo) {
      this.disposeObject(this.wire);
      this.disposeObject(this.vertices);
      this.wire = null;
      this.vertices = null;
      this.topo = topo;
      if (topo) {
        const seen = new Set<string>();
        const lines: number[] = [];
        const p = topo.canonicalPositions;
        for (let t = 0; t < topo.triangleCount; t++) {
          const [a, b, c] = triangleCanonical(topo, t);
          for (const [x, y] of [
            [a, b],
            [b, c],
            [c, a],
          ] as const) {
            if (x === y) continue;
            const k = edgeKey(x, y);
            if (seen.has(k)) continue;
            seen.add(k);
            lines.push(p[x * 3], p[x * 3 + 1], p[x * 3 + 2], p[y * 3], p[y * 3 + 1], p[y * 3 + 2]);
          }
        }
        const wg = new BufferGeometry();
        wg.setAttribute('position', new BufferAttribute(new Float32Array(lines), 3));
        this.wire = new LineSegments(wg, this.materials.wire);
        this.wire.frustumCulled = false;
        this.group.add(this.wire);
        const vg = new BufferGeometry();
        vg.setAttribute('position', new BufferAttribute(topo.canonicalPositions, 3));
        this.vertices = new Points(vg, this.materials.verts);
        this.vertices.frustumCulled = false;
        this.group.add(this.vertices);
      }
    }
    if (this.vertices) this.vertices.visible = mode === 'vertex';
  }

  setSelection(mode: ElementMode, sel: ElementSelection): void {
    this.disposeObject(this.selectedFaces);
    this.disposeObject(this.selectedEdges);
    this.disposeObject(this.selectedVertices);
    this.selectedFaces = this.selectedEdges = this.selectedVertices = null;
    const topo = this.topo;
    if (!topo) return;
    const p = topo.canonicalPositions;
    if (mode === 'face' && sel.faces.size) {
      const arr = new Float32Array(sel.faces.size * 9);
      let i = 0;
      for (const f of sel.faces) {
        if (f >= topo.triangleCount) continue;
        for (const v of triangleCanonical(topo, f)) {
          arr[i++] = p[v * 3];
          arr[i++] = p[v * 3 + 1];
          arr[i++] = p[v * 3 + 2];
        }
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(arr.subarray(0, i), 3));
      this.selectedFaces = new Mesh(g, this.materials.faces);
      this.selectedFaces.frustumCulled = false;
      this.group.add(this.selectedFaces);
    }
    if (mode === 'edge' && sel.edges.size) {
      const arr: number[] = [];
      for (const key of sel.edges) {
        const [a, b] = parseEdgeKey(key);
        arr.push(p[a * 3], p[a * 3 + 1], p[a * 3 + 2], p[b * 3], p[b * 3 + 1], p[b * 3 + 2]);
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(arr), 3));
      this.selectedEdges = new LineSegments(g, this.materials.edges);
      this.selectedEdges.renderOrder = 11;
      this.selectedEdges.frustumCulled = false;
      this.group.add(this.selectedEdges);
    }
    if (mode === 'vertex' && sel.vertices.size) {
      const arr = new Float32Array(sel.vertices.size * 3);
      let i = 0;
      for (const v of sel.vertices) {
        arr[i++] = p[v * 3];
        arr[i++] = p[v * 3 + 1];
        arr[i++] = p[v * 3 + 2];
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(arr, 3));
      this.selectedVertices = new Points(g, this.materials.selVerts);
      this.selectedVertices.renderOrder = 12;
      this.selectedVertices.frustumCulled = false;
      this.group.add(this.selectedVertices);
    }
  }

  private disposeObject(o: { geometry: BufferGeometry; removeFromParent(): unknown } | null): void {
    if (!o) return;
    o.removeFromParent();
    o.geometry.dispose();
  }

  dispose(): void {
    this.setTopology(null, 'face');
    this.setSelection('face', { faces: new Set(), edges: new Set(), vertices: new Set() });
    for (const m of Object.values(this.materials)) m.dispose();
    this.group.removeFromParent();
  }
}
