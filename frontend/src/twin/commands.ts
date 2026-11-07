// Turns the build manager's typed messages into answers and actions.
// This is a small rule-based parser so the interface works fully offline.
// It can later be replaced or backed by a language model running on the edge server.

import type { Asset, TwinSnapshot } from './types'
import type { TwinSource } from './source'
import { ageSeconds, formatAge, freshness } from './source'

export interface CommandResult {
  reply: string
  /** Asset to highlight on the map. */
  select?: string
  /** Map point to center on. */
  focus?: { x: number; y: number }
}

export const EXAMPLES = [
  'status',
  'where is RPD-1',
  'need a telehandler at B7',
  'pause CR-1',
  'who is in block C',
  'network',
]

const HELP = [
  'Things you can ask or tell the site:',
  '• status — progress, crews and network at a glance',
  '• where is <name> — find a robot, machine, worker or relay',
  '• need a <telehandler | crane> at <B7 | C-03-07 | laydown> — request equipment',
  '• pause <name> / resume <name> — hold or release a machine',
  '• stop all robots — pause every robot and drone',
  '• who is in block <A–D> — people and machines in a block',
  '• network — relay health and anything out of coverage',
  '• requests — open equipment requests; cancel REQ-001 to cancel one',
].join('\n')

function findAsset(snapshot: TwinSnapshot, text: string): Asset | undefined {
  const q = text.trim().toLowerCase().replace(/[.?!]$/, '')
  if (!q) return undefined
  return (
    snapshot.assets.find((a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q) ??
    snapshot.assets.find((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) ??
    snapshot.assets.find((a) => a.role.toLowerCase() === q)
  )
}

function blockOf(snapshot: TwinSnapshot, x: number, y: number) {
  return snapshot.blocks.find((b) => x >= b.x - 10 && x <= b.x + b.w + 10 && y >= b.y - 10 && y <= b.y + b.h + 30)
}

function describeAsset(a: Asset, snapshot: TwinSnapshot) {
  const age = ageSeconds(a.lastHeard, snapshot.now)
  const where = blockOf(snapshot, a.x, a.y)
  const place = where ? `in block ${where.id}` : 'outside the arrays'
  const link =
    a.link === 'none'
      ? 'Out of coverage right now, so this is its last reported position.'
      : `Reporting over ${a.link === 'lora' ? 'LoRa' : 'mesh'}${a.via ? ` via ${a.via}` : ''}.`
  const status = a.kind === 'worker' ? a.role : `${a.mode}. ${a.task}`
  return `${a.name} (${a.role.toLowerCase()}) is ${place}: ${status}. Last heard ${formatAge(age)}. ${link}`
}

export function runCommand(input: string, snapshot: TwinSnapshot, source: TwinSource): CommandResult {
  const text = input.trim()
  const lower = text.toLowerCase()
  if (!text) return { reply: '' }

  if (/^(help|\?|what can you do)/.test(lower)) return { reply: HELP }

  // Status / summary
  if (/^(status|summary|overview|how.*(site|going))/.test(lower)) {
    const total = snapshot.units.length
    const installed = snapshot.units.filter((u) => u.status === 'installed').length
    const piled = snapshot.units.filter((u) => u.status === 'piled').length
    const workers = snapshot.assets.filter((a) => a.kind === 'worker')
    const machines = snapshot.assets.filter((a) => a.kind !== 'worker' && a.kind !== 'relay')
    const stale = snapshot.assets.filter((a) => freshness(a.lastHeard, snapshot.now) === 'stale' && a.kind !== 'relay')
    const relays = snapshot.assets.filter((a) => a.kind === 'relay')
    const down = relays.filter((r) => r.mode === 'offline' || r.link === 'none')
    const open = snapshot.requests.filter((r) => !['done', 'cancelled'].includes(r.status))
    return {
      reply: [
        `${installed} of ${total} P3 units set (${Math.round((installed / total) * 100)}%), ${piled} more foundations ready.`,
        `${workers.length} people and ${machines.length} robots and machines on site.`,
        `${relays.length - down.length} of ${relays.length} relays up${down.length ? ` (${down.map((d) => d.name).join(', ')} down)` : ''}.`,
        stale.length ? `Not heard from in 30 s or more: ${stale.map((s) => s.name).join(', ')}.` : 'Every asset has reported in the last 30 s.',
        open.length ? `${open.length} open equipment request(s).` : 'No open equipment requests.',
        `Satellite uplink ${snapshot.uplink.online ? 'up' : 'down; site is running locally'}.`,
      ].join('\n'),
    }
  }

  // Where is X
  const where = lower.match(/^(?:where(?:'s| is)|find|locate|show|select)\s+(.+)$/)
  if (where) {
    const a = findAsset(snapshot, where[1])
    if (!a) return { reply: `I can't find "${where[1]}" on site. Try a name like RPD-1, TH-2, M-4 or J. Ortiz.` }
    return { reply: describeAsset(a, snapshot), select: a.id, focus: { x: a.x, y: a.y } }
  }

  // Stop all robots
  if (/^(stop|pause|halt) (all|every)( the)? robots?/.test(lower)) {
    return { reply: source.pauseAllRobots() }
  }

  // Pause / resume
  const pr = lower.match(/^(pause|hold|stop|resume|release|start)\s+(.+)$/)
  if (pr) {
    const a = findAsset(snapshot, pr[2])
    if (!a) return { reply: `I can't find "${pr[2]}" on site.` }
    const verb = pr[1]
    const reply = ['pause', 'hold', 'stop'].includes(verb) ? source.pause(a.id) : source.resume(a.id)
    return { reply, select: a.id, focus: { x: a.x, y: a.y } }
  }

  // Cancel request
  const cancel = lower.match(/^cancel\s+(req-?\d+)/)
  if (cancel) {
    const id = cancel[1].toUpperCase().replace(/^REQ-?/, 'REQ-')
    return { reply: source.cancelRequest(id) }
  }

  // Equipment request: "need a telehandler at B7", "request crane to C-03-07", "send TH at laydown"
  const req = lower.match(/^(?:i\s+)?(?:need|request|send|get)\s+(?:an?\s+|the\s+)?(.+?)\s+(?:at|to|for|near)\s+(.+)$/)
  if (req) {
    const target = source.resolveTarget(req[2])
    if (!target) {
      return { reply: `I couldn't place "${req[2]}" on the map. Use a block and row like B7, a unit like C-03-07, a machine name, or "laydown".` }
    }
    const r = source.createRequest(req[1], target, 'Build manager')
    const assigned = r.assignedTo ? ` Assigned to ${r.assignedTo}, about ${r.eta} s away.` : ' Nothing suitable is free yet, so it is queued.'
    return { reply: `Created ${r.id}: ${req[1]} at ${target.label}.${assigned}`, select: r.assignedTo, focus: target }
  }

  // Requests list
  if (/^(requests?|queue|open requests)/.test(lower)) {
    const open = snapshot.requests.filter((r) => !['done', 'cancelled'].includes(r.status))
    if (!open.length) return { reply: 'No open equipment requests. Try "need a telehandler at B7".' }
    return {
      reply: open
        .map((r) => `${r.id}: ${r.need} at ${r.target.label}, ${r.status}${r.assignedTo ? ` (${r.assignedTo}${r.eta != null && r.status === 'en-route' ? `, ${r.eta} s` : ''})` : ''}`)
        .join('\n'),
    }
  }

  // Who is in block X
  const inBlock = lower.match(/(?:who|what)(?:'s| is)?\s+in\s+block\s+([a-d])/)
  if (inBlock) {
    const id = inBlock[1].toUpperCase()
    const here = snapshot.assets.filter((a) => a.kind !== 'relay' && blockOf(snapshot, a.x, a.y)?.id === id)
    const b = snapshot.blocks.find((x) => x.id === id)!
    if (!here.length) return { reply: `No one is reported in block ${id} right now.`, focus: { x: b.x + b.w / 2, y: b.y + b.h / 2 } }
    const people = here.filter((a) => a.kind === 'worker').map((a) => `${a.name} (${a.role.toLowerCase()})`)
    const machines = here.filter((a) => a.kind !== 'worker').map((a) => a.name)
    return {
      reply: [`Block ${id}:`, people.length ? `People: ${people.join(', ')}` : 'No people.', machines.length ? `Machines: ${machines.join(', ')}` : 'No machines.'].join('\n'),
      focus: { x: b.x + b.w / 2, y: b.y + b.h / 2 },
    }
  }

  // Network
  if (/^(network|relays?|coverage|mesh)/.test(lower)) {
    const relays = snapshot.assets.filter((a) => a.kind === 'relay')
    const down = relays.filter((r) => r.mode === 'offline' || r.link === 'none')
    const dark = snapshot.assets.filter((a) => a.kind !== 'relay' && a.kind !== 'worker' && a.link === 'none')
    const lowBatt = relays.filter((r) => r.energy < 30 && r.mode !== 'offline')
    return {
      reply: [
        `${relays.length - down.length} of ${relays.length} relays up, ${snapshot.links.length} mesh links active.`,
        down.length ? `Down: ${down.map((d) => `${d.name} (last heard ${formatAge(ageSeconds(d.lastHeard, snapshot.now))})`).join(', ')}.` : 'No relays down.',
        dark.length ? `Out of coverage, working offline and queuing updates: ${dark.map((d) => d.name).join(', ')}.` : 'Every robot and machine has a path to the edge server.',
        lowBatt.length ? `Low battery: ${lowBatt.map((r) => `${r.name} ${r.energy}%`).join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  // Bare asset name
  const bare = findAsset(snapshot, text)
  if (bare) return { reply: describeAsset(bare, snapshot), select: bare.id, focus: { x: bare.x, y: bare.y } }

  return { reply: `I didn't understand "${text}". Type help to see what I can do.` }
}
