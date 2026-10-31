/**
 * Deterministic, geometry-only wheel candidate ranking for vehicle-like models.
 *
 * This is a heuristic. It looks for loose parts whose bounding boxes have a roughly circular profile
 * (two similar large extents, one smaller "axle" extent), that sit at the bottom of the model along the
 * detected up axis, and that come in groups of similar size placed on both sides of the model.
 * It does NOT assume a fixed forward direction, a fixed up axis, or that there are four wheels.
 * Wheels fused into the body mesh cannot be found this way; users must select those faces manually.
 */
export interface Box3Like {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ComponentInput extends Box3Like {
  id: number;
  /** Optional sample of the component's vertices (xyz, same space as the bounds) for shape analysis. */
  points?: Float32Array;
}

/**
 * Angular coverage (0..1) of the component's outermost vertices around the axis `axle`, using 24
 * angle bins. A wheel/cylinder rim covers nearly every bin; a box covers only the bins of its corners.
 */
export function circularity(points: Float32Array, axle: 0 | 1 | 2, box: Box3Like): number {
  const [u, v] = ([0, 1, 2] as const).filter((a) => a !== axle);
  const cu = (box.min[u] + box.max[u]) / 2;
  const cv = (box.min[v] + box.max[v]) / 2;
  const n = Math.floor(points.length / 3);
  if (n < 8) return 0;
  let maxR = 0;
  const radii = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(points[i * 3 + u] - cu, points[i * 3 + v] - cv);
    radii[i] = r;
    if (r > maxR) maxR = r;
  }
  if (maxR <= 0) return 0;
  const BINS = 24;
  const bins = new Uint8Array(BINS);
  for (let i = 0; i < n; i++) {
    if (radii[i] < maxR * 0.85) continue;
    const a = Math.atan2(points[i * 3 + v] - cv, points[i * 3 + u] - cu);
    bins[Math.min(BINS - 1, Math.floor(((a + Math.PI) / (2 * Math.PI)) * BINS))] = 1;
  }
  let covered = 0;
  for (const b of bins) covered += b;
  return covered / BINS;
}

/**
 * Collects up to `maxPerComponent` vertex positions per component (optionally transformed by a
 * column-major 4x4 matrix) for circularity analysis.
 */
export function collectComponentPoints(
  positions: Float32Array,
  triangles: Uint32Array,
  triangleComponent: Uint32Array,
  componentCount: number,
  matrix?: ArrayLike<number>,
  maxPerComponent = 4000,
): Float32Array[] {
  const lists: number[][] = Array.from({ length: componentCount }, () => []);
  const seen = new Uint8Array(Math.floor(positions.length / 3));
  for (let t = 0; t < triangleComponent.length; t++) {
    const list = lists[triangleComponent[t]];
    for (let k = 0; k < 3; k++) {
      const vi = triangles[t * 3 + k];
      if (seen[vi] || list.length >= maxPerComponent * 3) continue;
      seen[vi] = 1;
      let x = positions[vi * 3],
        y = positions[vi * 3 + 1],
        z = positions[vi * 3 + 2];
      if (matrix) {
        const e = matrix;
        const nx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const ny = e[1] * x + e[5] * y + e[9] * z + e[13];
        const nz = e[2] * x + e[6] * y + e[10] * z + e[14];
        x = nx;
        y = ny;
        z = nz;
      }
      list.push(x, y, z);
    }
  }
  return lists.map((l) => new Float32Array(l));
}

export interface WheelCandidate {
  componentId: number;
  score: number;
  diameter: number;
  axleAxis: 0 | 1 | 2;
  reasons: string[];
}

export interface WheelDetectionResult {
  upAxis: 0 | 1 | 2;
  candidates: WheelCandidate[];
}

const AXES = ['X', 'Y', 'Z'] as const;

function size(b: Box3Like): [number, number, number] {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

function scoreForUp(components: ComponentInput[], model: Box3Like, up: 0 | 1 | 2): WheelCandidate[] {
  const msize = size(model);
  const horizontal = ([0, 1, 2] as const).filter((a) => a !== up);
  const horizontalExtent = Math.max(msize[horizontal[0]], msize[horizontal[1]]);
  const height = Math.max(msize[up], 1e-12);
  const center = [0, 1, 2].map((a) => (model.min[a] + model.max[a]) / 2);
  const out: WheelCandidate[] = [];

  for (const c of components) {
    const s = size(c);
    const order = ([0, 1, 2] as const).slice().sort((a, b) => s[a] - s[b]);
    const thinAxis = order[0];
    const d1 = s[order[1]],
      d2 = s[order[2]];
    if (d2 <= 0) continue;
    const reasons: string[] = [];
    let score = 0;

    const roundness = d1 / d2; // 1 = circular profile
    if (roundness < 0.7) continue;
    score += 0.3 * Math.min(1, (roundness - 0.7) / 0.25);
    reasons.push(`circular profile (${Math.round(roundness * 100)}%)`);

    if (thinAxis === up) continue; // wheels stand upright: the axle cannot be vertical
    const thickness = s[thinAxis] / d2;
    if (thickness > 0.85) continue;
    score += 0.15 * (1 - Math.max(0, thickness - 0.2) / 0.65);
    if (c.points) {
      const circ = circularity(c.points, thinAxis, c);
      if (circ < 0.7) continue; // box-like profile, not a wheel
      score += 0.1 * circ;
      reasons.push(`round rim (${Math.round(circ * 100)}% coverage)`);
    }

    const diameter = (d1 + d2) / 2;
    const rel = diameter / Math.max(horizontalExtent, 1e-12);
    if (rel < 0.05 || rel > 0.6) continue;
    score += rel >= 0.1 && rel <= 0.45 ? 0.15 : 0.05;
    reasons.push(`diameter ${Math.round(rel * 100)}% of model length`);

    const bottomGap = (c.min[up] - model.min[up]) / height;
    if (bottomGap > 0.25) continue;
    score += 0.25 * (1 - bottomGap / 0.25);
    reasons.push(`touches ground along ${AXES[up]}`);

    // Off-centre along the axle axis (wheels are on the sides of the vehicle).
    const cc = (c.min[thinAxis] + c.max[thinAxis]) / 2;
    const side = Math.abs(cc - center[thinAxis]) / Math.max(msize[thinAxis] / 2, 1e-12);
    if (side > 0.4) {
      score += 0.15 * Math.min(1, side);
      reasons.push('positioned at the side');
    }
    out.push({ componentId: c.id, score, diameter, axleAxis: thinAxis, reasons });
  }

  // Bonus for groups of similarly sized candidates (pairs / sets of four).
  for (const cand of out) {
    const similar = out.filter(
      (o) =>
        o !== cand &&
        Math.abs(o.diameter - cand.diameter) / cand.diameter < 0.15 &&
        o.axleAxis === cand.axleAxis,
    );
    if (similar.length >= 1) {
      cand.score += Math.min(0.2, 0.07 * similar.length);
      cand.reasons.push(`${similar.length + 1} similar parts`);
    }
  }
  return out.sort((a, b) => b.score - a.score || a.componentId - b.componentId);
}

export function detectWheelCandidates(components: ComponentInput[], model: Box3Like): WheelDetectionResult {
  let best: WheelDetectionResult = { upAxis: 1, candidates: [] };
  let bestTotal = -1;
  // Prefer Y-up (glTF convention), then Z-up, then X-up when scores tie.
  for (const up of [1, 2, 0] as const) {
    const candidates = scoreForUp(components, model, up);
    const total = candidates.slice(0, 4).reduce((sum, c) => sum + c.score, 0);
    if (total > bestTotal + 1e-9) {
      bestTotal = total;
      best = { upAxis: up, candidates };
    }
  }
  for (const c of best.candidates) c.score = Math.min(1, Math.round(c.score * 100) / 100);
  return best;
}

// ------------------------------------------------------------------------------------------------
// Mesh-level analysis: orientation-independent detection with wheel-assembly grouping.
// ------------------------------------------------------------------------------------------------

export interface MeshWheelInput {
  positions: Float32Array;
  triangles: Uint32Array;
  triangleComponent: Uint32Array;
  componentCount: number;
  /** Column-major 4x4 matrix to world space (object.matrixWorld.elements). */
  matrix?: ArrayLike<number>;
}

export interface WheelGroup {
  /** The wheel-like component that anchors the group (usually the tyre). */
  anchorId: number;
  /** Anchor plus smaller parts inside its bounds (rim, hub, brake disc, bolts…). */
  componentIds: number[];
  score: number;
  diameter: number;
  reasons: string[];
}

export interface MeshWheelResult {
  upAxis: 0 | 1 | 2;
  /** Rotation (degrees) applied about the up axis to align the model's length with an axis. */
  yawDegrees: number;
  groups: WheelGroup[];
}

function toWorld(positions: Float32Array, matrix?: ArrayLike<number>): Float32Array {
  if (!matrix) return positions;
  const e = matrix;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  return out;
}

/** Principal horizontal direction (radians) of a point cloud around `up`, from a 2×2 covariance. */
export function horizontalYaw(
  points: Float32Array,
  up: 0 | 1 | 2,
): { angle: number; ca: number; cb: number } {
  const [a, b] = ([0, 1, 2] as const).filter((x) => x !== up);
  const n = Math.floor(points.length / 3);
  const stride = Math.max(1, Math.floor(n / 200_000));
  let sa = 0,
    sb = 0,
    m = 0;
  for (let i = 0; i < n; i += stride) {
    sa += points[i * 3 + a];
    sb += points[i * 3 + b];
    m++;
  }
  const ca = sa / Math.max(m, 1),
    cb = sb / Math.max(m, 1);
  let caa = 0,
    cbb = 0,
    cab = 0;
  for (let i = 0; i < n; i += stride) {
    const da = points[i * 3 + a] - ca,
      db = points[i * 3 + b] - cb;
    caa += da * da;
    cbb += db * db;
    cab += da * db;
  }
  return { angle: 0.5 * Math.atan2(2 * cab, caa - cbb), ca, cb };
}

/** Rotates points about `up` by -angle around (ca, cb) so the principal direction aligns with an axis. */
function alignYaw(
  points: Float32Array,
  up: 0 | 1 | 2,
  yaw: { angle: number; ca: number; cb: number },
): Float32Array {
  const [a, b] = ([0, 1, 2] as const).filter((x) => x !== up);
  const c = Math.cos(yaw.angle),
    s = Math.sin(yaw.angle);
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const da = points[i + a] - yaw.ca,
      db = points[i + b] - yaw.cb;
    out[i + up] = points[i + up];
    out[i + a] = c * da + s * db;
    out[i + b] = -s * da + c * db;
  }
  return out;
}

function componentInputs(
  points: Float32Array,
  triangles: Uint32Array,
  triangleComponent: Uint32Array,
  count: number,
  samplePerComponent = 3000,
): ComponentInput[] {
  const comps: ComponentInput[] = Array.from({ length: count }, (_, id) => ({
    id,
    min: [Infinity, Infinity, Infinity] as [number, number, number],
    max: [-Infinity, -Infinity, -Infinity] as [number, number, number],
  }));
  const vertexComp = new Int32Array(points.length / 3).fill(-1);
  const counts = new Uint32Array(count);
  for (let t = 0; t < triangleComponent.length; t++) {
    for (let k = 0; k < 3; k++) {
      const v = triangles[t * 3 + k];
      if (vertexComp[v] >= 0) continue;
      vertexComp[v] = triangleComponent[t];
      counts[triangleComponent[t]]++;
    }
  }
  const samples: number[][] = Array.from({ length: count }, () => []);
  const seen = new Uint32Array(count);
  for (let v = 0; v < vertexComp.length; v++) {
    const c = vertexComp[v];
    if (c < 0) continue;
    const box = comps[c];
    for (let axis = 0; axis < 3; axis++) {
      const value = points[v * 3 + axis];
      if (value < box.min[axis]) box.min[axis] = value;
      if (value > box.max[axis]) box.max[axis] = value;
    }
    const stride = Math.max(1, Math.floor(counts[c] / samplePerComponent));
    if (seen[c]++ % stride === 0) samples[c].push(points[v * 3], points[v * 3 + 1], points[v * 3 + 2]);
  }
  comps.forEach((c, i) => (c.points = new Float32Array(samples[i])));
  return comps.filter((c) => Number.isFinite(c.min[0]));
}

function unionBox(comps: ComponentInput[]): Box3Like {
  const box: Box3Like = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const c of comps) {
    for (let a = 0; a < 3; a++) {
      box.min[a] = Math.min(box.min[a], c.min[a]);
      box.max[a] = Math.max(box.max[a], c.max[a]);
    }
  }
  return box;
}

/**
 * Finds wheel assemblies in a mesh's loose parts, independent of the model's yaw and up axis.
 * Smaller parts whose centres lie inside a wheel candidate's bounds (rims, hubs, bolts) are grouped
 * with it, so a wheel built from several loose pieces is still separated as one wheel.
 */
export function analyzeMeshWheels(input: MeshWheelInput): MeshWheelResult {
  const world = toWorld(input.positions, input.matrix);
  type Trial = { up: 0 | 1 | 2; yaw: number; comps: ComponentInput[]; candidates: WheelCandidate[] };
  const trials: Trial[] = [];
  for (const up of [1, 2, 0] as const) {
    const yaw = horizontalYaw(world, up);
    const aligned = alignYaw(world, up, yaw);
    const comps = componentInputs(aligned, input.triangles, input.triangleComponent, input.componentCount);
    const model = unionBox(comps);
    trials.push({ up, yaw: yaw.angle, comps, candidates: scoreForUp(comps, model, up) });
  }
  const total = (list: WheelCandidate[]) => list.slice(0, 4).reduce((sum, c) => sum + c.score, 0);
  let best = trials[0];
  for (const t of trials.slice(1)) {
    if (t.candidates.length >= 2 && total(t.candidates) > total(best.candidates) * 1.5 + 0.2) best = t;
  }

  const byId = new Map(best.comps.map((c) => [c.id, c]));
  const center = (c: ComponentInput) => [0, 1, 2].map((a) => (c.min[a] + c.max[a]) / 2);
  const diag = (c: Box3Like) => Math.hypot(c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]);
  const assigned = new Set<number>();
  const groups: WheelGroup[] = [];
  // Largest candidates first so tyres absorb the rims and hubs inside them.
  const ordered = [...best.candidates].sort((x, y) => y.diameter - x.diameter);
  for (const cand of ordered) {
    if (assigned.has(cand.componentId)) continue;
    const anchor = byId.get(cand.componentId)!;
    const pad = 0.05 * diag(anchor);
    const members = [cand.componentId];
    assigned.add(cand.componentId);
    for (const other of best.comps) {
      if (assigned.has(other.id) || diag(other) >= diag(anchor)) continue;
      const c = center(other);
      if ([0, 1, 2].every((a) => c[a] >= anchor.min[a] - pad && c[a] <= anchor.max[a] + pad)) {
        members.push(other.id);
        assigned.add(other.id);
      }
    }
    const reasons = [...cand.reasons];
    if (members.length > 1) reasons.push(`${members.length - 1} attached piece(s) grouped`);
    groups.push({
      anchorId: cand.componentId,
      componentIds: members,
      score: Math.min(1, Math.round(cand.score * 100) / 100),
      diameter: cand.diameter,
      reasons,
    });
  }
  groups.sort((x, y) => y.score - x.score || x.anchorId - y.anchorId);
  return { upAxis: best.up, yawDegrees: Math.round((best.yaw * 180) / Math.PI), groups };
}
