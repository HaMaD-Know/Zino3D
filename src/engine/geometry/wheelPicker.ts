/**
 * Fused-wheel picker: when a wheel is part of the same connected mesh as the body, geometry alone
 * cannot isolate it. The user taps the wheel; this module estimates a cylinder around it (axle along
 * the model's width, radius = height of the wheel centre above the ground, depth measured inward
 * from the outer face) and selects the triangles inside it. Every parameter is adjustable, the
 * selection is previewed, and nothing is changed until the user confirms.
 */
import { horizontalYaw } from './wheelDetection';

export interface WheelCylinder {
  /** Wheel centre in world space. */
  center: [number, number, number];
  /** Unit axle direction in world space (points to the outside of the vehicle). */
  axle: [number, number, number];
  /** Unit up direction in world space. */
  up: [number, number, number];
  radius: number;
  /** Signed axle coordinate of the outer face of the wheel (relative to center). */
  outer: number;
  /** Selection depth measured inward from the outer face. */
  depth: number;
}

export interface PickerInput {
  /** World-space vertex positions. */
  world: Float32Array;
  triangles: Uint32Array;
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** World-space positions from local positions and a column-major matrix. */
export function worldPositions(positions: Float32Array, e: ArrayLike<number>): Float32Array {
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

/** Triangles whose centroid lies inside the cylinder (radially and within the depth band). */
export function trianglesInCylinder(input: PickerInput, cyl: WheelCylinder): Uint8Array {
  const { world, triangles } = input;
  const t = triangles.length / 3;
  const mask = new Uint8Array(t);
  const r2 = cyl.radius * cyl.radius;
  const lo = cyl.outer - cyl.depth;
  const hi = cyl.outer + cyl.radius * 0.05;
  for (let i = 0; i < t; i++) {
    const a = triangles[i * 3] * 3,
      b = triangles[i * 3 + 1] * 3,
      c = triangles[i * 3 + 2] * 3;
    const px = (world[a] + world[b] + world[c]) / 3 - cyl.center[0];
    const py = (world[a + 1] + world[b + 1] + world[c + 1]) / 3 - cyl.center[1];
    const pz = (world[a + 2] + world[b + 2] + world[c + 2]) / 3 - cyl.center[2];
    const along = px * cyl.axle[0] + py * cyl.axle[1] + pz * cyl.axle[2];
    if (along < lo || along > hi) continue;
    const rx = px - along * cyl.axle[0],
      ry = py - along * cyl.axle[1],
      rz = pz - along * cyl.axle[2];
    if (rx * rx + ry * ry + rz * rz <= r2) mask[i] = 1;
  }
  return mask;
}

/**
 * Estimates the wheel cylinder from a tapped surface point.
 * @param upAxis world axis that points up (1 = Y for glTF, 2 = Z for many CAD exports)
 */
export function estimateWheelFromTap(
  input: PickerInput,
  tap: [number, number, number],
  upAxis: 0 | 1 | 2,
): WheelCylinder {
  const { world } = input;
  const n = world.length / 3;
  const up: [number, number, number] = [0, 0, 0];
  up[upAxis] = 1;
  // Axle = the model's width direction: the minor principal horizontal axis.
  const yaw = horizontalYaw(world, upAxis);
  const [ha, hb] = ([0, 1, 2] as const).filter((x) => x !== upAxis);
  const major: [number, number, number] = [0, 0, 0];
  major[ha] = Math.cos(yaw.angle);
  major[hb] = Math.sin(yaw.angle);
  const axle: [number, number, number] = [0, 0, 0];
  axle[ha] = -Math.sin(yaw.angle);
  axle[hb] = Math.cos(yaw.angle);
  // Ground and model centre along the axle.
  let ground = Infinity;
  let minA = Infinity,
    maxA = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = [world[i * 3], world[i * 3 + 1], world[i * 3 + 2]];
    ground = Math.min(ground, p[upAxis]);
    const a = dot(p, axle);
    minA = Math.min(minA, a);
    maxA = Math.max(maxA, a);
  }
  // Point the axle outward on the tapped side.
  const midA = (minA + maxA) / 2;
  if (dot(tap, axle) < midA) axle.forEach((_, i) => (axle[i] = -axle[i]));

  let center: [number, number, number] = [...tap];
  let radius = Math.max(tap[upAxis] - ground, 1e-6);
  let outer = 0;
  // Refine: re-centre on the vertices inside the cylinder (side-plane centroid), then re-derive the
  // radius from the ground contact. A few iterations converge for tyres seen from the side.
  for (let iter = 0; iter < 4; iter++) {
    const c = center;
    let sumL = 0,
      sumU = 0,
      count = 0,
      outerMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = [world[i * 3] - c[0], world[i * 3 + 1] - c[1], world[i * 3 + 2] - c[2]];
      const along = dot(d, axle);
      const l = dot(d, major);
      const u = d[upAxis];
      if (l * l + u * u > radius * radius) continue;
      if (along < -radius * 0.9 || along > radius * 0.5) continue;
      sumL += l;
      sumU += u;
      count++;
      if (along > outerMax) outerMax = along;
    }
    if (count < 8) break;
    const dl = sumL / count;
    const du = sumU / count;
    center = [c[0] + major[0] * dl, c[1] + major[1] * dl, c[2] + major[2] * dl] as [number, number, number];
    center[upAxis] += du;
    radius = Math.max(center[upAxis] - ground, radius * 0.5);
    outer = outerMax;
  }
  // Recompute the outer face relative to the final centre.
  let outerMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = [world[i * 3] - center[0], world[i * 3 + 1] - center[1], world[i * 3 + 2] - center[2]];
    const along = dot(d, axle);
    const l = dot(d, major);
    const u = d[upAxis];
    if (l * l + u * u <= radius * radius && along >= -radius * 0.9 && along <= radius && along > outerMax)
      outerMax = along;
  }
  outer = Number.isFinite(outerMax) ? outerMax : outer;
  return { center, axle, up, radius: radius * 1.02, outer, depth: radius * 0.75 };
}
