// Geometry in the site frame (decimeters): zone distances, coverage area, integer helpers.

import type { Pos, Zone } from './types.js'

export const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y)

/** Integer square root, floor (9.5). */
export function isqrt(n: number): number {
  if (n <= 0) return 0
  let x = Math.floor(Math.sqrt(n))
  while (x * x > n) x--
  while ((x + 1) * (x + 1) <= n) x++
  return x
}

export function pointInPolygon(p: Pos, poly: Pos[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function segDist(p: Pos, a: Pos, b: Pos) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Signed distance from a zone's boundary to a point: negative inside, positive outside (dm). */
export function zoneDistance(zone: Zone, p: Pos): number {
  if ('circle' in zone.shape) {
    const c = zone.shape.circle
    return dist(p, c.center) - c.radius
  }
  const poly = zone.shape.polygon
  let d = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segDist(p, poly[j], poly[i]))
  return pointInPolygon(p, poly) ? -d : d
}

export function zoneCenter(zone: Zone): Pos {
  if ('circle' in zone.shape) return zone.shape.circle.center
  const poly = zone.shape.polygon
  return { x: poly.reduce((t, q) => t + q.x, 0) / poly.length, y: poly.reduce((t, q) => t + q.y, 0) / poly.length }
}

export interface CoverageCircle {
  center: Pos
  radius: number // dm
}

/** How far a point lies outside the coverage area, dm (0 inside). Polygon coverage, if given, replaces the circles (6.4). */
export function outsideCoverage(p: Pos, circles: CoverageCircle[], polygon?: Pos[]): number {
  if (polygon && polygon.length >= 3) {
    if (pointInPolygon(p, polygon)) return 0
    let d = Infinity
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) d = Math.min(d, segDist(p, polygon[j], polygon[i]))
    return d
  }
  let best = Infinity
  for (const c of circles) best = Math.min(best, dist(p, c.center) - c.radius)
  return Math.max(0, best)
}

/** Nearest point inside the coverage circles (for driving back after OUT_OF_COVERAGE). */
export function nearestCoveragePoint(p: Pos, circles: CoverageCircle[]): Pos | null {
  let best: Pos | null = null
  let bestD = Infinity
  for (const c of circles) {
    const d = dist(p, c.center)
    const target = d <= c.radius ? p : { x: c.center.x + ((p.x - c.center.x) / d) * (c.radius - 10), y: c.center.y + ((p.y - c.center.y) / d) * (c.radius - 10) }
    const dd = dist(p, target)
    if (dd < bestD) {
      bestD = dd
      best = target
    }
  }
  return best
}

/** Least-squares 2D position from ranges (weights = quality), linearised against the first anchor (8.5). */
export function multilaterate(obs: { anchor: Pos; range: number; w: number }[], prev?: Pos | null): { pos: Pos; rms: number } | null {
  if (obs.length < 3) return null
  // Gauss-Newton from several starting points (weighted centroid, previous fix, and points pushed out
  // from the centroid); poor anchor geometry has mirror solutions, so keep the best fit.
  const W = obs.reduce((t, o) => t + o.w, 0)
  const cx = obs.reduce((t, o) => t + o.anchor.x * o.w, 0) / W
  const cy = obs.reduce((t, o) => t + o.anchor.y * o.w, 0) / W
  const r = obs.reduce((t, o) => t + o.range, 0) / obs.length
  const starts: Pos[] = [{ x: cx, y: cy }, ...[0, 1, 2, 3].map((k) => ({ x: cx + r * Math.cos((k * Math.PI) / 2), y: cy + r * Math.sin((k * Math.PI) / 2) }))]
  if (prev) starts.unshift(prev)
  let best: { pos: Pos; rms: number } | null = null
  for (const s of starts) {
    const f = solve(obs, s.x, s.y)
    if (!best || f.rms < best.rms) best = f
  }
  return best
}

function solve(obs: { anchor: Pos; range: number; w: number }[], x0: number, y0: number): { pos: Pos; rms: number } {
  let x = x0
  let y = y0
  for (let it = 0; it < 12; it++) {
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0
    for (const o of obs) {
      const dx = x - o.anchor.x
      const dy = y - o.anchor.y
      const d = Math.max(1e-6, Math.hypot(dx, dy))
      const jx = dx / d
      const jy = dy / d
      const r = o.range - d
      a11 += o.w * jx * jx
      a12 += o.w * jx * jy
      a22 += o.w * jy * jy
      b1 += o.w * jx * r
      b2 += o.w * jy * r
    }
    const det = a11 * a22 - a12 * a12
    if (Math.abs(det) < 1e-9) break
    const sx = (a22 * b1 - a12 * b2) / det
    const sy = (a11 * b2 - a12 * b1) / det
    x += sx
    y += sy
    if (Math.hypot(sx, sy) < 0.5) break
  }
  const rms = Math.sqrt(obs.reduce((t, o) => t + (o.range - Math.hypot(x - o.anchor.x, y - o.anchor.y)) ** 2, 0) / obs.length)
  return { pos: { x: Math.round(x), y: Math.round(y) }, rms }
}
