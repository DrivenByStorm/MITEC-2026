// A small synthetic site for tests: office at the benchmark, two gateways, a ring of relays,
// two blocks of units, pile robots, a survey bot, supervisors, crew and manual machines.

import type { PlannedTask, SimInput } from '../src/index.js'
import type { Pos, SiteConfig } from '../src/types.js'

const mac = (a: number, b: number) => `02:00:00:00:${a.toString(16).padStart(2, '0')}:${b.toString(16).padStart(2, '0')}`

export function fixture(opts: { robots?: number; scenario?: 'demo' | 'quiet'; relaySpacingM?: number } = {}): SimInput {
  const nRobots = opts.robots ?? 3
  const office: Pos = { x: 0, y: 0 }
  const relays: SiteConfig['relays'] = [
    { node: mac(0, 0x10), name: 'GW-1', pos: { x: 100, y: 100 }, uwbAnchor: true, coverageRadiusM: 300, gateway: true },
    { node: mac(0, 0x11), name: 'GW-2', pos: { x: -100, y: 100 }, uwbAnchor: true, coverageRadiusM: 300, gateway: true },
  ]
  const sp = (opts.relaySpacingM ?? 220) * 10
  let k = 1
  for (const [x, y] of [[sp, 0], [sp, -sp], [0, -sp], [-sp, -sp], [-sp, 0], [sp * 2, -sp / 2]]) relays.push({ node: mac(1, k), name: `M-${k++}`, pos: { x, y }, uwbAnchor: true, coverageRadiusM: 300 })
  const anchors: SiteConfig['anchors'] = []
  let a = 1
  for (let x = -1500; x <= 3500; x += 1000) for (let y = -3500; y <= 500; y += 1000) anchors.push({ node: mac(2, a), name: `A-${a++}`, pos: { x, y } })
  const robots: SiteConfig['robots'] = []
  for (let i = 1; i <= nRobots; i++) robots.push({ node: mac(3, i), name: `RPD-${i}`, tag: 1, footprintDm: 15, maxSpeedCms: 150, drainPctPerHour: 20, workRatePct: 100 })
  robots.push({ node: mac(3, 0x20), name: 'SB-1', tag: 2, footprintDm: 8, maxSpeedCms: 200, drainPctPerHour: 15, workRatePct: 100 })
  const supervisors = [
    { node: mac(4, 1), badge: 5001, name: 'Build manager' },
    { node: mac(4, 2), badge: 5002, name: 'Foreman J. Ortiz' },
    { node: mac(4, 3), badge: 5003, name: 'Safety lead K. Begay' },
  ]
  const badges: SiteConfig['badges'] = [
    ...supervisors.map((s) => ({ badge: s.badge, kind: 'supervisor' as const, name: s.name })),
    { badge: 6001, kind: 'crew', name: 'A. Reyes' },
    { badge: 6002, kind: 'crew', name: 'H. Okafor' },
    { badge: 6003, kind: 'crew', name: 'P. Castillo' },
    { badge: 6004, kind: 'crew', name: 'M. Morales' },
    { badge: 7001, kind: 'machine', name: 'Crane CR-1', radiusDm: 60 },
    { badge: 7002, kind: 'machine', name: 'Telehandler TH-1', radiusDm: 30 },
  ]
  // Units: two blocks south-east of the office.
  const units: { id: string; block: string; pos: Pos }[] = []
  for (const [bi, block] of ['A', 'B'].entries()) for (let r = 0; r < 3; r++) for (let s = 0; s < 6; s++) units.push({ id: `${block}-${String(r + 1).padStart(2, '0')}-${String(s + 1).padStart(2, '0')}`, block, pos: { x: 400 + bi * 1300 + s * 180, y: -900 - r * 320 } })
  const hazard: Pos[] = [{ x: -1600, y: -2600 }, { x: -1000, y: -2600 }, { x: -1000, y: -2100 }, { x: -1600, y: -2100 }]
  const config: SiteConfig = {
    siteId: 'TEST',
    benchmark: { lat: 30.79, lon: -103.03, altM: 900, gridRotationDeg: 0 },
    twinBenchmarkM: { x: 3000, y: 3000 },
    boundary: [{ x: -3000, y: 1000 }, { x: 4000, y: 1000 }, { x: 4000, y: -4500 }, { x: -3000, y: -4500 }],
    hub: mac(0, 1),
    gateways: [mac(0, 0x10), mac(0, 0x11)],
    coverageRadiusM: 300,
    hazards: [{ kind: 'steep', polygon: hazard }],
    relays,
    anchors,
    robots,
    bid: { weights: { travel: 45, work: 30, energy: 15, risk: 10 }, travelCapS: 600, workCapS: 3600 },
    supervisors,
    badges,
    tags: [{ tag: 1, name: 'Pile driver bot' }, { tag: 2, name: 'Survey bot' }],
    timers: {},
  }
  const tasks: PlannedTask[] = ['A', 'B'].map((block, i) => {
    const items = units.filter((u) => u.block === block)
    return {
      taskId: 100 + i,
      revision: 1,
      mode: 'autonomous',
      tag: 1,
      robotCount: nRobots,
      priority: 5 - i,
      minBattery: 15,
      areaCenter: items[7].pos,
      localRadiusM: 0,
      zoneId: 0,
      requiresSignoff: false,
      items: items.map((u, j) => ({ itemId: j + 1, pos: u.pos, estDurationS: 20, exclusive: true })),
      unitIds: Object.fromEntries(items.map((u, j) => [j + 1, u.id])),
      label: `Drive piles, block ${block}`,
    }
  })
  tasks.push({ ...tasks[0], taskId: 200, mode: 'manual', tag: 0, label: 'Set units, block A', after: [], unitIds: tasks[0].unitIds })
  tasks.push({ taskId: 300, revision: 1, mode: 'autonomous', tag: 2, robotCount: 1, priority: 3, minBattery: 15, areaCenter: units[7].pos, localRadiusM: 0, zoneId: 0, requiresSignoff: true, items: [1, 2, 3].map((r) => ({ itemId: r, pos: { x: 1000, y: -900 - (r - 1) * 320 }, estDurationS: 15, exclusive: false })), after: [100], label: 'As-built check, block A' })
  return {
    config,
    world: {
      units,
      office,
      laydown: { x: 1500, y: 300 },
      charger: { x: 1300, y: 250 },
      people: [
        { badge: 5001, kind: 'supervisor', name: 'Build manager', role: 'Build manager', group: 'office', onShift: true, supervisorNode: mac(4, 1) },
        { badge: 5002, kind: 'supervisor', name: 'Foreman J. Ortiz', role: 'Foreman', group: 'roam', onShift: true, supervisorNode: mac(4, 2) },
        { badge: 5003, kind: 'supervisor', name: 'Safety lead K. Begay', role: 'Safety lead', group: 'roam', onShift: true, supervisorNode: mac(4, 3) },
        { badge: 6001, kind: 'crew', name: 'A. Reyes', role: 'Pile loader', group: mac(3, 1), onShift: true },
        { badge: 6002, kind: 'crew', name: 'H. Okafor', role: 'Pile loader', group: mac(3, 2), onShift: true },
        { badge: 6003, kind: 'crew', name: 'P. Castillo', role: 'Rigger', group: 'CR-1', onShift: true },
        { badge: 6004, kind: 'crew', name: 'M. Morales', role: 'Electrician', group: 'electrical', onShift: true },
      ],
      machines: [
        { badge: 7001, id: 'CR-1', role: 'Crane', radiusDm: 60 },
        { badge: 7002, id: 'TH-1', role: 'Telehandler', radiusDm: 30, serves: 'CR-1' },
      ],
      hazards: [hazard],
      bounds: { min: { x: -500, y: -2000 }, max: { x: 3000, y: 0 } },
    },
    tasks,
    buildManager: mac(4, 1),
    options: { seed: 11, speed: 1, scenario: opts.scenario ?? 'quiet' },
  }
}
