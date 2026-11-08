// Mesh simulator service. The edge service (hub software) connects over a WebSocket, starts a
// simulated site from the approved plan, and receives the hub mesh service's twin interface
// (12.1): a snapshot every second and an event stream, plus packet traces (12.2) on request.
//
//   node dist/src/server.js [--port 8766] [--host 127.0.0.1]
//
// Client -> server: start {input}, stop, command {id, supervisor, cmd, target, args},
//   ack {supervisor, alertId, action}, speed {value}, inject {id, kind, target},
//   trace {enabled, classes?, follow?, includeBeacons?}
// Server -> client: hello, snapshot {mesh, planning, status}, events {events}, traces {traces},
//   log {lines}, result {id, ok, text, result}

import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { Simulation } from './index.js'
import type { InjectKind, SimInput } from './index.js'
import type { MeshEvent, MeshTrace } from './types.js'
import { Cmd, MsgClass, MsgType } from './types.js'

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : (process.env[`MESH_${name.toUpperCase()}`] ?? def)
}
const port = Number(arg('port', '8766'))
const host = arg('host', '127.0.0.1')

let sim: Simulation | null = null
const clients = new Set<WebSocket>()
let events: MeshEvent[] = []
let traces: MeshTrace[] = []
let traceOpts: { enabled: boolean; classes: number[]; follow: string | null; includeBeacons: boolean } = { enabled: false, classes: [0, 1, 2, 3], follow: null, includeBeacons: false }
let lastSnapshot = 0
let flushTimer: ReturnType<typeof setInterval> | null = null

const QUIET_TYPES = new Set([MsgType.AUCTION_STATE, MsgType.TASK, MsgType.TRACKS, MsgType.ZONE_SET, MsgType.NODE_LIST, MsgType.BULK_CHUNK, MsgType.BULK_NACK])

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}
function broadcast(msg: unknown) {
  const data = JSON.stringify(msg)
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data)
}

function start(input: SimInput) {
  sim?.stop()
  events = []
  traces = []
  sim = new Simulation(input)
  sim.onEvent((e) => {
    if (e.kind === 'packet' && (QUIET_TYPES.has(e.h.type) || e.h.cls === MsgClass.STATUS)) return
    events.push(e)
    if (events.length > 2000) events.splice(0, events.length - 2000)
  })
  sim.onTrace((t) => {
    if (!traceOpts.enabled) return
    if (!traceOpts.includeBeacons && (t.type === MsgType.RELAY_BEACON || t.type === MsgType.ROBOT_BEACON)) return
    if (traceOpts.follow ? t.msgId !== traceOpts.follow : !traceOpts.classes.includes(t.cls)) return
    traces.push(t)
    if (traces.length > 5000) traces.splice(0, traces.length - 5000)
  })
  sim.boot()
  sim.run(() => {
    const now = Date.now()
    if (now - lastSnapshot >= 1000) {
      lastSnapshot = now
      pushSnapshot()
    }
  })
  flushTimer ??= setInterval(flush, 150)
  pushSnapshot()
}

function pushSnapshot() {
  if (!sim) return
  broadcast({ type: 'snapshot', mesh: sim.snapshot(), planning: sim.planning(), status: sim.status(), hubLog: sim.hub.log.slice(-120) })
  const lines = sim.takeLog()
  if (lines.length) broadcast({ type: 'log', lines })
}

function flush() {
  if (events.length) {
    broadcast({ type: 'events', events })
    events = []
  }
  if (traces.length) {
    broadcast({ type: 'traces', traces: traces.slice(-800) })
    traces = []
  }
}

const wss = new WebSocketServer({ port, host })
wss.on('connection', (ws) => {
  clients.add(ws)
  send(ws, { type: 'hello', running: !!sim, status: sim?.status() ?? null })
  if (sim) send(ws, { type: 'snapshot', mesh: sim.snapshot(), planning: sim.planning(), status: sim.status() })
  ws.on('close', () => clients.delete(ws))
  ws.on('message', async (raw) => {
    let m: { type: string; [k: string]: unknown }
    try {
      m = JSON.parse(String(raw))
    } catch {
      return
    }
    const reply = (ok: boolean, text: string, extra: Record<string, unknown> = {}) => send(ws, { type: 'result', id: m.id, ok, text, ...extra })
    try {
      switch (m.type) {
        case 'start':
          start(m.input as SimInput)
          return reply(true, 'Simulation started.')
        case 'stop':
          sim?.stop()
          sim = null
          return reply(true, 'Simulation stopped.')
        case 'speed':
          if (!sim) return reply(false, 'No simulation running.')
          sim.speed = Math.max(0.25, Math.min(20, Number(m.value) || 1))
          return reply(true, `Speed ${sim.speed}×.`)
        case 'inject':
          if (!sim) return reply(false, 'No simulation running.')
          return reply(true, sim.inject(m.kind as InjectKind, m.target as string | undefined))
        case 'trace':
          traceOpts = { enabled: !!m.enabled, classes: (m.classes as number[]) ?? [0, 1, 2, 3], follow: (m.follow as string) ?? null, includeBeacons: !!m.includeBeacons }
          return reply(true, traceOpts.enabled ? 'Tracing on.' : 'Tracing off.')
        case 'ack':
          if (!sim) return reply(false, 'No simulation running.')
          sim.ack(String(m.supervisor), Number(m.alertId), Number(m.action) as 0 | 1 | 2)
          return reply(true, 'Acknowledged.')
        case 'command': {
          if (!sim) return reply(false, 'No simulation running.')
          const cmd = typeof m.cmd === 'string' ? Cmd[m.cmd as keyof typeof Cmd] : Number(m.cmd)
          if (!cmd) return reply(false, `Unknown command ${String(m.cmd)}.`)
          const res = await sim.command(String(m.supervisor), cmd, (m.target as string) ?? null, (m.args as Record<string, unknown>) ?? {})
          if (!res) return reply(false, 'No answer: the command was retried 5 times without a CMD_RESULT.', { result: null })
          const reasons = ['', 'not a supervisor', 'unknown stop', 'not on site', 'condition not met', 'unknown item', 'bad arguments']
          const text = res.result === 0 ? 'Done.' : `${res.result === 1 ? 'Rejected' : 'Not applicable'}: ${reasons[res.reason] ?? `reason ${res.reason}`}.`
          return reply(res.result === 0, text, { result: res })
        }
      }
    } catch (e) {
      reply(false, `Error: ${(e as Error).message}`)
    }
  })
})
console.log(`mesh simulator listening on ws://${host}:${port}`)
