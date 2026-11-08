// Connection to the edge service (services/edge), which runs the site twin and the site agent.
//
// The UI holds no site logic of its own: it renders what the edge service streams and
// sends the build manager's actions and chat messages back. Point it at another edge
// server with VITE_EDGE_URL at build time or ?edge=host:port in the URL.

import { useEffect, useSyncExternalStore } from 'react'
import type { SurveySnapshot } from '../survey/types'
import type { TwinSnapshot } from '../twin/types'
import type { SitePlan } from '../buildup/types'
import type { Pt } from '../survey/types'

export type Stage = 'survey' | 'buildup' | 'construction'

export type ActionName =
  | 'survey.setDistance'
  | 'survey.start'
  | 'survey.requestSections'
  | 'survey.mapMore'
  | 'survey.recall'
  | 'survey.lock'
  | 'plan.generate'
  | 'plan.approve'
  | 'twin.pause'
  | 'twin.resume'
  | 'twin.pauseAll'
  | 'twin.request'
  | 'twin.cancelRequest'

export type Act = (name: ActionName, args?: Record<string, unknown>) => Promise<ActionResult>

export interface ActionResult {
  ok: boolean
  text: string
}

export interface Suggestion {
  id: string
  action: ActionName
  args: Record<string, unknown>
  label: string
  reason: string
  status: 'pending' | 'approved' | 'dismissed' | 'failed' | 'expired'
  result?: string
}

export interface ChatMessage {
  id: number
  at: number
  /** you = build manager, agent = site agent (Claude), site = result of a direct action */
  from: 'you' | 'agent' | 'site'
  text: string
  /** Agent spoke up on its own after the monitor flagged something. */
  proactive?: boolean
  /** What the agent looked up, in plain words. */
  tools?: string[]
  /** Asset the agent looked up; the map highlights it. */
  select?: string
  suggestions?: Suggestion[]
  /** For site messages: the action that ran. */
  action?: string
  ok?: boolean
}

export interface AgentState {
  online: boolean
  status: string
  busy: boolean
  activity: string
  model: string
}

export interface TerrainInfo {
  cols: number
  rows: number
  cellM: number
  real: boolean
  sourceLabel: string
  lat0: number
  lon0: number
}

export interface EdgeState {
  url: string
  connection: 'connecting' | 'open' | 'closed'
  /** True once the first full state has arrived. */
  ready: boolean
  /** Furthest stage the site has reached. */
  stage: Stage
  terrain: TerrainInfo | null
  network: { relayRangeM: number; assetRangeM: number; loraRangeM: number }
  survey: SurveySnapshot | null
  coverageVersion: number
  plan: SitePlan | null
  preview: TwinSnapshot | null
  planVersion: number
  twin: TwinSnapshot | null
  chat: ChatMessage[]
  agent: AgentState
}

function edgeUrl(): string {
  const q = new URLSearchParams(window.location.search).get('edge')
  if (q) return q.startsWith('ws') ? q : `ws://${q}/ws`
  const env = import.meta.env.VITE_EDGE_URL as string | undefined
  if (env) return env
  // Served by the edge service itself (tablets on the site network): same host.
  if (window.location.protocol.startsWith('http') && window.location.port === '8765') return `ws://${window.location.host}/ws`
  return 'ws://localhost:8765/ws'
}

// Python sends null for missing values; the UI types use undefined.
const parse = (text: string) => JSON.parse(text, (_k, v) => (v === null ? undefined : v))

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

class EdgeClient {
  /** Elevation in meters per cell (row-major). Only meaningful where `coverage` is 1. */
  heights = new Float32Array(0)
  /** 1 where the drones have mapped the ground (mutated in place; watch coverageVersion). */
  coverage = new Uint8Array(0)

  private state: EdgeState
  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private pending = new Map<number, (r: ActionResult) => void>()
  private reqSeq = 1
  private retry = 0

  constructor(url: string) {
    this.state = {
      url,
      connection: 'connecting',
      ready: false,
      stage: 'survey',
      terrain: null,
      network: { relayRangeM: 460, assetRangeM: 270, loraRangeM: 2000 },
      survey: null,
      coverageVersion: -1,
      plan: null,
      preview: null,
      planVersion: 0,
      twin: null,
      chat: [],
      agent: { online: false, status: 'connecting', busy: false, activity: '', model: '' },
    }
    this.connect()
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  getState = () => this.state

  /** Run an action directly (the build manager clicked a button). */
  act: Act = (name, args = {}) => {
    const id = this.reqSeq++
    if (!this.send({ type: 'action', id, name, args })) return Promise.resolve({ ok: false, text: 'Not connected to the edge service.' })
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      setTimeout(() => {
        if (this.pending.delete(id)) resolve({ ok: false, text: 'The edge service did not answer.' })
      }, 15000)
    })
  }

  /** Send a message to the site agent. */
  chat = (text: string) => {
    this.send({ type: 'chat', text })
  }

  /** Approve or dismiss one of the agent's suggestions. */
  decide = (suggestionId: string, approve: boolean) => {
    this.send({ type: 'decide', suggestionId, approve })
  }

  /** Survey distance slider (before the survey starts). */
  setDistance = (m: number) => {
    void this.act('survey.setDistance', { m })
  }

  elevationAt = (p: Pt): number | undefined => {
    const t = this.state.terrain
    if (!t) return undefined
    const c = Math.floor(p.x / t.cellM)
    const r = Math.floor(p.y / t.cellM)
    if (c < 0 || r < 0 || c >= t.cols || r >= t.rows) return undefined
    const i = r * t.cols + c
    return this.coverage[i] ? this.heights[i] : undefined
  }

  // ---------- connection ----------

  private connect() {
    const ws = new WebSocket(this.state.url)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.set({ connection: 'open' })
    }
    ws.onmessage = (e) => this.onMessage(parse(e.data as string))
    ws.onclose = () => {
      this.ws = null
      this.set({ connection: 'closed' })
      for (const resolve of this.pending.values()) resolve({ ok: false, text: 'Lost the connection to the edge service.' })
      this.pending.clear()
      const delay = Math.min(5000, 500 * 2 ** this.retry++)
      setTimeout(() => this.connect(), delay)
    }
  }

  private send(msg: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  private set(patch: Partial<EdgeState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  private applyCoverage(cov?: { version: number; bits: string }) {
    if (!cov || cov.version === this.state.coverageVersion) return {}
    const packed = b64ToBytes(cov.bits)
    const n = this.coverage.length
    for (let i = 0; i < n; i++) this.coverage[i] = (packed[i >> 3] >> (7 - (i & 7))) & 1
    return { coverageVersion: cov.version }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onMessage(m: any) {
    switch (m.type) {
      case 'hello': {
        const t = m.terrain
        const dm = new Int16Array(b64ToBytes(t.heightsDm).buffer)
        this.heights = new Float32Array(dm.length)
        for (let i = 0; i < dm.length; i++) this.heights[i] = dm[i] / 10
        this.coverage = new Uint8Array(t.cols * t.rows)
        this.state = { ...this.state, coverageVersion: -1 }
        const { heightsDm: _drop, ...terrain } = t // eslint-disable-line @typescript-eslint/no-unused-vars
        this.set({
          ready: true,
          terrain,
          network: m.network,
          stage: m.stage,
          survey: m.survey,
          ...this.applyCoverage(m.coverage),
          plan: m.plan ?? null,
          preview: m.preview ?? null,
          planVersion: m.planVersion,
          twin: m.twin ?? null,
          chat: m.chat ?? [],
          agent: m.agent,
        })
        return
      }
      case 'survey':
        return this.set({ survey: m.snapshot, ...this.applyCoverage(m.coverage) })
      case 'twin':
        return this.set({ twin: m.snapshot ?? null })
      case 'plan':
        return this.set({ plan: m.plan ?? null, preview: m.preview ?? null, planVersion: m.version })
      case 'stage':
        return this.set({ stage: m.stage })
      case 'agent':
        return this.set({ agent: { online: m.online, status: m.status, busy: m.busy, activity: m.activity ?? '', model: m.model } })
      case 'chat': {
        const msg = m.message as ChatMessage
        const chat = this.state.chat.some((c) => c.id === msg.id) ? this.state.chat.map((c) => (c.id === msg.id ? msg : c)) : [...this.state.chat, msg]
        return this.set({ chat })
      }
      case 'result': {
        const resolve = this.pending.get(m.id)
        this.pending.delete(m.id)
        resolve?.({ ok: m.ok, text: m.text })
        return
      }
    }
  }
}

export const edge = new EdgeClient(edgeUrl())

export function useEdge(): EdgeState {
  return useSyncExternalStore(edge.subscribe, edge.getState)
}

export const STAGE_ORDER: Stage[] = ['survey', 'buildup', 'construction']

/** The asset the agent most recently looked up, so views can highlight it on the map. */
export function useAgentSelection(chat: ChatMessage[], onSelect: (id: string) => void) {
  const last = [...chat].reverse().find((m) => m.from === 'agent' && m.select)
  const key = last ? `${last.id}:${last.select}` : ''
  useEffect(() => {
    if (last?.select) onSelect(last.select)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}
