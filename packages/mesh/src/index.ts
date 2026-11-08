// A whole simulated site: radio medium, every mesh node, the hub mesh service, the physical
// world and the planning software that feeds the hub tasks. Runs in simulation time, which a
// driver advances in real time at a chosen speed.

import { HubNode } from './hub/hub.js'
import type { NodeContext } from './nodes/base.js'
import { AnchorNode, SupervisorNode } from './nodes/endpoints.js'
import { RelayNode } from './nodes/relay.js'
import { RobotNode } from './nodes/robot.js'
import { Radio } from './sim/radio.js'
import { Scheduler, seededRandom } from './sim/scheduler.js'
import type { CmdResultP, MeshEvent, MeshSnapshot, MeshTrace, NodeId, Pos, SiteConfig, Task } from './types.js'
import { Cmd, ItemState, NodeKind, TrackKind } from './types.js'
import { World } from './world/world.js'
import type { WorldSpec } from './world/world.js'

export * from './types.js'
export { T, RADIO } from './constants.js'

export interface PlannedTask extends Task {
  /** Unit id for each item, so progress can be shown per unit. */
  unitIds?: Record<number, string>
  /** Publish only after these tasks are complete (planning order). */
  after?: number[]
  label?: string
}

export interface SimInput {
  config: SiteConfig
  world: WorldSpec
  tasks: PlannedTask[]
  /** Supervisor identity of the build manager using the twin. */
  buildManager: NodeId
  options?: { seed?: number; speed?: number; scenario?: 'demo' | 'quiet'; maxOpenTasks?: number }
}

export interface PlanningView {
  units: { id: string; status: 'planned' | 'piled' | 'installed' }[]
  tasks: { taskId: number; label: string; tag: number; mode: 'autonomous' | 'manual'; status: 'queued' | 'open' | 'complete' }[]
}

export interface SimStatus {
  simTime: number
  speed: number
  running: boolean
  hubUp: boolean
  txPerSec: number
  lossPerSec: number
  scenario: string
}

export type InjectKind = 'relay_down' | 'relay_up' | 'gateway_down' | 'hub_down' | 'hub_up' | 'rtk_degraded' | 'rtk_ok' | 'robot_fault' | 'robot_fault_clear' | 'robot_radio_off' | 'robot_radio_on' | 'stray_object' | 'crew_into_hazard' | 'crew_near_robot' | 'starlink_down' | 'starlink_up'

export class Simulation {
  readonly sched: Scheduler
  readonly radio: Radio
  readonly world: World
  readonly hub: HubNode
  readonly relays = new Map<NodeId, RelayNode>()
  readonly robots = new Map<NodeId, RobotNode>()
  readonly anchors = new Map<NodeId, AnchorNode>()
  readonly supervisors = new Map<NodeId, SupervisorNode>()
  readonly input: SimInput
  speed: number
  running = false
  private rand: () => number
  private queue: PlannedTask[]
  private published = new Set<number>()
  private completed = new Set<number>()
  private unitOf = new Map<string, string>() // "task/item" -> unit id
  private logLines: { at: number; who: string; text: string }[] = []
  private eventSinks = new Set<(e: MeshEvent) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTx = { t: 0, tx: 0, loss: 0, txPerSec: 0, lossPerSec: 0 }

  constructor(input: SimInput) {
    this.input = input
    const seed = input.options?.seed ?? 7
    this.speed = input.options?.speed ?? 1
    this.rand = seededRandom(seed)
    this.sched = new Scheduler()
    this.radio = new Radio(this.sched, this.rand)
    this.world = new World(input.world, this.rand)
    const ctx: NodeContext = { sched: this.sched, radio: this.radio, rand: this.rand, bootStore: new Map(), log: (who, text) => this.pushLog(who, text) }
    const cfg = input.config

    // Hub, wired to both gateways.
    this.hub = new HubNode(ctx, cfg)
    this.radio.add(this.hub)
    for (const r of cfg.relays) {
      const relay = new RelayNode(ctx, r.node, r.name, r.pos, { gateway: r.gateway, uwbAnchor: r.uwbAnchor, coverageRadiusM: r.coverageRadiusM, uwb: (p) => this.world.uwbRanges(p) })
      this.relays.set(r.node, relay)
      this.radio.add(relay)
      if (r.gateway) this.radio.wire(r.node, cfg.hub)
    }
    for (const a of cfg.anchors) {
      const anchor = new AnchorNode(ctx, a.node, a.name, a.pos, this.world)
      this.anchors.set(a.node, anchor)
      this.radio.add(anchor)
    }
    cfg.robots.forEach((r, i) => {
      const c = input.world.charger
      const pos: Pos = { x: c.x - 120 + (i % 6) * 50, y: c.y - 60 - Math.floor(i / 6) * 50 }
      const robot = new RobotNode(ctx, cfg, r, pos, this.world, {
        itemDone: (rb, taskId, itemId) => {
          const unit = this.unitOf.get(`${taskId}/${itemId}`)
          if (unit && rb.tag === 1) this.world.markPiled(unit)
        },
        log: (rb, text) => this.pushLog(rb.name, text),
      })
      this.robots.set(r.node, robot)
      this.radio.add(robot)
    })
    for (const s of cfg.supervisors) {
      if (!this.world.people.has(s.badge)) continue
      const sup = new SupervisorNode(ctx, cfg, s, this.world, { autoRespond: s.node !== input.buildManager, robotLink: (id) => this.robots.get(id) })
      this.supervisors.set(s.node, sup)
      this.radio.add(sup)
    }

    // Planning software: publishes tasks in order, a few at a time.
    this.queue = [...input.tasks]
    for (const t of input.tasks) for (const [itemId, unit] of Object.entries(t.unitIds ?? {})) this.unitOf.set(`${t.taskId}/${itemId}`, unit)
    this.hub.onTaskComplete = (taskId) => {
      this.completed.add(taskId)
      this.publishReady()
    }
    this.hub.onEvent((e) => {
      for (const s of this.eventSinks) s(e)
    })
  }

  /** Start every node and the planning software. */
  boot() {
    this.hub.start()
    for (const r of this.relays.values()) r.start()
    for (const a of this.anchors.values()) a.start()
    for (const r of this.robots.values()) r.start()
    for (const s of this.supervisors.values()) s.start()
    this.sched.every(100, () => this.world.step(this.sched.now, 100))
    this.sched.every(1000, () => {
      this.manualTaskTick()
      this.publishReady()
    })
    // Give the mesh a few seconds to form before the first tasks.
    if ((this.input.options?.scenario ?? 'demo') === 'demo') this.scheduleDemo()
    this.scheduleCrewBehaviour()
  }

  /**
   * Planning order: tasks wait for the tasks they come after, and autonomous tasks for one fleet
   * type open one at a time (a second one would only show as a shortfall while the robots are busy).
   */
  private publishReady() {
    if (this.sched.now < 8000) return // let the mesh form and supervisors be located first
    const max = this.input.options?.maxOpenTasks ?? 1
    for (const t of this.queue) {
      if (this.published.has(t.taskId)) continue
      if (t.after && !t.after.every((a) => this.completed.has(a))) continue
      if (t.mode === 'autonomous') {
        const openSame = [...this.published].filter((id) => !this.completed.has(id)).map((id) => this.input.tasks.find((x) => x.taskId === id)!).filter((x) => x.mode === 'autonomous' && x.tag === t.tag)
        if (openSame.length >= max) continue
      }
      this.published.add(t.taskId)
      const { unitIds: _u, after: _a, label: _l, ...task } = t // eslint-disable-line @typescript-eslint/no-unused-vars
      this.hub.publishTask(task)
    }
  }

  /** Manual tasks (crane setting) complete when the planning software sees all their units installed. */
  private manualTaskTick() {
    for (const t of this.input.tasks) {
      if (t.mode !== 'manual' || !this.published.has(t.taskId) || this.completed.has(t.taskId)) continue
      const units = Object.values(t.unitIds ?? {})
      if (units.length && units.every((u) => this.world.unitById.get(u)?.status === 'installed')) {
        this.completed.add(t.taskId)
        this.pushLog('Planning', `${t.label ?? `Task ${t.taskId}`} complete.`)
        this.publishReady()
      }
    }
  }

  // ---------- driving ----------

  /** Advance simulation time by ms (for tests and fast-forward). */
  advance(ms: number) {
    this.sched.runUntil(this.sched.now + ms)
  }

  /** Run in real time at `speed`, calling onTick after each slice. */
  run(onTick?: () => void) {
    if (this.timer) return
    this.running = true
    let last = Date.now()
    this.timer = setInterval(() => {
      const now = Date.now()
      const wall = Math.min(250, now - last)
      last = now
      const until = this.sched.now + wall * this.speed
      this.sched.runUntil(until)
      onTick?.()
    }, 50)
  }

  pause() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.running = false
  }

  stop() {
    this.pause()
  }

  onEvent(fn: (e: MeshEvent) => void) {
    this.eventSinks.add(fn)
    return () => this.eventSinks.delete(fn)
  }

  onTrace(fn: (t: MeshTrace) => void) {
    return this.radio.onTrace(fn)
  }

  // ---------- views ----------

  snapshot(): MeshSnapshot {
    return this.hub.snapshot()
  }

  planning(): PlanningView {
    const units: PlanningView['units'] = []
    for (const u of this.world.units) {
      // Piles: what the mesh reports (items DONE in the hub's book). Installs: manual work reported to planning.
      let status: 'planned' | 'piled' | 'installed' = 'planned'
      if (u.status === 'installed') status = 'installed'
      else if (this.pileReported(u.id)) status = 'piled'
      units.push({ id: u.id, status })
    }
    const tasks = this.input.tasks.map((t) => ({ taskId: t.taskId, label: t.label ?? `Task ${t.taskId}`, tag: t.tag, mode: t.mode, status: (this.completed.has(t.taskId) ? 'complete' : this.published.has(t.taskId) ? 'open' : 'queued') as 'queued' | 'open' | 'complete' }))
    return { units, tasks }
  }

  private pileIndex: Map<string, [number, number]> | null = null
  private pileReported(unitId: string) {
    if (!this.pileIndex) {
      this.pileIndex = new Map()
      for (const t of this.input.tasks) if (t.mode === 'autonomous' && t.tag === 1) for (const [itemId, u] of Object.entries(t.unitIds ?? {})) this.pileIndex.set(u, [t.taskId, Number(itemId)])
    }
    const ref = this.pileIndex.get(unitId)
    if (!ref) return false
    const e = this.hub.book.get(ref[0], ref[1])
    return !!e && (e.state === ItemState.DONE || e.state === ItemState.AWAITING_SIGNOFF)
  }

  status(): SimStatus {
    const now = this.sched.now
    if (now - this.lastTx.t >= 1000) {
      const dt = (now - this.lastTx.t) / 1000
      this.lastTx = { t: now, tx: this.radio.txCount, loss: this.radio.lossCount, txPerSec: Math.round((this.radio.txCount - this.lastTx.tx) / dt), lossPerSec: Math.round((this.radio.lossCount - this.lastTx.loss) / dt) }
    }
    return { simTime: Math.round(now), speed: this.speed, running: this.running, hubUp: this.hub.powered, txPerSec: this.lastTx.txPerSec, lossPerSec: this.lastTx.lossPerSec, scenario: this.input.options?.scenario ?? 'demo' }
  }

  takeLog() {
    const out = this.logLines
    this.logLines = []
    return out
  }

  private pushLog(who: string, text: string) {
    this.logLines.push({ at: this.sched.gpsTime, who, text })
    if (this.logLines.length > 500) this.logLines.shift()
  }

  // ---------- the twin's actions (12.3) ----------

  command(supervisor: NodeId, cmd: Cmd, target: NodeId | null, args: Record<string, unknown>): Promise<CmdResultP | null> {
    return this.hub.commandOnBehalf(supervisor, cmd, target, args)
  }

  ack(supervisor: NodeId, alertId: number, action: 0 | 1 | 2) {
    this.hub.ackOnBehalf(supervisor, alertId, action)
  }

  // ---------- failure injection (simulator only) ----------

  inject(kind: InjectKind, target?: string): string {
    const pickRelay = () => {
      if (target && this.relays.has(target)) return this.relays.get(target)!
      // The relay most robots are attached to (excluding gateways).
      const count = new Map<NodeId, number>()
      for (const r of this.robots.values()) if (r.via && this.relays.get(r.via)?.kind === NodeKind.RELAY) count.set(r.via, (count.get(r.via) ?? 0) + 1)
      const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      return this.relays.get(best ?? '') ?? [...this.relays.values()].find((r) => r.kind === NodeKind.RELAY && r.powered)
    }
    const pickRobot = () => (target && this.robots.get(target)) || [...this.robots.values()].find((r) => r.tag === 1 && r.powered)
    switch (kind) {
      case 'relay_down': {
        const r = pickRelay()
        if (!r) return 'No relay to take down.'
        r.powerOff()
        return `${r.name} powered off.`
      }
      case 'relay_up': {
        const r = target ? this.relays.get(target) : [...this.relays.values()].find((x) => !x.powered)
        if (!r || r.powered) return 'No relay is down.'
        r.powerOn()
        return `${r.name} back on (boot ${r.boot}).`
      }
      case 'gateway_down': {
        const g = [...this.relays.values()].find((x) => x.isGateway && x.powered)
        if (!g) return 'No gateway to take down.'
        g.powerOff()
        return `${g.name} powered off.`
      }
      case 'hub_down':
        this.hub.powerOff()
        return 'Hub down: robots keep working known tasks and fall back to their own crew positions.'
      case 'hub_up':
        this.hub.powerOn()
        return 'Hub back.'
      case 'rtk_degraded':
      case 'rtk_ok': {
        const r = pickRobot()
        if (!r) return 'No robot.'
        r.degradePosition(kind === 'rtk_degraded')
        return `${r.name} RTK ${kind === 'rtk_degraded' ? 'degraded (float, 1.2 m)' : 'fixed again'}.`
      }
      case 'robot_fault':
      case 'robot_fault_clear': {
        const r = pickRobot()
        if (!r) return 'No robot.'
        r.injectFault(kind === 'robot_fault')
        return `${r.name} ${kind === 'robot_fault' ? 'reports a fault' : 'fault cleared'}.`
      }
      case 'robot_radio_off':
      case 'robot_radio_on': {
        const r = pickRobot()
        if (!r) return 'No robot.'
        r.radioWorks = kind === 'robot_radio_on'
        return `${r.name} radio ${r.radioWorks ? 'working' : 'dead'}.`
      }
      case 'stray_object': {
        const r = pickRobot()
        const at = r ? r.pos() : this.input.world.office
        const from = { x: at.x - 400, y: at.y + 250 }
        const to = { x: at.x + 400, y: at.y - 250 }
        this.world.spawnStray(this.sched.now, from, to)
        return 'A vehicle without a badge is crossing the site.'
      }
      case 'crew_into_hazard': {
        const h = this.input.world.hazards[0]
        const crew = [...this.world.people.values()].find((p) => p.kind === 'crew')
        if (!h || !crew) return 'No hazard zone or crew to use.'
        const c = { x: h.reduce((t, p) => t + p.x, 0) / h.length, y: h.reduce((t, p) => t + p.y, 0) / h.length }
        this.world.sendOnErrand(crew.badge, c, this.sched.now + 120_000, 'shortcut through a hazard zone')
        return `${crew.name} is walking into a hazard zone.`
      }
      case 'crew_near_robot': {
        const r = [...this.robots.values()].find((x) => x.speed > 0) ?? pickRobot()
        const crew = [...this.world.people.values()].find((p) => p.kind === 'crew' && !p.errand)
        if (!r || !crew) return 'No robot or crew.'
        const p = r.pos()
        this.world.sendOnErrand(crew.badge, { x: p.x + 20, y: p.y + 20 }, this.sched.now + 25_000, 'walking up to a robot')
        return `${crew.name} is walking up to ${r.name}.`
      }
      case 'starlink_down':
      case 'starlink_up':
        this.hub.starlinkUp = kind === 'starlink_up'
        return `Starlink ${this.hub.starlinkUp ? 'up' : 'down'}.`
    }
  }

  /** The scripted demo: a few of the failure cases in section 17, spaced out. */
  private scheduleDemo() {
    const at = (s: number, fn: () => void) => this.sched.after(s * 1000, fn)
    at(45, () => {
      const msg = this.inject('relay_down')
      this.pushLog('Demo', msg)
      const r = [...this.relays.values()].find((x) => !x.powered)
      at(70, () => r && !r.powered && (r.powerOn(), this.pushLog('Demo', `${r.name} back on.`)))
    })
    at(130, () => this.pushLog('Demo', this.inject('stray_object')))
    at(210, () => {
      this.pushLog('Demo', this.inject('rtk_degraded'))
      at(90, () => this.pushLog('Demo', this.inject('rtk_ok')))
    })
    at(300, () => this.pushLog('Demo', this.inject('crew_into_hazard')))
    at(380, () => {
      this.pushLog('Demo', this.inject('robot_radio_off'))
      at(25, () => this.pushLog('Demo', this.inject('robot_radio_on')))
    })
  }

  /** Every so often someone walks up to a working robot: robots hold for them and carry on. */
  private scheduleCrewBehaviour() {
    this.sched.every(75_000, () => {
      if (this.rand() < 0.7) this.inject('crew_near_robot')
    }, 20_000, this.rand)
  }
}

export { TrackKind }
export type { WorldSpec }
