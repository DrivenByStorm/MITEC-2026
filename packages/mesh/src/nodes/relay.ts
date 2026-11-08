// RELAY and GATEWAY nodes: flood forwarding (5.1), beacons (6.1), RELAY_STATUS (7.2) and,
// for anchor-equipped relays, UWB ranging (8.4). Gateways also bridge the radio and the
// wired link to the hub (5.5).

import { RELAY_QUEUE, T } from '../constants.js'
import { clonePacket } from '../sim/radio.js'
import type { NodeId, Packet, Pos, RelayBeaconP, RelayStatus, UwbRangesP } from '../types.js'
import { MsgClass, MsgType, NodeKind, msgId } from '../types.js'
import { MeshNode, isRelayKind } from './base.js'
import type { NodeContext } from './base.js'

export type UwbProvider = (anchorPos: Pos) => UwbRangesP['ranges']

interface Neighbor {
  kind: NodeKind
  rssi: number
  lastHeard: number
  gatewayHops?: number
}

export class RelayNode extends MeshNode {
  readonly isGateway: boolean
  readonly uwbAnchor: boolean
  gpsLocked = true
  gatewayHops = 255
  neighbors = new Map<NodeId, Neighbor>()
  private uwb?: UwbProvider
  private lastUwbSent = -Infinity

  constructor(ctx: NodeContext, id: NodeId, name: string, pos: Pos, opts: { gateway?: boolean; uwbAnchor?: boolean; coverageRadiusM?: number; uwb?: UwbProvider } = {}) {
    super(ctx, id, opts.gateway ? NodeKind.GATEWAY : NodeKind.RELAY, name, pos)
    this.isGateway = !!opts.gateway
    this.uwbAnchor = !!opts.uwbAnchor
    this.coverageRadiusM = opts.coverageRadiusM ?? T.COVERAGE_RADIUS_M
    this.uwb = opts.uwb
    if (this.isGateway) this.gatewayHops = 0
  }

  override start() {
    this.every(T.BEACON_INTERVAL, () => this.beacon(), T.BEACON_JITTER)
    this.every(T.RELAY_STATUS_INTERVAL, () => this.sendStatus())
    if (this.uwbAnchor && this.uwb) this.every(T.UWB_INTERVAL, () => this.sendUwb())
  }

  protected override onReboot() {
    this.neighbors.clear()
    this.gatewayHops = this.isGateway ? 0 : 255
    for (const c of Object.values(this.counters)) if (Array.isArray(c)) c.fill(0)
  }

  /** Gateways also copy their own status and ranges to the hub over the wire (5.5). */
  protected override transmitOwn(pkt: Packet) {
    super.transmitOwn(pkt)
    if (this.isGateway && pkt.h.type !== MsgType.RELAY_BEACON) this.ctx.radio.wireSend(this, pkt)
  }

  protected override queueLimit(cls: MsgClass) {
    return RELAY_QUEUE.limit[cls]
  }

  private beacon() {
    if (!this.isGateway) {
      let best = 255
      for (const n of this.neighbors.values()) {
        if (n.gatewayHops !== undefined && this.now - n.lastHeard <= T.GATEWAY_HOPS_WINDOW) best = Math.min(best, n.gatewayHops)
      }
      this.gatewayHops = best < 255 ? best + 1 : 255
    }
    const p: RelayBeaconP = {
      gatewayHops: this.gatewayHops,
      relayFlags: (this.gpsLocked ? 1 : 0) | (this.isGateway ? 2 : 0) | (this.uwbAnchor ? 4 : 0),
      loadPct: this.loadPct(),
    }
    this.send(MsgType.RELAY_BEACON, p)
  }

  status(): RelayStatus {
    const neighbors = []
    for (const [node, n] of this.neighbors) {
      const age = this.now - n.lastHeard
      if (age <= 5000) neighbors.push({ node, kind: n.kind, rssi: n.rssi, ageMs: Math.round(age) })
    }
    return {
      uptimeS: Math.floor((this.now - this.bootedAt) / 1000),
      gatewayHops: this.gatewayHops,
      gpsLocked: this.gpsLocked,
      rx: [...this.counters.rx],
      fwd: [...this.counters.fwd],
      dup: [...this.counters.dup],
      hopDrop: [...this.counters.hopDrop],
      qDrop: [...this.counters.qDrop],
      neighbors: neighbors.slice(0, 48),
    }
  }

  private sendStatus() {
    this.send(MsgType.RELAY_STATUS, this.status())
  }

  private sendUwb() {
    const ranges = this.uwb!(this.position)
    // Heartbeat at least every 5 s even with zero ranges (7.1).
    if (!ranges.length && this.now - this.lastUwbSent < T.ANCHOR_HEARTBEAT) return
    this.lastUwbSent = this.now
    const p: UwbRangesP = { anchorPos: { ...this.position }, anchorAcc: 0, ranges }
    this.send(MsgType.UWB_RANGES, p)
  }

  protected hasOtherNeighbors(except: NodeId) {
    for (const [id, n] of this.neighbors) if (id !== except && this.now - n.lastHeard <= 5000) return true
    return false
  }

  /** Section 5.1, run for each packet received on any interface. */
  receive(pkt: Packet, from: NodeId, rssi: number, iface: 'radio' | 'wire') {
    if (!this.powered) return
    if (!this.valid(pkt)) return
    const h = pkt.h
    const id = msgId(h)
    if (this.seen.has(id, this.now)) {
      this.heardAgain(id) // someone else forwarded it (5.10)
      this.counters.dup[h.cls]++
      this.ctx.radio.trace(this.id, null, pkt, 'dup_dropped')
      return
    }
    this.seen.insert(id, this.now)
    this.counters.rx[h.cls]++

    if (h.type === MsgType.RELAY_BEACON) {
      const b = pkt.p as RelayBeaconP
      this.neighbors.set(h.src, { kind: h.srcKind, rssi, lastHeard: this.now, gatewayHops: b.gatewayHops })
      return // never forwarded
    }
    // First-hop detection (5.2): heard straight from an endpoint.
    if (iface === 'radio' && h.hopsLeft === h.initialHops && !isRelayKind(h.srcKind) && from === h.src) {
      this.neighbors.set(h.src, { kind: h.srcKind, rssi, lastHeard: this.now })
    }
    if (h.dst === this.id) {
      this.deliverLocal(pkt)
      return
    }
    if (h.hopsLeft === 0) {
      this.counters.hopDrop[h.cls]++
      this.ctx.radio.trace(this.id, null, pkt, 'hop_dropped')
      return
    }
    const fwd = clonePacket(pkt)
    fwd.h.hopsLeft -= 1
    this.counters.fwd[h.cls]++
    const jitterMax = RELAY_QUEUE.jitterMax[h.cls]
    this.enqueue(fwd, false, this.ctx.rand() * jitterMax)
    if (h.cls === MsgClass.SAFETY || h.cls === MsgClass.CONTROL) this.watchRepair(fwd, from)
    if (this.isGateway && iface === 'radio') this.ctx.radio.wireSend(this, pkt) // copy to the hub
  }

  /** Relays only act on SUPERVISOR_CMD addressed to them; version 1 defines none, so nothing happens. */
  private deliverLocal(_pkt: Packet) {}
}
