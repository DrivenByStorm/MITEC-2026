// How fresh an asset's last report is: live under 10 s, lagging under 30 s, stale beyond that.
// Ages are in site seconds. When the simulation runs faster than real time, each update covers
// more site time, so the thresholds stretch by `slack` (set from the speed dial).

let slack = 0

/** Extra site seconds of tolerance; about one snapshot interval at the current speed. */
export function setFreshnessSlack(seconds: number) {
  slack = Math.max(0, seconds)
}

/** Seconds since an asset was last heard from. */
export function ageSeconds(lastHeard: number, now: number) {
  return Math.max(0, Math.round((now - lastHeard) / 1000))
}

export type Freshness = 'live' | 'lagging' | 'stale'

/** Live under 10 s, lagging under 30 s, stale beyond that (plus the speed slack). */
export function freshness(lastHeard: number, now: number): Freshness {
  const age = ageSeconds(lastHeard, now)
  if (age < 10 + slack) return 'live'
  if (age < 30 + slack) return 'lagging'
  return 'stale'
}

export function formatAge(seconds: number) {
  if (seconds < 5 + slack) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const m = Math.floor(seconds / 60)
  return m < 120 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`
}
