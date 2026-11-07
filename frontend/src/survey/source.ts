// The survey UI reaches the survey only through this interface, so the simulated
// session can later be replaced by live drone data from the edge server.

import { useEffect, useSyncExternalStore } from 'react'
import type { Pt, SurveySnapshot } from './types'
import { SurveySession } from './session'

export interface SurveySource {
  start(): void
  stop(): void
  subscribe(listener: () => void): () => void
  getSnapshot(): SurveySnapshot
  /** Elevation in meters per cell (row-major). Only read cells where `coverage` is 1. */
  readonly heights: Float32Array
  /** 1 where the drones have mapped the ground, else 0. */
  readonly coverage: Uint8Array
  setDistance(m: number): void
  startSurvey(distanceM?: number): string
  requestSections(ids: string[]): string
  mapMore(): string
  recallAll(): string
  lock(): string
  elevationAt(p: Pt): number | undefined
}

let instance: SurveySource | null = null

export function getSurveySource(): SurveySource {
  // Swap the selection algorithm here when it's ready:
  //   new SurveySession({ selection: teammateSelection })
  if (!instance) instance = new SurveySession()
  return instance
}

export function useSurvey(source: SurveySource): SurveySnapshot {
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
