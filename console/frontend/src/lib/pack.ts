export interface Circle { x: number; y: number; r: number }

/**
 * Places circles as close to the middle as they fit, the largest first, searching outward on rings stretched to
 * `aspect` (width over height). Returns one circle per radius, in the order given. The same radii always give the same
 * picture, so a circle keeps its place while it grows.
 */
export function pack(radii: number[], aspect = 1, gap = 2): Circle[] {
  const order = radii.map((_, i) => i).sort((a, b) => radii[b] - radii[a] || a - b);
  const placed: Circle[] = [];
  const out: Circle[] = radii.map((r) => ({ x: 0, y: 0, r }));
  for (const i of order) {
    const r = radii[i];
    let spot: Circle | null = placed.length ? null : { x: 0, y: 0, r };
    const step = Math.max(3, r * 0.6);
    for (let rho = step; !spot; rho += step) {
      const n = Math.max(8, Math.ceil((2 * Math.PI * rho) / step));
      for (let k = 0; k < n && !spot; k++) {
        const angle = (2 * Math.PI * k) / n + rho * 0.37;
        const x = rho * Math.cos(angle) * aspect;
        const y = rho * Math.sin(angle);
        if (placed.every((c) => Math.hypot(c.x - x, c.y - y) >= c.r + r + gap)) spot = { x, y, r };
      }
    }
    placed.push(spot);
    out[i] = spot;
  }
  return out;
}

/** The box that holds every circle. */
export function bounds(circles: Circle[], pad = 0): { x: number; y: number; w: number; h: number } {
  if (!circles.length) return { x: -50, y: -50, w: 100, h: 100 };
  const x0 = Math.min(...circles.map((c) => c.x - c.r)) - pad;
  const y0 = Math.min(...circles.map((c) => c.y - c.r)) - pad;
  const x1 = Math.max(...circles.map((c) => c.x + c.r)) + pad;
  const y1 = Math.max(...circles.map((c) => c.y + c.r)) + pad;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Circles packed around the middle, shrunk to sit inside a circle of radius `inside`. */
export function packInside(radii: number[], inside: number): Circle[] {
  const loose = pack(radii, 1, 1);
  const reach = Math.max(...loose.map((c) => Math.hypot(c.x, c.y) + c.r), 1);
  const k = inside / reach;
  return loose.map((c) => ({ x: c.x * k, y: c.y * k, r: c.r * k }));
}
