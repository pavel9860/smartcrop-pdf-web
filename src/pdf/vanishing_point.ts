// vanishing_point.ts — text-line vanishing-point estimation for §7.1b (skew correction): PROSAC
// (confidence×leverage-ordered sampling) -> MSAC (bounded-loss scoring) -> IRLS (confidence×
// leverage×Huber-residual reweighted refinement). Ported from a Python research prototype
// validated against real scanned/photographed pages (see PROGRESS.md) — every fix noted inline
// below was found by that validation, not theoretical.
//
// Why a vanishing point, not a simple per-page rotation angle: text lines that are truly parallel
// in the real document converge to a common vanishing point when extended, and representing it in
// homogeneous coordinates (vx, vy, vz) on the unit sphere gives a materially more precise rotation
// angle than a single whole-page row-profile search (§7.1a's classic-CV classifier) — it's fit
// from many individually detected text lines, not one aggregate profile.
import { cv } from './cv'
import { VP_INLIER_THRESH, VP_HUBER_DELTA, VP_IRLS_ITERS, VP_MAX_PAIRS } from '@core/constants'

export interface Point {
  readonly x: number
  readonly y: number
}

export type Vp = readonly [number, number, number]

export interface VpEstimate {
  readonly v: Vp
  readonly mean_residual: number
}

// A LINE's orientation is defined mod 180deg, not mod 360 — direction and its exact opposite
// describe the same line. Both the VP's inherent SVD/eigen sign ambiguity (+v and -v are equally
// valid solutions) and the finite-VP "toward the point, which may legitimately be behind (x,y)
// along the line" case produce a raw atan2 result that can read ~180deg off from the line's actual
// orientation. Folding into (-90, 90] makes the reported angle canonical regardless of which
// mechanism produced the ambiguity — validated bug: without this, a near-perfectly-flat page's
// reported angle flipped unpredictably between ~0deg and ~180deg between runs.
export function fold_line_angle(angle_deg: number): number {
  return angle_deg - 180 * Math.ceil(angle_deg / 180 - 0.5)
}

// Homogeneous line through 2 points, normalized so (A,B) is unit length (makes l.v a genuine
// perpendicular-residual-like quantity, comparable across lines of different length).
function line_from_points(p1: Point, p2: Point): Vp {
  const a = p1.y - p2.y
  const b = p2.x - p1.x
  const c = p1.x * p2.y - p2.x * p1.y   // cross product of homogeneous points (p1x,p1y,1) x (p2x,p2y,1)
  const norm = Math.hypot(a, b)
  return norm > 1e-9 ? [a / norm, b / norm, c / norm] : [a, b, c]
}

function cross(l1: Vp, l2: Vp): Vp {
  return [
    l1[1] * l2[2] - l1[2] * l2[1],
    l1[2] * l2[0] - l1[0] * l2[2],
    l1[0] * l2[1] - l1[1] * l2[0],
  ]
}

function normalize(v: Vp): Vp | null {
  const n = Math.hypot(v[0], v[1], v[2])
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : null
}

// v minimizing sum(w_i * (l_i . v)^2) s.t. |v|=1 -> smallest eigenvector of M = L^T diag(w) L
// (equivalent to the smallest right-singular-vector of diag(sqrt(w))L, which is what a direct SVD
// would give — opencv.js has no SVDecomp binding, but does have eigen, and for a symmetric 3x3
// this is the same answer without needing one).
function weighted_vp_eigen(lines: readonly Vp[], weights: readonly number[]): Vp {
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < lines.length; i++) {
    const [a, b, c] = lines[i] as Vp
    const w = weights[i] as number
    m[0] = (m[0] as number) + w * a * a; m[1] = (m[1] as number) + w * a * b; m[2] = (m[2] as number) + w * a * c
    m[3] = (m[3] as number) + w * a * b; m[4] = (m[4] as number) + w * b * b; m[5] = (m[5] as number) + w * b * c
    m[6] = (m[6] as number) + w * a * c; m[7] = (m[7] as number) + w * b * c; m[8] = (m[8] as number) + w * c * c
  }
  const mat = cv.matFromArray(3, 3, cv.CV_64F, m)
  const eigenvalues = new cv.Mat()
  const eigenvectors = new cv.Mat()
  cv.eigen(mat, eigenvalues, eigenvectors)
  mat.delete()
  // eigen() returns eigenvalues in DESCENDING order — the smallest is the LAST row of eigenvectors.
  const data = eigenvectors.data64F
  const v: Vp = [data[6] as number, data[7] as number, data[8] as number]
  eigenvalues.delete(); eigenvectors.delete()
  return normalize(v) ?? v
}

// Bounded loss (MSAC): each line contributes min(residual, thresh^2), not a hard 0/1 — smoother
// preference among close candidates than plain RANSAC's inlier count.
function msac_cost(lines: readonly Vp[], v: Vp, thresh: number): number {
  const t2 = thresh * thresh
  let sum = 0
  for (const l of lines) {
    const r = l[0] * v[0] + l[1] * v[1] + l[2] * v[2]
    sum += Math.min(r * r, t2)
  }
  return sum
}

// PROSAC (confidence x leverage-ordered pair sampling) -> MSAC (bounded-loss scoring) -> IRLS
// (confidence x leverage x Huber-residual reweighted refinement). `weights` is a per-segment
// ANGLE-PRECISION leverage weight (e.g. detected-region width^2 — see dbnet.ts), independent of
// `confidences` (detection confidence answers "is this text", not "how precisely is its angle
// known" — a narrow-but-confident region's angle is quantization-noisy regardless of confidence).
// Validated bug: using confidence alone let a real skewed-page fixture's fit overshoot; adding
// the leverage weight fixed it completely (residual dropped from -1.60deg to +0.04deg on that
// same page).
export function estimate_vanishing_point(
  segments: ReadonlyArray<readonly [Point, Point]>,
  confidences: readonly number[],
  weights: readonly number[],
): VpEstimate | null {
  const n = segments.length
  if (n < 3) return null

  const lines = segments.map(([p1, p2]) => line_from_points(p1, p2))
  const max_weight = Math.max(...weights, 1e-9)
  const combined = confidences.map((c, i) => c * ((weights[i] as number) / max_weight))

  const pairs: Array<readonly [number, number]> = []
  const quality: number[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs.push([i, j])
      quality.push((combined[i] as number) * (combined[j] as number))
    }
  }
  const order = pairs.map((_, k) => k).sort((a, b) => (quality[b] as number) - (quality[a] as number))
    .slice(0, VP_MAX_PAIRS)

  let best_v: Vp | null = null
  let best_cost = Infinity
  for (const k of order) {
    const [i, j] = pairs[k] as readonly [number, number]
    const candidate = normalize(cross(lines[i] as Vp, lines[j] as Vp))
    if (!candidate) continue
    const cost = msac_cost(lines, candidate, VP_INLIER_THRESH)
    if (cost < best_cost) { best_cost = cost; best_v = candidate }
  }
  if (!best_v) return null

  // IRLS: reweight by confidence x leverage AND current geometric residual (Huber), refit, repeat.
  let v = best_v
  for (let iter = 0; iter < VP_IRLS_ITERS; iter++) {
    const huber_w = lines.map((l) => {
      const r = Math.abs(l[0] * v[0] + l[1] * v[1] + l[2] * v[2])
      return r <= VP_HUBER_DELTA ? 1.0 : VP_HUBER_DELTA / Math.max(r, 1e-9)
    })
    const w = combined.map((c, i) => c * (huber_w[i] as number))
    if (w.reduce((s, x) => s + x, 0) < 1e-9) break
    let v_new = weighted_vp_eigen(lines, w)
    if (v_new[0] * v[0] + v_new[1] * v[1] + v_new[2] * v[2] < 0) {
      v_new = [-v_new[0], -v_new[1], -v_new[2]]   // sign ambiguity — keep continuity across iterations
    }
    const delta = Math.hypot(v_new[0] - v[0], v_new[1] - v[1], v_new[2] - v[2])
    v = v_new
    if (delta < 1e-8) break
  }

  let sum_resid = 0
  for (const l of lines) sum_resid += Math.abs(l[0] * v[0] + l[1] * v[1] + l[2] * v[2])
  return { v, mean_residual: sum_resid / n }
}

// Implied local text-line angle (degrees) at point (x,y), given a vanishing point v. Always uses
// the finite-VP formula (direction from (x,y) toward the VP) — immune to v's eigen sign ambiguity
// (px=vx/vz and py=vy/vz are unchanged if v flips sign, since numerator and denominator flip
// together) AND reduces continuously to the constant-direction / pure-rotation case as vz -> 0
// (px, py -> +-infinity), so no separate "at infinity" branch is needed in the math. A prior
// version branched on vz and forced a constant angle whenever vz was small — that discarded real
// signal for a VP that's near-infinite in one axis but finite/nearby in the other (found on a real
// scanned-page fixture: horizontal component practically infinite, vertical component ~50px from
// the content — the branching version zeroed out that real signal).
export function local_angle_from_vp(v: Vp, x: number, y: number): number {
  const [vx, vy, vz0] = v
  const vz = Math.abs(vz0) > 1e-12 ? vz0 : (vz0 >= 0 ? 1e-12 : -1e-12)
  const px = vx / vz, py = vy / vz
  return fold_line_angle(Math.atan2(py - y, px - x) * 180 / Math.PI)
}

// Angle implied at the CENTER of the observed segments' own extent — NOT the page's physical
// center or edges. Extrapolating the fitted VP out to a page edge far past where any text actually
// was amplifies slope-estimation noise into a large false reading — validated bug: doing this
// produced a spurious multi-degree false reading on a known-flat real page. Evaluating within the
// observed range is interpolation, not extrapolation, and stays numerically stable.
export function vp_center_angle(v: Vp, segments: ReadonlyArray<readonly [Point, Point]>): number {
  const xs = segments.map(([p1, p2]) => (p1.x + p2.x) / 2)
  const ys = segments.map(([p1, p2]) => (p1.y + p2.y) / 2)
  const x_mid = (Math.min(...xs) + Math.max(...xs)) / 2
  const y_mid = (Math.min(...ys) + Math.max(...ys)) / 2
  return local_angle_from_vp(v, x_mid, y_mid)
}
