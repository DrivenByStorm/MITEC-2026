import type { MeshRound } from './types'

export const MODE_LABEL = 'Emulated bidding and consensus'

/** Plain-language status of one round from the hub's point of view. */
export function roundSummary(r: MeshRound) {
  const heard = Object.keys(r.bids).length + r.declined.length
  if (r.status === 'committed') return `Assigned to ${r.commit?.owner} after ${r.ageS} s`
  if (r.status === 'no_eligible') return 'No eligible robot'
  if (r.status === 'cancelled') return r.outcome ?? 'Cancelled'
  const t = r.tentative
  if (t) return `Awaiting agreement: ${t.robot} has ${t.matching} of ${t.of} matching`
  return `Bidding: hub has ${heard} of ${r.participants.length} responses`
}

