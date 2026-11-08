// Behaviour tests against the mesh specification. Each test builds the small fixture site and
// runs it in simulation time.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AuctionBook, beats, utility } from '../src/cbaa.js'
import { DedupMemory, ReplayWindow } from '../src/nodes/base.js'
import { Simulation } from '../src/index.js'
import type { Header, ItemEntry, MeshTrace } from '../src/types.js'
import { Cmd, ItemState, Liveness, MsgClass, MsgType, NodeKind, RobotMode, StopReason, TrackKind, ZoneKind } from '../src/types.js'
import { fixture } from './fixture.js'

const sim = (o: Parameters<typeof fixture>[0] = {}) => {
  const s = new Simulation(fixture(o))
  s.boot()
  return s
}
const robot = (s: Simulation, name: string) => [...s.robots.values()].find((r) => r.name === name)!
const hubNode = (s: Simulation, name: string) => s.snapshot().nodes.find((n) => n.name === name)!

// ---------- units ----------

test('duplicate memory forgets IDs after 10 s and evicts the oldest when full (5.3)', () => {
  const d = new DedupMemory(10_000, 3)
  d.insert('a', 0)
  assert.ok(d.has('a', 9_999))
  assert.ok(!d.has('a', 10_001))
  d.insert('b', 1)
  d.insert('c', 2)
  d.insert('d', 3)
  d.insert('e', 4)
  assert.ok(!d.has('b', 5) && d.has('e', 5))
})

test('replay window drops old boots, far-behind and repeated sequence numbers (5.3)', () => {
  const w = new ReplayWindow()
  const h = (boot: number, seq: number) => ({ src: 'X', boot, seq }) as Header
  assert.equal(w.checkAndRecord(h(2, 500)), false)
  assert.equal(w.checkAndRecord(h(2, 500)), true, 'same seq twice')
  assert.equal(w.checkAndRecord(h(2, 300)), true, 'more than 128 below')
  assert.equal(w.checkAndRecord(h(2, 450)), false, 'inside the window')
  assert.equal(w.checkAndRecord(h(1, 900)), true, 'lower boot')
  assert.equal(w.checkAndRecord(h(3, 0)), false, 'higher boot resets')
})

test('CBAA ordering: final beats all, then gen, then STARTED, then bid, then lower node (9.3)', () => {
  const e = (o: Partial<ItemEntry>): ItemEntry => ({ taskId: 1, itemId: 1, gen: 0, winBid: 0, winNode: null, state: ItemState.OPEN, ...o })
  assert.ok(beats(e({ state: ItemState.DONE }), e({ gen: 5, state: ItemState.STARTED })))
  assert.ok(beats(e({ gen: 2 }), e({ gen: 1, state: ItemState.STARTED, winBid: 9 })))
  assert.ok(beats(e({ state: ItemState.STARTED, winBid: 1, winNode: 'B' }), e({ state: ItemState.ASSIGNED, winBid: 9, winNode: 'A' })))
  assert.ok(beats(e({ state: ItemState.ASSIGNED, winBid: 9, winNode: 'B' }), e({ state: ItemState.ASSIGNED, winBid: 5, winNode: 'A' })))
  assert.ok(beats(e({ state: ItemState.ASSIGNED, winBid: 5, winNode: 'A' }), e({ state: ItemState.ASSIGNED, winBid: 5, winNode: 'B' })))
})

test('utility is integer, prefers closer items and higher task priority (9.5)', () => {
  const bid = { weights: { travel: 45, work: 30, energy: 15, risk: 10 }, travelCapS: 600, workCapS: 3600 }
  const r = { pos: { x: 0, y: 0 }, maxSpeed: 150, workRatePct: 100, drainPctPerHour: 20, batteryPct: 80, health: 0 as const, posSource: 0 as const }
  const t = { taskId: 1, revision: 1, mode: 'autonomous' as const, tag: 1, robotCount: 1, priority: 3, minBattery: 15, areaCenter: { x: 0, y: 0 }, localRadiusM: 0, zoneId: 0, requiresSignoff: false, items: [] }
  const near = utility(r, t, { itemId: 1, pos: { x: 100, y: 0 }, estDurationS: 60, exclusive: false }, false, bid)
  const far = utility(r, t, { itemId: 2, pos: { x: 3000, y: 0 }, estDurationS: 60, exclusive: false }, false, bid)
  assert.ok(Number.isInteger(near) && near > far)
  const urgent = utility(r, { ...t, priority: 4 }, { itemId: 2, pos: { x: 3000, y: 0 }, estDurationS: 60, exclusive: false }, false, bid)
  assert.ok(urgent > near, 'a priority level outweighs the whole cost range')
})

test('slot rule caps active items at robot_count (9.7)', () => {
  const b = new AuctionBook()
  b.addTask({ taskId: 1, revision: 1, mode: 'autonomous', tag: 1, robotCount: 1, priority: 1, minBattery: 0, areaCenter: { x: 0, y: 0 }, localRadiusM: 0, zoneId: 0, requiresSignoff: false, items: [1, 2].map((i) => ({ itemId: i, pos: { x: 0, y: 0 }, estDurationS: 1, exclusive: false })), slice: 0, slices: 1 }, 0)
  b.set({ taskId: 1, itemId: 1, gen: 0, winBid: 10, winNode: 'A', state: ItemState.ASSIGNED }, 0)
  const t = b.tasks.get(1)!.task
  assert.equal(b.slotRuleAllows(t, 2, 5), false)
  assert.equal(b.slotRuleAllows(t, 2, 11), true)
  b.set({ taskId: 1, itemId: 2, gen: 0, winBid: 11, winNode: 'B', state: ItemState.ASSIGNED }, 0)
  b.enforceSlotCap(0)
  assert.equal(b.get(1, 1)!.state, ItemState.OPEN, 'weakest goes back to OPEN')
})

// ---------- transport ----------

test('flooding: each relay forwards a message at most once, plus at most one repair (5.1, 5.10)', () => {
  const s = sim()
  const tx = new Map<string, number>()
  s.onTrace((t: MeshTrace) => {
    if (t.result === 'tx' || t.result === 'repair_tx') tx.set(`${t.msgId}|${t.from}`, (tx.get(`${t.msgId}|${t.from}`) ?? 0) + 1)
  })
  s.advance(20_000)
  assert.ok(tx.size > 1000)
  for (const n of tx.values()) assert.ok(n <= 2)
})

test('the hub processes every radio packet once even though both gateways copy it (5.5)', () => {
  const s = sim()
  s.advance(15_000)
  const rpd = robot(s, 'RPD-1')
  let processed = 0
  s.hub.onEvent((e) => {
    if (e.kind === 'packet' && e.h.src === rpd.id && e.h.type === MsgType.SAFETY_STOP) processed++
  })
  rpd.stop(StopReason.SUPERVISOR_STOP, 0)
  s.advance(3000)
  assert.equal(processed, 1)
})

test('relays drop packets with a class not allowed for their type (4.4, 5.1)', () => {
  const s = sim()
  s.advance(5000)
  const relay = [...s.relays.values()][2]
  const before = relay.counters.malformed
  const pkt = { h: { version: 1 as const, type: MsgType.ROBOT_STATE, cls: MsgClass.SAFETY, flags: 0, initialHops: 8, hopsLeft: 8, srcKind: NodeKind.ROBOT, src: 'X', dst: 'FF:FF:FF:FF:FF:FF', boot: 1, seq: 1, gpsTime: 0 }, p: {} }
  relay.receive(pkt, 'X', -60, 'radio')
  assert.equal(relay.counters.malformed, before + 1)
})

// ---------- contact, coverage, liveness ----------

test('a robot with no path to the mesh for 1.5 s stops and needs a RESUME after contact returns (6.3, 10.3)', async () => {
  const s = sim()
  s.advance(15_000)
  const r = robot(s, 'RPD-1')
  r.radioWorks = false
  s.advance(1300)
  assert.notEqual(r.mode, RobotMode.STOPPED, 'not before the timeout')
  s.advance(2000) // depth 0 holds for 1.5 s after the last relay beacon, then 1.5 s with no path
  assert.equal(r.mode, RobotMode.STOPPED)
  assert.equal(r.stopReason, StopReason.LOST_MESH_CONTACT)
  // Remote resume while still out of contact: rejected.
  let res = s.command(s.input.buildManager, Cmd.RESUME, r.id, { stopId: r.stopId })
  s.advance(7000)
  assert.equal(await res, null, 'no answer from a robot with a dead radio')
  r.radioWorks = true
  s.advance(3000)
  res = s.command(s.input.buildManager, Cmd.RESUME, r.id, { stopId: r.stopId })
  s.advance(3000)
  assert.equal((await res)?.result, 0)
  assert.notEqual(r.mode, RobotMode.STOPPED)
})

test('a robot just outside relay coverage reaches the mesh through a neighbor robot (depth 1) (6.3, 6.4)', () => {
  const s = sim({ robots: 2 })
  s.advance(10_000)
  const a = robot(s, 'RPD-1')
  const b = robot(s, 'RPD-2')
  // Move them past the eastern edge: b inside coverage, a 2 m beyond it but within robot radio range of b.
  const east = [...s.relays.values()].reduce((m, r) => (r.pos().x > m.pos().x ? r : m))
  const edge = east.pos().x + 3000
  ;(b as unknown as { position: { x: number; y: number } }).position = { x: edge - 400, y: east.pos().y }
  ;(a as unknown as { position: { x: number; y: number } }).position = { x: edge + 20, y: east.pos().y }
  s.advance(4000)
  assert.equal(a.depth, 1)
  assert.equal(a.via, b.id)
  assert.notEqual(a.stopReason, StopReason.OUT_OF_COVERAGE)
  // More than 3 m outside: stop OUT_OF_COVERAGE.
  ;(a as unknown as { position: { x: number; y: number } }).position = { x: edge + 60, y: east.pos().y }
  s.advance(500)
  assert.equal(a.mode, RobotMode.STOPPED)
  assert.equal(a.stopReason, StopReason.OUT_OF_COVERAGE)
})

test('a relay that dies is LOST after 15 s and grouped with the robots that were only reachable through it (7.3)', () => {
  const s = sim({ robots: 1 })
  s.advance(10_000)
  const r = robot(s, 'RPD-1')
  const far = [...s.relays.values()].find((x) => x.name === 'M-6')! // the outlying relay
  ;(r as unknown as { position: { x: number; y: number } }).position = { x: far.pos().x + 1500, y: far.pos().y }
  s.advance(6000)
  assert.equal(r.via, far.id)
  const groups: { cause: number; causeNode: string | null; nodes: string[] }[] = []
  s.onEvent((e) => e.kind === 'node_lost' && groups.push(e))
  far.powerOff()
  s.advance(20_000)
  const g = groups.find((x) => x.cause === 1)
  assert.ok(g, 'a RELAY_DOWN group')
  assert.equal(g!.causeNode, far.id)
  assert.ok(g!.nodes.includes(r.id) && g!.nodes.includes(far.id))
  assert.equal(hubNode(s, 'M-6').liveness, Liveness.LOST)
})

// ---------- task allocation ----------

test('CBAA: robots agree, each item gets one robot, no duplicate starts (9.7)', () => {
  const s = sim()
  const starts = new Map<string, Set<string>>()
  s.hub.onEvent((e) => {
    if (e.kind === 'item' && e.entry.state === ItemState.STARTED) {
      const k = `${e.entry.taskId}/${e.entry.itemId}/${e.entry.gen}`
      starts.set(k, (starts.get(k) ?? new Set()).add(e.entry.winNode!))
    }
  })
  s.advance(150_000)
  assert.ok(starts.size >= 3)
  for (const [k, w] of starts) assert.equal(w.size, 1, `item ${k} started by ${[...w].join(', ')}`)
  // Every robot's view of task 100 matches the hub's for items already decided.
  const hubView = s.hub.book.tasks.get(100)!
  for (const r of s.robots.values()) {
    if (r.tag !== 1) continue
    const mine = r.book.tasks.get(100)!
    for (const [id, e] of hubView.items) if (e.state === ItemState.DONE) assert.equal(mine.items.get(id)!.state, ItemState.DONE)
  }
})

test('an item whose owner goes silent is released after 5 s, or HELD if exclusive and started (9.9)', () => {
  const s = sim()
  s.advance(60_000)
  const owner = [...s.robots.values()].find((r) => r.holding && r.book.get(r.holding.taskId, r.holding.itemId)?.state === ItemState.STARTED)
  assert.ok(owner, 'someone is working')
  const { taskId, itemId } = owner!.holding!
  owner!.powerOff()
  s.advance(8000)
  const e = s.hub.book.get(taskId, itemId)!
  assert.equal(e.state, ItemState.HELD, 'fixture items are exclusive')
  // A supervisor releases it.
  void s.command(s.input.buildManager, Cmd.RELEASE_ITEM, null, { taskId, itemId })
  s.advance(1000)
  assert.equal(s.hub.book.get(taskId, itemId)!.state, ItemState.OPEN)
})

// ---------- safety ----------

test('a robot holds for a crew member and the hold clears itself (8.7)', () => {
  const s = sim()
  s.advance(40_000)
  const r = robot(s, 'RPD-1')
  const crew = [...s.world.people.values()].find((p) => p.kind === 'crew')!
  // Everyone else well away from the robot, and the crew member standing next to it.
  const park = (who: typeof crew, dx: number) => {
    who.errand = undefined
    who.group = 'office'
    who.pos = { x: s.input.world.office.x + dx, y: s.input.world.office.y - 2000 }
    who.target = who.pos
  }
  let k = 0
  for (const p of s.world.people.values()) if (p !== crew) park(p, 3000 + 100 * k++)
  const at = r.pos()
  crew.group = r.id
  crew.offset = { x: 30, y: 0 }
  crew.pos = { x: at.x + 30, y: at.y }
  let held = false
  for (let i = 0; i < 20 && !held; i++) {
    s.advance(500)
    held = r.mode === RobotMode.HOLD && r.stopReason === StopReason.CREW_HOLD
  }
  assert.ok(held, 'robot held for the crew member')
  park(crew, 2500)
  s.advance(9000)
  assert.notEqual(r.mode, RobotMode.HOLD, 'hold cleared without a supervisor')
})

test('remote RESUME of an on-site stop is refused; the LOCAL_LINK resume from a tablet works (10.3)', async () => {
  const s = sim()
  s.advance(15_000)
  const r = robot(s, 'RPD-1')
  r.stop(StopReason.NEAR_MISS, 0)
  s.advance(1000)
  const remote = s.command(s.input.buildManager, Cmd.RESUME, r.id, { stopId: r.stopId })
  s.advance(3000)
  const res = await remote
  assert.equal(res?.result, 1)
  assert.equal(res?.reason, 3, 'not on site')
  const foreman = [...s.supervisors.values()].find((x) => x.name.startsWith('Foreman'))!
  const local = foreman.localCommand(r.id, Cmd.RESUME, { stopId: r.stopId })
  s.advance(500)
  assert.equal((await local)?.result, 0)
  assert.notEqual(r.mode, RobotMode.STOPPED)
})

test('a zone added from the twin stops a robot inside it (8.6, 8.7, 12.3)', async () => {
  const s = sim()
  s.advance(15_000)
  const r = robot(s, 'RPD-2')
  const res = s.command(s.input.buildManager, Cmd.ZONE_ADD, null, { zone: { kind: ZoneKind.NO_GO, appliesTo: { robots: true, crew: false }, shape: { circle: { center: r.pos(), radius: 50 } }, buffer: 10, slowBand: 30, until: 0 } })
  assert.equal((await res)?.result, 0)
  s.advance(3000)
  assert.equal(r.mode, RobotMode.STOPPED)
  assert.equal(r.stopReason, StopReason.ZONE_BREACH)
})

test('alerts go to the nearest supervisor and escalate when not acknowledged (10.1)', () => {
  const s = sim()
  s.advance(15_000)
  for (const sup of s.supervisors.values()) sup.autoRespond = false
  const a = s.hub.raiseAlert(9, s.input.world.office, [], 0, 0, 0) // DUPLICATE_START, warning: 120 s
  assert.equal(a.notified.length, 1)
  s.advance(121_000)
  assert.equal(a.notified.length, 2)
  s.advance(121_000)
  assert.equal(a.notified.length, 3)
})

test('with the hub down, robots keep working, use their own crew fix and slow down (8.5, 11)', () => {
  const s = sim()
  s.advance(40_000)
  s.inject('hub_down')
  const before = [...s.robots.values()].map((r) => r.book.tasks.get(100)?.items.size ?? 0)
  s.advance(8000)
  const r = [...s.robots.values()].find((x) => x.tag === 1)!
  assert.ok((r.state().flags & 8) !== 0, 'tracks stale flag')
  if (r.mode === RobotMode.TO_ITEM) assert.ok(r.speed <= 50)
  const doneBefore = r.book.tasks.get(100) ? [...r.book.tasks.get(100)!.items.values()].filter((e) => e.state === ItemState.DONE).length : 0
  s.advance(300_000) // at 0.5 m/s it takes a while to reach the first items
  const doneAfter = [...r.book.tasks.get(100)!.items.values()].filter((e) => e.state === ItemState.DONE).length
  assert.ok(before.every((n) => n > 0), 'robots still know the task')
  assert.ok(doneAfter > doneBefore, `work continued without the hub (${doneBefore} -> ${doneAfter})`)
})

test('manual machines and crew appear as tracks from UWB fusion (8.5)', () => {
  const s = sim()
  s.advance(20_000)
  const tracks = s.snapshot().tracks.list
  assert.ok(tracks.some((t) => t.kind === TrackKind.MACHINE))
  assert.ok(tracks.filter((t) => t.kind === TrackKind.CREW || t.kind === TrackKind.SUPERVISOR).length >= 4)
  for (const t of tracks.filter((x) => x.kind === TrackKind.CREW && !x.stale)) {
    const truth = s.world.people.get(t.id)!.pos
    assert.ok(Math.hypot(truth.x - t.pos.x, truth.y - t.pos.y) < 20 + t.acc / 10, `crew ${t.id} within its stated accuracy + 2 m`)
  }
})
