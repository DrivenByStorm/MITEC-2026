// ROBOT nodes: the robot mesh agent. Robot beacons (6.2), the contact watchdog and mesh depth
// (6.3), coverage and the 3 m band (6.4), ROBOT_STATE (7.1), lidar and moving-anchor UWB
// (8.3, 8.4), zone and proximity checks (8.7), stops and holds (8.8), near misses (8.9),
// CBAA (9.6–9.9), supervisor commands and resume rules (10.2–10.4), robot-to-robot
// forwarding (5.9) and bulk evidence (5.8). The robot's body moves in the World.

import { ROBOT_QUEUE, T } from '../constants.js'
import { AuctionBook, ReleaseReason, applyReleaseRule, beats, neededPct, updateOwner, utility } from '../cbaa.js'
import type { BidderInfo, OwnerView } from '../cbaa.js'
import { dist, multilaterate, nearestCoveragePoint, outsideCoverage, zoneDistance } from '../geometry.js'
import type { CoverageCircle } from '../geometry.js'
import { clonePacket } from '../sim/radio.js'
import type {
  AuctionStateP,
  BulkChunkP,
  BulkNackP,
  CmdResultP,
  ItemDoneP,
  ItemEntry,
  ItemReleasedP,
  ItemStartedP,
  LidarObjectsP,
  NearMissP,
  NodeId,
  NodeListEntry,
  NodeListP,
  Packet,
  Pos,
  RobotBeacon,
  RobotState,
  SafetyStopP,
  SiteConfig,
  SupervisorCmdP,
  Task,
  TaskCancelP,
  TaskP,
  Track,
  TracksP,
  UwbRangesP,
  Zone,
  ZoneBreachP,
  ZoneSetP,
} from '../types.js'
import { BROADCAST, BeaconFlag, Cmd, Flag, ItemState, MsgClass, MsgType, NodeKind, RobotFlag, RobotMode, StopReason, TrackKind, ZoneKind, msgId } from '../types.js'
import type { RobotBody, World } from '../world/world.js'
import { MeshNode, ReplayWindow } from './base.js'
import type { NodeContext } from './base.js'

type Severity = 0 | 1 | 2 | 3 // normal, slow, hold, stop

interface Check {
  sev: Severity
  reason?: StopReason
  detail?: number
  zoneId?: number
  text?: string
}

export interface RobotEvents {
  /** The robot finished an item; the world records the piles. */
  itemDone?(robot: RobotNode, taskId: number, itemId: number): void
  log?(robot: RobotNode, text: string): void
}

export class RobotNode extends MeshNode implements RobotBody {
  readonly cfg: SiteConfig['robots'][number]
  readonly site: SiteConfig
  readonly world: World
  readonly tag: number
  readonly footprint: number
  vel = { x: 0, y: 0 }
  heading = 0 // centidegrees, CCW from east
  speed = 0 // cm/s
  mode = RobotMode.IDLE
  stopId = 0
  stopReason = StopReason.NONE
  stoppedAt = 0
  private stopSeq = 0
  battery = 80
  health: 0 | 1 | 2 = 0
  faultActive = false
  posSource: 0 | 1 | 2 | 3 = 0
  posAcc = 2 // cm
  rtkError = { x: 0, y: 0 } // dm, applied to the reported position when degraded
  lights = false
  horn = false
  slowBand = false
  hornUntil = 0
  inService = true
  returningToCoverage = false

  // mesh contact
  private relayHeard = new Map<NodeId, { times: number[]; rssi: number[] }>()
  private robotNeighbors = new Map<NodeId, { b: RobotBeacon; t: number; rssi: number }>()
  depth = 255
  contact: 'IN_CONTACT' | 'LOST' = 'IN_CONTACT'
  private noPathSince: number | null = null
  via: NodeId | null = null
  private pendingOnContact: (() => void)[] = []

  // knowledge
  private relayAlive = new Map<NodeId, number>()
  zones: { version: number; list: Zone[] } = { version: 0, list: [] }
  private zoneParts = new Map<number, Map<number, Zone[]>>()
  tracks: { version: number; list: Track[]; at: number } = { version: 0, list: [], at: -Infinity }
  private trackParts = new Map<number, { parts: number; got: Map<number, Track[]> }>()
  nodeList: { version: number; nodes: Map<NodeId, NodeListEntry> }
  private nodeListParts = new Map<number, Map<number, NodeListEntry[]>>()
  otherStates = new Map<NodeId, { s: RobotState; t: number }>()
  owners = new Map<NodeId, OwnerView>()
  private uwbHeard: { anchor: Pos; acc: number; badge: number; range: number; quality: number; t: number }[] = []
  private replay = new ReplayWindow()
  private cmdMemory = new Map<number, { res: CmdResultP; t: number }>()

  // tasks
  book = new AuctionBook()
  private inbox: Packet[] = []
  holding: { taskId: number; itemId: number } | null = null
  private workDoneAt = 0
  private lastAuctionSent = new Map<number, number>()
  private nodeFirstSeen = new Map<NodeId, number>()
  private chargingTarget: Pos | null = null
  private bulkSeq = 1
  private bulkSent = new Map<number, BulkChunkP[]>()
  private lastStateSent: string = ''
  private lastBeaconFlags = 0
  private crewZoneWarnUntil = 0
  private holdClearSince: number | null = null
  private readonly events: RobotEvents

  constructor(ctx: NodeContext, site: SiteConfig, cfg: SiteConfig['robots'][number], pos: Pos, world: World, events: RobotEvents = {}) {
    super(ctx, cfg.node, NodeKind.ROBOT, cfg.name, pos)
    this.site = site
    this.cfg = cfg
    this.world = world
    this.events = events
    this.tag = cfg.tag
    this.footprint = cfg.footprintDm
    this.battery = 70 + Math.floor(ctx.rand() * 28)
    // NODE_LIST is pre-loaded from the site config so robots work from boot even if the hub is down (10.5).
    this.nodeList = { version: 0, nodes: preloadNodeList(site) }
    world.robots.set(this.id, this)
  }

  override start() {
    this.every(T.ROBOT_BEACON_INTERVAL, () => this.sendBeacon(), T.ROBOT_BEACON_JITTER)
    this.every(T.ROBOT_STATE_INTERVAL, () => this.sendState(true))
    this.every(T.LIDAR_INTERVAL, () => this.sendLidar())
    this.every(T.UWB_INTERVAL, () => this.sendUwb())
    this.every(T.CONTACT_CHECK, () => this.tick100())
    this.every(T.CBAA_ROUND, () => this.round())
  }

  protected override onReboot() {
    this.mode = RobotMode.IDLE
    this.stopId = 0
    this.stopReason = StopReason.NONE
    this.holding = null
    this.relayHeard.clear()
    this.robotNeighbors.clear()
    this.depth = 255
    this.contact = 'IN_CONTACT'
    this.noPathSince = null
    this.book = new AuctionBook()
    this.replay = new ReplayWindow()
    this.cmdMemory.clear()
    this.zones = { version: 0, list: [] }
    this.tracks = { version: 0, list: [], at: -Infinity }
    this.nodeList = { version: 0, nodes: preloadNodeList(this.site) }
  }

  // ---------- position ----------

  /** Position the robot reports: RTK output in the site frame (includes RTK error when degraded). */
  reportedPos(): Pos {
    return { x: Math.round(this.position.x + this.rtkError.x), y: Math.round(this.position.y + this.rtkError.y) }
  }

  get degraded() {
    return this.posSource !== 0 || this.posAcc > T.DEGRADED_POS_ACC_CM
  }

  /** Footprint used in zone checks: inflated by position accuracy when degraded (8.2). */
  effFootprint() {
    return this.footprint + (this.degraded ? Math.round(this.posAcc / 10) : 0)
  }

  degradePosition(on: boolean) {
    if (on) {
      this.posSource = 1
      this.posAcc = 120
      const a = this.ctx.rand() * Math.PI * 2
      this.rtkError = { x: Math.cos(a) * 25, y: Math.sin(a) * 25 }
    } else {
      this.posSource = 0
      this.posAcc = 2
      this.rtkError = { x: 0, y: 0 }
    }
  }

  // ---------- periodic messages ----------

  private beaconPayload(): RobotBeacon {
    return {
      pos: this.reportedPos(),
      heading: this.heading,
      vx: Math.round(this.vel.x),
      vy: Math.round(this.vel.y),
      footprint: this.effFootprint(),
      mode: this.mode,
      meshDepth: this.depth,
      taskPriority: this.holding ? (this.book.tasks.get(this.holding.taskId)?.task.priority ?? 0) : 0,
      flags: this.beaconFlags(),
    }
  }

  private beaconFlags() {
    return (this.mode === RobotMode.STOPPED ? BeaconFlag.STOPPED : 0) | (this.mode === RobotMode.HOLD ? BeaconFlag.HOLDING : 0) | (this.lights ? BeaconFlag.LIGHTS : 0) | (this.inBand() ? BeaconFlag.COVERAGE_BAND : 0)
  }

  private sendBeacon() {
    const b = this.beaconPayload()
    this.lastBeaconFlags = b.flags
    this.send(MsgType.ROBOT_BEACON, b)
  }

  state(): RobotState {
    const e = this.holding ? this.book.get(this.holding.taskId, this.holding.itemId) : undefined
    return {
      tag: this.tag,
      mode: this.mode,
      stopId: this.mode === RobotMode.STOPPED ? this.stopId : 0,
      stopReason: this.mode === RobotMode.STOPPED || this.mode === RobotMode.HOLD ? this.stopReason : StopReason.NONE,
      pos: this.reportedPos(),
      heading: this.heading,
      speed: Math.round(this.speed),
      posSource: this.posSource,
      posAcc: this.posAcc,
      batteryPct: Math.round(this.battery),
      health: this.health,
      taskId: this.holding?.taskId ?? 0,
      itemId: this.holding?.itemId ?? 0,
      itemGen: e?.gen ?? 0,
      via: this.via,
      footprint: this.footprint,
      maxSpeed: this.cfg.maxSpeedCms,
      flags: (this.lights ? RobotFlag.LIGHTS : 0) | (this.horn ? RobotFlag.HORN : 0) | (this.slowBand ? RobotFlag.SLOW_BAND : 0) | (this.tracksStale() ? RobotFlag.TRACKS_STALE : 0) | (this.inService ? RobotFlag.IN_SERVICE : 0),
    }
  }

  /** Send ROBOT_STATE: on the 1 s timer, and immediately when mode, stop, task or item changes (7.1). */
  sendState(periodic = false) {
    const s = this.state()
    const key = `${s.mode}/${s.stopId}/${s.taskId}/${s.itemId}`
    if (!periodic && key === this.lastStateSent) return
    this.lastStateSent = key
    if (this.contact === 'LOST') return // queued until contact returns (6.3)
    this.send(MsgType.ROBOT_STATE, s)
  }

  private sendLidar() {
    const objects = this.world.lidar(this.id, this.position, this.reportedPos())
    const p: LidarObjectsP = { observerPos: this.reportedPos(), observerHeading: this.heading, posAcc: this.posAcc, objects }
    this.send(MsgType.LIDAR_OBJECTS, p)
  }

  private sendUwb() {
    const p: UwbRangesP = { anchorPos: this.reportedPos(), anchorAcc: this.posAcc, ranges: this.world.uwbRanges(this.position) }
    this.send(MsgType.UWB_RANGES, p)
    this.recordUwb(p) // a robot also uses its own ranges for the fallback fix
  }

  // ---------- receive ----------

  protected override queueLimit(cls: MsgClass) {
    return ROBOT_QUEUE.limit[cls] || 32
  }

  /** Own SAFETY first, then forwarded SAFETY, then own and forwarded lower classes in class order (5.9). */
  protected override pickNext() {
    const q0 = this.queues[0]
    const own = q0.findIndex((e) => e.own && e.readyAt <= this.now)
    if (own >= 0) return q0.splice(own, 1)[0]
    return super.pickNext()
  }

  protected hasOtherNeighbors(except: NodeId) {
    for (const [id, r] of this.relayHeard) if (id !== except && r.times.some((t) => this.now - t <= 2000)) return true
    for (const [id, n] of this.robotNeighbors) if (id !== except && this.now - n.t <= T.ROBOT_NEIGHBOR_DEPTH_FRESH) return true
    return false
  }

  receive(pkt: Packet, from: NodeId, rssi: number, _iface: 'radio' | 'wire') {
    if (!this.powered) return
    if (!this.valid(pkt)) return
    const h = pkt.h
    const id = msgId(h)
    if (this.seen.has(id, this.now)) {
      this.heardAgain(id)
      this.ctx.radio.trace(this.id, null, pkt, 'dup_dropped')
      return
    }
    if (this.replay.checkAndRecord(h)) {
      this.ctx.radio.trace(this.id, null, pkt, 'stale_dropped')
      return
    }
    this.seen.insert(id, this.now)
    if (h.dst === this.id || h.dst === BROADCAST) {
      if (this.ctx.radio.tracing) this.ctx.radio.trace(from, this.id, pkt, 'delivered')
      this.process(pkt, from, rssi)
    }
    if (h.type === MsgType.RELAY_BEACON || h.type === MsgType.ROBOT_BEACON) return
    if (h.hopsLeft > 0 && this.radioOn() && this.shouldForward(pkt)) {
      const fwd = clonePacket(pkt)
      fwd.h.hopsLeft -= 1
      const jitter = h.cls === MsgClass.SAFETY ? 2 + this.ctx.rand() * 8 : 10 + this.ctx.rand() * 30
      this.enqueue(fwd, false, jitter)
      this.watchRepair(fwd, from)
    }
  }

  /** Forwarding rules F1–F4 (5.9). */
  private shouldForward(pkt: Packet): boolean {
    const h = pkt.h
    if (h.cls === MsgClass.BULK) return false
    if (h.type >= MsgType.TASK && h.type <= MsgType.TASK_CANCEL) return true // F1
    if (h.type === MsgType.SUPERVISOR_CMD && h.dst === BROADCAST) return true // F1
    if (h.cls === MsgClass.SAFETY) return true // F2 (beacons already excluded)
    const deeper = (n: NodeId) => {
      const nb = this.robotNeighbors.get(n)
      return !!nb && this.now - nb.t <= T.ROBOT_NEIGHBOR_DEPTH_FRESH && nb.b.meshDepth > this.depth && nb.b.meshDepth !== 255
    }
    if (deeper(h.src)) return true // F3 upstream for a neighbor
    if (deeper(h.dst)) return true // F4 downstream to a neighbor
    return false
  }

  private process(pkt: Packet, from: NodeId, rssi: number) {
    const h = pkt.h
    switch (h.type) {
      case MsgType.RELAY_BEACON: {
        const r = this.relayHeard.get(h.src) ?? { times: [], rssi: [] }
        r.times.push(this.now)
        r.rssi.push(rssi)
        while (r.times.length && this.now - r.times[0] > 2000) {
          r.times.shift()
          r.rssi.shift()
        }
        this.relayHeard.set(h.src, r)
        this.relayAlive.set(h.src, this.now)
        return
      }
      case MsgType.ROBOT_BEACON:
        this.robotNeighbors.set(h.src, { b: pkt.p as RobotBeacon, t: this.now, rssi })
        return
      case MsgType.RELAY_STATUS:
        this.relayAlive.set(h.src, this.now)
        return
      case MsgType.ROBOT_STATE: {
        const s = pkt.p as RobotState
        this.otherStates.set(h.src, { s, t: this.now })
        updateOwner(this.owners, h.src, s, this.now)
        return
      }
      case MsgType.UWB_RANGES:
        this.recordUwb(pkt.p as UwbRangesP)
        return
      case MsgType.TRACKS:
        if (h.src === this.site.hub) this.onTracks(pkt.p as TracksP)
        return
      case MsgType.ZONE_SET:
        if (h.src === this.site.hub) this.onZoneSet(pkt.p as ZoneSetP)
        return
      case MsgType.NODE_LIST:
        if (h.src === this.site.hub) this.onNodeList(pkt.p as NodeListP)
        return
      case MsgType.NEAR_MISS: {
        const nm = pkt.p as NearMissP
        if (nm.involved.some((i) => i.id === this.id)) this.stop(StopReason.NEAR_MISS, 0)
        return
      }
      case MsgType.TASK:
        if (h.src === this.site.hub && (pkt.p as TaskP).mode === 'autonomous') this.book.addTask(pkt.p as TaskP, this.now)
        return
      case MsgType.AUCTION_STATE:
      case MsgType.ITEM_STARTED:
      case MsgType.ITEM_DONE:
      case MsgType.ITEM_RELEASED:
      case MsgType.TASK_CANCEL:
        this.inbox.push(pkt) // merged at the start of the next round (9.7)
        return
      case MsgType.SUPERVISOR_CMD:
        this.onCommand(pkt as Packet<SupervisorCmdP>, from)
        return
      case MsgType.BULK_NACK:
        if (h.dst === this.id) this.onBulkNack(pkt.p as BulkNackP)
        return
    }
  }

  // ---------- knowledge ----------

  private recordUwb(p: UwbRangesP) {
    for (const r of p.ranges) this.uwbHeard.push({ anchor: p.anchorPos, acc: p.anchorAcc, badge: r.badge, range: r.range, quality: r.quality, t: this.now })
    const cutoff = this.now - 1000
    if (this.uwbHeard.length > 2000 || (this.uwbHeard[0] && this.uwbHeard[0].t < cutoff)) this.uwbHeard = this.uwbHeard.filter((u) => u.t >= cutoff)
  }

  private onTracks(p: TracksP) {
    if (p.tracksVersion < this.tracks.version) return
    const e = this.trackParts.get(p.tracksVersion) ?? { parts: p.parts, got: new Map() }
    e.got.set(p.part, p.tracks)
    this.trackParts.set(p.tracksVersion, e)
    // Robots use every packet of the newest version they have received (8.5).
    const list = [...e.got.values()].flat()
    this.tracks = { version: p.tracksVersion, list, at: this.now }
    for (const v of this.trackParts.keys()) if (v < p.tracksVersion) this.trackParts.delete(v)
  }

  private onZoneSet(p: ZoneSetP) {
    if (p.zoneSetVersion <= this.zones.version) return
    const parts = this.zoneParts.get(p.zoneSetVersion) ?? new Map()
    parts.set(p.part, p.zones)
    this.zoneParts.set(p.zoneSetVersion, parts)
    if (parts.size === p.parts) {
      this.zones = { version: p.zoneSetVersion, list: [...parts.entries()].sort((a, b) => a[0] - b[0]).flatMap((e) => e[1]) }
      for (const v of this.zoneParts.keys()) if (v <= p.zoneSetVersion) this.zoneParts.delete(v)
    }
  }

  private onNodeList(p: NodeListP) {
    if (p.listVersion <= this.nodeList.version) return
    const parts = this.nodeListParts.get(p.listVersion) ?? new Map()
    parts.set(p.part, p.nodes)
    this.nodeListParts.set(p.listVersion, parts)
    if (parts.size === p.parts) {
      const nodes = new Map<NodeId, NodeListEntry>()
      for (const list of parts.values()) for (const n of list) nodes.set(n.node, n)
      this.nodeList = { version: p.listVersion, nodes }
      this.nodeListParts.clear()
      const me = nodes.get(this.id)
      if (me) this.setInService(me.inService)
    }
  }

  private setInService(on: boolean) {
    if (this.inService === on) return
    this.inService = on
    if (!on) {
      this.dropHolding(ReleaseReason.SUPERVISOR)
      this.mode = RobotMode.OUT_OF_SERVICE
      this.sendState()
    } else if (this.mode === RobotMode.OUT_OF_SERVICE) {
      this.mode = RobotMode.IDLE
      this.sendState()
    }
  }

  private tracksStale() {
    return this.now - this.tracks.at > T.TRACKS_STALE
  }

  /** Crew and supervisor positions: TRACKS from the hub, or the robot's own UWB fix when tracks are stale (8.5). */
  private crewTracks(): Track[] {
    if (!this.tracksStale()) return this.tracks.list
    const byBadge = new Map<number, { anchor: Pos; range: number; w: number; acc: number }[]>()
    for (const u of this.uwbHeard) {
      if (this.now - u.t > T.UWB_RANGE_WINDOW || u.acc > T.UWB_MAX_ANCHOR_ACC_CM) continue
      const list = byBadge.get(u.badge) ?? []
      list.push({ anchor: u.anchor, range: u.range / 10, w: u.quality, acc: u.acc })
      byBadge.set(u.badge, list)
    }
    const out: Track[] = []
    for (const [badge, obs] of byBadge) {
      const fix = multilaterate(obs)
      if (!fix) continue
      const b = this.site.badges.find((x) => x.badge === badge)
      const kind = b?.kind === 'machine' ? TrackKind.MACHINE : b?.kind === 'supervisor' ? TrackKind.SUPERVISOR : TrackKind.CREW
      out.push({ kind, id: badge, pos: fix.pos, radius: b?.radiusDm ?? 4, vx: 0, vy: 0, acc: Math.round(fix.rms * 10), stale: false })
    }
    return out
  }

  private coverageCircles(): CoverageCircle[] {
    const out: CoverageCircle[] = []
    for (const r of this.site.relays) {
      const t = this.relayAlive.get(r.node)
      if (t !== undefined && this.now - t <= T.RELAY_ALIVE_FOR_COVERAGE) out.push({ center: r.pos, radius: (r.coverageRadiusM ?? this.site.coverageRadiusM) * 10 })
    }
    return out
  }

  private coveragePolygon(): Pos[] | undefined {
    const z = this.zones.list.find((x) => x.kind === ZoneKind.COVERAGE && 'polygon' in x.shape)
    return z && 'polygon' in z.shape ? z.shape.polygon : undefined
  }

  outside(p: Pos = this.reportedPos()) {
    return outsideCoverage(p, this.coverageCircles(), this.coveragePolygon())
  }

  private inBand() {
    const o = this.outside()
    return o > 0 && o <= T.COVERAGE_TOLERANCE_DM
  }

  // ---------- 100 ms loop: contact, checks, motion ----------

  private tick100() {
    this.updateContact()
    this.runChecks()
    this.move(T.CONTACT_CHECK)
    if (this.hornUntil && this.now > this.hornUntil && this.mode !== RobotMode.STOPPED && this.mode !== RobotMode.HOLD) {
      this.horn = false
      this.hornUntil = 0
    }
    if (this.beaconFlags() !== this.lastBeaconFlags) this.sendBeacon() // flags change: don't wait for the 200 ms slot (6.2)
  }

  /** Mesh contact watchdog (6.3). */
  private updateContact() {
    const relays1000 = [...this.relayHeard.values()].filter((r) => r.times.some((t) => this.now - t <= 1000)).length
    const relays1500 = [...this.relayHeard.values()].filter((r) => r.times.some((t) => this.now - t <= 1500)).length
    let depth: number
    if (relays1000 >= 2 || (relays1500 >= 1 && this.depth === 0)) depth = 0
    else {
      let best = 255
      for (const n of this.robotNeighbors.values()) if (this.now - n.t <= T.ROBOT_NEIGHBOR_DEPTH_FRESH) best = Math.min(best, n.b.meshDepth)
      depth = best < T.MAX_ROBOT_DEPTH ? best + 1 : 255
    }
    this.depth = depth
    // Attached node: strongest relay over 2 s at depth 0, otherwise the shallowest neighbor robot.
    if (depth === 0) {
      let best: NodeId | null = null
      let bestRssi = -Infinity
      for (const [id, r] of this.relayHeard) {
        if (!r.times.length || this.now - r.times[r.times.length - 1] > 2000) continue
        const avg = r.rssi.reduce((a, b) => a + b, 0) / r.rssi.length
        if (avg > bestRssi) {
          bestRssi = avg
          best = id
        }
      }
      this.via = best
    } else if (depth !== 255) {
      let best: NodeId | null = null
      let bd = 256
      let br = -Infinity
      for (const [id, n] of this.robotNeighbors) {
        if (this.now - n.t > T.ROBOT_NEIGHBOR_DEPTH_FRESH) continue
        if (n.b.meshDepth < bd || (n.b.meshDepth === bd && n.rssi > br)) {
          bd = n.b.meshDepth
          br = n.rssi
          best = id
        }
      }
      this.via = best
    }
    if (depth === 255) {
      this.noPathSince ??= this.now
      if (this.contact === 'IN_CONTACT' && this.now - this.noPathSince >= T.CONTACT_TIMEOUT) {
        this.contact = 'LOST'
        this.log('Lost mesh contact; stopping.')
        this.stop(StopReason.LOST_MESH_CONTACT, 0)
      }
    } else {
      this.noPathSince = null
      if (this.contact === 'LOST') {
        this.contact = 'IN_CONTACT'
        const queued = this.pendingOnContact
        this.pendingOnContact = []
        for (const f of queued) f()
        this.sendState(true)
      }
    }
  }

  /** Zone, track, proximity and coverage checks (8.7), near misses (8.9) and onboard safety. */
  private runChecks() {
    if (!this.powered) return
    const me = this.reportedPos()
    const fp = this.effFootprint()
    let worst: Check = { sev: 0 }
    const consider = (c: Check) => {
      if (c.sev > worst.sev) worst = c
    }
    const moving = this.speed > T.NEAR_MISS_SPEED
    let crewWarn = false

    // static zones
    for (const z of this.zones.list) {
      if (z.kind === ZoneKind.COVERAGE) continue
      if (z.until && z.until < this.sched.gpsTime) continue
      const d = zoneDistance(z, me) - fp
      if (z.appliesTo.robots && !(this.holding && this.taskZone() === z.zoneId)) {
        if (d <= z.buffer) consider({ sev: 3, reason: StopReason.ZONE_BREACH, detail: z.kind, zoneId: z.zoneId })
        else if (d <= z.buffer + z.slowBand) consider({ sev: 1 })
      }
      if (z.appliesTo.crew) {
        for (const t of this.tracks.list) {
          if ((t.kind === TrackKind.CREW || t.kind === TrackKind.SUPERVISOR) && zoneDistance(z, t.pos) <= 0 && dist(t.pos, me) <= T.CREW_ZONE_WARN_DM) crewWarn = true
        }
      }
    }

    // dynamic zones from tracks
    let crewHold = false
    for (const t of this.crewTracks()) {
      const d = dist(me, t.pos) - fp
      let stopR: number
      let slowR: number
      if (t.kind === TrackKind.CREW || t.kind === TrackKind.SUPERVISOR) {
        stopR = T.CREW_STOP_RADIUS_DM + Math.round(t.acc / 10)
        slowR = T.CREW_SLOW_RADIUS_DM
      } else if (t.kind === TrackKind.MACHINE) {
        stopR = t.radius + T.MACHINE_STOP_EXTRA_DM
        slowR = t.radius + T.MACHINE_SLOW_EXTRA_DM
      } else {
        stopR = t.radius + T.UNKNOWN_STOP_EXTRA_DM
        slowR = t.radius + T.UNKNOWN_SLOW_EXTRA_DM
      }
      const holdingNow = this.mode === RobotMode.HOLD && this.stopReason === StopReason.CREW_HOLD
      if (d < stopR || (holdingNow && d < stopR + T.HOLD_HYSTERESIS_DM)) {
        crewHold = true
        consider({ sev: 2, reason: StopReason.CREW_HOLD })
      } else if (d < slowR) consider({ sev: 1 })
      if ((t.kind !== TrackKind.UNKNOWN) && moving && d < T.NEAR_MISS_CREW_DM) this.nearMiss([{ kind: t.kind === TrackKind.MACHINE ? 3 : 2, id: String(t.id), pos: t.pos, speed: Math.round(Math.hypot(t.vx, t.vy)) }], d)
    }

    // robot proximity (constant-velocity prediction over 3 s)
    for (const [id, n] of this.neighborsForProximity()) {
      const sep = predictSeparation(me, this.vel, n.pos, { x: n.vx, y: n.vy }, T.PROXIMITY_HORIZON_MS / 1000)
      const limit = fp + n.footprint + T.PROXIMITY_MARGIN_DM
      const yielding = this.mode === RobotMode.HOLD && this.stopReason === StopReason.PROXIMITY_YIELD
      if ((sep < limit || (yielding && sep < limit + T.HOLD_HYSTERESIS_DM)) && this.yieldsTo(id, n.taskPriority)) consider({ sev: 2, reason: StopReason.PROXIMITY_YIELD })
      const now = dist(me, n.pos) - fp - n.footprint
      if (now < T.NEAR_MISS_ROBOT_DM && (moving || Math.hypot(n.vx, n.vy) > T.NEAR_MISS_SPEED)) this.nearMiss([{ kind: 1, id, pos: n.pos, speed: Math.round(Math.hypot(n.vx, n.vy)) }], now)
    }

    // coverage (only once the robot knows of at least one live relay; before that the contact watchdog decides)
    const out = this.coverageCircles().length || this.coveragePolygon() ? this.outside(me) : 0
    if (out > T.COVERAGE_TOLERANCE_DM && !this.returningToCoverage) consider({ sev: 3, reason: StopReason.OUT_OF_COVERAGE })
    else if (out > 0) consider({ sev: 1 })
    if (this.returningToCoverage && out <= T.COVERAGE_TOLERANCE_DM) this.returningToCoverage = false

    // onboard safety: emergency stop for a person right next to the moving robot (the mesh doesn't decide this)
    const ob = this.world.nearestObstacle(this.position, this.id)
    if (ob && ob.kind === 'person' && moving && ob.d - this.footprint < 8) consider({ sev: 3, reason: StopReason.PERSON_DETECTED })

    if (crewWarn && this.now > this.crewZoneWarnUntil) {
      this.lights = true
      this.horn = true
      this.hornUntil = this.now + T.CREW_ZONE_WARN_MS
      this.crewZoneWarnUntil = this.now + T.CREW_ZONE_WARN_MS
    }

    this.applyCheck(worst, crewHold)
  }

  private taskZone() {
    return this.holding ? (this.book.tasks.get(this.holding.taskId)?.task.zoneId ?? 0) : 0
  }

  private neighborsForProximity(): [NodeId, RobotBeacon][] {
    const out: [NodeId, RobotBeacon][] = []
    for (const [id, n] of this.robotNeighbors) if (this.now - n.t <= T.ROBOT_BEACON_FRESH) out.push([id, n.b])
    // Fall back to ROBOT_STATE for robots with no fresh beacon (6.2).
    for (const [id, o] of this.otherStates) {
      if (out.some((x) => x[0] === id) || this.now - o.t > 3000) continue
      if (dist(o.s.pos, this.reportedPos()) > 600) continue
      const rad = ((o.s.heading / 100) * Math.PI) / 180
      out.push([id, { pos: o.s.pos, heading: o.s.heading, vx: Math.round(Math.cos(rad) * o.s.speed), vy: Math.round(Math.sin(rad) * o.s.speed), footprint: o.s.footprint, mode: o.s.mode, meshDepth: 255, taskPriority: this.book.tasks.get(o.s.taskId)?.task.priority ?? 0, flags: 0 }])
    }
    return out
  }

  /** Yield priority (8.7): higher task priority keeps moving; then higher utility; then lower NodeId. */
  private yieldsTo(other: NodeId, otherPriority: number): boolean {
    const mine = this.holding ? (this.book.tasks.get(this.holding.taskId)?.task.priority ?? 0) : 0
    if (mine !== otherPriority) return mine < otherPriority
    const myBid = this.holding ? (this.book.get(this.holding.taskId, this.holding.itemId)?.winBid ?? 0) : 0
    const os = this.otherStates.get(other)?.s
    const theirBid = os ? (this.book.get(os.taskId, os.itemId)?.winBid ?? 0) : 0
    if (myBid !== theirBid) return myBid < theirBid
    return this.id > other
  }

  private applyCheck(c: Check, crewHold: boolean) {
    const stoppedForGood = this.mode === RobotMode.STOPPED || this.mode === RobotMode.CHARGING || this.mode === RobotMode.OUT_OF_SERVICE
    this.slowBand = c.sev === 1
    if (c.sev === 3 && c.reason !== undefined) {
      if (this.mode !== RobotMode.STOPPED) {
        this.stop(c.reason, c.detail ?? 0)
        if (c.reason === StopReason.ZONE_BREACH && c.zoneId) {
          const zb: ZoneBreachP = { subjectKind: 1, subjectId: this.id, zoneId: c.zoneId, pos: this.reportedPos(), stopId: this.stopId }
          this.sendSafety(MsgType.ZONE_BREACH, zb)
        }
        if (c.reason === StopReason.PERSON_DETECTED) {
          const ob = this.world.nearestObstacle(this.position, this.id)
          this.nearMiss([{ kind: 2, id: ob?.id ?? '0', pos: this.reportedPos(), speed: 0 }], ob ? ob.d - this.footprint : 0, true)
        }
      }
      return
    }
    if (stoppedForGood) return
    if (c.sev === 2 && c.reason !== undefined) {
      this.holdClearSince = null
      if (this.mode !== RobotMode.HOLD || this.stopReason !== c.reason) {
        this.enterHold(c.reason)
      }
      return
    }
    // Holds clear by themselves once the condition has been false for 3 s (8.7).
    if (this.mode === RobotMode.HOLD) {
      this.holdClearSince ??= this.now
      if (this.now - this.holdClearSince >= T.HOLD_CLEAR_MS) {
        this.holdClearSince = null
        this.mode = this.holding && this.book.get(this.holding.taskId, this.holding.itemId)?.state === ItemState.STARTED ? (this.workDoneAt ? RobotMode.WORKING : RobotMode.TO_ITEM) : RobotMode.IDLE
        this.stopReason = StopReason.NONE
        this.lights = false
        this.horn = false
        this.sendState()
      }
    }
    void crewHold
  }

  private enterHold(reason: StopReason) {
    this.mode = RobotMode.HOLD
    this.stopReason = reason
    this.lights = true
    this.horn = reason === StopReason.CREW_HOLD
    this.sendState()
  }

  /** Controlled stop with a new stop_id (8.8). */
  stop(reason: StopReason, detail: number) {
    if (this.mode === RobotMode.STOPPED && this.stopReason === reason) return
    this.stopId = ++this.stopSeq + this.boot * 100000
    this.stopReason = reason
    this.stoppedAt = this.sched.gpsTime
    this.mode = RobotMode.STOPPED
    this.speed = 0
    this.vel = { x: 0, y: 0 }
    this.lights = true
    this.horn = true
    this.hornUntil = this.now + 5000
    const e = this.holding ? this.book.get(this.holding.taskId, this.holding.itemId) : undefined
    const p: SafetyStopP = { stopId: this.stopId, stopReason: reason, pos: this.reportedPos(), stoppedAt: this.stoppedAt, taskId: this.holding?.taskId ?? 0, itemId: this.holding?.itemId ?? 0, itemGen: e?.gen ?? 0, detail }
    this.log(`Stopped: ${StopReason[reason]}`)
    this.sendSafety(MsgType.SAFETY_STOP, p)
    this.sendState()
    this.sendBeacon()
  }

  /** SAFETY messages: sent now, or queued until contact returns when LOST (6.3). */
  private sendSafety<P>(type: MsgType, p: P) {
    if (this.contact === 'LOST') this.pendingOnContact.push(() => this.send(type, p))
    else this.send(type, p)
  }

  private lastNearMiss = 0
  private nearMiss(involved: NearMissP['involved'], minDistDm: number, force = false) {
    if (!force && this.now - this.lastNearMiss < 5000) return
    this.lastNearMiss = this.now
    const p: NearMissP = { eventId: Math.floor(this.ctx.rand() * 2 ** 31), pos: this.reportedPos(), involved: [{ kind: 1, id: this.id, pos: this.reportedPos(), speed: Math.round(this.speed) }, ...involved].slice(0, 4), minDistance: Math.max(0, Math.round(minDistDm * 10)) }
    this.sendSafety(MsgType.NEAR_MISS, p)
    if (this.mode !== RobotMode.STOPPED) this.stop(StopReason.NEAR_MISS, 0)
  }

  // ---------- motion and work ----------

  private move(dtMs: number) {
    const dt = dtMs / 1000
    const drain = this.cfg.drainPctPerHour / 3600
    const active = this.mode === RobotMode.TO_ITEM || this.mode === RobotMode.WORKING || this.mode === RobotMode.CHARGING
    if (this.mode === RobotMode.CHARGING && this.chargingTarget && dist(this.position, this.chargingTarget) < 10) {
      this.battery = Math.min(100, this.battery + (60 / 3600) * dt * 10)
      if (this.battery >= 95) {
        this.mode = RobotMode.IDLE
        this.chargingTarget = null
        this.sendState()
      }
    } else {
      this.battery = Math.max(0, this.battery - drain * dt * (active ? 1 : 0.25))
    }

    let target: Pos | null = null
    if (this.mode === RobotMode.TO_ITEM && this.holding) {
      const it = this.book.item(this.holding.taskId, this.holding.itemId)
      if (it) target = { x: it.pos.x, y: it.pos.y - 25 }
    } else if (this.mode === RobotMode.CHARGING && this.chargingTarget) target = this.chargingTarget
    else if (this.mode === RobotMode.IDLE && this.returningToCoverage) target = nearestCoveragePoint(this.reportedPos(), this.coverageCircles())

    if (this.mode === RobotMode.WORKING && this.holding) {
      this.speed = 0
      this.vel = { x: 0, y: 0 }
      if (this.now >= this.workDoneAt) this.finishItem()
      return
    }
    if (!target || this.mode === RobotMode.STOPPED || this.mode === RobotMode.HOLD) {
      this.speed = 0
      this.vel = { x: 0, y: 0 }
      return
    }
    let vmax = this.cfg.maxSpeedCms
    if (this.slowBand || this.degraded || this.tracksStale() || this.returningToCoverage) vmax = Math.min(vmax, T.CAUTIOUS_SPEED)
    const step = (vmax * dt) / 10
    const d = dist(this.position, target)
    if (d <= step) {
      this.position = { ...target }
      this.speed = 0
      this.vel = { x: 0, y: 0 }
      if (this.mode === RobotMode.TO_ITEM) {
        this.mode = RobotMode.WORKING
        const it = this.book.item(this.holding!.taskId, this.holding!.itemId)!
        this.workDoneAt = this.now + Math.ceil((it.estDurationS * 100) / Math.max(this.cfg.workRatePct, 1)) * 1000
        this.sendState()
      }
      return
    }
    const ux = (target.x - this.position.x) / d
    const uy = (target.y - this.position.y) / d
    this.position = { x: this.position.x + ux * step, y: this.position.y + uy * step }
    this.speed = vmax
    this.vel = { x: ux * vmax, y: uy * vmax }
    this.heading = Math.round((((Math.atan2(uy, ux) * 180) / Math.PI + 360) % 360) * 100)
  }

  private finishItem() {
    const h = this.holding!
    const e = this.book.get(h.taskId, h.itemId)
    const t = this.book.tasks.get(h.taskId)?.task
    this.workDoneAt = 0
    if (!e || e.winNode !== this.id) {
      this.holding = null
      this.mode = RobotMode.IDLE
      return
    }
    const failed = this.ctx.rand() < 0.02
    const transfer = failed ? 0 : this.startEvidence(h.taskId, h.itemId)
    const p: ItemDoneP = { taskId: h.taskId, itemId: h.itemId, gen: e.gen, result: failed ? 1 : 0, evidenceTransfer: transfer }
    if (failed) {
      this.book.set({ ...e, gen: e.gen + 1, winBid: 0, winNode: null, state: ItemState.OPEN }, this.now)
    } else {
      this.book.set({ ...e, state: t?.requiresSignoff ? ItemState.AWAITING_SIGNOFF : ItemState.DONE }, this.now)
      this.events.itemDone?.(this, h.taskId, h.itemId)
    }
    this.send(MsgType.ITEM_DONE, p)
    this.holding = null
    this.mode = RobotMode.IDLE
    this.sendState()
  }

  /** Camera evidence as bulk chunks, sent only at depth 0 (5.8). */
  private startEvidence(taskId: number, itemId: number) {
    const transferId = (this.boot << 16) + this.bulkSeq++
    const count = 8
    const chunks: BulkChunkP[] = []
    for (let i = 0; i < count; i++) chunks.push({ transferId, content: 1, chunkIndex: i, chunkCount: count, itemRef: { taskId, itemId }, bytes: T.BULK_CHUNK_BYTES })
    this.bulkSent.set(transferId, chunks)
    if (this.bulkSent.size > 8) this.bulkSent.delete(this.bulkSent.keys().next().value!)
    if (this.depth === 0) for (const c of chunks) this.send(MsgType.BULK_CHUNK, c, { dst: this.site.hub })
    return transferId
  }

  private onBulkNack(p: BulkNackP) {
    const chunks = this.bulkSent.get(p.transferId)
    if (!chunks || this.depth !== 0) return
    for (const i of p.missing) if (chunks[i]) this.send(MsgType.BULK_CHUNK, chunks[i], { dst: this.site.hub })
  }

  // ---------- CBAA round (9.7) ----------

  private bidder(): BidderInfo {
    return { pos: this.reportedPos(), maxSpeed: this.cfg.maxSpeedCms, workRatePct: this.cfg.workRatePct, drainPctPerHour: this.cfg.drainPctPerHour, batteryPct: Math.floor(this.battery), health: this.health, posSource: this.posSource }
  }

  private eligibleRobot(): boolean {
    if (this.health === 2 || this.health === 1) return false // DEGRADED may bid only if the tag allows it (default: no)
    if (!this.inService || this.nodeList.nodes.get(this.id)?.inService === false) return false
    if ([RobotMode.STOPPED, RobotMode.HOLD, RobotMode.CHARGING, RobotMode.OUT_OF_SERVICE, RobotMode.MANUAL_OVERRIDE].includes(this.mode)) return false
    if (this.contact !== 'IN_CONTACT' || this.depth === 255) return false
    return true
  }

  private eligibleItem(t: Task, itemId: number, r: BidderInfo): boolean {
    if (t.tag !== this.tag || t.mode !== 'autonomous') return false
    if (t.localRadiusM && dist(r.pos, t.areaCenter) > t.localRadiusM * 10) return false
    const e = this.book.get(t.taskId, itemId)
    if (!e || (e.state !== ItemState.OPEN && e.state !== ItemState.ASSIGNED)) return false
    const it = t.items.find((i) => i.itemId === itemId)!
    if (r.batteryPct - neededPct(r, it) < t.minBattery) return false
    for (const z of this.zones.list) {
      if (!z.appliesTo.robots || z.kind === ZoneKind.COVERAGE || z.zoneId === t.zoneId) continue
      if (zoneDistance(z, it.pos) <= 0) return false
    }
    if (this.outside(it.pos) > T.COVERAGE_TOLERANCE_DM) return false
    return true
  }

  private round() {
    if (!this.powered) return
    // Phase 1: consensus.
    const inbox = this.inbox
    this.inbox = []
    for (const pkt of inbox) this.mergePacket(pkt)
    const releases = applyReleaseRule(this.book, this.owners, this.id, this.now, (n) => {
      if (!this.nodeFirstSeen.has(n)) this.nodeFirstSeen.set(n, this.now)
      return this.nodeFirstSeen.get(n)!
    })
    for (const r of releases) if (!r.held) this.send(MsgType.ITEM_RELEASED, { taskId: r.taskId, itemId: r.itemId, newGen: r.newGen, reason: r.reason } satisfies ItemReleasedP)

    // Did I lose my item?
    if (this.holding) {
      const e = this.book.get(this.holding.taskId, this.holding.itemId)
      if (!e || e.winNode !== this.id || e.state === ItemState.CANCELLED || e.state === ItemState.DONE) {
        if (e && e.state === ItemState.STARTED && this.mode !== RobotMode.IDLE) {
          this.log(`Lost ${this.holding.itemId} to ${e.winNode}; aborting.`)
        }
        this.holding = null
        this.workDoneAt = 0
        if (this.mode === RobotMode.TO_ITEM || this.mode === RobotMode.WORKING) this.mode = RobotMode.IDLE
        this.sendState()
      }
    }

    // Go charge when idle and low.
    if (!this.holding && this.mode === RobotMode.IDLE && this.battery < 20) {
      this.mode = RobotMode.CHARGING
      this.chargingTarget = this.world.spec.charger
      this.sendState()
    }

    // Phase 2: auction (only when holding nothing).
    if (!this.holding && this.eligibleRobot() && this.mode === RobotMode.IDLE && !this.returningToCoverage) {
      const r = this.bidder()
      let best: { t: Task; itemId: number; u: number } | null = null
      for (const bt of this.book.tasks.values()) {
        const t = bt.task
        if (t.tag !== this.tag || t.mode !== 'autonomous') continue
        for (const it of t.items) {
          if (!this.eligibleItem(t, it.itemId, r)) continue
          const u = utility(r, t, it, this.outside(it.pos) > 0, this.site.bid)
          const cur = this.book.get(t.taskId, it.itemId)!
          const cand: ItemEntry = { taskId: t.taskId, itemId: it.itemId, gen: cur.gen, winBid: u, winNode: this.id, state: ItemState.ASSIGNED }
          if (!beats(cand, cur) || !this.book.slotRuleAllows(t, it.itemId, u)) continue
          if (!best || u > best.u || (u === best.u && (t.taskId < best.t.taskId || (t.taskId === best.t.taskId && it.itemId < best.itemId)))) best = { t, itemId: it.itemId, u }
        }
      }
      if (best) {
        const cur = this.book.get(best.t.taskId, best.itemId)!
        this.book.set({ ...cur, winBid: best.u, winNode: this.id, state: ItemState.ASSIGNED }, this.now)
        this.holding = { taskId: best.t.taskId, itemId: best.itemId }
        this.sendState()
      }
    }

    this.book.enforceSlotCap(this.now)
    this.broadcastAuction()

    // Phase 3: start.
    if (this.holding && this.mode === RobotMode.IDLE) {
      const h = this.holding
      const e = this.book.get(h.taskId, h.itemId)
      const bt = this.book.tasks.get(h.taskId)
      if (e && bt && e.winNode === this.id && e.state === ItemState.ASSIGNED && this.now - bt.firstSeen >= T.BID_WINDOW && this.now - this.book.lastChange(h.taskId, h.itemId) >= T.STABLE_TIME && this.onboardSafetyOk()) {
        this.book.set({ ...e, state: ItemState.STARTED }, this.now)
        this.send(MsgType.ITEM_STARTED, { taskId: h.taskId, itemId: h.itemId, gen: e.gen, winBid: e.winBid } satisfies ItemStartedP)
        this.mode = RobotMode.TO_ITEM
        this.sendState()
      }
    }
  }

  private onboardSafetyOk() {
    return this.mode === RobotMode.IDLE && !this.faultActive
  }

  private mergePacket(pkt: Packet) {
    const h = pkt.h
    switch (h.type) {
      case MsgType.AUCTION_STATE:
        for (const e of (pkt.p as AuctionStateP).entries) this.book.merge(e, this.now)
        return
      case MsgType.ITEM_STARTED: {
        const p = pkt.p as ItemStartedP
        this.book.merge({ taskId: p.taskId, itemId: p.itemId, gen: p.gen, winBid: p.winBid, winNode: h.src, state: ItemState.STARTED }, this.now)
        return
      }
      case MsgType.ITEM_DONE: {
        const p = pkt.p as ItemDoneP
        const cur = this.book.get(p.taskId, p.itemId)
        if (!cur || cur.gen !== p.gen) return
        if (p.result === 0) {
          const t = this.book.tasks.get(p.taskId)?.task
          this.book.merge({ ...cur, winNode: h.src, state: t?.requiresSignoff ? ItemState.AWAITING_SIGNOFF : ItemState.DONE }, this.now)
        } else {
          this.book.merge({ taskId: p.taskId, itemId: p.itemId, gen: p.gen + 1, winBid: 0, winNode: null, state: ItemState.OPEN }, this.now)
        }
        return
      }
      case MsgType.ITEM_RELEASED: {
        const p = pkt.p as ItemReleasedP
        const cur = this.book.get(p.taskId, p.itemId)
        if (cur && p.newGen > cur.gen) this.book.merge({ taskId: p.taskId, itemId: p.itemId, gen: p.newGen, winBid: 0, winNode: null, state: ItemState.OPEN }, this.now)
        return
      }
      case MsgType.TASK_CANCEL: {
        const p = pkt.p as TaskCancelP
        this.book.cancelTask(p.taskId, this.now)
        return
      }
    }
  }

  /** AUCTION_STATE when our view changed this round, and at least every 1 s while eligible (9.4). */
  private broadcastAuction() {
    const changed = this.book.takeChanged()
    for (const bt of this.book.tasks.values()) {
      const t = bt.task
      if (t.tag !== this.tag || this.book.isComplete(t.taskId)) continue
      const last = this.lastAuctionSent.get(t.taskId) ?? -Infinity
      const due = this.now - last >= T.AUCTION_STATE_MIN_INTERVAL && this.eligibleRobot()
      const ch = changed.get(t.taskId)
      if (!due && !ch) continue
      const all = t.items.map((i) => bt.items.get(i.itemId)!)
      for (let first = 0; first < all.length; first += 55) {
        const slice = all.slice(first, first + 55)
        if (!due && !slice.some((e) => ch!.has(e.itemId))) continue
        this.send(MsgType.AUCTION_STATE, { taskId: t.taskId, revision: t.revision, firstIndex: first, entries: slice } satisfies AuctionStateP)
      }
      this.lastAuctionSent.set(t.taskId, this.now)
    }
  }

  private dropHolding(reason: number) {
    if (!this.holding) return
    const e = this.book.get(this.holding.taskId, this.holding.itemId)
    if (e && e.winNode === this.id && e.state !== ItemState.DONE && e.state !== ItemState.CANCELLED) {
      this.book.set({ taskId: e.taskId, itemId: e.itemId, gen: e.gen + 1, winBid: 0, winNode: null, state: ItemState.OPEN }, this.now)
      this.send(MsgType.ITEM_RELEASED, { taskId: e.taskId, itemId: e.itemId, newGen: e.gen + 1, reason } satisfies ItemReleasedP)
    }
    this.holding = null
    this.workDoneAt = 0
  }

  // ---------- supervisor commands (10.2–10.4) ----------

  private onCommand(pkt: Packet<SupervisorCmdP>, from: NodeId) {
    const h = pkt.h
    const c = pkt.p
    const forMe = h.dst === this.id || c.target === this.id
    const broadcastItemCmd = h.dst === BROADCAST && [Cmd.CANCEL_ITEM, Cmd.REDIRECT, Cmd.RELEASE_ITEM, Cmd.SIGN_OFF].includes(c.cmd)
    if (!forMe && !broadcastItemCmd) return
    const commander = h.src === this.site.hub && c.onBehalfOf ? c.onBehalfOf : h.src
    const isSupervisor = this.nodeList.nodes.get(commander)?.kind === NodeKind.SUPERVISOR
    const answer = forMe || (c.cmd === Cmd.REDIRECT && c.args.robot === this.id)
    const reply = (result: CmdResultP['result'], reason = 0) => {
      const res: CmdResultP = { cmdId: c.cmdId, result, reason }
      this.cmdMemory.set(c.cmdId, { res, t: this.now })
      if (this.cmdMemory.size > T.CMD_ID_MEMORY) this.cmdMemory.delete(this.cmdMemory.keys().next().value!)
      if (answer) this.sendReply(res, h, from)
    }
    // Idempotency: a repeated cmd_id gets the original result (5.7).
    const prev = this.cmdMemory.get(c.cmdId)
    if (prev && this.now - prev.t <= T.CMD_ID_MEMORY_MS) {
      if (answer) this.sendReply(prev.res, h, from)
      return
    }
    if (!isSupervisor) return reply(1, 1)
    switch (c.cmd) {
      case Cmd.RESUME:
        return reply(...this.tryResume(Number(c.args.stopId), commander, (h.flags & Flag.LOCAL_LINK) !== 0))
      case Cmd.STOP:
        this.stop(StopReason.SUPERVISOR_STOP, 0)
        return reply(0)
      case Cmd.CANCEL_ITEM:
      case Cmd.RELEASE_ITEM:
      case Cmd.SIGN_OFF: {
        const taskId = Number(c.args.taskId)
        const itemId = Number(c.args.itemId)
        const e = this.book.get(taskId, itemId)
        if (!e) return reply(2, 5)
        if (c.cmd === Cmd.CANCEL_ITEM) {
          this.book.set({ ...e, state: ItemState.CANCELLED }, this.now)
          if (this.holding?.taskId === taskId && this.holding.itemId === itemId) {
            this.holding = null
            this.workDoneAt = 0
            if (this.mode === RobotMode.TO_ITEM || this.mode === RobotMode.WORKING) this.mode = RobotMode.IDLE
            this.sendState()
          }
        } else if (c.cmd === Cmd.RELEASE_ITEM) {
          if (e.state === ItemState.HELD) this.book.set({ ...e, gen: e.gen + 1, winBid: 0, winNode: null, state: ItemState.OPEN }, this.now)
        } else if (e.state === ItemState.AWAITING_SIGNOFF) {
          if (c.args.ok) this.book.set({ ...e, state: ItemState.DONE }, this.now)
          else this.book.set({ ...e, gen: e.gen + 1, winBid: 0, winNode: null, state: ItemState.OPEN }, this.now)
        }
        return reply(0)
      }
      case Cmd.REDIRECT: {
        const taskId = Number(c.args.taskId)
        const itemId = Number(c.args.itemId)
        const robot = String(c.args.robot)
        const e = this.book.get(taskId, itemId)
        if (!e) return reply(2, 5)
        if (robot === this.id) this.dropHolding(ReleaseReason.REDIRECT)
        const gen = e.winNode && e.winNode !== robot ? e.gen + 1 : e.gen
        this.book.set({ taskId, itemId, gen, winBid: 0xffffffff, winNode: robot, state: ItemState.ASSIGNED }, this.now)
        if (robot === this.id) {
          this.holding = { taskId, itemId }
          if (this.mode === RobotMode.TO_ITEM || this.mode === RobotMode.WORKING) this.mode = RobotMode.IDLE
          this.sendState()
        }
        return reply(0)
      }
      default:
        return reply(2, 6)
    }
  }

  private sendReply(res: CmdResultP, h: Packet['h'], from: NodeId) {
    const local = (h.flags & Flag.LOCAL_LINK) !== 0
    if (local) {
      // Direct short-range link back to the tablet.
      const tablet = this.ctx.radio.get(from)
      const pkt: Packet<CmdResultP> = { h: { ...h, type: MsgType.CMD_RESULT, cls: MsgClass.CONTROL, src: this.id, srcKind: this.kind, dst: h.src, boot: this.boot, seq: this.seq++, flags: Flag.LOCAL_LINK, initialHops: 0, hopsLeft: 0, gpsTime: this.sched.gpsTime }, p: res }
      tablet?.receive(pkt, this.id, -40, 'radio')
      return
    }
    this.send(MsgType.CMD_RESULT, res, { dst: h.src })
  }

  /** Resume rules (10.3). Returns [result, reason]. */
  private tryResume(stopId: number, by: NodeId, localLink: boolean): [0 | 1 | 2, number] {
    if (this.mode !== RobotMode.STOPPED || stopId !== this.stopId) return [1, 2]
    const r = this.stopReason
    if (r === StopReason.LOW_BATTERY) return [2, 4]
    if (r === StopReason.LOST_MESH_CONTACT && this.contact !== 'IN_CONTACT') return [1, 4]
    if (r === StopReason.ZONE_BREACH) {
      const me = this.reportedPos()
      const inZone = this.zones.list.some((z) => z.appliesTo.robots && z.kind !== ZoneKind.COVERAGE && zoneDistance(z, me) - this.effFootprint() <= z.buffer)
      if (inZone) return [1, 4]
    }
    if (r === StopReason.FAULT && this.faultActive) return [1, 4]
    const onSite = [StopReason.NEAR_MISS, StopReason.PERSON_DETECTED, StopReason.COLLISION, StopReason.FAULT].includes(r)
    if (onSite && !localLink) {
      const badge = this.site.supervisors.find((s) => s.node === by)?.badge
      const t = this.crewTracks().find((x) => x.id === badge && (x.kind === TrackKind.SUPERVISOR || x.kind === TrackKind.CREW))
      if (!t || t.stale || dist(t.pos, this.reportedPos()) > T.RESUME_ON_SITE_DM) return [1, 3]
    }
    if (r === StopReason.OUT_OF_COVERAGE) this.returningToCoverage = true
    this.log(`Resumed (stop ${StopReason[r]}) by ${by}`)
    this.mode = RobotMode.IDLE
    this.stopReason = StopReason.NONE
    this.lights = false
    this.horn = false
    // Back to IDLE: re-enter the auction rather than silently continuing an item that may have been released.
    this.dropHolding(ReleaseReason.SUPERVISOR)
    this.sendState(true)
    return [0, 0]
  }

  // ---------- faults (simulator) ----------

  injectFault(on: boolean) {
    this.faultActive = on
    if (on) {
      this.health = 1
      this.stop(StopReason.FAULT, 1)
    } else this.health = 0
  }

  private log(text: string) {
    this.events.log?.(this, text)
  }
}

function predictSeparation(a: Pos, va: { x: number; y: number }, b: Pos, vb: { x: number; y: number }, horizonS: number) {
  // Positions in dm, velocities in cm/s -> dm/s = v/10.
  const rx = b.x - a.x
  const ry = b.y - a.y
  const vx = (vb.x - va.x) / 10
  const vy = (vb.y - va.y) / 10
  const v2 = vx * vx + vy * vy
  const t = v2 > 0 ? Math.max(0, Math.min(horizonS, -(rx * vx + ry * vy) / v2)) : 0
  return Math.hypot(rx + vx * t, ry + vy * t)
}

export function preloadNodeList(site: SiteConfig): Map<NodeId, NodeListEntry> {
  const m = new Map<NodeId, NodeListEntry>()
  m.set(site.hub, { node: site.hub, kind: NodeKind.HUB, tag: 0, inService: true, badge: 0 })
  for (const r of site.relays) m.set(r.node, { node: r.node, kind: r.gateway ? NodeKind.GATEWAY : NodeKind.RELAY, tag: 0, inService: true, badge: 0 })
  for (const a of site.anchors) m.set(a.node, { node: a.node, kind: NodeKind.ANCHOR, tag: 0, inService: true, badge: 0 })
  for (const r of site.robots) m.set(r.node, { node: r.node, kind: NodeKind.ROBOT, tag: r.tag, inService: true, badge: 0 })
  for (const s of site.supervisors) m.set(s.node, { node: s.node, kind: NodeKind.SUPERVISOR, tag: 0, inService: true, badge: s.badge })
  return m
}

