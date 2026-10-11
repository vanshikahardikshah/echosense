export interface NodeRange {
  id: string;
  /** Node position on the floor plan, metres. */
  x: number;
  y: number;
  /** Measured slant range to the target, metres. */
  range: number;
  /** Range standard deviation, metres. */
  sigma: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Position {
  x: number;
  y: number;
  /** RMS range residual, metres. */
  residual: number;
  /** Geometric dilution of precision (1 is ideal). */
  gdop: number;
  used: number;
  /** Two-node fix where both mirror solutions are plausible. */
  ambiguous: boolean;
}

/**
 * Convert slant range (phone at table height to a chest at another height) to
 * horizontal range on the floor plan.
 */
export function horizontal(range: number, heightDiff: number): number {
  return Math.sqrt(Math.max(0.01, range * range - heightDiff * heightDiff));
}

function inBounds(p: { x: number; y: number }, b?: Bounds, margin = 0.3): boolean {
  if (!b) return true;
  return p.x >= b.minX - margin && p.x <= b.maxX + margin && p.y >= b.minY - margin && p.y <= b.maxY + margin;
}

function circleIntersections(a: NodeRange, b: NodeRange): { x: number; y: number }[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return [];
  // Clamp to the nearest consistent geometry when circles don't intersect.
  const r1 = a.range;
  const r2 = b.range;
  if (d > r1 + r2 || d < Math.abs(r1 - r2)) {
    const t = d > r1 + r2 ? r1 / (r1 + r2) : r1 > r2 ? 1 + r2 / d : -r1 / d;
    return [{ x: a.x + dx * Math.max(-1, Math.min(2, t)), y: a.y + dy * Math.max(-1, Math.min(2, t)) }];
  }
  const l = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - l * l));
  const mx = a.x + (dx * l) / d;
  const my = a.y + (dy * l) / d;
  return [
    { x: mx + (h * -dy) / d, y: my + (h * dx) / d },
    { x: mx - (h * -dy) / d, y: my - (h * dx) / d },
  ];
}

/**
 * Locate a target on the floor plan from ranges measured by several phones.
 *
 * Three or more nodes: weighted nonlinear least squares (Gauss-Newton),
 * seeded from the previous fix or a linearised solution. Two nodes: circle
 * intersection, with the mirror ambiguity resolved by room bounds and the
 * previous position.
 */
export function trilaterate(nodes: NodeRange[], prior?: { x: number; y: number } | null, bounds?: Bounds): Position | null {
  const ns = nodes.filter((n) => Number.isFinite(n.range) && n.range > 0);
  if (ns.length < 2) return null;
  if (ns.length === 2) {
    const cands = circleIntersections(ns[0], ns[1]);
    if (cands.length === 0) return null;
    const valid = cands.filter((c) => inBounds(c, bounds));
    const pool = valid.length ? valid : cands;
    let best = pool[0];
    if (pool.length > 1 && prior) {
      best = pool.reduce((a, c) => (Math.hypot(c.x - prior.x, c.y - prior.y) < Math.hypot(a.x - prior.x, a.y - prior.y) ? c : a));
    }
    const res = Math.sqrt(ns.reduce((s, n) => s + (Math.hypot(best.x - n.x, best.y - n.y) - n.range) ** 2, 0) / 2);
    return { x: best.x, y: best.y, residual: res, gdop: gdopAt(best, ns), used: 2, ambiguous: pool.length > 1 && !prior };
  }

  // Linearised initial guess (subtract the first equation from the others).
  let x0: number;
  let y0: number;
  if (prior) {
    x0 = prior.x;
    y0 = prior.y;
  } else {
    const r = ns[0];
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 1; i < ns.length; i++) {
      const n = ns[i];
      const ax = 2 * (n.x - r.x);
      const ay = 2 * (n.y - r.y);
      const bb = r.range ** 2 - n.range ** 2 + n.x ** 2 - r.x ** 2 + n.y ** 2 - r.y ** 2;
      a11 += ax * ax;
      a12 += ax * ay;
      a22 += ay * ay;
      b1 += ax * bb;
      b2 += ay * bb;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-9) {
      x0 = ns.reduce((s, n) => s + n.x, 0) / ns.length;
      y0 = ns.reduce((s, n) => s + n.y, 0) / ns.length;
    } else {
      x0 = (a22 * b1 - a12 * b2) / det;
      y0 = (a11 * b2 - a12 * b1) / det;
    }
  }
  let x = x0;
  let y = y0;
  for (let it = 0; it < 20; it++) {
    let h11 = 0;
    let h12 = 0;
    let h22 = 0;
    let g1 = 0;
    let g2 = 0;
    for (const n of ns) {
      const dx = x - n.x;
      const dy = y - n.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const w = 1 / (n.sigma * n.sigma);
      const jx = dx / d;
      const jy = dy / d;
      const e = d - n.range;
      h11 += w * jx * jx;
      h12 += w * jx * jy;
      h22 += w * jy * jy;
      g1 += w * jx * e;
      g2 += w * jy * e;
    }
    // Levenberg damping keeps steps sane with poor geometry.
    const lam = 1e-3 * (h11 + h22);
    const a = h11 + lam;
    const c = h22 + lam;
    const det = a * c - h12 * h12;
    if (Math.abs(det) < 1e-12) break;
    const sx = (c * g1 - h12 * g2) / det;
    const sy = (a * g2 - h12 * g1) / det;
    x -= sx;
    y -= sy;
    if (Math.hypot(sx, sy) < 1e-4) break;
  }
  const residual = Math.sqrt(ns.reduce((s, n) => s + (Math.hypot(x - n.x, y - n.y) - n.range) ** 2, 0) / ns.length);
  return { x, y, residual, gdop: gdopAt({ x, y }, ns), used: ns.length, ambiguous: false };
}

function gdopAt(p: { x: number; y: number }, ns: NodeRange[]): number {
  let h11 = 0;
  let h12 = 0;
  let h22 = 0;
  for (const n of ns) {
    const d = Math.hypot(p.x - n.x, p.y - n.y) || 1e-6;
    const jx = (p.x - n.x) / d;
    const jy = (p.y - n.y) / d;
    h11 += jx * jx;
    h12 += jx * jy;
    h22 += jy * jy;
  }
  const det = h11 * h22 - h12 * h12;
  if (det < 1e-9) return 99;
  return Math.sqrt((h11 + h22) / det);
}

/** Constant-velocity 2-D alpha-beta smoother for the fused position. */
export class PositionTracker {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  private t = -1;
  private init = false;

  constructor(
    private readonly alpha = 0.45,
    private readonly beta = 0.08,
  ) {}

  update(p: { x: number; y: number }, t: number): { x: number; y: number; vx: number; vy: number } {
    if (!this.init) {
      this.x = p.x;
      this.y = p.y;
      this.t = t;
      this.init = true;
      return { x: this.x, y: this.y, vx: 0, vy: 0 };
    }
    const dt = Math.max(1e-3, Math.min(1, t - this.t));
    this.t = t;
    const px = this.x + this.vx * dt;
    const py = this.y + this.vy * dt;
    const rx = p.x - px;
    const ry = p.y - py;
    this.x = px + this.alpha * rx;
    this.y = py + this.alpha * ry;
    this.vx += (this.beta * rx) / dt;
    this.vy += (this.beta * ry) / dt;
    return { x: this.x, y: this.y, vx: this.vx, vy: this.vy };
  }

  reset(): void {
    this.init = false;
    this.vx = 0;
    this.vy = 0;
  }
}
