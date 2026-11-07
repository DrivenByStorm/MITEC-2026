// Section selection: decides which part of the surveyed area each drone maps next.
//
// THIS IS A PLACEHOLDER. The real selection algorithm is being developed separately.
// To plug it in, write a function with the `SelectionAlgorithm` signature and pass it to
// `new SurveySession({ selection: yourAlgorithm })` (see survey/source.ts). Nothing else
// in the app needs to change.

import type { Pt } from './types'

export interface SelectionSection {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** Fraction already mapped, 0–1. */
  coverage: number
}

export interface SelectionDrone {
  id: string
  x: number
  y: number
  battery: number // 0–100
}

export interface SelectionInput {
  /** 'initial' = first pass after the perimeter closes; 'requested' = the user picked sections. */
  mode: 'initial' | 'requested'
  launch: Pt
  perimeter: Pt[]
  sections: SelectionSection[]
  /** Drones that are free to take work (docked with a charged battery). */
  drones: SelectionDrone[]
  /** Width of ground each drone maps in one pass, meters. */
  swathM: number
  /** For 'requested' mode: the sections the user asked for, in order. */
  requestedSectionIds: string[]
}

export interface Assignment {
  droneId: string
  sectionId: string
  /** Flight path over the section. The session adds the legs to and from the launch point. */
  waypoints: Pt[]
}

export type SelectionAlgorithm = (input: SelectionInput) => Assignment[]

/**
 * Placeholder rules:
 *  - initial pass: give each free drone one of the sections closest to the launch point;
 *  - requested: split each requested section into strips, one per free drone.
 * Each drone flies a back-and-forth (lawnmower) pattern over its area.
 */
export const placeholderSelection: SelectionAlgorithm = (input) => {
  const free = [...input.drones]
  const out: Assignment[] = []
  if (!free.length) return out

  if (input.mode === 'initial') {
    const ranked = [...input.sections]
      .filter((s) => s.coverage < 0.97)
      .sort((a, b) => distTo(input.launch, a) - distTo(input.launch, b))
      .slice(0, free.length)
    for (const s of ranked) {
      const drone = takeNearest(free, center(s))
      if (!drone) break
      out.push({ droneId: drone.id, sectionId: s.id, waypoints: lawnmower(s, input.swathM, drone) })
    }
    return out
  }

  const requested = input.requestedSectionIds
    .map((id) => input.sections.find((s) => s.id === id))
    .filter((s): s is SelectionSection => !!s)
  if (!requested.length) return out
  // Share drones out across the requested sections, then split each section into strips.
  const perSection = Math.max(1, Math.floor(free.length / requested.length))
  for (const s of requested) {
    const crew: SelectionDrone[] = []
    for (let i = 0; i < perSection && free.length; i++) crew.push(takeNearest(free, center(s))!)
    if (!crew.length) break
    const bandH = s.h / crew.length
    crew.forEach((d, i) => {
      const band = { ...s, y: s.y + i * bandH, h: bandH }
      out.push({ droneId: d.id, sectionId: s.id, waypoints: lawnmower(band, input.swathM, d) })
    })
  }
  return out
}

function center(s: { x: number; y: number; w: number; h: number }): Pt {
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 }
}

function distTo(p: Pt, s: SelectionSection) {
  const c = center(s)
  return Math.hypot(c.x - p.x, c.y - p.y)
}

function takeNearest(drones: SelectionDrone[], p: Pt) {
  if (!drones.length) return undefined
  let best = 0
  for (let i = 1; i < drones.length; i++) {
    if (Math.hypot(drones[i].x - p.x, drones[i].y - p.y) < Math.hypot(drones[best].x - p.x, drones[best].y - p.y)) best = i
  }
  return drones.splice(best, 1)[0]
}

/** Back-and-forth rows across a rectangle, starting from the corner nearest the drone. */
export function lawnmower(area: { x: number; y: number; w: number; h: number }, swathM: number, from: Pt): Pt[] {
  const spacing = swathM * 0.85 // overlap so rows leave no gaps
  const rowsN = Math.max(1, Math.ceil(area.h / spacing))
  const step = area.h / rowsN
  const left = area.x + swathM * 0.4
  const right = area.x + area.w - swathM * 0.4
  const fromTop = Math.abs(from.y - area.y) <= Math.abs(from.y - (area.y + area.h))
  const fromLeft = Math.abs(from.x - left) <= Math.abs(from.x - right)
  const pts: Pt[] = []
  for (let i = 0; i < rowsN; i++) {
    const y = fromTop ? area.y + step * (i + 0.5) : area.y + area.h - step * (i + 0.5)
    const leftFirst = (i % 2 === 0) === fromLeft
    pts.push({ x: leftFirst ? left : right, y }, { x: leftFirst ? right : left, y })
  }
  return pts
}
