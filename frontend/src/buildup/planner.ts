// Rule-based buildup planner.
//
// Given the surveyed terrain, the number of P3 units and the crew available, it decides:
//   1. WHERE units go: rows on mapped ground flat enough to build on, grouped into blocks,
//      packed as close to the site office as the terrain allows;
//   2. HOW MANY RELAYS and where: every unit within machine-link range of at least two
//      relays (so one failure never cuts a work area off), all chained to the gateway;
//   3. WHAT FLEET and CREW: starts with one crew of each kind, then keeps adding to
//      whichever stage is the schedule bottleneck while people remain;
//   4. HOW LONG it should take, and what limits it.
// The number of units is always the build manager's input; the planner never changes it
// (it only warns if the mapped ground can't fit them all).

import type { Pt } from '../survey/types'
import { ASSUMPTIONS } from './assumptions'
import type { Assumptions } from './assumptions'
import type { CrewRole, FleetItem, PlanInput, PlannedBlock, PlannedRelay, PlannedUnit, Rect, SitePlan, StageEstimate } from './types'
import { ASSET_RANGE_M, RELAY_RANGE_M } from '../twin/network'

export interface PlannerContext {
  heights: Float32Array
  /** 1 where the survey mapped the ground. */
  coverage: Uint8Array
  cols: number
  rows: number
  cellM: number
  /** Surveyed boundary, NW, NE, SE, SW. */
  perimeter: Pt[]
  launch: Pt
}

const UNIT_HALF_W = 6 // P3 footprint used for layout, meters (12 × 8)
const UNIT_HALF_H = 4
const RELAY_GRID_M = 90
const REDUNDANCY = 2

export function planSite(input: PlanInput, ctx: PlannerContext, A: Assumptions = ASSUMPTIONS): SitePlan {
  const warnings: string[] = []
  const { cols, rows, cellM, launch } = ctx
  const unitCount = Math.max(0, Math.round(input.unitCount))
  const crewSize = Math.max(0, Math.round(input.crewSize))

  // ---------- ground classification ----------
  const office: Rect = { x: launch.x - 70, y: launch.y - 60, w: 140, h: 120 }
  const laydown: Rect = { x: launch.x + 85, y: launch.y - 80, w: 190, h: 160 }
  const [nw, , se] = ctx.perimeter
  const slope = slopeGrid(ctx)
  const ground = new Uint8Array(cols * rows)
  const reserved = (x: number, y: number) => inRect(x, y, office, 25) || inRect(x, y, laydown, 25)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (!ctx.coverage[i]) continue
      const x = (c + 0.5) * cellM
      const y = (r + 0.5) * cellM
      const inside = x >= nw.x + A.boundarySetbackM && x <= se.x - A.boundarySetbackM && y >= nw.y + A.boundarySetbackM && y <= se.y - A.boundarySetbackM
      if (slope[i] > A.maxSlopePct) ground[i] = 2
      else if (!inside || reserved(x, y)) ground[i] = 3
      else ground[i] = 1
    }
  }

  // ---------- slots: a lattice of possible unit positions anchored on the launch point ----------
  const SX = A.slotSpacingM
  const SY = A.rowSpacingM
  interface Slot { i: number; j: number; x: number; y: number; slopeMax: number }
  const slots: Slot[] = []
  const iMin = Math.ceil((nw.x - launch.x) / SX)
  const iMax = Math.floor((se.x - launch.x) / SX)
  const jMin = Math.ceil((nw.y - launch.y) / SY)
  const jMax = Math.floor((se.y - launch.y) / SY)
  const pad = 3
  for (let j = jMin; j <= jMax; j++) {
    for (let i = iMin; i <= iMax; i++) {
      const x = launch.x + i * SX
      const y = launch.y + j * SY
      const c0 = Math.floor((x - UNIT_HALF_W - pad) / cellM)
      const c1 = Math.floor((x + UNIT_HALF_W + pad) / cellM)
      const r0 = Math.floor((y - UNIT_HALF_H - pad) / cellM)
      const r1 = Math.floor((y + UNIT_HALF_H + pad) / cellM)
      if (c0 < 0 || r0 < 0 || c1 >= cols || r1 >= rows) continue
      let ok = true
      let lo = Infinity
      let hi = -Infinity
      let sMax = 0
      for (let r = r0; r <= r1 && ok; r++) {
        for (let c = c0; c <= c1; c++) {
          const k = r * cols + c
          if (ground[k] !== 1) { ok = false; break }
          const h = ctx.heights[k]
          if (h < lo) lo = h
          if (h > hi) hi = h
          if (slope[k] > sMax) sMax = slope[k]
        }
      }
      if (ok && hi - lo <= A.maxFootprintReliefM) slots.push({ i, j, x, y, slopeMax: sMax })
    }
  }

  // Fill whole blocks, nearest the office first (how crews actually sequence the work).
  // Blocks with little buildable ground rank lower; inside the last block, the slots
  // closest to the office (and flattest) go first.
  const capacity = A.blockRows * A.blockSlots
  const byBlock = new Map<string, Slot[]>()
  for (const s of slots) {
    const key = `${Math.floor(s.i / A.blockSlots)},${Math.floor(s.j / A.blockRows)}`
    if (!byBlock.has(key)) byBlock.set(key, [])
    byBlock.get(key)!.push(s)
  }
  const rankedBlocks = [...byBlock.values()]
    .map((list) => {
      const cx = list.reduce((t, s) => t + s.x, 0) / list.length
      const cy = list.reduce((t, s) => t + s.y, 0) / list.length
      const fill = list.length / capacity
      return { list, rank: Math.hypot(cx - launch.x, cy - launch.y) * (1 + 0.6 * (1 - fill)) }
    })
    .sort((a, b) => a.rank - b.rank)
  const slotScore = (s: Slot) => Math.hypot(s.x - launch.x, s.y - launch.y) * (1 + (0.5 * s.slopeMax) / A.maxSlopePct)
  const chosen: Slot[] = []
  // First pass skips nearly-empty blocks (a few scattered flat spots); they're used only if needed.
  const minUseful = Math.ceil(capacity * 0.1)
  for (const pass of [0, 1]) {
    for (const b of rankedBlocks) {
      if (chosen.length >= unitCount) break
      const sparse = b.list.length < minUseful
      if ((pass === 0 && sparse) || (pass === 1 && !sparse)) continue
      const take = [...b.list].sort((x, y) => slotScore(x) - slotScore(y)).slice(0, unitCount - chosen.length)
      chosen.push(...take)
    }
  }
  if (chosen.length < unitCount) {
    warnings.push(
      `Only ${chosen.length} of ${unitCount} units fit on mapped ground flatter than ${A.maxSlopePct}%. Map more of the site in the survey, or build in phases.`,
    )
  }

  // ---------- blocks ----------
  const groups = new Map<string, Slot[]>()
  for (const s of chosen) {
    const key = `${Math.floor(s.i / A.blockSlots)},${Math.floor(s.j / A.blockRows)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }
  // Blocks are named in build order (A first), so the last, partial block comes last.
  const ordered = [...groups.entries()].map(([key, list]) => {
    const [bi, bj] = key.split(',').map(Number)
    return { bi, bj, list }
  })

  const units: PlannedUnit[] = []
  const blocks: PlannedBlock[] = []
  ordered.forEach((g, n) => {
    const id = blockLabel(n)
    const list = g.list
      .map((s) => ({ ...s, row: s.j - g.bj * A.blockRows + 1, slot: s.i - g.bi * A.blockSlots + 1 }))
      // build order: row by row, alternating direction so machines don't backtrack
      .sort((a, b) => a.row - b.row || (a.row % 2 ? a.slot - b.slot : b.slot - a.slot))
    for (const s of list) {
      units.push({ id: `${id}-${pad2(s.row)}-${pad2(s.slot)}`, block: id, row: s.row, slot: s.slot, x: s.x, y: s.y })
    }
    const xs = list.map((s) => s.x)
    const ys = list.map((s) => s.y)
    blocks.push({
      id,
      x: Math.min(...xs) - UNIT_HALF_W - 6,
      y: Math.min(...ys) - UNIT_HALF_H - 8,
      w: Math.max(...xs) - Math.min(...xs) + 2 * UNIT_HALF_W + 12,
      h: Math.max(...ys) - Math.min(...ys) + 2 * UNIT_HALF_H + 16,
      rows: new Set(list.map((s) => s.row)).size,
      slots: new Set(list.map((s) => s.slot)).size,
      unitCount: list.length,
    })
  })

  // ---------- trench & haul distances ----------
  const hub = { x: laydown.x + laydown.w / 2, y: laydown.y + laydown.h / 2 }
  let trenchM = 0
  for (const b of blocks) {
    const bu = units.filter((u) => u.block === b.id)
    const byRow = new Map<number, number[]>()
    bu.forEach((u) => byRow.set(u.row, [...(byRow.get(u.row) ?? []), u.x]))
    for (const xs of byRow.values()) trenchM += Math.max(...xs) - Math.min(...xs) + SX
    trenchM += b.h // spine along the block
    trenchM += Math.abs(b.x + b.w / 2 - office.x) + Math.abs(b.y + b.h / 2 - office.y) // feeder to the office
  }
  const meanHaulM = units.length ? (units.reduce((t, u) => t + Math.hypot(u.x - hub.x, u.y - hub.y), 0) / units.length) * 1.2 : 0

  // ---------- relays ----------
  const gateway = { x: office.x + 20, y: office.y + 20 }
  const { relays, uncovered } = planRelays(units, [center(office), center(laydown)], gateway, ctx, nw, se)
  if (uncovered > 0) warnings.push(`${uncovered} work location(s) could only be covered by one relay; the mapped ground ran out for a second.`)

  // ---------- fleet & crew ----------
  const fleetPlan = sizeFleet(units.length, trenchM, meanHaulM, crewSize, A)
  warnings.push(...fleetPlan.warnings)

  const loraGateways = Math.max(1, Math.ceil(relays.length / 2))
  const N = units.length
  const fleet: FleetItem[] = [
    {
      key: 'pile',
      name: 'Pile-driving robot',
      kind: 'robot',
      count: fleetPlan.c.pile,
      why: `${N} units × ${A.pilesPerUnit} piles = ${N * A.pilesPerUnit} piles at ${A.pileRobotPilesPerDay} per robot per day.`,
    },
    {
      key: 'crane',
      name: 'Crane',
      kind: 'machine',
      count: fleetPlan.c.crane,
      why: `Sets about ${A.craneUnitsPerDay} units a day each, matched to the piling rate.`,
    },
    {
      key: 'telehandler',
      name: 'Telehandler',
      kind: 'machine',
      count: fleetPlan.c.crane * fleetPlan.thPerCrane,
      why: `Average haul ${Math.round(meanHaulM)} m from the laydown yard, so each crane needs ${fleetPlan.thPerCrane} to keep it fed.`,
    },
    {
      key: 'trencher',
      name: 'Trencher',
      kind: 'machine',
      count: fleetPlan.c.trench,
      why: `${(trenchM / 1000).toFixed(1)} km of cable trench at ${A.trencherMPerDay} m per trencher per day.`,
    },
    { key: 'drone', name: 'Survey drone', kind: 'drone', count: 1, why: 'Daily progress surveys; reused from the survey fleet.' },
    {
      key: 'relay',
      name: 'Solar relay mast',
      kind: 'network',
      count: relays.length,
      why: `Every unit within ${ASSET_RANGE_M} m of at least ${REDUNDANCY} relays; ${relays.filter((r) => r.linkOnly).length} extra to chain far relays back to the gateway (hops ≤ ${RELAY_RANGE_M} m).`,
    },
    { key: 'loraGateway', name: 'LoRa gateway', kind: 'network', count: loraGateways, why: 'On every other relay mast, for worker tags.' },
    { key: 'tag', name: 'Worker tag (LoRa + UWB)', kind: 'wearable', count: fleetPlan.crewUsed, why: 'One per person on site, for position and proximity stops.' },
  ]

  const bounds = boundsOf([...units.map((u) => ({ x: u.x, y: u.y })), ...relays, ...corners(office), ...corners(laydown)], 140)

  return {
    input: { unitCount, crewSize },
    createdAt: Date.now(),
    units,
    blocks,
    relays,
    gateway,
    office,
    laydown,
    trenchM,
    meanHaulM,
    fleet,
    crew: fleetPlan.crew,
    crewUsed: fleetPlan.crewUsed,
    stages: fleetPlan.stages,
    totalDays: fleetPlan.totalDays,
    bottleneck: fleetPlan.bottleneck,
    warnings,
    buildableSlots: slots.length,
    bounds,
    ground,
    terrain: { cols, rows, cellM },
  }
}

// ---------- relays ----------

function planRelays(units: PlannedUnit[], extra: Pt[], gateway: Pt, ctx: PlannerContext, nw: Pt, se: Pt) {
  const targets: Pt[] = [...units.map((u) => ({ x: u.x, y: u.y })), ...extra]
  const R2 = ASSET_RANGE_M ** 2
  const need = targets.map((t) => Math.max(0, REDUNDANCY - (d2(t, gateway) <= R2 ? 1 : 0)))

  // Candidate mast sites: a grid over mapped ground, not on top of a unit.
  const unitHash = new Map<string, PlannedUnit[]>()
  const hkey = (x: number, y: number) => `${Math.floor(x / 50)},${Math.floor(y / 50)}`
  for (const u of units) unitHash.set(hkey(u.x, u.y), [...(unitHash.get(hkey(u.x, u.y)) ?? []), u])
  const nearUnit = (p: Pt) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const u of unitHash.get(`${Math.floor(p.x / 50) + dx},${Math.floor(p.y / 50) + dy}`) ?? []) {
        if (Math.abs(u.x - p.x) < UNIT_HALF_W + 8 && Math.abs(u.y - p.y) < UNIT_HALF_H + 8) return true
      }
    }
    return false
  }
  const candidates: { p: Pt; cover: number[] }[] = []
  for (let y = nw.y; y <= se.y; y += RELAY_GRID_M) {
    for (let x = nw.x; x <= se.x; x += RELAY_GRID_M) {
      const c = Math.floor(x / ctx.cellM)
      const r = Math.floor(y / ctx.cellM)
      if (c < 0 || r < 0 || c >= ctx.cols || r >= ctx.rows || !ctx.coverage[r * ctx.cols + c]) continue
      const p = { x, y }
      if (nearUnit(p) || d2(p, gateway) < 60 ** 2) continue
      const cover: number[] = []
      targets.forEach((t, i) => d2(t, p) <= R2 && cover.push(i))
      if (cover.length) candidates.push({ p, cover })
    }
  }

  // Greedy multi-cover: keep adding the mast that serves the most still-under-covered targets.
  const picked: Pt[] = []
  for (;;) {
    let best = -1
    let bestGain = 0
    candidates.forEach((cand, i) => {
      let g = 0
      for (const t of cand.cover) if (need[t] > 0) g++
      if (g > bestGain) { bestGain = g; best = i }
    })
    if (best < 0) break
    const cand = candidates.splice(best, 1)[0]
    picked.push(cand.p)
    for (const t of cand.cover) if (need[t] > 0) need[t]--
  }
  const uncovered = need.filter((n) => n > 0).length

  // Chain every mast back to the gateway within mesh range, adding link-only masts where needed.
  const link = RELAY_RANGE_M * 0.92
  const linkOnly = new Set<Pt>()
  const all: Pt[] = [...picked]
  for (let guard = 0; guard < 200; guard++) {
    const connected = reachable(gateway, all, link)
    const loose = all.filter((p) => !connected.has(p))
    if (!loose.length) break
    let bestPair: [Pt, Pt] | null = null
    let bestD = Infinity
    for (const u of loose) {
      for (const c of [gateway, ...all.filter((p) => connected.has(p))]) {
        const d = Math.sqrt(d2(u, c))
        if (d < bestD) { bestD = d; bestPair = [c, u] }
      }
    }
    const [from, to] = bestPair!
    const steps = Math.ceil(bestD / (link * 0.95))
    for (let k = 1; k < steps; k++) {
      const p = { x: from.x + ((to.x - from.x) * k) / steps, y: from.y + ((to.y - from.y) * k) / steps }
      all.push(p)
      linkOnly.add(p)
    }
    if (steps <= 1) break // already within range; nothing more to do
  }

  const relays: PlannedRelay[] = all
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((p, i) => ({
      id: `M-${i + 1}`,
      x: Math.round(p.x),
      y: Math.round(p.y),
      covers: units.filter((u) => d2(u, p) <= R2).length,
      linkOnly: linkOnly.has(p),
    }))
  return { relays, uncovered }
}

function reachable(gateway: Pt, nodes: Pt[], range: number) {
  const r2 = range * range
  const seen = new Set<Pt>()
  const queue: Pt[] = [gateway]
  while (queue.length) {
    const cur = queue.shift()!
    for (const n of nodes) {
      if (!seen.has(n) && d2(cur, n) <= r2) {
        seen.add(n)
        queue.push(n)
      }
    }
  }
  return seen
}

// ---------- fleet sizing ----------

interface Counts { pile: number; crane: number; trench: number; elec: number }

function sizeFleet(N: number, trenchM: number, meanHaulM: number, crewSize: number, A: Assumptions) {
  const warnings: string[] = []
  // Telehandlers per crane: units/day one telehandler can deliver over the average haul.
  const metersPerMin = (A.telehandlerSpeedKmh * 1000) / 60
  const cycleMin = A.telehandlerLoadMin + A.telehandlerHandoffMin + (2 * meanHaulM) / metersPerMin
  const thUnitsPerDay = A.shiftMinutes / cycleMin
  const thPerCrane = Math.max(1, Math.ceil(A.craneUnitsPerDay / thUnitsPerDay))

  const field = (c: Counts) =>
    c.pile * A.pileRobotCrew + c.crane * (A.craneCrew + thPerCrane * A.telehandlerCrew) + c.trench * A.trencherCrew + c.elec * A.electricalCrew + 1 // + drone pilot
  const supervisors = (f: number) => ({ foremen: Math.max(1, Math.ceil(f / A.workersPerForeman)), safety: Math.max(1, Math.ceil(f / A.workersPerSafetyLead)) })
  const total = (c: Counts) => {
    const f = field(c)
    const s = supervisors(f)
    return f + s.foremen + s.safety
  }
  const stageDays = (c: Counts): Record<StageEstimate['stage'], number> => ({
    Piling: N ? (N * A.pilesPerUnit) / (c.pile * A.pileRobotPilesPerDay) : 0,
    'Setting units': N ? N / (c.crane * A.craneUnitsPerDay) : 0,
    Trenching: trenchM ? trenchM / (c.trench * A.trencherMPerDay) : 0,
    Electrical: N ? N / (c.elec * A.electricalUnitsPerDay) : 0,
  })
  const keyOf: Record<StageEstimate['stage'], keyof Counts> = { Piling: 'pile', 'Setting units': 'crane', Trenching: 'trench', Electrical: 'elec' }

  const c: Counts = { pile: 1, crane: 1, trench: 1, elec: 1 }
  const minimum = total(c)
  if (minimum > crewSize) {
    warnings.push(`One crew of each kind needs ${minimum} people; you entered ${crewSize}. The plan uses the minimum of ${minimum}.`)
  }
  let blockedBy = ''
  for (let guard = 0; guard < 400; guard++) {
    const days = stageDays(c)
    const stage = (Object.keys(days) as StageEstimate['stage'][]).reduce((a, b) => (days[b] > days[a] ? b : a))
    const k = keyOf[stage]
    const next = { ...c, [k]: c[k] + 1 }
    const saved = days[stage] - stageDays(next)[stage]
    if (saved < 0.25) { blockedBy = `another ${stageNoun(stage)} would save less than a quarter day`; break }
    if (total(next) > Math.max(crewSize, minimum)) { blockedBy = `another ${stageNoun(stage)} needs ${total(next) - total(c)} more people`; break }
    c[k]++
  }

  const days = stageDays(c)
  const bottleneck = (Object.keys(days) as StageEstimate['stage'][]).reduce((a, b) => (days[b] > days[a] ? b : a))
  const crewUsed = total(c)
  const f = field(c)
  const sup = supervisors(f)
  if (crewSize > crewUsed) warnings.push(`${crewSize - crewUsed} of your ${crewSize} people aren't needed: ${blockedBy}.`)

  const stages: StageEstimate[] = [
    { stage: 'Piling', days: days.Piling, detail: `${c.pile} pile-driving robot${c.pile > 1 ? 's' : ''}` },
    { stage: 'Setting units', days: days['Setting units'], detail: `${c.crane} crane${c.crane > 1 ? 's' : ''} with ${c.crane * thPerCrane} telehandler${c.crane * thPerCrane > 1 ? 's' : ''}` },
    { stage: 'Trenching', days: days.Trenching, detail: `${c.trench} trencher${c.trench > 1 ? 's' : ''}` },
    { stage: 'Electrical', days: days.Electrical, detail: `${c.elec} electrical crew${c.elec > 1 ? 's' : ''}` },
  ]
  // Stages overlap: setting follows piling by about a day, so total ≈ slowest stage + 1 day.
  const totalDays = N ? Math.ceil((Math.max(...Object.values(days)) + 1) * 2) / 2 : 0

  const crew: CrewRole[] = [
    { role: 'Robot operator', count: c.pile, with: 'pile-driving robots' },
    { role: 'Pile loader', count: c.pile * (A.pileRobotCrew - 1), with: 'pile-driving robots' },
    { role: 'Crane operator', count: c.crane, with: 'cranes' },
    { role: 'Rigger', count: c.crane * 2, with: 'cranes' },
    { role: 'Signal person', count: c.crane * (A.craneCrew - 3), with: 'cranes' },
    { role: 'Telehandler operator', count: c.crane * thPerCrane * A.telehandlerCrew, with: 'telehandlers' },
    { role: 'Trencher operator', count: c.trench, with: 'trenchers' },
    { role: 'Trench laborer', count: c.trench * (A.trencherCrew - 1), with: 'trenchers' },
    { role: 'Electrician', count: c.elec * A.electricalCrew, with: 'connecting and commissioning units' },
    { role: 'Drone pilot', count: 1, with: 'progress surveys' },
    { role: 'Foreman', count: sup.foremen, with: `one per ${A.workersPerForeman} workers` },
    { role: 'Safety lead', count: sup.safety, with: 'site safety' },
  ].filter((r) => r.count > 0)

  return { c, thPerCrane, crew, crewUsed, stages, totalDays, bottleneck, warnings }
}

function stageNoun(s: StageEstimate['stage']) {
  return { Piling: 'pile-driving robot', 'Setting units': 'crane crew', Trenching: 'trencher', Electrical: 'electrical crew' }[s]
}

// ---------- helpers ----------

function slopeGrid(ctx: PlannerContext) {
  const { cols, rows, cellM, heights, coverage } = ctx
  const out = new Float32Array(cols * rows).fill(Infinity)
  const h = (c: number, r: number, fallback: number) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return fallback
    const i = r * cols + c
    return coverage[i] ? heights[i] : fallback
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (!coverage[i]) continue
      const z = heights[i]
      const dzdx = (h(c + 1, r, z) - h(c - 1, r, z)) / (2 * cellM)
      const dzdy = (h(c, r + 1, z) - h(c, r - 1, z)) / (2 * cellM)
      out[i] = 100 * Math.hypot(dzdx, dzdy)
    }
  }
  return out
}

function inRect(x: number, y: number, r: Rect, pad = 0) {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad
}

function center(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

function corners(r: Rect): Pt[] {
  return [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }]
}

function boundsOf(pts: Pt[], pad: number): Rect {
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x0 = Math.min(...xs) - pad
  const y0 = Math.min(...ys) - pad
  const w = Math.max(800, Math.max(...xs) - Math.min(...xs) + 2 * pad)
  const h = Math.max(600, Math.max(...ys) - Math.min(...ys) + 2 * pad)
  return { x: x0, y: y0, w, h }
}

function d2(a: Pt, b: Pt) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function blockLabel(n: number) {
  let s = ''
  let k = n
  do {
    s = String.fromCharCode(65 + (k % 26)) + s
    k = Math.floor(k / 26) - 1
  } while (k >= 0)
  return s
}
