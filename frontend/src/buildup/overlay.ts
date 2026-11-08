// Image of where units can't go: mapped ground that's too steep, and reserved ground
// (boundary setback, site office and laydown yard). Drawn under the plan preview.

import type { SitePlan } from './types'

let canvas: HTMLCanvasElement | null = null

export function groundOverlay(plan: SitePlan): { href: string; x: number; y: number; w: number; h: number } {
  const { cols, rows, cellM } = plan.terrain
  canvas ??= document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(cols, rows)
  const ground = atob(plan.ground) // one byte per cell, base64 from the edge service
  for (let i = 0; i < ground.length; i++) {
    const g = ground.charCodeAt(i)
    const d = i * 4
    if (g === 2) {
      // too steep: brick red
      img.data[d] = 184
      img.data[d + 1] = 50
      img.data[d + 2] = 42
      img.data[d + 3] = 120
    } else if (g === 3) {
      // reserved: slate
      img.data[d] = 86
      img.data[d + 1] = 101
      img.data[d + 2] = 107
      img.data[d + 3] = 55
    }
  }
  ctx.putImageData(img, 0, 0)
  return { href: canvas.toDataURL(), x: 0, y: 0, w: cols * cellM, h: rows * cellM }
}
