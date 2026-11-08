// Shared node machinery: identity (boot, seq), duplicate memory (5.3), the endpoint replay
// window (5.3), class-based transmit queues with jitter and status coalescing (5.4), the
// repair re-send (5.10) and packet validation (5.1).

import { ALLOWED_CLASSES, RADIO, T } from '../constants.js'
import type { Radio, RadioNode } from '../sim/radio.js'
import type { Scheduler } from '../sim/scheduler.js'
import type { Header, NodeId, Packet, Pos } from '../types.js'
import { BROADCAST, MsgClass, MsgType, NodeKind, msgId } from '../types.js'

export interface NodeContext {
  sched: Scheduler
  radio: Radio
  rand: () => number
  /** Persistent boot counters (non-volatile memory), keyed by node. */
  bootStore: Map<NodeId, number>
  log: (node: string, text: string) => void
}

interface Queued {
  pkt: Packet
  readyAt: number
  own: boolean
  repairOf?: string // set on a repair re-send
}

/** Duplicate memory: message IDs forgotten after DEDUP_TTL, oldest evicted when full. */
export class DedupMemory {
  private seen = new Map<string, number>()
  constructor(
    private ttl: number = T.DEDUP_TTL,
    private cap: number = T.DEDUP_CAP,
  ) {}

  has(id: string, now: number) {
    const t = this.seen.get(id)
    if (t === undefined) return false
    if (now - t > this.ttl) {
      this.seen.delete(id)
      return false
    }
    return true
  }

  insert(id: string, now: number) {
    // Expire from the front (Map keeps insertion order, which is also time order).
    for (const [k, t] of this.seen) {
      if (now - t <= this.ttl && this.seen.size < this.cap) break
      this.seen.delete(k)
    }
    this.seen.set(id, now)
  }

  get size() {
    return this.seen.size
  }
}

/** Endpoint replay window (5.3): highest boot, highest seq and a 128-bit window per sender. */
export class ReplayWindow {
  private bySrc = new Map<NodeId, { boot: number; max: number; bits: Set<number> }>()

  /** Returns true if the packet is stale (and should be dropped); otherwise records it. */
  checkAndRecord(h: Header): boolean {
    const w = this.bySrc.get(h.src)
    if (!w || h.boot > w.boot) {
      this.bySrc.set(h.src, { boot: h.boot, max: h.seq, bits: new Set([h.seq]) })
      return false
    }
    if (h.boot < w.boot) return true
    if (h.seq + T.REPLAY_WINDOW < w.max) return true
    if (w.bits.has(h.seq)) return true
    w.bits.add(h.seq)
    if (h.seq > w.max) {
      w.max = h.seq
      for (const s of w.bits) if (s + T.REPLAY_WINDOW < w.max) w.bits.delete(s)
    }
    return false
  }
}

export abstract class MeshNode implements RadioNode {
  readonly id: NodeId
  readonly kind: NodeKind
  readonly name: string
  coverageRadiusM?: number
  boot: number
  seq = 0
  powered = true
  /** Set false to simulate a dead radio while the node keeps running. */
  radioWorks = true
  protected position: Pos
  protected seen = new DedupMemory()
  protected queues: Queued[][] = [[], [], [], []]
  protected busy = false
  protected repairWatch = new Map<string, { job: ReturnType<Scheduler['after']>; pkt: Packet; from: NodeId }>()
  protected timers: { cancel(): void }[] = []
  readonly counters = { rx: [0, 0, 0, 0], fwd: [0, 0, 0, 0], dup: [0, 0, 0, 0], hopDrop: [0, 0, 0, 0], qDrop: [0, 0, 0, 0], malformed: 0 }
  bootedAt = 0
  protected readonly ctx: NodeContext

  constructor(ctx: NodeContext, id: NodeId, kind: NodeKind, name: string, pos: Pos) {
    this.ctx = ctx
    this.id = id
    this.kind = kind
    this.name = name
    this.position = { ...pos }
    this.boot = this.nextBoot()
    this.bootedAt = ctx.sched.now
  }

  get sched() {
    return this.ctx.sched
  }
  get now() {
    return this.ctx.sched.now
  }

  pos(): Pos {
    return this.position
  }

  radioOn() {
    return this.powered && this.radioWorks
  }

  /** Start the node's periodic behaviour. Subclasses add their timers. */
  start() {}

  powerOff() {
    this.powered = false
    for (const t of this.timers) t.cancel()
    this.timers = []
    for (const q of this.queues) q.length = 0
    for (const w of this.repairWatch.values()) this.sched.cancel(w.job)
    this.repairWatch.clear()
    this.busy = false
  }

  /** Power back up: new boot number, seq from 0, empty memories (4.3, 5.3). */
  powerOn() {
    this.powered = true
    this.boot = this.nextBoot()
    this.seq = 0
    this.bootedAt = this.now
    this.seen = new DedupMemory()
    this.onReboot()
    this.start()
  }

  protected onReboot() {}

  private nextBoot() {
    const b = (this.ctx.bootStore.get(this.id) ?? 0) + 1
    this.ctx.bootStore.set(this.id, b)
    return b
  }

  protected every(interval: number, fn: () => void, jitter = 0) {
    this.timers.push(this.sched.every(interval, fn, jitter, this.ctx.rand))
  }

  // ---------- sending ----------

  /** Originate a packet. */
  send<P>(type: MsgType, p: P, opts: { cls?: MsgClass; dst?: NodeId; hops?: number; flags?: number } = {}): Packet<P> {
    const cls = opts.cls ?? ALLOWED_CLASSES[type][0]
    const hops = opts.hops ?? (type === MsgType.RELAY_BEACON || type === MsgType.ROBOT_BEACON ? 0 : T.HOP_LIMIT)
    const h: Header = {
      version: 1,
      type,
      cls,
      flags: opts.flags ?? 0,
      initialHops: hops,
      hopsLeft: hops,
      srcKind: this.kind,
      src: this.id,
      dst: opts.dst ?? BROADCAST,
      boot: this.boot,
      seq: this.seq++,
      gpsTime: this.sched.gpsTime,
    }
    const pkt: Packet<P> = { h, p }
    this.seen.insert(msgId(h), this.now) // never process our own packet when it comes back
    this.transmitOwn(pkt)
    return pkt
  }

  /** Hand an originated packet to the radio (hub overrides: it sends to both gateways). */
  protected transmitOwn(pkt: Packet) {
    this.enqueue(pkt, true, 0)
  }

  protected queueLimit(cls: MsgClass): number {
    return [64, 128, 64, 32][cls]
  }

  protected enqueue(pkt: Packet, own: boolean, jitter: number, repairOf?: string) {
    if (!this.radioOn()) return
    const cls = pkt.h.cls
    const q = this.queues[cls]
    if (cls === MsgClass.STATUS) {
      // Status coalescing: only the latest status from each sender is worth sending.
      const i = q.findIndex((e) => e.pkt.h.src === pkt.h.src && e.pkt.h.type === pkt.h.type)
      if (i >= 0) q.splice(i, 1)
    }
    const limit = this.queueLimit(cls)
    if (q.length >= limit) {
      this.counters.qDrop[cls]++
      if (cls === MsgClass.BULK) {
        this.ctx.radio.trace(this.id, null, pkt, 'queue_dropped')
        return // drop the newest
      }
      const dropped = q.shift()!
      this.ctx.radio.trace(this.id, null, dropped.pkt, 'queue_dropped')
    }
    q.push({ pkt, readyAt: this.now + jitter, own, repairOf })
    this.pump()
  }

  /** Transmit queued packets one at a time, highest class first. */
  protected pump() {
    if (this.busy || !this.radioOn()) return
    const next = this.pickNext()
    if (!next) {
      // Nothing ready yet: wake up when the earliest jittered packet becomes ready.
      let soonest = Infinity
      for (const q of this.queues) for (const e of q) soonest = Math.min(soonest, e.readyAt)
      if (soonest < Infinity) {
        this.busy = true
        this.sched.after(soonest - this.now, () => {
          this.busy = false
          this.pump()
        })
      }
      return
    }
    this.busy = true
    this.ctx.radio.transmit(this, next.pkt, next.repairOf ? 'repair_tx' : 'tx')
    this.sched.after(RADIO.AIRTIME_MS, () => {
      this.busy = false
      this.pump()
    })
  }

  protected pickNext(): Queued | undefined {
    for (const q of this.queues) {
      const i = q.findIndex((e) => e.readyAt <= this.now)
      if (i >= 0) return q.splice(i, 1)[0]
    }
    return undefined
  }

  protected loadPct(): number {
    let best = 0
    for (let c = 0; c < 4; c++) best = Math.max(best, this.queues[c].length / Math.max(1, this.queueLimit(c)))
    return Math.round(best * 100)
  }

  // ---------- validation, dedup, repair ----------

  /** The checks in the first lines of 5.1. Returns false (and counts) if the packet is malformed. */
  protected valid(pkt: Packet): boolean {
    const h = pkt.h
    if (h.version !== 1 || h.hopsLeft > h.initialHops || h.initialHops > T.MAX_HOPS || !ALLOWED_CLASSES[h.type]?.includes(h.cls)) {
      this.counters.malformed++
      return false
    }
    return true
  }

  /** Watch a forwarded SAFETY/CONTROL packet; re-send once if no other node is heard sending it (5.10). */
  protected watchRepair(pkt: Packet, from: NodeId) {
    if (pkt.h.cls !== MsgClass.SAFETY && pkt.h.cls !== MsgClass.CONTROL) return
    const id = msgId(pkt.h)
    if (this.repairWatch.has(id)) return
    const job = this.sched.after(T.REPAIR_WAIT, () => {
      const w = this.repairWatch.get(id)
      this.repairWatch.delete(id)
      if (!w || !this.radioOn()) return
      if (!this.hasOtherNeighbors(w.from)) return // end of a chain: skip the repair
      this.enqueue(w.pkt, false, 0, id)
    })
    this.repairWatch.set(id, { job, pkt, from })
  }

  /** Called on a duplicate: someone else forwarded it, so no repair is needed. */
  protected heardAgain(id: string) {
    const w = this.repairWatch.get(id)
    if (w) {
      this.sched.cancel(w.job)
      this.repairWatch.delete(id)
    }
  }

  /** Whether this node has any neighbor other than `except` (used to skip repair at the end of a chain). */
  protected abstract hasOtherNeighbors(except: NodeId): boolean

  abstract receive(pkt: Packet, from: NodeId, rssi: number, iface: 'radio' | 'wire'): void
}

export const isRelayKind = (k: NodeKind) => k === NodeKind.RELAY || k === NodeKind.GATEWAY
