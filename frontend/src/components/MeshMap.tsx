import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { MeshView, ViewNode, ViewTrack, ViewZone, XY } from '../mesh/adapter'
import { MODE_LABEL, STOP_LABEL } from '../mesh/adapter'
import { ItemState, Liveness, MsgClass, MsgType, NodeKind, RobotMode, TrackKind } from '../mesh/types'
import type { SitePlan } from '../buildup/types'
import type { TwinSnapshot } from '../twin/types'
import { edge } from '../edge/client'
import type { MeshEvent } from '../mesh/types'

interface Props {
  view: MeshView
  plan: SitePlan
  terrainImage?: TwinSnapshot['terrainImage']
  selectedId?: string
  onSelect: (id: string | undefined) => void
  focus?: { x: number; y: number; key: number }
  expanded: boolean
  events: (MeshEvent & { recv: number })[]
  packets: boolean
  follow: string | null
  onFollow: (msgId: string | null) => void
  speed: number
  /** Wall-clock time (ms), ticking once a second, for fading recent events. */
  wallNow: number
  children?: ReactNode
}

interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

type Layers = { coverage: boolean; zones: boolean; safety: boolean; mesh: boolean; people: boolean; labels: boolean; anchors: boolean }

export function MeshMap({ view, plan, terrainImage, selectedId, onSelect, focus, expanded, events, packets, follow, onFollow, speed, wallNow, children }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const b = plan.bounds
  const fit: ViewBox = useMemo(() => ({ x: b.x, y: b.y - b.h * 0.06, w: b.w, h: b.h * 1.16 }), [b.x, b.y, b.w, b.h])
  const [px, setPx] = useState({ w: 1000, h: 600 })
  const [vb, setVb] = useState<ViewBox>(fit)
  const [layers, setLayers] = useState<Layers>({ coverage: true, zones: true, safety: false, mesh: true, people: true, labels: true, anchors: false })
  const drag = useRef<{ x: number; y: number; vb: ViewBox; moved: boolean } | null>(null)
  const zoom = fit.w / vb.w

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const ro = new ResizeObserver(([entry]) => setPx({ w: entry.contentRect.width, h: entry.contentRect.height }))
    ro.observe(svg)
    return () => ro.disconnect()
  }, [])

  const [seenFocus, setSeenFocus] = useState(focus?.key)
  if (focus && focus.key !== seenFocus) {
    setSeenFocus(focus.key)
    const w = Math.min(vb.w, fit.w / 2.4)
    const h = (w * fit.h) / fit.w
    setVb({ x: focus.x - w / 2, y: focus.y - h / 2, w, h })
  }

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const pt = toSvg(svg, e.clientX, e.clientY)
      const factor = Math.exp(e.deltaY * 0.0015)
      setVb((cur) => {
        const w = clamp(cur.w * factor, fit.w / 12, fit.w * 1.3)
        const h = (cur.h * w) / cur.w
        return { x: pt.x - ((pt.x - cur.x) * w) / cur.w, y: pt.y - ((pt.y - cur.y) * h) / cur.h, w, h }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [fit.w])

  const onPointerDown = (e: ReactPointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, vb, moved: false }
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      // synthetic events have no active pointer
    }
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    const svg = svgRef.current
    if (!d || !svg) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.hypot(dx, dy) > 4) d.moved = true
    if (!d.moved) return
    const rect = svg.getBoundingClientRect()
    const scale = Math.max(d.vb.w / rect.width, d.vb.h / rect.height)
    setVb({ ...d.vb, x: d.vb.x - dx * scale, y: d.vb.y - dy * scale })
  }
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current
    drag.current = null
    if (d && !d.moved) {
      const el = e.target as Element
      const msg = el.closest('[data-msg]')?.getAttribute('data-msg')
      if (msg) return onFollow(msg)
      onSelect(el.closest('[data-asset]')?.getAttribute('data-asset') ?? undefined)
    }
  }
  const zoomBy = (f: number) =>
    setVb((cur) => {
      const w = clamp(cur.w * f, fit.w / 12, fit.w * 1.3)
      const h = (cur.h * w) / cur.w
      return { x: cur.x + (cur.w - w) / 2, y: cur.y + (cur.h - h) / 2, w, h }
    })

  const pxPerUnit = Math.min(px.w / vb.w, px.h / vb.h) || 1
  const k = (1 / pxPerUnit) * Math.min(1.5, Math.pow(zoom, 0.25)) * clamp(px.w / 1000, 0.6, 1)

  const relays = view.nodes.filter((n) => n.kind === NodeKind.RELAY || n.kind === NodeKind.GATEWAY)
  const robots = view.nodes.filter((n) => n.kind === NodeKind.ROBOT && n.hasPos)
  const anchors = view.nodes.filter((n) => n.kind === NodeKind.ANCHOR)
  const people = view.tracks.filter((t) => t.kind === TrackKind.CREW || t.kind === TrackKind.SUPERVISOR)
  const machines = view.tracks.filter((t) => t.kind === TrackKind.MACHINE)
  const unknowns = view.tracks.filter((t) => t.kind === TrackKind.UNKNOWN)
  const office = plan.office
  const laydown = plan.laydown
  const hub = { x: office.x + office.w / 2, y: office.y + office.h / 2 }
  const recent = events.filter((e) => wallNow - e.recv < 25_000)
  const showPeopleNames = layers.labels && zoom > 2.2

  return (
    <div className={`map ${expanded ? 'map--expanded' : ''}`}>
      <svg
        ref={svgRef}
        className="map__svg"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="img"
        aria-label="Live site plan with the site mesh"
        style={{ ['--zs' as string]: k }}
      >
        <defs>
          <pattern id="ground" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" fill="none" className="ground-grid" />
          </pattern>
          <pattern id="hazard-hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <path d="M0 0V12" className="hazard-hatch" />
          </pattern>
        </defs>

        <rect x={0} y={0} width={plan.terrain.cols * plan.terrain.cellM} height={plan.terrain.rows * plan.terrain.cellM} className="ground" />
        {terrainImage && <image href={terrainImage.href} x={terrainImage.x} y={terrainImage.y} width={terrainImage.w} height={terrainImage.h} preserveAspectRatio="none" className="terrain-image" />}
        <rect x={0} y={0} width={plan.terrain.cols * plan.terrain.cellM} height={plan.terrain.rows * plan.terrain.cellM} fill="url(#ground)" />

        {/* Coverage area and the 3 m tolerance band (6.4) */}
        {layers.coverage && (
          <g className="mesh-coverage">
            {view.coverage.map((c, i) => (
              <circle key={i} cx={c.x} cy={c.y} r={c.r} className="coverage" />
            ))}
            {view.coverage.map((c, i) => (
              <circle key={`b${i}`} cx={c.x} cy={c.y} r={c.r + 3} className="coverage-band" />
            ))}
          </g>
        )}

        {/* Office (hub), laydown */}
        <g className={`office ${office.w * pxPerUnit < 120 ? 'office--small' : ''}`}>
          <rect x={laydown.x} y={laydown.y} width={laydown.w} height={laydown.h} className="laydown" />
          <text x={laydown.x + 8} y={laydown.y + laydown.h - 10} className="area-label">Laydown yard</text>
          <rect x={office.x} y={office.y} width={office.w} height={office.h} className="office__pad" />
          <text x={office.x + 8} y={office.y + office.h - 10} className="area-label">Site office</text>
          <rect x={hub.x - 10} y={hub.y - 10} width={20} height={20} className="edge-server" />
          <text x={hub.x + 16} y={hub.y + 5} className="small-label">Hub</text>
        </g>

        {layers.zones && view.zones.map((z) => <ZoneShape key={z.zone.zoneId} z={z} />)}

        {/* Blocks and units */}
        {plan.blocks.map((bl) => {
          const units = plan.units.filter((u) => u.block === bl.id)
          const set = units.filter((u) => view.unitStatus.get(u.id) === 'installed').length
          const piled = units.filter((u) => view.unitStatus.get(u.id) !== 'planned').length
          return (
            <g key={bl.id}>
              <rect x={bl.x} y={bl.y} width={bl.w} height={bl.h} className="block" />
              <text x={bl.x} y={bl.y + bl.h + 20} className="block-label">
                Block {bl.id}
                <tspan className="block-label__count" dx={8}>{piled}/{units.length} piled · {set} set</tspan>
              </text>
            </g>
          )
        })}
        {plan.units.map((u) => {
          const it = view.itemByUnit.get(u.id)
          return <Unit key={u.id} x={u.x} y={u.y} status={view.unitStatus.get(u.id) ?? 'planned'} item={it?.entry.state} />
        })}
        {view.items
          .filter((i) => !i.unitId && i.entry.state !== ItemState.DONE && i.entry.state !== ItemState.CANCELLED)
          .map((i) => (
            <g key={`${i.taskId}/${i.itemId}`} className={`check-item check-item--${i.entry.state}`} transform={`translate(${i.x} ${i.y}) scale(${k})`}>
              <title>{`As-built check ${i.itemId}: ${ItemState[i.entry.state]}`}</title>
              <path d="M0 -6L6 0L0 6L-6 0Z" />
            </g>
          ))}

        {/* Relay links (from relay neighbor tables) and gateway wires */}
        {layers.mesh &&
          view.links.map((l) => <line key={`${l.a.id}-${l.b.id}`} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} className="mesh-link" style={{ opacity: clamp((l.rssi + 115) / 45, 0.15, 0.95) }} />)}
        {layers.mesh &&
          relays
            .filter((r) => r.kind === NodeKind.GATEWAY)
            .map((g) => <line key={`w-${g.id}`} x1={g.x} y1={g.y} x2={hub.x} y2={hub.y} className={`wired-link ${g.liveness === Liveness.LOST ? 'is-down' : ''}`} />)}

        {/* Robot attachment: a line to the relay, or to the robot it reaches the mesh through */}
        {layers.mesh &&
          robots.map((r) => {
            const via = r.robot?.via ? view.byId.get(r.robot.via) : undefined
            if (!via || r.liveness === Liveness.LOST) return null
            return <line key={`via-${r.id}`} x1={r.x} y1={r.y} x2={via.x} y2={via.y} className={`via-link ${r.robot!.viaIsRobot ? 'via-link--robot' : ''}`} />
          })}

        {layers.anchors && anchors.map((a) => <AnchorMark key={a.id} a={a} k={k} selected={a.id === selectedId} />)}

        {/* Safety circles around tracks (8.6) */}
        {layers.safety &&
          view.tracks.map((t) => (
            <g key={`s-${t.kind}-${t.id}`} className="safety-circles">
              <circle cx={t.x} cy={t.y} r={t.slowM + (t.kind === TrackKind.CREW || t.kind === TrackKind.SUPERVISOR ? 0 : 0)} className="slow-circle" />
              <circle cx={t.x} cy={t.y} r={t.stopM} className="stop-circle" />
            </g>
          ))}

        {relays.map((r) => (
          <RelayMark key={r.id} r={r} k={k} selected={r.id === selectedId} label={layers.labels} />
        ))}

        {layers.people && people.map((t) => <PersonMark key={`p-${t.id}`} t={t} k={k} selected={selectedId === `t:${t.id}`} label={showPeopleNames || selectedId === `t:${t.id}` || t.kind === TrackKind.SUPERVISOR} />)}
        {machines.map((t) => (
          <MachineMark key={`m-${t.id}`} t={t} k={k} selected={selectedId === `t:${t.id}`} label={layers.labels} />
        ))}
        {unknowns.map((t) => (
          <UnknownMark key={`u-${t.id}`} t={t} k={k} />
        ))}

        {robots.map((r) => (
          <RobotMark key={r.id} r={r} now={view.now} k={k} selected={r.id === selectedId} label={layers.labels} />
        ))}

        {/* Recent events on the map */}
        {recent.map((e, i) => (
          <EventMark key={i} e={e} view={view} k={k} />
        ))}

        {packets && <PacketLayer view={view} k={k} speed={speed} />}
      </svg>

      <div className="map__tools" role="toolbar" aria-label="Map controls">
        <button type="button" onClick={() => zoomBy(0.7)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoomBy(1 / 0.7)} aria-label="Zoom out">−</button>
        <button type="button" onClick={() => setVb(fit)}>Fit site</button>
      </div>

      <fieldset className="map__layers">
        <legend className="visually-hidden">Map layers</legend>
        {(
          [
            ['coverage', 'Coverage'],
            ['zones', 'Zones'],
            ['safety', 'Safety circles'],
            ['mesh', 'Mesh'],
            ['anchors', 'Anchors'],
            ['people', 'People'],
            ['labels', 'Names'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <input type="checkbox" checked={layers[key]} onChange={() => setLayers((l) => ({ ...l, [key]: !l[key] }))} />
            {label}
          </label>
        ))}
      </fieldset>

      {follow && (
        <div className="follow-bar">
          Following message <code>{follow}</code>
          <button type="button" className="link-btn" onClick={() => onFollow(null)}>Stop following</button>
        </div>
      )}
      <MeshKey />
      {children}
    </div>
  )
}

// ---------- marks ----------

function Unit({ x, y, status, item }: { x: number; y: number; status: string; item?: ItemState }) {
  const cls = item === ItemState.STARTED ? 'unit--started' : item === ItemState.ASSIGNED ? 'unit--assigned' : item === ItemState.HELD ? 'unit--held' : item === ItemState.AWAITING_SIGNOFF ? 'unit--signoff' : ''
  if (status === 'installed') return <rect x={x - 6} y={y - 4} width={12} height={8} rx={1} className="unit unit--installed" />
  if (status === 'piled')
    return (
      <g className={`unit unit--piled ${cls}`}>
        <rect x={x - 6} y={y - 4} width={12} height={8} rx={1} />
        <circle cx={x - 3.5} cy={y} r={1.4} />
        <circle cx={x + 3.5} cy={y} r={1.4} />
      </g>
    )
  return <rect x={x - 6} y={y - 4} width={12} height={8} rx={1} className={`unit unit--planned ${cls}`} />
}

function ZoneShape({ z }: { z: ViewZone }) {
  const cls = `zone zone--${z.zone.kind}`
  const label = `${z.label} zone ${z.zone.zoneId}${z.zone.appliesTo.robots ? ' (robots out)' : ''}${z.zone.appliesTo.crew ? ' (crew out)' : ''}`
  if (z.circle) {
    const c = z.circle
    return (
      <g className={cls}>
        <title>{label}</title>
        <circle cx={c.x} cy={c.y} r={c.r + z.bufferM + z.slowM} className="zone__slow" />
        <circle cx={c.x} cy={c.y} r={c.r + z.bufferM} className="zone__buffer" />
        <circle cx={c.x} cy={c.y} r={c.r} className="zone__body" />
        <text x={c.x} y={c.y - c.r - z.bufferM - 4} textAnchor="middle" className="zone__label">{z.label}</text>
      </g>
    )
  }
  const pts = z.polygon!.map((p) => `${p.x},${p.y}`).join(' ')
  return (
    <g className={cls}>
      <title>{label}</title>
      <polygon points={pts} className="zone__body" />
    </g>
  )
}

function RelayMark({ r, k, selected, label }: { r: ViewNode; k: number; selected: boolean; label: boolean }) {
  const down = r.liveness === Liveness.LOST
  const late = r.liveness === Liveness.LATE
  const gw = r.kind === NodeKind.GATEWAY
  const load = r.relay ? Math.max(...r.relay.qDrop) : 0
  return (
    <g data-asset={r.id} className={`asset asset--relay ${gw ? 'asset--gateway' : ''} ${down ? 'is-down' : ''} ${late ? 'is-late' : ''}`} transform={`translate(${r.x} ${r.y}) scale(${k})`}>
      <title>{`${r.name}${gw ? ' (gateway)' : ''}: ${down ? 'lost' : late ? 'late' : 'live'}${r.relay ? `, ${r.relay.gatewayHops === 255 ? 'no path to a gateway' : `${r.relay.gatewayHops} hop(s) to a gateway`}` : ''}`}</title>
      {selected && <circle r={20} className="selection" />}
      {gw ? <rect x={-9} y={-9} width={18} height={18} className="asset__body" /> : <path d="M0 -10L9 0L0 10L-9 0Z" className="asset__body" />}
      {down && <circle r={15} className="relay-down-ring" />}
      {load > 0 && <circle r={3} cx={9} cy={-9} className="relay-drop-dot" />}
      {label && (
        <text x={13} y={4} className="asset-label">
          {r.name}
        </text>
      )}
    </g>
  )
}

function AnchorMark({ a, k, selected }: { a: ViewNode; k: number; selected: boolean }) {
  return (
    <g data-asset={a.id} className={`asset asset--anchor ${a.liveness === Liveness.LOST ? 'is-down' : ''}`} transform={`translate(${a.x} ${a.y}) scale(${k})`}>
      <title>{`${a.name} (UWB anchor)`}</title>
      {selected && <circle r={14} className="selection" />}
      <path d="M0 -6L5.5 4H-5.5Z" />
    </g>
  )
}

function RobotMark({ r, now, k, selected, label }: { r: ViewNode; now: number; k: number; selected: boolean; label: boolean }) {
  const s = r.robot
  if (!s) return null
  const age = Math.max(0, Math.round((now - r.lastHeard) / 1000))
  const lost = r.liveness === Liveness.LOST
  const late = r.liveness === Liveness.LATE
  const stopped = s.mode === RobotMode.STOPPED
  const hold = s.mode === RobotMode.HOLD
  const survey = s.tag === 2
  const horn = (s.flags & 2) !== 0
  const reason = STOP_LABEL[s.stopReason] ?? ''
  return (
    <g data-asset={r.id} className={`asset asset--robot robot--m${s.mode} ${lost ? 'fresh--stale' : late ? 'fresh--lagging' : ''} ${survey ? 'robot--survey' : ''}`} transform={`translate(${r.x} ${r.y}) scale(${k})`}>
      <title>{`${r.name}: ${MODE_LABEL[s.mode as RobotMode]}${reason ? ` (${reason})` : ''}, battery ${s.batteryPct}%${s.viaName ? `, via ${s.viaName}` : ''}`}</title>
      {selected && <circle r={22} className="selection" />}
      {hold && <circle r={17} className="hold-ring" />}
      {stopped && <path d="M-7 -17H7L17 -7V7L7 17H-7L-17 7V-7Z" className="stop-ring" />}
      {horn && !lost && <circle r={24} className="horn-ring" />}
      <g transform={`rotate(${s.headingDeg})`} className="asset__body">
        <rect x={-11} y={-7} width={22} height={14} rx={survey ? 3 : 7} />
        <path d="M6 -4L11 0L6 4" className="asset__nose" />
      </g>
      {s.viaIsRobot && <text x={13} y={14} className="depth-tag">via robot</text>}
      {label && (
        <text y={-19} textAnchor="middle" className="asset-label">
          {r.name}
        </text>
      )}
      {(late || lost) && (
        <text y={32} textAnchor="middle" className="stale-tag">
          {age < 60 ? `${age} s ago` : `${Math.floor(age / 60)} min ago`}
        </text>
      )}
    </g>
  )
}

function PersonMark({ t, k, selected, label }: { t: ViewTrack; k: number; selected: boolean; label: boolean }) {
  const sup = t.kind === TrackKind.SUPERVISOR
  return (
    <g data-asset={`t:${t.id}`} className={`asset asset--worker ${sup ? 'asset--supervisor' : ''} ${t.stale ? 'fresh--stale' : ''}`} transform={`translate(${t.x} ${t.y}) scale(${k})`}>
      <title>{`${t.name}${t.stale ? ' (position stale)' : ''}, ±${t.accM.toFixed(1)} m`}</title>
      {selected && <circle r={14} className="selection" />}
      <circle r={sup ? 6.5 : 5.5} className="asset__body" />
      {label && (
        <text y={-10} textAnchor="middle" className="asset-label asset-label--small">
          {t.name}
        </text>
      )}
    </g>
  )
}

function MachineMark({ t, k, selected, label }: { t: ViewTrack; k: number; selected: boolean; label: boolean }) {
  const short = t.name.split(' ').pop() ?? t.name
  return (
    <g data-asset={`t:${t.id}`} className={`asset asset--manual ${t.stale ? 'fresh--stale' : ''}`} transform={`translate(${t.x} ${t.y})`}>
      <title>{`${t.name} (UWB badge), ±${t.accM.toFixed(1)} m`}</title>
      <circle r={t.radiusM} className="manual__footprint" />
      <g transform={`scale(${k})`}>
        {selected && <circle r={20} className="selection" />}
        <rect x={-10} y={-7} width={20} height={14} rx={2} className="asset__body" />
        {label && (
          <text y={-14} textAnchor="middle" className="asset-label">
            {short}
          </text>
        )}
      </g>
    </g>
  )
}

function UnknownMark({ t, k }: { t: ViewTrack; k: number }) {
  return (
    <g className="asset asset--unknown" transform={`translate(${t.x} ${t.y})`}>
      <title>Unknown object seen by robot lidar</title>
      <circle r={Math.max(t.radiusM, 2)} className="unknown__body" />
      <text transform={`scale(${k})`} y={5} textAnchor="middle" className="unknown__q">?</text>
    </g>
  )
}

function EventMark({ e, view, k }: { e: MeshEvent & { recv: number }; view: MeshView; k: number }) {
  if (e.kind === 'stop') {
    const p = view.toTwin(e.pos)
    return (
      <g className="event-mark event-mark--stop" transform={`translate(${p.x} ${p.y}) scale(${k})`}>
        <title>Stop: {STOP_LABEL[e.reason]}</title>
        <path d="M-5 -12H5L12 -5V5L5 12H-5L-12 5V-5Z" />
      </g>
    )
  }
  if (e.kind === 'near_miss') {
    const p = view.toTwin(e.pos)
    return (
      <g className="event-mark event-mark--near" transform={`translate(${p.x} ${p.y}) scale(${k})`}>
        <title>Near miss</title>
        <path d="M0 -13L12 9H-12Z" />
      </g>
    )
  }
  if (e.kind === 'zone_breach') {
    const p = view.toTwin(e.pos)
    return (
      <g className="event-mark event-mark--breach" transform={`translate(${p.x} ${p.y}) scale(${k})`}>
        <title>Zone breach</title>
        <circle r={9} />
      </g>
    )
  }
  return null
}

function MeshKey() {
  return (
    <ul className="map__key" aria-label="Map key">
      <li><svg width="16" height="10"><rect x="2" y="1" width="12" height="8" rx="1" className="unit unit--installed" /></svg>P3 set</li>
      <li><svg width="16" height="10"><g className="unit unit--piled"><rect x="2" y="1" width="12" height="8" rx="1" /><circle cx="4.5" cy="5" r="1.4" /><circle cx="11.5" cy="5" r="1.4" /></g></svg>Piled</li>
      <li><svg width="16" height="12"><rect x="1" y="2" width="14" height="8" rx="4" className="key-machine" /></svg>Robot</li>
      <li><svg width="16" height="12"><rect x="1" y="2" width="14" height="8" rx="1" className="key-manual" /></svg>Manual machine</li>
      <li><svg width="12" height="12"><circle cx="6" cy="6" r="4.5" className="key-worker" /></svg>Person (UWB)</li>
      <li><svg width="14" height="14"><path d="M7 1L13 7L7 13L1 7Z" className="key-relay" /></svg>Relay</li>
      <li><svg width="14" height="14"><rect x="2" y="2" width="10" height="10" className="key-relay" /></svg>Gateway</li>
      <li><svg width="16" height="10"><line x1="1" y1="5" x2="15" y2="5" className="key-via" /></svg>Attached via</li>
    </ul>
  )
}

// ---------- packet animation (12.2) ----------

const CLASS_COLOR = ['var(--alert)', 'var(--teal)', '#6b7f88', '#7a4fa3']
const HOP_MS = 380

/**
 * Animates mesh traffic from the simulator's traces. Each transmission is a ring at the
 * transmitter; the hop it continues (the same message sent by a neighbor one hop further on)
 * is a dot moving along that link, one hop at a time, so a flood reads as a wave.
 * Duplicates dropped show as small grey crosses; hop-limit and queue drops as red crosses.
 * Click a dot to follow that message through the whole flood.
 */
function PacketLayer({ view, k, speed }: { view: MeshView; k: number; speed: number }) {
  const gRef = useRef<SVGGElement>(null)
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const g = gRef.current
      if (!g) return
      const now = performance.now()
      const v = viewRef.current
      const traces = edge.traces
      // Keep the last few seconds of traffic.
      let start = traces.length
      while (start > 0 && now - traces[start - 1].recv < 4000) start--
      const live = traces.slice(start)
      const byMsg = new Map<string, typeof live>()
      for (const t of live) {
        if (t.type === MsgType.RELAY_BEACON || t.type === MsgType.ROBOT_BEACON) continue
        const list = byMsg.get(t.msgId)
        if (list) list.push(t)
        else byMsg.set(t.msgId, [t])
      }
      const parts: string[] = []
      let budget = 350
      for (const [msg, list] of byMsg) {
        if (budget <= 0) break
        const txs = list.filter((t) => t.result === 'tx' || t.result === 'repair_tx')
        const top = Math.max(...list.map((t) => t.hopsLeft), 0)
        const base = list[0].recv
        for (const t of list) {
          const from = v.byId.get(t.from)
          if (!from) continue
          const hop = Math.max(0, top - t.hopsLeft)
          const t0 = base + hop * HOP_MS
          const p = (now - t0) / HOP_MS
          if (p < 0 || p > 1.6) continue
          const color = CLASS_COLOR[t.cls] ?? '#888'
          if (t.result === 'tx' || t.result === 'repair_tx') {
            if (p <= 1) parts.push(`<circle cx="${from.x}" cy="${from.y}" r="${(6 + 26 * p) * k}" fill="none" stroke="${color}" stroke-opacity="${(1 - p) * 0.55}" stroke-width="${1.6 * k}"/>`)
            // The previous hop: who sent this message one hop earlier, nearest to us.
            const prev = txs.filter((x) => x.hopsLeft === t.hopsLeft + 1 && x.from !== t.from)
            let src: XY | undefined
            let best = Infinity
            for (const x of prev) {
              const n = v.byId.get(x.from)
              if (!n) continue
              const d = Math.hypot(n.x - from.x, n.y - from.y)
              if (d < best && d < 480) {
                best = d
                src = n
              }
            }
            if (src && p <= 1) {
              const q = Math.min(1, p * 1.4)
              const x = src.x + (from.x - src.x) * q
              const y = src.y + (from.y - src.y) * q
              parts.push(`<circle data-msg="${msg}" cx="${x}" cy="${y}" r="${(t.cls === MsgClass.SAFETY ? 4.5 : 3.5) * k}" fill="${color}" class="packet-dot"><title>${MsgType[t.type]} ${msg}</title></circle>`)
              budget--
            }
          } else if (t.result === 'delivered' && t.to) {
            const to = v.byId.get(t.to)
            if (!to || p > 1) continue
            const x = from.x + (to.x - from.x) * p
            const y = from.y + (to.y - from.y) * p
            parts.push(`<circle data-msg="${msg}" cx="${x}" cy="${y}" r="${3 * k}" fill="${color}" class="packet-dot"><title>${MsgType[t.type]} to ${to.name}</title></circle>`)
            budget--
          } else if (t.result === 'dup_dropped' || t.result === 'hop_dropped' || t.result === 'queue_dropped' || t.result === 'stale_dropped') {
            if (p > 1.2) continue
            const s = 4 * k
            const c = t.result === 'dup_dropped' ? '#9aa4a8' : 'var(--alert)'
            parts.push(`<path d="M${from.x - s} ${from.y - s - 10 * k}l${2 * s} ${2 * s}m0 ${-2 * s}l${-2 * s} ${2 * s}" stroke="${c}" stroke-width="${1.4 * k}" stroke-opacity="${1 - p / 1.2}"/>`)
          } else if (t.result === 'lost' && t.to) {
            const to = v.byId.get(t.to)
            if (!to || p > 1) continue
            parts.push(`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="var(--alert)" stroke-dasharray="${3 * k} ${3 * k}" stroke-opacity="${0.5 * (1 - p)}" stroke-width="${k}"/>`)
          }
        }
      }
      g.innerHTML = parts.join('')
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [k, speed])
  return <g ref={gRef} className="packet-layer" />
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function toSvg(svg: SVGSVGElement, clientX: number, clientY: number) {
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  const m = svg.getScreenCTM()
  return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 }
}
