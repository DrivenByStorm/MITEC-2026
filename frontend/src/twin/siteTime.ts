// Site times are UTC epoch ms on the site's own calendar (Day 1 = 2026-11-09), so they are
// always formatted in UTC: 07:00 on screen is 07:00 on site, wherever the browser is.

const DAY1 = Date.UTC(2026, 10, 9)

export function siteTime(ms: number, seconds = true) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23', timeZone: 'UTC' })
}

export function siteDay(ms: number) {
  return Math.floor((ms - DAY1) / 86_400_000) + 1
}

/** "x" with a clean label: 1×, 10×, 900×. */
export function speedLabel(x: number) {
  return `${Number.isInteger(x) ? x : x.toFixed(1)}×`
}
