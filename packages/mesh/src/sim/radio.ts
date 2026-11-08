// The radio medium. Every transmission is a broadcast heard by the nodes in range; each
// reception can be lost, with loss growing toward the edge of range. Gateways also have a
// wired link to the hub (5.5). Every transmission and every drop can be traced (12.2).

import { RADIO } from '../constants.js'
import type { MeshTrace, NodeId, Packet, Pos } from '../types.js'
import { NodeKind, msgId } from '../types.js'
import type { Scheduler } from './scheduler.js'

export interface RadioNode {
  id: NodeId
  kind: NodeKind
  /** Powered and radio working. */
  radioOn(): boolean
  pos(): Pos
  /** Relays and gateways: coverage radius for endpoints, meters. */
  coverageRadiusM?: number
  receive(pkt: Packet, from: NodeId, rssi: number, iface: 'radio' | 'wire'): void
}

export type TraceSink = (t: MeshTrace) => void

const distM = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y) / 10

const isRelay = (k: NodeKind) => k === NodeKind.RELAY || k === NodeKind.GATEWAY

export class Radio {
  private nodes = new Map<NodeId, RadioNode>()
  private wires = new Map<NodeId, NodeId[]>() // gateway <-> hub
  private traceSinks = new Set<TraceSink>()
  txCount = 0
  rxCount = 0
  lossCount = 0
  private readonly sched: Scheduler
  private readonly rand: () => number

  constructor(sched: Scheduler, rand: () => number) {
    this.sched = sched
    this.rand = rand
  }

  add(node: RadioNode) {
    this.nodes.set(node.id, node)
  }

  get(id: NodeId) {
    return this.nodes.get(id)
  }

  all() {
    return [...this.nodes.values()]
  }

  wire(a: NodeId, b: NodeId) {
    this.wires.set(a, [...(this.wires.get(a) ?? []), b])
    this.wires.set(b, [...(this.wires.get(b) ?? []), a])
  }

  onTrace(sink: TraceSink) {
    this.traceSinks.add(sink)
    return () => this.traceSinks.delete(sink)
  }

  get tracing() {
    return this.traceSinks.size > 0
  }

  trace(from: NodeId, to: NodeId | null, pkt: Packet, result: MeshTrace['result']) {
    if (!this.traceSinks.size) return
    const t: MeshTrace = { t: this.sched.now, msgId: msgId(pkt.h), type: pkt.h.type, cls: pkt.h.cls, from, to, result, hopsLeft: pkt.h.hopsLeft }
    for (const s of this.traceSinks) s(t)
  }

  /** Range in meters at which these two kinds of node can hear each other, or 0 if they can't. */
  rangeM(a: RadioNode, b: RadioNode): number {
    if (isRelay(a.kind) && isRelay(b.kind)) return RADIO.RELAY_RANGE_M
    if (isRelay(a.kind) && isEndpoint(b.kind)) return a.coverageRadiusM ?? RADIO.ENDPOINT_RANGE_M
    if (isRelay(b.kind) && isEndpoint(a.kind)) return b.coverageRadiusM ?? RADIO.ENDPOINT_RANGE_M
    if (a.kind === NodeKind.ROBOT && b.kind === NodeKind.ROBOT) return RADIO.ROBOT_RANGE_M
    return 0
  }

  rssiAt(d: number) {
    return Math.round(-30 - 27 * Math.log10(Math.max(1, d)))
  }

  /** Neighbors a node can currently hear (for diagnostics and the twin). */
  neighbors(node: RadioNode): { node: RadioNode; d: number }[] {
    const out = []
    const p = node.pos()
    for (const o of this.nodes.values()) {
      if (o === node || !o.radioOn()) continue
      const r = this.rangeM(node, o)
      if (!r) continue
      const d = distM(p, o.pos())
      if (d <= r) out.push({ node: o, d })
    }
    return out
  }

  /** Broadcast a packet over the air. The packet object is shared read-only by every receiver. */
  transmit(from: RadioNode, pkt: Packet, result: 'tx' | 'repair_tx' = 'tx') {
    if (!from.radioOn()) return
    this.txCount++
    this.trace(from.id, null, pkt, result)
    const p = from.pos()
    for (const o of this.nodes.values()) {
      if (o === from || !o.radioOn()) continue
      const r = this.rangeM(from, o)
      if (!r) continue
      const d = distM(p, o.pos())
      if (d > r) continue
      const frac = d / r
      const loss = RADIO.BASE_LOSS + RADIO.EDGE_LOSS * frac ** 4
      if (this.rand() < loss) {
        this.lossCount++
        this.trace(from.id, o.id, pkt, 'lost')
        continue
      }
      const rssi = this.rssiAt(d)
      this.sched.after(RADIO.AIRTIME_MS + this.rand() * 0.5, () => {
        if (!o.radioOn()) return
        this.rxCount++
        o.receive(pkt, from.id, rssi, 'radio')
      })
    }
  }

  /** Send over the wired link between a gateway and the hub (lossless). */
  wireSend(from: RadioNode, pkt: Packet) {
    for (const id of this.wires.get(from.id) ?? []) {
      const o = this.nodes.get(id)
      if (!o || !o.radioOn() || !from.radioOn()) continue
      this.sched.after(0.2, () => o.receive(pkt, from.id, 0, 'wire'))
    }
  }
}

export function isEndpoint(k: NodeKind) {
  return k === NodeKind.ROBOT || k === NodeKind.SUPERVISOR || k === NodeKind.ANCHOR
}

/** Copy a packet so a forwarder can change hopsLeft without touching other receivers' copies. */
export function clonePacket<P>(pkt: Packet<P>): Packet<P> {
  return { h: { ...pkt.h }, p: pkt.p }
}
