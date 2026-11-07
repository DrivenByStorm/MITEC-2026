// The UI talks to the twin only through this interface, so the simulator can
// later be swapped for a live feed from the on-site edge server (e.g. a
// WebSocket bridged from Zenoh) without touching the components.

import { useEffect, useSyncExternalStore } from 'react'
import type { AssetRequest, TwinSnapshot } from './types'
import { getSimulatedSite } from './simulator'

export interface TwinSource {
  start(): void
  stop(): void
  subscribe(listener: () => void): () => void
  getSnapshot(): TwinSnapshot
  pause(assetId: string): string
  resume(assetId: string): string
  pauseAllRobots(): string
  createRequest(need: string, target: { label: string; x: number; y: number }, requestedBy: string): AssetRequest
  cancelRequest(requestId: string): string
  resolveTarget(text: string): { label: string; x: number; y: number } | undefined
}

export function getTwinSource(): TwinSource {
  return getSimulatedSite()
}

export function useTwin(source: TwinSource = getTwinSource()): TwinSnapshot {
  useEffect(() => {
    source.start()
  }, [source])
  return useSyncExternalStore(
    (cb) => {
      const unsub = source.subscribe(cb)
      return () => {
        unsub()
      }
    },
    () => source.getSnapshot(),
  )
}

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
