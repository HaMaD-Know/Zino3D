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

function scoreForUp(
  components: Array<Box3Like & { id: number }>,
  model: Box3Like,
  up: 0 | 1 | 2,
): WheelCandidate[] {
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

export function detectWheelCandidates(
  components: Array<Box3Like & { id: number }>,
  model: Box3Like,
): WheelDetectionResult {
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
