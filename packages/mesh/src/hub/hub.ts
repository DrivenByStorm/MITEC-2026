// The hub mesh service (section 11). It sits between the two gateways and the twin:
// keeps the latest state of every node, task, item, zone and track; computes liveness and
// NODE_LOST groups (7.3); runs fusion and broadcasts TRACKS (8.5); owns ZONE_SET and
// NODE_LIST (8.6, 10.5); publishes and rebroadcasts tasks and runs the CBAA merge and release
// rule without bidding (9); detects shortfalls (9.11); sends and escalates alerts (10.1);
// applies supervisor commands addressed to it (10.2); keeps the event log; serves the twin (12).

import { T } from '../constants.js'
import { AuctionBook, NEEDS_RESUME, applyReleaseRule, updateOwner } from '../cbaa.js'
import type { OwnerView } from '../cbaa.js'
import { dist, multilaterate, zoneDistance } from '../geometry.js'
import { MeshNode, ReplayWindow } from '../nodes/base.js'
import type { NodeContext } from '../nodes/base.js'
import { preloadNodeList } from '../nodes/robot.js'
import type {
  Alert,
  AlertAckP,
  AlertP,
  AuctionStateP,
  BulkChunkP,
  CmdResultP,
  ItemDoneP,
  ItemEntry,
  ItemReleasedP,
  ItemStartedP,
  LidarObjectsP,
  MeshEvent,
  MeshSnapshot,
  NearMissP,
  NodeId,
  NodeListEntry,
  NodeListP,
  NodeLostP,
  Packet,
  Pos,
  RelayStatus,
  RobotState,
  SafetyStopP,
  SiteConfig,
  SupervisorCmdP,
  SupervisorStateP,
  Task,
  TaskP,
  Track,
  TracksP,
  UwbRangesP,
  Zone,
  ZoneBreachP,
  ZoneSetP,
} from '../types.js'
import { AlertKind, BROADCAST, Cmd, ItemState, Liveness, MsgClass, MsgType, NodeKind, RobotMode, StopReason, TrackKind, ZoneKind, msgId } from '../types.js'

interface NodeInfo {
  id: NodeId
  kind: NodeKind
  name: string
  lastHeard: number // sim ms
  pos: Pos | null
  liveness: Liveness
  robot?: RobotState
  relay?: RelayStatus
  supervisor?: { badgeId: number; onShift: boolean }
  lastVia?: NodeId | null
  holdSince?: number
  holdAlerted?: boolean
}

interface BadgeTrack {
  badge: number
  kind: TrackKind
  pos: Pos | null
  acc: number // cm
  vx: number
  vy: number
  lastFix: number
  radius: number
}

interface UnknownTrack {
  id: number
  pos: Pos
  radius: number
  vx: number
  vy: number
  firstSeen: number
  lastSeen: number
  conf: number
}

interface PendingAlert {
  alert: Alert
  cls: MsgClass
  timer?: ReturnType<MeshNode['sched']['after']>
  broadcastDone?: boolean
}

export interface LogEntry {
  at: number // gps time
  kind: string
  text: string
  synced: boolean
}

/** Alert kind -> severity and class (10.1). */
const ALERT_META: Record<AlertKind, { severity: 0 | 1 | 2; cls: MsgClass }> = {
  [AlertKind.NODE_LOST]: { severity: 2, cls: MsgClass.SAFETY },
  [AlertKind.NEAR_MISS]: { severity: 2, cls: MsgClass.SAFETY },
  [AlertKind.CREW_IN_ZONE]: { severity: 2, cls: MsgClass.SAFETY },
  [AlertKind.STOP_NEEDS_RESUME]: { severity: 1, cls: MsgClass.SAFETY },
  [AlertKind.CREW_HOLD_LONG]: { severity: 1, cls: MsgClass.CONTROL },
  [AlertKind.POSITION_MISMATCH]: { severity: 1, cls: MsgClass.SAFETY },
  [AlertKind.SHORTFALL]: { severity: 1, cls: MsgClass.CONTROL },
  [AlertKind.ITEM_FAILED]: { severity: 1, cls: MsgClass.CONTROL },
  [AlertKind.DUPLICATE_START]: { severity: 1, cls: MsgClass.CONTROL },
  [AlertKind.MANUAL_TASK]: { severity: 0, cls: MsgClass.CONTROL },
  [AlertKind.SIGNOFF_NEEDED]: { severity: 0, cls: MsgClass.CONTROL },
}

export class HubNode extends MeshNode {
  readonly site: SiteConfig
  nodes = new Map<NodeId, NodeInfo>()
  book = new AuctionBook()
  owners = new Map<NodeId, OwnerView>()
  zones: { version: number; list: Zone[] } = { version: 0, list: [] }
  private nextZoneId = 1
  nodeList: { version: number; nodes: Map<NodeId, NodeListEntry> }
  tracks: { version: number; list: Track[] } = { version: 0, list: [] }
  private badgeTracks = new Map<number, BadgeTrack>()
  private unknowns: UnknownTrack[] = []
  private unknownSeq = 1
  private uwb: { anchor: Pos; acc: number; badge: number; range: number; quality: number; t: number }[] = []
  private lidar = new Map<NodeId, { p: LidarObjectsP; t: number }>()
  private mismatch = new Map<NodeId, number>()
  private crewInZone = new Map<string, number>()
  alerts: PendingAlert[] = []
  private alertSeq = 1
  private lostPending: { id: NodeId; at: number }[] = []
  private groupSeq = 1
  private lostGrouped = new Set<NodeId>()
  private shortfall = new Map<number, { since: number | null; lastAlert: number; deficit: number }>()
  private openTasks = new Map<number, { task: Task; postedAt: number; lastBroadcast: number; manual: boolean }>()
  private bulk = new Map<number, { robot: NodeId; got: Set<number>; count: number; last: number; nacks: number; done: boolean }>()
  private replay = new ReplayWindow()
  private endpointVia = new Map<NodeId, { relay: NodeId; rssi: number; at: number }>()
  private pendingCmds = new Map<number, { resolve: (r: CmdResultP | null) => void; tries: number; timer?: ReturnType<MeshNode['sched']['after']>; pkt: SupervisorCmdP; dst: NodeId; cls: MsgClass }>()
  log: LogEntry[] = []
  starlinkUp = true
  lastHqSync = 0
  private listeners = new Set<(e: MeshEvent) => void>()
  /** Called when a task finishes (the planning software decides what comes next). */
  onTaskComplete?: (taskId: number) => void
  onItemDone?: (taskId: number, itemId: number, robot: NodeId) => void

  constructor(ctx: NodeContext, site: SiteConfig) {
    super(ctx, site.hub, NodeKind.HUB, 'Hub', site.relays.find((r) => r.gateway)?.pos ?? { x: 0, y: 0 })
    this.site = site
    this.nodeList = { version: 1, nodes: preloadNodeList(site) }
    const add = (id: NodeId, kind: NodeKind, name: string, pos: Pos | null) => this.nodes.set(id, { id, kind, name, lastHeard: 0, pos, liveness: Liveness.FRESH })
    for (const r of site.relays) add(r.node, r.gateway ? NodeKind.GATEWAY : NodeKind.RELAY, r.name, r.pos)
    for (const a of site.anchors) add(a.node, NodeKind.ANCHOR, a.name, a.pos)
    for (const r of site.robots) add(r.node, NodeKind.ROBOT, r.name, null)
    for (const s of site.supervisors) add(s.node, NodeKind.SUPERVISOR, s.name, null)
    for (const b of site.badges) this.badgeTracks.set(b.badge, { badge: b.badge, kind: b.kind === 'machine' ? TrackKind.MACHINE : b.kind === 'supervisor' ? TrackKind.SUPERVISOR : TrackKind.CREW, pos: null, acc: 0, vx: 0, vy: 0, lastFix: -Infinity, radius: b.radiusDm ?? 4 })
    // Survey hazards are permanent HAZARD zones for robots and crew (6.4, 8.6).
    for (const h of site.hazards) this.addZone({ kind: ZoneKind.HAZARD, appliesTo: { robots: true, crew: true }, shape: { polygon: h.polygon }, buffer: 20, slowBand: 50, until: 0, setBy: site.hub }, false)
  }

  override start() {
    this.every(500, () => this.checkLiveness())
    this.every(T.TRACKS_INTERVAL, () => this.fusion())
    this.every(T.ZONE_SET_REBROADCAST, () => this.broadcastZones())
    this.every(T.NODE_LIST_REBROADCAST, () => this.broadcastNodeList())
    this.every(T.CBAA_ROUND, () => this.cbaa())
    this.every(1000, () => this.rebroadcastTasks())
    this.every(T.HUB_AUCTION_STATE_INTERVAL, () => this.broadcastAuctionStates())
    this.every(T.SHORTFALL_CHECK, () => this.checkShortfall())
    this.every(1000, () => this.checkBulk())
    this.every(5000, () => this.syncHq())
    this.sched.after(500, () => {
      this.broadcastNodeList()
      this.broadcastZones()
    })
  }

  // ---------- transport ----------

  /** The hub sends every packet it originates to both gateways (5.5). */
  protected override transmitOwn(pkt: Packet) {
    if (!this.powered) return
    this.ctx.radio.wireSend(this, pkt)
  }

  protected hasOtherNeighbors() {
    return false
  }

  onEvent(fn: (e: MeshEvent) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: MeshEvent) {
    for (const l of this.listeners) l(e)
  }

  private record(kind: string, text: string) {
    this.log.push({ at: this.sched.gpsTime, kind, text, synced: false })
    if (this.log.length > 5000) this.log.splice(0, this.log.length - 5000)
  }

  receive(pkt: Packet, _from: NodeId, _rssi: number, iface: 'radio' | 'wire') {
    if (!this.powered || iface !== 'wire' || !this.valid(pkt)) return
    const id = msgId(pkt.h)
    if (this.seen.has(id, this.now)) return // second copy from the other gateway
    if (this.replay.checkAndRecord(pkt.h)) return
    this.seen.insert(id, this.now)
    if (pkt.h.dst !== BROADCAST && pkt.h.dst !== this.id) {
      this.watchOther(pkt)
      return
    }
    this.process(pkt)
  }

  /** Packets addressed to someone else still tell the hub things (command results, acks). */
  private watchOther(pkt: Packet) {
    if (pkt.h.type === MsgType.ALERT_ACK) this.onAck(pkt.h.src, pkt.p as AlertAckP)
    if (pkt.h.type === MsgType.CMD_RESULT) this.emitPacket(pkt)
  }

  private emitPacket(pkt: Packet) {
    if (pkt.h.cls === MsgClass.STATUS) return
    this.emit({ kind: 'packet', at: this.sched.gpsTime, h: pkt.h, summary: summarize(pkt) })
  }

  private heard(id: NodeId, kind: NodeKind) {
    const n = this.nodes.get(id)
    if (!n) return
    n.lastHeard = this.now
    if (n.liveness !== Liveness.FRESH) {
      if (n.liveness === Liveness.LOST) this.record('liveness', `${n.name} is back.`)
      n.liveness = Liveness.FRESH
      this.lostGrouped.delete(id)
    }
    void kind
  }

  private process(pkt: Packet) {
    const h = pkt.h
    this.emitPacket(pkt)
    switch (h.type) {
      case MsgType.RELAY_STATUS: {
        const st = pkt.p as RelayStatus
        const n = this.nodes.get(h.src)
        if (n) n.relay = st
        this.heard(h.src, h.srcKind)
        // Endpoints without a state message that names their relay (anchors, tablets): their attached
        // relay is the one that hears them best directly, from the relays' neighbor tables (7.2), so
        // their losses can be grouped by cause too (7.3).
        for (const nb of st.neighbors) {
          if (nb.kind !== NodeKind.ANCHOR && nb.kind !== NodeKind.SUPERVISOR) continue
          const e = this.nodes.get(nb.node)
          if (!e) continue
          const cur = this.endpointVia.get(nb.node)
          if (!cur || cur.relay === h.src || nb.rssi > cur.rssi || this.now - cur.at > 10_000) {
            this.endpointVia.set(nb.node, { relay: h.src, rssi: nb.rssi, at: this.now })
            e.lastVia = h.src
          }
        }
        return
      }
      case MsgType.ROBOT_STATE: {
        const s = pkt.p as RobotState
        const n = this.nodes.get(h.src)
        if (n) {
          n.robot = s
          n.pos = s.pos
          n.lastVia = s.via
          if (s.mode === RobotMode.HOLD && s.stopReason === StopReason.CREW_HOLD) n.holdSince ??= this.now
          else {
            n.holdSince = undefined
            n.holdAlerted = false
          }
        }
        updateOwner(this.owners, h.src, s, this.now)
        this.heard(h.src, h.srcKind)
        return
      }
      case MsgType.SUPERVISOR_STATE: {
        const s = pkt.p as SupervisorStateP
        const n = this.nodes.get(h.src)
        if (n) {
          n.supervisor = { badgeId: s.badgeId, onShift: s.onShift }
          n.pos = s.pos
        }
        this.heard(h.src, h.srcKind)
        return
      }
      case MsgType.UWB_RANGES: {
        const p = pkt.p as UwbRangesP
        for (const r of p.ranges) this.uwb.push({ anchor: p.anchorPos, acc: p.anchorAcc, badge: r.badge, range: r.range, quality: r.quality, t: this.now })
        if (h.srcKind === NodeKind.ANCHOR) this.heard(h.src, h.srcKind)
        return
      }
      case MsgType.LIDAR_OBJECTS:
        this.lidar.set(h.src, { p: pkt.p as LidarObjectsP, t: this.now })
        return
      case MsgType.SAFETY_STOP: {
        const p = pkt.p as SafetyStopP
        const n = this.nodes.get(h.src)
        this.emit({ kind: 'stop', at: this.sched.gpsTime, node: h.src, stopId: p.stopId, reason: p.stopReason, pos: p.pos })
        this.record('stop', `${n?.name ?? h.src} stopped: ${StopReason[p.stopReason]}.`)
        if (NEEDS_RESUME.has(p.stopReason)) this.raiseAlert(AlertKind.STOP_NEEDS_RESUME, p.pos, [h.src], p.taskId, p.itemId, p.stopId)
        return
      }
      case MsgType.NEAR_MISS: {
        const p = pkt.p as NearMissP
        this.emit({ kind: 'near_miss', at: this.sched.gpsTime, eventId: p.eventId, pos: p.pos, involved: p.involved.map((i) => i.id) })
        this.record('near_miss', `Near miss: ${p.involved.map((i) => this.nameOf(i.id)).join(', ')} (${(p.minDistance / 100).toFixed(1)} m).`)
        this.raiseAlert(AlertKind.NEAR_MISS, p.pos, p.involved.map((i) => i.id), 0, 0, p.eventId)
        return
      }
      case MsgType.ZONE_BREACH: {
        const p = pkt.p as ZoneBreachP
        this.emit({ kind: 'zone_breach', at: this.sched.gpsTime, subject: p.subjectId, zoneId: p.zoneId, pos: p.pos })
        this.record('zone_breach', `${this.nameOf(p.subjectId)} breached zone ${p.zoneId}.`)
        return
      }
      case MsgType.AUCTION_STATE:
        for (const e of (pkt.p as AuctionStateP).entries) this.mergeEntry(e)
        return
      case MsgType.ITEM_STARTED: {
        const p = pkt.p as ItemStartedP
        const cur = this.book.get(p.taskId, p.itemId)
        if (cur && cur.state === ItemState.STARTED && cur.gen === p.gen && cur.winNode && cur.winNode !== h.src) {
          this.raiseAlert(AlertKind.DUPLICATE_START, this.book.item(p.taskId, p.itemId)?.pos ?? { x: 0, y: 0 }, [cur.winNode, h.src], p.taskId, p.itemId, p.gen)
        }
        this.mergeEntry({ taskId: p.taskId, itemId: p.itemId, gen: p.gen, winBid: p.winBid, winNode: h.src, state: ItemState.STARTED })
        return
      }
      case MsgType.ITEM_DONE: {
        const p = pkt.p as ItemDoneP
        const cur = this.book.get(p.taskId, p.itemId)
        const t = this.openTasks.get(p.taskId)?.task
        if (!cur || cur.gen !== p.gen) return
        if (p.result === 0) {
          const state = t?.requiresSignoff ? ItemState.AWAITING_SIGNOFF : ItemState.DONE
          this.mergeEntry({ ...cur, winNode: h.src, state })
          this.onItemDone?.(p.taskId, p.itemId, h.src)
          if (state === ItemState.AWAITING_SIGNOFF) this.raiseAlert(AlertKind.SIGNOFF_NEEDED, this.book.item(p.taskId, p.itemId)!.pos, [h.src], p.taskId, p.itemId, 0)
        } else {
          this.mergeEntry({ taskId: p.taskId, itemId: p.itemId, gen: p.gen + 1, winBid: 0, winNode: null, state: ItemState.OPEN })
          this.raiseAlert(AlertKind.ITEM_FAILED, this.book.item(p.taskId, p.itemId)?.pos ?? { x: 0, y: 0 }, [h.src], p.taskId, p.itemId, 0)
        }
        return
      }
      case MsgType.ITEM_RELEASED: {
        const p = pkt.p as ItemReleasedP
        const cur = this.book.get(p.taskId, p.itemId)
        if (cur && p.newGen > cur.gen) this.mergeEntry({ taskId: p.taskId, itemId: p.itemId, gen: p.newGen, winBid: 0, winNode: null, state: ItemState.OPEN })
        return
      }
      case MsgType.ALERT_ACK:
        this.onAck(h.src, pkt.p as AlertAckP)
        return
      case MsgType.SUPERVISOR_CMD:
        this.onCommand(pkt as Packet<SupervisorCmdP>)
        return
      case MsgType.CMD_RESULT: {
        const r = pkt.p as CmdResultP
        const e = this.pendingCmds.get(r.cmdId)
        if (e) {
          this.sched.cancel(e.timer)
          this.pendingCmds.delete(r.cmdId)
          e.resolve(r)
        }
        return
      }
      case MsgType.BULK_CHUNK:
        this.onBulk(h.src, pkt.p as BulkChunkP)
        return
    }
  }

  nameOf(id: string) {
    return this.nodes.get(id)?.name ?? this.site.badges.find((b) => String(b.badge) === id)?.name ?? id
  }

  // ---------- items ----------

  private mergeEntry(e: ItemEntry) {
    const before = this.book.get(e.taskId, e.itemId)
    if (this.book.merge(e, this.now)) {
      const after = this.book.get(e.taskId, e.itemId)!
      if (!before || before.state !== after.state || before.winNode !== after.winNode || before.gen !== after.gen) {
        this.emit({ kind: 'item', at: this.sched.gpsTime, entry: { ...after } })
        if (!before || before.state !== after.state) this.record('item', `Task ${e.taskId} item ${e.itemId}: ${ItemState[after.state]}${after.winNode ? ` (${this.nameOf(after.winNode)})` : ''}.`)
      }
    }
  }

  /** Same consensus merge and release rule as the robots (9.7 phase 1, 9.9), but the hub never bids. */
  private cbaa() {
    const releases = applyReleaseRule(this.book, this.owners, null, this.now, () => 0)
    for (const r of releases) {
      const e = this.book.get(r.taskId, r.itemId)!
      this.emit({ kind: 'item', at: this.sched.gpsTime, entry: { ...e } })
      if (!r.held) this.send(MsgType.ITEM_RELEASED, { taskId: r.taskId, itemId: r.itemId, newGen: r.newGen, reason: r.reason } satisfies ItemReleasedP)
      this.record('item', `Task ${r.taskId} item ${r.itemId} ${r.held ? 'held' : 'released'} (reason ${r.reason}).`)
    }
    for (const [taskId, o] of this.openTasks) {
      if (!o.manual && this.book.isComplete(taskId)) {
        this.openTasks.delete(taskId)
        this.record('task', `Task ${taskId} complete.`)
        this.onTaskComplete?.(taskId)
      }
    }
    // CREW_HOLD lasting more than 60 s (8.7).
    for (const n of this.nodes.values()) {
      if (n.holdSince !== undefined && !n.holdAlerted && this.now - n.holdSince > T.CREW_HOLD_LONG && n.robot) {
        n.holdAlerted = true
        this.raiseAlert(AlertKind.CREW_HOLD_LONG, n.robot.pos, [n.id], n.robot.taskId, n.robot.itemId, 0)
      }
    }
  }

  // ---------- tasks (9.2) ----------

  /** Publish a task from the planning software. Autonomous tasks are auctioned; manual ones go to a supervisor. */
  publishTask(task: Task) {
    const manual = task.mode === 'manual'
    this.openTasks.set(task.taskId, { task, postedAt: this.now, lastBroadcast: this.now, manual })
    if (!manual) {
      this.book.addTask({ ...task, slice: 0, slices: 1 }, this.now)
      this.sendTask(task)
      this.record('task', `Published task ${task.taskId} (${task.items.length} items, up to ${task.robotCount} robots).`)
    } else {
      this.raiseAlert(AlertKind.MANUAL_TASK, task.areaCenter, [], task.taskId, 0, task.items.length, task.areaCenter)
      this.record('task', `Manual task ${task.taskId} sent to a supervisor.`)
    }
  }

  cancelTask(taskId: number) {
    this.book.cancelTask(taskId, this.now)
    this.send(MsgType.TASK_CANCEL, { taskId })
    this.openTasks.delete(taskId)
  }

  private sendTask(task: Task) {
    const slices = Math.max(1, Math.ceil(task.items.length / 60))
    for (let i = 0; i < slices; i++) {
      const p: TaskP = { ...task, items: task.items.slice(i * 60, i * 60 + 60), slice: i, slices }
      this.send(MsgType.TASK, p)
    }
  }

  private rebroadcastTasks() {
    for (const o of this.openTasks.values()) {
      if (o.manual || this.now - o.lastBroadcast < T.TASK_REBROADCAST) continue
      o.lastBroadcast = this.now
      this.sendTask(o.task)
    }
  }

  private broadcastAuctionStates() {
    for (const o of this.openTasks.values()) {
      if (o.manual) continue
      const bt = this.book.tasks.get(o.task.taskId)
      if (!bt) continue
      const all = bt.task.items.map((i) => bt.items.get(i.itemId)!)
      for (let first = 0; first < all.length; first += 55) this.send(MsgType.AUCTION_STATE, { taskId: o.task.taskId, revision: bt.task.revision, firstIndex: first, entries: all.slice(first, first + 55) } satisfies AuctionStateP)
    }
  }

  /** Shortfall (9.11). */
  private checkShortfall() {
    for (const o of this.openTasks.values()) {
      if (o.manual || this.now - o.postedAt < T.BID_WINDOW + T.STABLE_TIME) continue
      const bt = this.book.tasks.get(o.task.taskId)
      if (!bt) continue
      const entries = [...bt.items.values()]
      const open = entries.filter((e) => e.state === ItemState.OPEN).length
      const working = entries.filter((e) => e.state === ItemState.ASSIGNED || e.state === ItemState.STARTED).length
      const deficit = Math.min(o.task.robotCount, working + open) - working
      const s = this.shortfall.get(o.task.taskId) ?? { since: null, lastAlert: -Infinity, deficit: 0 }
      s.deficit = Math.max(0, deficit)
      if (deficit > 0) {
        s.since ??= this.now
        if (this.now - s.since >= T.SHORTFALL_DELAY && this.now - s.lastAlert >= T.SHORTFALL_REPEAT) {
          s.lastAlert = this.now
          this.raiseAlert(AlertKind.SHORTFALL, o.task.areaCenter, [], o.task.taskId, 0, deficit)
        }
      } else s.since = null
      this.shortfall.set(o.task.taskId, s)
    }
  }

  // ---------- liveness (7.3) ----------

  private thresholds(kind: NodeKind): [number, number] {
    switch (kind) {
      case NodeKind.ROBOT:
        return [T.ROBOT_LATE, T.ROBOT_LOST]
      case NodeKind.SUPERVISOR:
        return [T.SUPERVISOR_LATE, T.SUPERVISOR_LOST]
      case NodeKind.ANCHOR:
        return [T.ANCHOR_LATE, T.ANCHOR_LOST]
      default:
        return [T.RELAY_LATE, T.RELAY_LOST]
    }
  }

  private checkLiveness() {
    for (const n of this.nodes.values()) {
      if (n.kind === NodeKind.HUB) continue
      const age = this.now - n.lastHeard
      const [late, lost] = this.thresholds(n.kind)
      const next = age >= lost ? Liveness.LOST : age >= late ? Liveness.LATE : Liveness.FRESH
      if (next === Liveness.LOST && n.liveness !== Liveness.LOST) this.lostPending.push({ id: n.id, at: this.now })
      n.liveness = next
    }
    // Group losses after ALERT_GROUP_WINDOW.
    if (this.lostPending.length && this.now - this.lostPending[0].at >= T.ALERT_GROUP_WINDOW) {
      const batch = this.lostPending.filter((l) => !this.lostGrouped.has(l.id))
      this.lostPending = []
      if (batch.length) this.groupLosses(batch.map((b) => b.id))
    }
  }

  private groupLosses(ids: NodeId[]) {
    const lost = (k: NodeKind) => [...this.nodes.values()].filter((n) => n.kind === k && n.liveness === Liveness.LOST).map((n) => n.id)
    const gateways = this.site.gateways
    const groups: { cause: 0 | 1 | 2; causeNode: NodeId | null; nodes: NodeId[] }[] = []
    if (gateways.length && gateways.every((g) => this.nodes.get(g)?.liveness === Liveness.LOST)) {
      groups.push({ cause: 2, causeNode: null, nodes: ids })
    } else {
      const lostRelays = new Set([...lost(NodeKind.RELAY), ...lost(NodeKind.GATEWAY)])
      const remaining = new Set(ids)
      const allLost = [...this.nodes.values()].filter((n) => n.liveness === Liveness.LOST)
      for (const r of lostRelays) {
        // Every lost endpoint whose last via is this relay, including ones already reported as UNKNOWN
        // (a robot goes LOST after 5 s, its relay only after 15 s).
        const members = allLost.filter((n) => n.id === r || n.lastVia === r).map((n) => n.id)
        if (!members.some((m) => remaining.has(m))) continue
        members.forEach((m) => remaining.delete(m))
        groups.push({ cause: 1, causeNode: r, nodes: members })
      }
      if (remaining.size) groups.push({ cause: 0, causeNode: null, nodes: [...remaining] })
    }
    for (const g of groups) {
      const groupId = this.groupSeq++
      g.nodes.forEach((n) => this.lostGrouped.add(n))
      const p: NodeLostP = {
        groupId,
        cause: g.cause,
        causeNode: g.causeNode,
        nodes: g.nodes.slice(0, 32).map((id) => {
          const n = this.nodes.get(id)!
          return { node: id, kind: n.kind, lastPos: n.pos, lastTask: n.robot?.taskId ?? 0, lastItem: n.robot?.itemId ?? 0, lastHeardMs: Math.round(this.now - n.lastHeard) }
        }),
      }
      this.send(MsgType.NODE_LOST, p)
      this.emit({ kind: 'node_lost', at: this.sched.gpsTime, groupId, cause: g.cause, causeNode: g.causeNode, nodes: g.nodes })
      const causeName = g.causeNode ? this.nameOf(g.causeNode) : ''
      this.record('node_lost', g.cause === 1 ? `${causeName} down: ${g.nodes.filter((n) => n !== g.causeNode).length} node(s) lost with it.` : g.cause === 2 ? 'Hub isolated: both gateways lost.' : `Lost: ${g.nodes.map((n) => this.nameOf(n)).join(', ')}.`)
      const pos = (g.causeNode && this.nodes.get(g.causeNode)?.pos) || this.nodes.get(g.nodes[0])?.pos || { x: 0, y: 0 }
      this.raiseAlert(AlertKind.NODE_LOST, pos, g.nodes, 0, 0, groupId)
    }
  }

  // ---------- fusion and TRACKS (8.5) ----------

  private fusion() {
    if (!this.powered) return
    const now = this.now
    this.uwb = this.uwb.filter((u) => now - u.t <= 1000)
    // Crew, supervisor and machine positions from UWB.
    for (const bt of this.badgeTracks.values()) {
      const obs = this.uwb.filter((u) => u.badge === bt.badge && now - u.t <= T.UWB_RANGE_WINDOW && u.acc <= T.UWB_MAX_ANCHOR_ACC_CM)
      const uniq: typeof obs = []
      for (const o of obs) if (!uniq.some((q) => dist(q.anchor, o.anchor) < T.UWB_ANCHOR_MIN_SEPARATION_DM)) uniq.push(o)
      const fix = uniq.length >= 3 ? multilaterate(uniq.map((o) => ({ anchor: o.anchor, range: o.range / 10, w: o.quality })), bt.pos) : null
      if (fix) {
        const meanAcc = uniq.reduce((t, o) => t + o.acc, 0) / uniq.length
        if (bt.pos && now - bt.lastFix < 3000) {
          const dt = (now - bt.lastFix) / 1000
          bt.vx = Math.round(((fix.pos.x - bt.pos.x) * 10) / dt)
          bt.vy = Math.round(((fix.pos.y - bt.pos.y) * 10) / dt)
        }
        bt.pos = fix.pos
        bt.acc = Math.round(fix.rms * 10 + meanAcc)
        bt.lastFix = now
      } else if (bt.pos) {
        bt.acc += 100 // 1 m/s uncertainty growth at a 1 s fusion rate
      }
    }
    // Robot cross-check by neighbors' lidar, and unknown objects.
    const robots = [...this.nodes.values()].filter((n) => n.kind === NodeKind.ROBOT && n.robot && n.liveness !== Liveness.LOST)
    const crew = [...this.badgeTracks.values()].filter((b) => b.pos && now - b.lastFix < T.UWB_STALE)
    const fresh = [...this.lidar.entries()].filter(([, l]) => now - l.t <= 1000)
    for (const r of robots) {
      // Each other robot's lidar: the detection nearest R's reported position that isn't better
      // explained by another robot or a crew track.
      const obs: Pos[] = []
      for (const [src, l] of fresh) {
        if (src === r.id) continue
        let best: Pos | null = null
        let bestD = Infinity
        for (const o of l.p.objects) {
          if (o.cls !== 2 && o.cls !== 0) continue
          const d = dist(o.pos, r.robot!.pos)
          if (d > r.robot!.footprint + T.CROSS_CHECK_EXTRA_DM + 60 || d >= bestD) continue
          const other = robots.some((q) => q !== r && q.id !== src && dist(o.pos, q.robot!.pos) < d)
          const crewNear = crew.some((b) => dist(o.pos, b.pos!) < d)
          if (other || crewNear) continue
          best = o.pos
          bestD = d
        }
        if (best) obs.push(best)
      }
      if (obs.length >= 2) {
        const mean = { x: obs.reduce((t, p) => t + p.x, 0) / obs.length, y: obs.reduce((t, p) => t + p.y, 0) / obs.length }
        if (dist(mean, r.robot!.pos) > T.POS_MISMATCH_DM) {
          const since = this.mismatch.get(r.id) ?? now
          this.mismatch.set(r.id, since)
          if (now - since >= T.POS_MISMATCH_MS && now - since < T.POS_MISMATCH_MS + T.TRACKS_INTERVAL) {
            this.raiseAlert(AlertKind.POSITION_MISMATCH, mean, [r.id], r.robot!.taskId, r.robot!.itemId, 0)
            this.unknowns.push({ id: this.unknownSeq++, pos: { x: Math.round(mean.x), y: Math.round(mean.y) }, radius: r.robot!.footprint, vx: 0, vy: 0, firstSeen: now - T.UNKNOWN_TRACK_MIN_MS, lastSeen: now, conf: 80 })
          }
        } else this.mismatch.delete(r.id)
      } else this.mismatch.delete(r.id)
    }
    for (const [, l] of fresh) {
      for (const o of l.p.objects) {
        if (o.cls === 3) continue
        const nearRobot = robots.some((r) => dist(o.pos, r.robot!.pos) <= r.robot!.footprint + T.UNKNOWN_MATCH_DM)
        const nearCrew = crew.some((b) => dist(o.pos, b.pos!) <= b.radius + T.UNKNOWN_MATCH_DM)
        if (nearRobot || nearCrew) continue
        const u = this.unknowns.find((x) => dist(x.pos, o.pos) <= T.UNKNOWN_MERGE_DM + x.radius)
        if (u) {
          const w = o.confidence / (o.confidence + u.conf)
          u.pos = { x: Math.round(u.pos.x * (1 - w) + o.pos.x * w), y: Math.round(u.pos.y * (1 - w) + o.pos.y * w) }
          u.vx = o.vx
          u.vy = o.vy
          u.lastSeen = now
          u.conf = Math.max(u.conf, o.confidence)
        } else this.unknowns.push({ id: this.unknownSeq++, pos: { ...o.pos }, radius: o.radius, vx: o.vx, vy: o.vy, firstSeen: now, lastSeen: now, conf: o.confidence })
      }
    }
    this.unknowns = this.unknowns.filter((u) => now - u.lastSeen <= T.UNKNOWN_TRACK_TIMEOUT)

    const list: Track[] = []
    for (const b of this.badgeTracks.values()) {
      if (!b.pos) continue
      list.push({ kind: b.kind, id: b.badge, pos: b.pos, radius: b.radius, vx: b.vx, vy: b.vy, acc: b.acc, stale: now - b.lastFix > T.UWB_STALE })
    }
    for (const u of this.unknowns) if (now - u.firstSeen >= T.UNKNOWN_TRACK_MIN_MS) list.push({ kind: TrackKind.UNKNOWN, id: 100000 + u.id, pos: u.pos, radius: u.radius, vx: u.vx, vy: u.vy, acc: 50, stale: false })
    const version = this.tracks.version + 1
    this.tracks = { version, list }
    const parts = Math.max(1, Math.ceil(list.length / 44))
    for (let i = 0; i < parts; i++) this.send(MsgType.TRACKS, { tracksVersion: version, part: i, parts, tracks: list.slice(i * 44, i * 44 + 44) } satisfies TracksP)
    this.checkCrewZones(list)
  }

  /** Crew breaches (8.7): a crew, supervisor or machine track inside a crew-excluded zone for 2 s. */
  private checkCrewZones(list: Track[]) {
    const inside = new Set<string>()
    for (const t of list) {
      if (t.kind === TrackKind.UNKNOWN || t.stale) continue
      for (const z of this.zones.list) {
        if (!z.appliesTo.crew || z.kind === ZoneKind.COVERAGE) continue
        if (zoneDistance(z, t.pos) > 0) continue
        const key = `${t.id}/${z.zoneId}`
        inside.add(key)
        const since = this.crewInZone.get(key)
        if (since === undefined) this.crewInZone.set(key, this.now)
        else if (since >= 0 && this.now - since >= T.CREW_BREACH_MS) {
          this.crewInZone.set(key, -1) // reported
          const p: ZoneBreachP = { subjectKind: t.kind === TrackKind.MACHINE ? 3 : 2, subjectId: String(t.id), zoneId: z.zoneId, pos: t.pos, stopId: 0 }
          this.send(MsgType.ZONE_BREACH, p)
          this.emit({ kind: 'zone_breach', at: this.sched.gpsTime, subject: String(t.id), zoneId: z.zoneId, pos: t.pos })
          this.record('zone_breach', `${this.nameOf(String(t.id))} entered zone ${z.zoneId} (${ZoneKind[z.kind]}).`)
          this.raiseAlert(AlertKind.CREW_IN_ZONE, t.pos, [String(t.id)], 0, 0, z.zoneId)
        }
      }
    }
    for (const k of this.crewInZone.keys()) if (!inside.has(k)) this.crewInZone.delete(k)
  }

  // ---------- zones (8.6) and NODE_LIST (10.5) ----------

  addZone(z: Omit<Zone, 'zoneId'>, broadcast = true): number {
    const zoneId = this.nextZoneId++
    this.zones = { version: this.zones.version + 1, list: [...this.zones.list, { ...z, zoneId }] }
    if (broadcast) this.broadcastZones()
    return zoneId
  }

  removeZone(zoneId: number): boolean {
    if (!this.zones.list.some((z) => z.zoneId === zoneId)) return false
    this.zones = { version: this.zones.version + 1, list: this.zones.list.filter((z) => z.zoneId !== zoneId) }
    this.broadcastZones()
    return true
  }

  private broadcastZones() {
    // Expire timed zones.
    const live = this.zones.list.filter((z) => !z.until || z.until > this.sched.gpsTime)
    if (live.length !== this.zones.list.length) this.zones = { version: this.zones.version + 1, list: live }
    const parts: Zone[][] = [[]]
    let size = 8
    for (const z of this.zones.list) {
      const bytes = 'circle' in z.shape ? 34 : 24 + 8 * z.shape.polygon.length
      if (size + bytes > 985) {
        parts.push([])
        size = 8
      }
      parts[parts.length - 1].push(z)
      size += bytes
    }
    parts.forEach((zones, part) => this.send(MsgType.ZONE_SET, { zoneSetVersion: this.zones.version, part, parts: parts.length, zones } satisfies ZoneSetP))
  }

  private broadcastNodeList() {
    const all = [...this.nodeList.nodes.values()]
    const parts = Math.max(1, Math.ceil(all.length / 69))
    for (let i = 0; i < parts; i++) this.send(MsgType.NODE_LIST, { listVersion: this.nodeList.version, part: i, parts, hub: this.id, nodes: all.slice(i * 69, i * 69 + 69) } satisfies NodeListP)
  }

  private setInService(node: NodeId, on: boolean) {
    const e = this.nodeList.nodes.get(node)
    if (!e) return false
    this.nodeList.nodes.set(node, { ...e, inService: on })
    this.nodeList = { version: this.nodeList.version + 1, nodes: this.nodeList.nodes }
    this.broadcastNodeList()
    return true
  }

  // ---------- alerts (10.1) ----------

  raiseAlert(kind: AlertKind, pos: Pos, subjects: string[], taskId: number, itemId: number, ref: number, near?: Pos) {
    const meta = ALERT_META[kind]
    const alert: Alert = { alertId: this.alertSeq++, kind, severity: meta.severity, pos, subjects: subjects.slice(0, 16), taskId, itemId, ref, notified: [] }
    const pa: PendingAlert = { alert, cls: meta.cls }
    this.alerts.unshift(pa)
    if (this.alerts.length > 200) this.alerts.length = 200
    this.record('alert', `Alert ${alert.alertId}: ${AlertKind[kind]}${subjects.length ? ` (${subjects.map((s) => this.nameOf(s)).join(', ')})` : ''}.`)
    this.notifyNext(pa, near ?? pos)
    return alert
  }

  /** Supervisors on shift and not lost, nearest first (ties: lower NodeId). */
  private supervisorsByDistance(p: Pos): NodeId[] {
    const cands = this.site.supervisors
      .map((s) => {
        const n = this.nodes.get(s.node)
        const tr = this.badgeTracks.get(s.badge)
        const pos = tr?.pos ?? n?.pos ?? null
        return { id: s.node, n, pos }
      })
      .filter((c) => c.n && c.n.liveness !== Liveness.LOST && c.n.supervisor?.onShift !== false && c.pos)
    cands.sort((a, b) => dist(a.pos!, p) - dist(b.pos!, p) || (a.id < b.id ? -1 : 1))
    return cands.map((c) => c.id)
  }

  private notifyNext(pa: PendingAlert, near: Pos) {
    if (pa.alert.ack && pa.alert.ack.action !== 2) return
    const order = this.supervisorsByDistance(near)
    const next = order.find((s) => !pa.alert.notified.includes(s))
    const payload: AlertP = { alertId: pa.alert.alertId, kind: pa.alert.kind, severity: pa.alert.severity, pos: pa.alert.pos, subjects: pa.alert.subjects, taskId: pa.alert.taskId, itemId: pa.alert.itemId, ref: pa.alert.ref }
    if (next) {
      pa.alert.notified.push(next)
      this.send(MsgType.ALERT, payload, { dst: next, cls: pa.cls })
    } else if (!pa.broadcastDone) {
      pa.broadcastDone = true
      this.send(MsgType.ALERT, payload, { dst: BROADCAST, cls: pa.cls })
      this.record('alert', `Alert ${pa.alert.alertId} broadcast to all supervisors.`)
      this.emit({ kind: 'alert', at: this.sched.gpsTime, alert: { ...pa.alert } })
      return
    } else return
    this.emit({ kind: 'alert', at: this.sched.gpsTime, alert: { ...pa.alert, notified: [...pa.alert.notified] } })
    const wait = pa.alert.severity === 2 ? T.ALERT_ACK_URGENT : T.ALERT_ACK_OTHER
    this.sched.cancel(pa.timer)
    pa.timer = this.sched.after(wait, () => {
      if (!pa.alert.ack) this.notifyNext(pa, near)
    })
  }

  private onAck(from: NodeId, a: AlertAckP) {
    const pa = this.alerts.find((x) => x.alert.alertId === a.alertId)
    if (!pa) return
    pa.alert.ack = { by: from, action: a.action, at: this.sched.gpsTime }
    this.record('ack', `Alert ${a.alertId} acknowledged by ${this.nameOf(from)} (${['seen', 'handling', 'needs help'][a.action]}).`)
    this.emit({ kind: 'alert', at: this.sched.gpsTime, alert: { ...pa.alert } })
    if (a.action === 2) {
      // Needs help: escalate immediately to the next supervisor.
      this.sched.cancel(pa.timer)
      pa.alert.ack = undefined
      this.notifyNext(pa, pa.alert.pos)
    } else this.sched.cancel(pa.timer)
  }

  /** The twin acknowledges for a supervisor logged in to it (12.3). */
  ackOnBehalf(supervisor: NodeId, alertId: number, action: 0 | 1 | 2) {
    this.onAck(supervisor, { alertId, action })
  }

  // ---------- commands (10.2, 12.3) ----------

  private isSupervisor(node: NodeId) {
    return this.nodeList.nodes.get(node)?.kind === NodeKind.SUPERVISOR
  }

  private onCommand(pkt: Packet<SupervisorCmdP>) {
    const h = pkt.h
    const c = pkt.p
    const by = c.onBehalfOf ?? h.src
    const hubCmd = h.dst === this.id
    const itemCmd = h.dst === BROADCAST && [Cmd.CANCEL_ITEM, Cmd.RELEASE_ITEM, Cmd.SIGN_OFF, Cmd.REDIRECT].includes(c.cmd)
    if (!hubCmd && !itemCmd) return
    const reply = (result: 0 | 1 | 2, reason = 0) => {
      // The robot answers REDIRECT; the hub answers everything else addressed to it or to the whole site.
      if (c.cmd !== Cmd.REDIRECT) this.send(MsgType.CMD_RESULT, { cmdId: c.cmdId, result, reason } satisfies CmdResultP, { dst: h.src })
    }
    if (!this.isSupervisor(by)) return reply(1, 1)
    this.record('command', `${this.nameOf(by)}: ${Cmd[c.cmd]} ${JSON.stringify(c.args)}.`)
    const res = this.applyHubCommand(c, by)
    reply(res[0], res[1])
  }

  /** Commands the hub applies itself. Returns [result, reason]. */
  applyHubCommand(c: SupervisorCmdP, by: NodeId): [0 | 1 | 2, number] {
    const a = c.args
    switch (c.cmd) {
      case Cmd.ZONE_ADD: {
        const z = a.zone as Omit<Zone, 'zoneId'> | undefined
        if (!z || !z.shape) return [1, 6]
        this.addZone({ ...z, setBy: by })
        return [0, 0]
      }
      case Cmd.ZONE_REMOVE:
        return this.removeZone(Number(a.zoneId)) ? [0, 0] : [2, 6]
      case Cmd.OUT_OF_SERVICE:
        return this.setInService(String(a.node), false) ? [0, 0] : [1, 6]
      case Cmd.RETURN_TO_SERVICE:
        return this.setInService(String(a.node), true) ? [0, 0] : [1, 6]
      case Cmd.ADMIT_NODE: {
        const node = String(a.node)
        this.nodeList.nodes.set(node, { node, kind: Number(a.kind) as NodeKind, tag: Number(a.tag ?? 0), inService: true, badge: 0 })
        this.nodeList = { version: this.nodeList.version + 1, nodes: this.nodeList.nodes }
        this.broadcastNodeList()
        return [0, 0]
      }
      case Cmd.REQUEST_ROBOTS:
        this.record('planning', `Request for ${a.count} more robots on task ${a.taskId} passed to planning.`)
        return [0, 0]
      case Cmd.CANCEL_ITEM:
      case Cmd.RELEASE_ITEM:
      case Cmd.SIGN_OFF:
      case Cmd.REDIRECT: {
        const e = this.book.get(Number(a.taskId), Number(a.itemId))
        if (!e) return [2, 5]
        if (c.cmd === Cmd.CANCEL_ITEM) this.book.set({ ...e, state: ItemState.CANCELLED }, this.now)
        else if (c.cmd === Cmd.RELEASE_ITEM) {
          if (e.state !== ItemState.HELD) return [2, 4]
          this.book.set({ ...e, gen: e.gen + 1, winBid: 0, winNode: null, state: ItemState.OPEN }, this.now)
        } else if (c.cmd === Cmd.SIGN_OFF) {
          if (e.state !== ItemState.AWAITING_SIGNOFF) return [2, 4]
          this.book.set(a.ok ? { ...e, state: ItemState.DONE } : { ...e, gen: e.gen + 1, winBid: 0, winNode: null, state: ItemState.OPEN }, this.now)
        } else {
          const robot = String(a.robot)
          const gen = e.winNode && e.winNode !== robot ? e.gen + 1 : e.gen
          this.book.set({ taskId: e.taskId, itemId: e.itemId, gen, winBid: 0xffffffff, winNode: robot, state: ItemState.ASSIGNED }, this.now)
        }
        const after = this.book.get(e.taskId, e.itemId)!
        this.emit({ kind: 'item', at: this.sched.gpsTime, entry: { ...after } })
        return [0, 0]
      }
      default:
        return [2, 6]
    }
  }

  /**
   * Send a command for a supervisor logged in to the twin (12.3): src is the hub, the payload
   * carries on_behalf_of. Robot commands are retried like a tablet's (5.7).
   */
  commandOnBehalf(supervisor: NodeId, cmd: Cmd, target: NodeId | null, args: Record<string, unknown>): Promise<CmdResultP | null> {
    const cmdId = Math.floor(this.ctx.rand() * 2 ** 32)
    const p: SupervisorCmdP = { cmdId, cmd, target, args, onBehalfOf: supervisor }
    const hubCommands = [Cmd.ZONE_ADD, Cmd.ZONE_REMOVE, Cmd.OUT_OF_SERVICE, Cmd.RETURN_TO_SERVICE, Cmd.ADMIT_NODE, Cmd.REQUEST_ROBOTS]
    this.record('command', `${this.nameOf(supervisor)} (twin): ${Cmd[cmd]} ${JSON.stringify(args)}.`)
    if (!this.isSupervisor(supervisor)) return Promise.resolve({ cmdId, result: 1, reason: 1 })
    if (hubCommands.includes(cmd)) {
      const [result, reason] = this.applyHubCommand(p, supervisor)
      return Promise.resolve({ cmdId, result, reason })
    }
    const cls = cmd === Cmd.STOP ? MsgClass.SAFETY : MsgClass.CONTROL
    const broadcastCmd = [Cmd.CANCEL_ITEM, Cmd.REDIRECT, Cmd.RELEASE_ITEM, Cmd.SIGN_OFF].includes(cmd)
    const dst = broadcastCmd ? BROADCAST : (target ?? BROADCAST)
    if (broadcastCmd) {
      // The hub applies it too, then broadcasts so every robot does in its next round.
      const [result, reason] = this.applyHubCommand(p, supervisor)
      this.send(MsgType.SUPERVISOR_CMD, p, { dst, cls })
      if (cmd !== Cmd.REDIRECT) return Promise.resolve({ cmdId, result, reason })
    }
    return new Promise((resolve) => {
      const entry = { resolve, tries: 0, pkt: p, dst, cls, timer: undefined as ReturnType<MeshNode['sched']['after']> | undefined }
      this.pendingCmds.set(cmdId, entry)
      if (!broadcastCmd) this.send(MsgType.SUPERVISOR_CMD, p, { dst, cls })
      const retry = () => {
        if (!this.pendingCmds.has(cmdId)) return
        if (entry.tries >= T.CMD_RETRIES) {
          this.pendingCmds.delete(cmdId)
          resolve(null)
          return
        }
        entry.tries++
        this.send(MsgType.SUPERVISOR_CMD, p, { dst, cls, flags: 2 })
        entry.timer = this.sched.after(T.CMD_RETRY_MS, retry)
      }
      entry.timer = this.sched.after(T.CMD_RETRY_MS, retry)
    })
  }

  // ---------- bulk (5.8) ----------

  private onBulk(robot: NodeId, c: BulkChunkP) {
    const t = this.bulk.get(c.transferId) ?? { robot, got: new Set<number>(), count: c.chunkCount, last: this.now, nacks: 0, done: false }
    t.got.add(c.chunkIndex)
    t.last = this.now
    this.bulk.set(c.transferId, t)
    if (t.got.size === t.count && !t.done) {
      t.done = true
      this.record('bulk', `Evidence ${c.transferId} from ${this.nameOf(robot)} received (${t.count} chunks).`)
    }
  }

  private checkBulk() {
    for (const [id, t] of this.bulk) {
      if (t.done || this.now - t.last < T.BULK_NACK_WAIT) continue
      if (t.nacks >= T.BULK_MAX_NACKS) {
        this.record('bulk', `Evidence ${id} from ${this.nameOf(t.robot)} abandoned after ${t.nacks} NACKs.`)
        this.bulk.delete(id)
        continue
      }
      const missing = []
      for (let i = 0; i < t.count && missing.length < 256; i++) if (!t.got.has(i)) missing.push(i)
      t.nacks++
      t.last = this.now
      this.send(MsgType.BULK_NACK, { transferId: id, missing }, { dst: t.robot })
    }
  }

  // ---------- HQ ledger ----------

  private syncHq() {
    if (!this.starlinkUp) return
    for (const e of this.log) e.synced = true
    this.lastHqSync = this.sched.gpsTime
  }

  // ---------- twin interface (12.1) ----------

  snapshot(): MeshSnapshot {
    const gps = (simT: number) => this.ctx.sched.epoch + Math.round(simT)
    const links = new Map<string, { a: NodeId; b: NodeId; rssi: number }>()
    for (const n of this.nodes.values()) {
      if (!n.relay || n.liveness === Liveness.LOST) continue
      for (const nb of n.relay.neighbors) {
        if (nb.kind !== NodeKind.RELAY && nb.kind !== NodeKind.GATEWAY) continue
        if (this.nodes.get(nb.node)?.liveness === Liveness.LOST) continue
        const key = n.id < nb.node ? `${n.id}|${nb.node}` : `${nb.node}|${n.id}`
        const prev = links.get(key)
        if (!prev || nb.rssi > prev.rssi) links.set(key, { a: n.id < nb.node ? n.id : nb.node, b: n.id < nb.node ? nb.node : n.id, rssi: nb.rssi })
      }
    }
    const tasks = [...this.openTasks.values()].map((o) => {
      const bt = this.book.tasks.get(o.task.taskId)
      return { task: o.task, items: bt ? o.task.items.map((i) => ({ ...bt.items.get(i.itemId)! })) : [], shortfall: this.shortfall.get(o.task.taskId)?.deficit ?? 0 }
    })
    // Recently completed tasks stay visible so their items keep showing on the map.
    for (const bt of this.book.tasks.values()) {
      if (this.openTasks.has(bt.task.taskId)) continue
      tasks.push({ task: bt.task, items: bt.task.items.map((i) => ({ ...bt.items.get(i.itemId)! })), shortfall: 0 })
    }
    return {
      now: this.sched.gpsTime,
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id,
        kind: n.kind,
        name: n.name,
        liveness: n.liveness,
        lastHeard: gps(n.lastHeard),
        pos: n.pos,
        robot: n.robot,
        relay: n.relay,
        supervisor: n.supervisor,
      })),
      links: [...links.values()],
      zones: { version: this.zones.version, list: this.zones.list },
      tracks: { version: this.tracks.version, list: this.tracks.list },
      tasks,
      alerts: this.alerts.map((a) => ({ ...a.alert, notified: [...a.alert.notified] })),
      hubLinks: { gatewaysUp: this.site.gateways.filter((g) => this.nodes.get(g)?.liveness !== Liveness.LOST), starlinkUp: this.starlinkUp, lastHqSync: this.lastHqSync },
    }
  }
}

function summarize(pkt: Packet): string {
  const p = pkt.p as Record<string, unknown>
  switch (pkt.h.type) {
    case MsgType.SAFETY_STOP:
      return `stop ${StopReason[(p as unknown as SafetyStopP).stopReason]}`
    case MsgType.ITEM_STARTED:
    case MsgType.ITEM_DONE:
    case MsgType.ITEM_RELEASED:
      return `task ${p.taskId} item ${p.itemId}`
    case MsgType.CMD_RESULT:
      return `cmd ${p.cmdId}: ${['ok', 'rejected', 'n/a'][Number(p.result)]}`
    default:
      return MsgType[pkt.h.type]
  }
}
