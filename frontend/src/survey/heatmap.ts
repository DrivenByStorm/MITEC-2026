// Elevation heat map: colors each mapped cell by height, with light hillshading so the
// shape of the ground reads at a glance. Only the region inside the boundary is drawn.

import type { SurveySnapshot } from './types'

// Low → high: basin blue, teal, sage, sand, ochre, umber.
export const RAMP: [number, [number, number, number]][] = [
  [0, [31, 78, 121]],
  [0.25, [58, 140, 140]],
  [0.45, [156, 197, 154]],
  [0.62, [234, 217, 160]],
  [0.8, [200, 138, 74]],
  [1, [110, 63, 34]],
]

export const RAMP_CSS = `linear-gradient(90deg, ${RAMP.map(([t, [r, g, b]]) => `rgb(${r} ${g} ${b}) ${t * 100}%`).join(', ')})`

function rampColor(t: number): [number, number, number] {
  const v = Math.min(1, Math.max(0, t))
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i]
    const [t0, c0] = RAMP[i - 1]
    if (v <= t1) {
      const f = (v - t0) / (t1 - t0)
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f]
    }
  }
  return RAMP[RAMP.length - 1][1]
}

export interface HeatRegion {
  c0: number
  r0: number
  w: number
  h: number
  colors: Uint8ClampedArray // RGB per cell in the region (alpha added per frame)
}

/** Precompute shaded colors for the region around the boundary (once per survey). */
export function buildRegion(snap: SurveySnapshot, heights: Float32Array): HeatRegion | null {
  if (!snap.perimeter.length) return null
  const { cols, rows, cellM } = snap.terrain
  const margin = 80
  const xs = snap.perimeter.map((p) => p.x)
  const ys = snap.perimeter.map((p) => p.y)
  const c0 = Math.max(0, Math.floor((Math.min(...xs) - margin) / cellM))
  const r0 = Math.max(0, Math.floor((Math.min(...ys) - margin) / cellM))
  const c1 = Math.min(cols, Math.ceil((Math.max(...xs) + margin) / cellM))
  const r1 = Math.min(rows, Math.ceil((Math.max(...ys) + margin) / cellM))
  const w = c1 - c0
  const h = r1 - r0
  const colors = new Uint8ClampedArray(w * h * 3)
  const { min, max } = snap.colorRange
  const span = max - min || 1
  const at = (c: number, r: number) => heights[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))]
  // Hillshade: sun from the north-west, 45° up; relief exaggerated so gentle terrain still shows.
  const exag = 3
  const lx = -Math.SQRT1_2 * Math.SQRT1_2
  const ly = -Math.SQRT1_2 * Math.SQRT1_2
  const lz = Math.SQRT1_2
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const gc = c0 + c
      const gr = r0 + r
      const z = at(gc, gr)
      const dzdx = ((at(gc + 1, gr) - at(gc - 1, gr)) / (2 * cellM)) * exag
      const dzdy = ((at(gc, gr + 1) - at(gc, gr - 1)) / (2 * cellM)) * exag
      const n = Math.hypot(dzdx, dzdy, 1)
      const lambert = Math.max(0, (-dzdx * lx - dzdy * ly + lz) / n)
      const shade = 0.62 + 0.38 * lambert / lz
      const [cr, cg, cb] = rampColor((z - min) / span)
      const i = (r * w + c) * 3
      colors[i] = cr * shade
      colors[i + 1] = cg * shade
      colors[i + 2] = cb * shade
    }
  }
  return { c0, r0, w, h, colors }
}

let canvas: HTMLCanvasElement | null = null

/** Render mapped cells to a PNG data URL (unmapped cells transparent). */
export function renderHeatmap(region: HeatRegion, coverage: Uint8Array, cols: number): string {
  canvas ??= document.createElement('canvas')
  canvas.width = region.w
  canvas.height = region.h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(region.w, region.h)
  const px = img.data
  for (let r = 0; r < region.h; r++) {
    const row = (region.r0 + r) * cols + region.c0
    for (let c = 0; c < region.w; c++) {
      if (!coverage[row + c]) continue
      const s = (r * region.w + c) * 3
      const d = (r * region.w + c) * 4
      px[d] = region.colors[s]
      px[d + 1] = region.colors[s + 1]
      px[d + 2] = region.colors[s + 2]
      px[d + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL()
}
