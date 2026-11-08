// ANCHOR and SUPERVISOR nodes.
//
// Anchors: fixed UWB posts with a mesh radio. Their UWB_RANGES (at least every 5 s) is their
// heartbeat (7.1, 8.4).
// Supervisors: a tablet carried by a person. SUPERVISOR_STATE every 5 s (7.1), alerts and
// acknowledgements (10.1), commands with retries (5.7) and the direct tablet-to-robot link
// (LOCAL_LINK) for on-site resumes (10.3). Simulated supervisors also behave like people: they
// acknowledge alerts after a short delay and walk over to robots that need an on-site resume.
// The build manager's own supervisor identity is driven by the twin instead (autoRespond off).

import { T } from '../constants.js'
import type { AlertAckP, AlertP, CmdResultP, NodeId, Packet, Pos, RobotState, SiteConfig, SupervisorCmdP, SupervisorStateP, TracksP, UwbRangesP } from '../types.js'
import { AlertKind, Cmd, Flag, MsgClass, MsgType, NodeKind, StopReason, TrackKind, msgId } from '../types.js'
import type { Person, World } from '../world/world.js'
import { MeshNode, ReplayWindow, isRelayKind } from './base.js'
import type { NodeContext } from './base.js'

abstract class Endpoint extends MeshNode {
  protected relayHeard = new Map<NodeId, number>()
  protected replay = new ReplayWindow()

  /** Relay contact for the device's own display: depth 0 or no contact (6.5). */
  get hasCoverage() {
    let n1000 = 0
    let n1500 = 0
    for (const t of this.relayHeard.values()) {
      if (this.now - t <= 1000) n1000++
      if (this.now - t <= 1500) n1500++
    }
    return n1000 >= 2 || n1500 >= 1
  }

  protected hasOtherNeighbors() {
    return false // endpoints never forward
  }

  receive(pkt: Packet, from: NodeId, _rssi: number, _iface: 'radio' | 'wire') {
    if (!this.powered || !this.valid(pkt)) return
    const id = msgId(pkt.h)
    if (this.seen.has(id, this.now)) {
      this.ctx.radio.trace(this.id, null, pkt, 'dup_dropped')
      return
    }
    if (this.replay.checkAndRecord(pkt.h)) {
      this.ctx.radio.trace(this.id, null, pkt, 'stale_dropped')
      return
    }
    this.seen.insert(id, this.now)
    if (pkt.h.type === MsgType.RELAY_BEACON && isRelayKind(pkt.h.srcKind)) this.relayHeard.set(pkt.h.src, this.now)
    if (pkt.h.dst === this.id || pkt.h.dst === 'FF:FF:FF:FF:FF:FF') {
      if (this.ctx.radio.tracing && pkt.h.type !== MsgType.RELAY_BEACON) this.ctx.radio.trace(from, this.id, pkt, 'delivered')
      this.process(pkt)
    }
  }

  protected process(_pkt: Packet) {}
}

export class AnchorNode extends Endpoint {
  private lastSent = -Infinity
  private readonly world: World

  constructor(ctx: NodeContext, id: NodeId, name: string, pos: Pos, world: World) {
    super(ctx, id, NodeKind.ANCHOR, name, pos)
    this.world = world
  }

  override start() {
    this.every(T.UWB_INTERVAL, () => this.ranges())
  }

  private ranges() {
    const ranges = this.world.uwbRanges(this.position)
    if (!ranges.length && this.now - this.lastSent < T.ANCHOR_HEARTBEAT) return
    this.lastSent = this.now
    this.send(MsgType.UWB_RANGES, { anchorPos: { ...this.position }, anchorAcc: 0, ranges } satisfies UwbRangesP)
  }
}

interface PendingCmd {
  pkt: Packet<SupervisorCmdP>
  tries: number
  timer?: ReturnType<MeshNode['sched']['after']>
  done: (r: CmdResultP | null) => void
}

export class SupervisorNode extends Endpoint {
  readonly badge: number
  readonly person: Person
  onShift = true
  /** Simulated people respond to alerts on their own; the build manager's identity is driven by the twin. */
  autoRespond: boolean
  inbox: { alert: AlertP; at: number; acked: boolean }[] = []
  private ownTrack: Pos | null = null
  /** Latest stop reason per robot, from their ROBOT_STATE broadcasts. */
  private robotStops = new Map<NodeId, StopReason>()
  private pending = new Map<number, PendingCmd>()
  private readonly site: SiteConfig
  private readonly world: World
  private readonly robotLink: (robot: NodeId) => MeshNode | undefined
  private readonly logFn: (t: string) => void

  constructor(ctx: NodeContext, site: SiteConfig, cfg: SiteConfig['supervisors'][number], world: World, opts: { autoRespond: boolean; robotLink: (robot: NodeId) => MeshNode | undefined }) {
    const person = world.people.get(cfg.badge)!
    super(ctx, cfg.node, NodeKind.SUPERVISOR, cfg.name, person.pos)
    this.site = site
    this.world = world
    this.badge = cfg.badge
    this.person = person
    this.autoRespond = opts.autoRespond
    this.robotLink = opts.robotLink
    this.logFn = (t) => ctx.log(cfg.name, t)
  }

  override pos(): Pos {
    return this.person.pos // the tablet goes where its person goes
  }

  override start() {
    this.every(T.SUPERVISOR_STATE_INTERVAL, () => {
      const p: SupervisorStateP = { badgeId: this.badge, onShift: this.onShift, pos: this.ownTrack ?? { x: Math.round(this.person.pos.x), y: Math.round(this.person.pos.y) } }
      this.send(MsgType.SUPERVISOR_STATE, p)
    })
  }

  protected override process(pkt: Packet) {
    const h = pkt.h
    if (h.type === MsgType.TRACKS && h.src === this.site.hub) {
      const t = (pkt.p as TracksP).tracks.find((x) => x.id === this.badge && x.kind === TrackKind.SUPERVISOR)
      if (t) this.ownTrack = t.pos
      return
    }
    if (h.type === MsgType.ROBOT_STATE) {
      this.robotStops.set(h.src, (pkt.p as RobotState).stopReason)
      return
    }
    if (h.type === MsgType.ALERT && h.dst === this.id) {
      const a = pkt.p as AlertP
      if (this.inbox.some((x) => x.alert.alertId === a.alertId)) return
      this.inbox.unshift({ alert: a, at: this.now, acked: false })
      this.inbox.length = Math.min(this.inbox.length, 50)
      if (this.autoRespond) this.respond(a)
      return
    }
    if (h.type === MsgType.CMD_RESULT && h.dst === this.id) this.onResult(pkt.p as CmdResultP)
  }

  /** Acknowledge an alert (10.1). */
  ack(alertId: number, action: 0 | 1 | 2) {
    const e = this.inbox.find((x) => x.alert.alertId === alertId)
    if (e) e.acked = true
    this.send(MsgType.ALERT_ACK, { alertId, action } satisfies AlertAckP, { dst: this.site.hub })
  }

  /** Send a command over the mesh with retries every 1 s, up to 5 (5.7). */
  command(cmd: Cmd, target: NodeId | null, args: Record<string, unknown>, dst: NodeId, cls = MsgClass.CONTROL): Promise<CmdResultP | null> {
    const cmdId = Math.floor(this.ctx.rand() * 2 ** 32)
    return new Promise((done) => {
      const p: SupervisorCmdP = { cmdId, cmd, target, args }
      const entry: PendingCmd = { pkt: this.send(MsgType.SUPERVISOR_CMD, p, { dst, cls }), tries: 0, done }
      this.pending.set(cmdId, entry)
      const retry = () => {
        if (!this.pending.has(cmdId)) return
        if (entry.tries >= T.CMD_RETRIES) {
          this.pending.delete(cmdId)
          done(null)
          return
        }
        entry.tries++
        entry.pkt = this.send(MsgType.SUPERVISOR_CMD, p, { dst, cls, flags: Flag.RETRY })
        entry.timer = this.sched.after(T.CMD_RETRY_MS, retry)
      }
      entry.timer = this.sched.after(T.CMD_RETRY_MS, retry)
    })
  }

  /** Send a command over the direct short-range link to a robot next to us (LOCAL_LINK, 4.2). */
  localCommand(robot: NodeId, cmd: Cmd, args: Record<string, unknown>): Promise<CmdResultP | null> {
    const node = this.robotLink(robot)
    if (!node) return Promise.resolve(null)
    const cmdId = Math.floor(this.ctx.rand() * 2 ** 32)
    return new Promise((done) => {
      this.pending.set(cmdId, { pkt: null as unknown as Packet<SupervisorCmdP>, tries: T.CMD_RETRIES, done })
      const pkt: Packet<SupervisorCmdP> = {
        h: { version: 1, type: MsgType.SUPERVISOR_CMD, cls: MsgClass.SAFETY, flags: Flag.LOCAL_LINK, initialHops: 0, hopsLeft: 0, srcKind: this.kind, src: this.id, dst: robot, boot: this.boot, seq: this.seq++, gpsTime: this.sched.gpsTime },
        p: { cmdId, cmd, target: robot, args },
      }
      node.receive(pkt, this.id, -40, 'radio')
      this.sched.after(3000, () => {
        if (this.pending.delete(cmdId)) done(null)
      })
    })
  }

  private onResult(r: CmdResultP) {
    const e = this.pending.get(r.cmdId)
    if (!e) return
    this.sched.cancel(e.timer)
    this.pending.delete(r.cmdId)
    e.done(r)
  }

  /** How a simulated supervisor reacts to an alert. */
  private respond(a: AlertP) {
    const delay = 4000 + this.ctx.rand() * 10_000
    this.sched.after(delay, () => {
      if (!this.powered) return
      const onSiteStop = a.kind === AlertKind.STOP_NEEDS_RESUME && this.needsOnSite(a)
      const handling = onSiteStop || [AlertKind.NODE_LOST, AlertKind.NEAR_MISS, AlertKind.CREW_IN_ZONE, AlertKind.MANUAL_TASK, AlertKind.CREW_HOLD_LONG].includes(a.kind)
      this.ack(a.alertId, handling ? 1 : 0)
      if (onSiteStop) this.walkOverAndResume(a)
      if (a.kind === AlertKind.CREW_IN_ZONE) this.radioCrewOut(a)
    })
  }

  private needsOnSite(a: AlertP) {
    // ALERT.ref is the stop_id; the reason comes from the robot's own ROBOT_STATE.
    const r = this.robotStops.get(a.subjects[0])
    return r === StopReason.NEAR_MISS || r === StopReason.PERSON_DETECTED || r === StopReason.COLLISION
  }

  private walkOverAndResume(a: AlertP) {
    const robot = a.subjects[0]
    const node = this.robotLink(robot)
    if (!node) return
    const target = node.pos()
    this.logFn(`Walking to ${node.name} to check it before resuming.`)
    this.world.sendOnErrand(this.badge, { x: target.x + 40, y: target.y + 40 }, this.now + 10 * 60_000, `check ${node.name}`, () => {
      this.sched.after(20_000, () => {
        void this.localCommand(robot, Cmd.RESUME, { stopId: a.ref }).then((r) => {
          this.logFn(r && r.result === 0 ? `Resumed ${node.name} on site.` : `Couldn't resume ${node.name} yet.`)
        })
      })
    })
  }

  private radioCrewOut(a: AlertP) {
    for (const s of a.subjects) {
      const badge = Number(s)
      const p = this.world.people.get(badge)
      if (!p) continue
      this.sched.after(8000, () => this.world.sendOnErrand(badge, { x: this.world.spec.office.x + (this.ctx.rand() - 0.5) * 400, y: this.world.spec.office.y + (this.ctx.rand() - 0.5) * 300 }, this.now + 120_000, 'leaving a keep-out zone'))
    }
  }
}
