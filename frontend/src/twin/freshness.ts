// How fresh an asset's last report is: live under 10 s, lagging under 30 s, stale beyond that.

/** Seconds since an asset was last heard from. */
export function ageSeconds(lastHeard: number, now: number) {
  return Math.max(0, Math.round((now - lastHeard) / 1000))
}

export type Freshness = 'live' | 'lagging' | 'stale'

/** Live under 10 s, lagging under 30 s, stale beyond that. */
export function freshness(lastHeard: number, now: number): Freshness {
  const age = ageSeconds(lastHeard, now)
  if (age < 10) return 'live'
  if (age < 30) return 'lagging'
  return 'stale'
}

export function formatAge(seconds: number) {
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const m = Math.floor(seconds / 60)
  return `${m} min ago`
}
