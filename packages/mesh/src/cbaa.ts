// Consensus-Based Auction Algorithm pieces shared by robots and the hub (section 9):
// entry ordering (9.3), utility (9.5), the task/item book with revisions (9.10), the slot rule
// (9.7) and the release rule (9.9).

import { T } from './constants.js'
import { isqrt } from './geometry.js'
import type { ItemEntry, NodeId, Pos, SiteConfig, Task, TaskItem, TaskP } from './types.js'
import { ItemState, RobotMode, StopReason } from './types.js'

const FINAL = (s: ItemState) => s === ItemState.DONE || s === ItemState.CANCELLED

/**
 * Same-generation state rank. The spec's ordering (9.3) puts STARTED above other states of the
 * same generation; states that can only follow STARTED in the same generation (HELD,
 * AWAITING_SIGNOFF) rank above it so an older STARTED copy can't undo them. (Clarification of 9.3.)
 */
const RANK: Record<ItemState, number> = {
  [ItemState.OPEN]: 0,
  [ItemState.ASSIGNED]: 0,
  [ItemState.STARTED]: 1,
  [ItemState.HELD]: 2,
  [ItemState.AWAITING_SIGNOFF]: 3,
  [ItemState.DONE]: 4,
  [ItemState.CANCELLED]: 4,
}

/** Does entry a beat entry b for the same item? (9.3) */
export function beats(a: ItemEntry, b: ItemEntry): boolean {
  const af = FINAL(a.state)
  const bf = FINAL(b.state)
  if (af !== bf) return af
  if (a.gen !== b.gen) return a.gen > b.gen
  if (RANK[a.state] !== RANK[b.state]) return RANK[a.state] > RANK[b.state]
  if (a.winBid !== b.winBid) return a.winBid > b.winBid
  const an = a.winNode ?? 'ZZ'
  const bn = b.winNode ?? 'ZZ'
  return an < bn
}

export interface BidderInfo {
  pos: Pos
  maxSpeed: number // cm/s
  workRatePct: number
  drainPctPerHour: number
  batteryPct: number
  health: 0 | 1 | 2
  posSource: 0 | 1 | 2 | 3
}

/** Battery percent an item would use (9.5). */
export function neededPct(r: BidderInfo, j: TaskItem): number {
  const distDm = isqrt((r.pos.x - j.pos.x) ** 2 + (r.pos.y - j.pos.y) ** 2)
  const travelS = Math.ceil((distDm * 10) / Math.max(r.maxSpeed, 1))
  const workS = Math.ceil((j.estDurationS * 100) / Math.max(r.workRatePct, 1))
  return Math.ceil(((travelS + workS) * r.drainPctPerHour) / 3600)
}

/** Utility of item j of task t for robot r (9.5). All integer arithmetic. */
export function utility(r: BidderInfo, t: Task, j: TaskItem, inBand: boolean, bid: SiteConfig['bid']): number {
  const distDm = isqrt((r.pos.x - j.pos.x) ** 2 + (r.pos.y - j.pos.y) ** 2)
  const travelS = Math.ceil((distDm * 10) / Math.max(r.maxSpeed, 1))
  const workS = Math.ceil((j.estDurationS * 100) / Math.max(r.workRatePct, 1))
  const totalS = travelS + workS
  const needed = Math.ceil((totalS * r.drainPctPerHour) / 3600)
  const spare = r.batteryPct - t.minBattery
  const travel = Math.min(1000, Math.floor((travelS * 1000) / bid.travelCapS))
  const work = Math.min(1000, Math.floor((workS * 1000) / bid.workCapS))
  const energy = Math.min(1000, Math.floor((needed * 1000) / Math.max(spare, 1)))
  const risk = Math.min(1000, (r.health === 1 ? 500 : 0) + (r.posSource !== 0 ? 250 : 0) + (inBand ? 250 : 0))
  const w = bid.weights
  const cost = Math.floor((w.travel * travel + w.work * work + w.energy * energy + w.risk * risk) / 100)
  return 1_000_000 + t.priority * 10_000 - cost
}

export interface BookTask {
  task: Task
  items: Map<number, ItemEntry>
  firstSeen: number
  lastChange: Map<number, number>
}

/** Every robot's (and the hub's) view of open tasks and their items. */
export class AuctionBook {
  tasks = new Map<number, BookTask>()
  /** Items whose local entry changed since the last call to takeChanged(). */
  private changed = new Map<number, Set<number>>()

  /** Learn a TASK slice (9.2) or a new revision (9.10). Returns true if anything changed. */
  addTask(p: TaskP, now: number): boolean {
    const known = this.tasks.get(p.taskId)
    const { slice: _s, slices: _n, ...def } = p // eslint-disable-line @typescript-eslint/no-unused-vars
    if (!known) {
      const items = new Map<number, ItemEntry>()
      for (const it of def.items) items.set(it.itemId, open(def.taskId, it.itemId))
      this.tasks.set(p.taskId, { task: { ...def, items: [...def.items] }, items, firstSeen: now, lastChange: new Map() })
      for (const it of def.items) this.touch(p.taskId, it.itemId, now)
      return true
    }
    if (p.revision < known.task.revision) return false
    if (p.revision === known.task.revision) {
      // Another slice of the same revision: add items we don't have yet.
      let added = false
      for (const it of def.items) {
        if (known.items.has(it.itemId)) continue
        known.task.items.push(it)
        known.items.set(it.itemId, open(def.taskId, it.itemId))
        this.touch(p.taskId, it.itemId, now)
        added = true
      }
      return added
    }
    // Higher revision: replace the definition. Same item ids keep state; removed become CANCELLED; new start OPEN.
    // A revision may arrive in slices too, so only items in this slice are known to exist; others are kept until
    // a full revision has been seen. (Version 1 tasks in this simulator fit one slice per revision change.)
    const ids = new Set(def.items.map((i) => i.itemId))
    for (const [id, e] of known.items) {
      if (!ids.has(id) && !FINAL(e.state)) {
        known.items.set(id, { ...e, state: ItemState.CANCELLED })
        this.touch(p.taskId, id, now)
      }
    }
    for (const it of def.items) {
      if (!known.items.has(it.itemId)) {
        known.items.set(it.itemId, open(def.taskId, it.itemId))
        this.touch(p.taskId, it.itemId, now)
      }
    }
    known.task = { ...def, items: [...def.items] }
    return true
  }

  get(taskId: number, itemId: number): ItemEntry | undefined {
    return this.tasks.get(taskId)?.items.get(itemId)
  }

  item(taskId: number, itemId: number): TaskItem | undefined {
    return this.tasks.get(taskId)?.task.items.find((i) => i.itemId === itemId)
  }

  /** Merge a received entry; keeps it if it beats ours (9.7 phase 1). */
  merge(e: ItemEntry, now: number): boolean {
    const bt = this.tasks.get(e.taskId)
    if (!bt) return false
    const cur = bt.items.get(e.itemId)
    if (!cur) return false
    if (!beats(e, cur)) return false
    bt.items.set(e.itemId, { ...e })
    this.touch(e.taskId, e.itemId, now)
    return true
  }

  /** Set an entry locally (our own decision). */
  set(e: ItemEntry, now: number) {
    const bt = this.tasks.get(e.taskId)
    if (!bt) return
    bt.items.set(e.itemId, { ...e })
    this.touch(e.taskId, e.itemId, now)
  }

  cancelTask(taskId: number, now: number) {
    const bt = this.tasks.get(taskId)
    if (!bt) return
    for (const [id, e] of bt.items) {
      if (e.state !== ItemState.DONE && e.state !== ItemState.CANCELLED) {
        bt.items.set(id, { ...e, state: ItemState.CANCELLED })
        this.touch(taskId, id, now)
      }
    }
  }

  lastChange(taskId: number, itemId: number) {
    return this.tasks.get(taskId)?.lastChange.get(itemId) ?? 0
  }

  isComplete(taskId: number) {
    const bt = this.tasks.get(taskId)
    return !!bt && [...bt.items.values()].every((e) => FINAL(e.state))
  }

  takeChanged(): Map<number, Set<number>> {
    const c = this.changed
    this.changed = new Map()
    return c
  }

  private touch(taskId: number, itemId: number, now: number) {
    this.tasks.get(taskId)?.lastChange.set(itemId, now)
    if (!this.changed.has(taskId)) this.changed.set(taskId, new Set())
    this.changed.get(taskId)!.add(itemId)
  }

  // ---------- slot rule (9.7) ----------

  private active(taskId: number) {
    return [...(this.tasks.get(taskId)?.items.values() ?? [])].filter((e) => e.state === ItemState.ASSIGNED || e.state === ItemState.STARTED)
  }

  private weakest(entries: ItemEntry[]): ItemEntry | undefined {
    let w: ItemEntry | undefined
    for (const e of entries) {
      if (e.state === ItemState.STARTED) continue
      if (!w || e.winBid < w.winBid || (e.winBid === w.winBid && (e.winNode ?? '') > (w.winNode ?? ''))) w = e
    }
    return w
  }

  slotRuleAllows(t: Task, itemId: number, u: number): boolean {
    const A = this.active(t.taskId)
    if (A.length < t.robotCount) return true
    if (A.some((e) => e.itemId === itemId)) return true
    const w = this.weakest(A)
    return !!w && u > w.winBid
  }

  enforceSlotCap(now: number) {
    for (const bt of this.tasks.values()) {
      let A = this.active(bt.task.taskId)
      while (A.length > bt.task.robotCount) {
        const w = this.weakest(A)
        if (!w) break
        this.set({ ...w, winBid: 0, winNode: null, state: ItemState.OPEN }, now)
        A = this.active(bt.task.taskId)
      }
    }
  }
}

export function open(taskId: number, itemId: number): ItemEntry {
  return { taskId, itemId, gen: 0, winBid: 0, winNode: null, state: ItemState.OPEN }
}

// ---------- release rule (9.9) ----------

/** Stop reasons that need a RESUME (8.8): everything except holds and low battery. */
export const NEEDS_RESUME = new Set([
  StopReason.LOST_MESH_CONTACT,
  StopReason.NEAR_MISS,
  StopReason.PERSON_DETECTED,
  StopReason.COLLISION,
  StopReason.FAULT,
  StopReason.ZONE_BREACH,
  StopReason.SUPERVISOR_STOP,
  StopReason.OUT_OF_COVERAGE,
])

/** What each robot knows about other robots from their ROBOT_STATE. */
export interface OwnerView {
  lastState: number
  mode: RobotMode
  stopReason: StopReason
  taskId: number
  itemId: number
  stoppedSince?: number
  mismatchSince?: Map<string, number> // per "task/item" being watched
}

export function updateOwner(views: Map<NodeId, OwnerView>, node: NodeId, s: { mode: RobotMode; stopReason: StopReason; taskId: number; itemId: number }, now: number) {
  const v = views.get(node)
  const stopped = s.mode === RobotMode.STOPPED && NEEDS_RESUME.has(s.stopReason)
  const stoppedSince = stopped ? (v?.stoppedSince ?? now) : undefined
  views.set(node, { lastState: now, mode: s.mode, stopReason: s.stopReason, taskId: s.taskId, itemId: s.itemId, stoppedSince, mismatchSince: v?.mismatchSince ?? new Map() })
}

export type Release = { taskId: number; itemId: number; newGen: number; reason: number; held: boolean }

/** Release reasons in ITEM_RELEASED (9.9). */
export const ReleaseReason = { OWNER_SILENT: 1, OWNER_STOPPED: 2, OWNER_MISMATCH: 3, SUPERVISOR: 4, ITEM_FAILED: 5, REDIRECT: 6, SIGNOFF_REJECTED: 7 } as const

/** Apply 9.9 to every ASSIGNED/STARTED item owned by another node. Returns releases applied. */
export function applyReleaseRule(book: AuctionBook, views: Map<NodeId, OwnerView>, self: NodeId | null, now: number, firstSeenNode: (n: NodeId) => number): Release[] {
  const out: Release[] = []
  for (const bt of book.tasks.values()) {
    for (const e of bt.items.values()) {
      if (e.state !== ItemState.ASSIGNED && e.state !== ItemState.STARTED) continue
      const w = e.winNode
      if (!w || w === self) continue
      const exclusiveStarted = e.state === ItemState.STARTED && !!book.item(e.taskId, e.itemId)?.exclusive
      const v = views.get(w)
      const lastHeard = v?.lastState ?? firstSeenNode(w)
      let reason = 0
      let hold = false
      if (now - lastHeard >= T.OWNER_SILENT) {
        reason = ReleaseReason.OWNER_SILENT
        hold = exclusiveStarted
      } else if (v?.stoppedSince !== undefined && now - v.stoppedSince >= T.OWNER_STOPPED) {
        reason = ReleaseReason.OWNER_STOPPED
        hold = exclusiveStarted
      } else if (v) {
        const key = `${e.taskId}/${e.itemId}/${e.gen}`
        const mismatch = v.taskId !== e.taskId || v.itemId !== e.itemId || (e.state === ItemState.STARTED && v.mode === RobotMode.IDLE)
        if (mismatch) {
          const since = v.mismatchSince!.get(key) ?? now
          v.mismatchSince!.set(key, since)
          if (now - since >= T.OWNER_MISMATCH) reason = ReleaseReason.OWNER_MISMATCH
        } else {
          v.mismatchSince!.delete(key)
        }
      }
      if (!reason) continue
      if (hold) {
        book.set({ ...e, state: ItemState.HELD }, now)
        out.push({ taskId: e.taskId, itemId: e.itemId, newGen: e.gen, reason, held: true })
      } else {
        book.set({ taskId: e.taskId, itemId: e.itemId, gen: e.gen + 1, winBid: 0, winNode: null, state: ItemState.OPEN }, now)
        out.push({ taskId: e.taskId, itemId: e.itemId, newGen: e.gen + 1, reason, held: false })
      }
    }
  }
  return out
}
