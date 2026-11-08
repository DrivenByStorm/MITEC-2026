// Turns a buildup plan into a twin snapshot so the plan can be previewed on the same
// site map the construction stage uses: units as planned footprints, relays live.

import type { SitePlan } from './types'
import type { Asset, RelayLink, TwinSnapshot } from '../twin/types'
import { RELAY_RANGE_M } from '../twin/network'

export function planPreview(plan: SitePlan): TwinSnapshot {
  const now = plan.createdAt
  const relays: Asset[] = [
    ...plan.relays.map((r) => relay(r.id, r.x, r.y, r.linkOnly ? 'Relay mast (link only)' : 'Solar relay mast', now)),
    relay('GW', plan.gateway.x, plan.gateway.y, 'Gateway (wired to edge server)', now, 'Gateway'),
  ]
  const links: RelayLink[] = []
  for (let i = 0; i < relays.length; i++) {
    for (let j = i + 1; j < relays.length; j++) {
      const d = Math.hypot(relays[i].x - relays[j].x, relays[i].y - relays[j].y)
      if (d <= RELAY_RANGE_M) links.push({ a: relays[i].id, b: relays[j].id, quality: Math.max(0.2, 1 - (d / RELAY_RANGE_M) * 0.7) })
    }
  }
  const o = plan.office
  const { cols, rows, cellM } = plan.terrain
  return {
    now,
    siteName: 'New site, Pecos County TX',
    site: { w: cols * cellM, h: rows * cellM },
    view: plan.bounds,
    office: plan.office,
    laydown: plan.laydown,
    terrainImage: plan.terrainImage,
    blocks: plan.blocks.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, rows: b.rows, slots: b.slots })),
    units: plan.units.map((u) => ({ ...u, status: 'planned' })),
    assets: relays,
    links,
    edgeServer: { x: o.x + o.w - 30, y: o.y + 45, online: true },
    rtkBase: { x: o.x + o.w - 30, y: o.y + o.h - 30, online: true },
    uplink: { online: true, lastSync: now },
    events: [],
    requests: [],
  }
}

function relay(id: string, x: number, y: number, role: string, now: number, name = id): Asset {
  return { id, name, kind: 'relay', role, x, y, heading: 0, mode: 'autonomous', task: 'Planned', energy: 100, lastHeard: now, link: 'mesh' }
}
