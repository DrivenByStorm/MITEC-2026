import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { Asset, TwinSnapshot } from '../twin/types'
import { ageSeconds, formatAge, freshness } from '../twin/freshness'

interface Props {
  snapshot: TwinSnapshot
  selectedId?: string
  onSelect: (id: string | undefined) => void
  focus?: { x: number; y: number; key: number }
  expanded: boolean
  /** Machine-to-relay link range, meters: the coverage circle around each relay. */
  coverageM?: number
  /** Extra SVG drawn above the terrain and below the site (e.g. the buildable-ground overlay). */
  underlay?: ReactNode
  /** Extra controls rendered over the map (e.g. a plan card). */
  children?: ReactNode
  /** Site mesh links, drawn instead of the relay links (toggled by "Mesh links"). Gets the mark scale. */
  meshUnder?: (k: number) => ReactNode
  /** Drawn above everything (packets). */
  meshOver?: (k: number) => ReactNode
  /** Short second line under a machine's name (e.g. its mesh task). */
  notes?: Record<string, string>
  /** Extra entries for the map key. */
  keyExtra?: ReactNode
}

interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}


export function SiteMap({ snapshot, selectedId, onSelect, focus, expanded, coverageM = 270, underlay, children, meshUnder, meshOver, notes, keyExtra }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  // Extra room at the bottom so the map key never covers the site.
  const view = snapshot.view
  const fit: ViewBox = useMemo(() => ({ x: view.x, y: view.y - view.h * 0.06, w: view.w, h: view.h * 1.16 }), [view.x, view.y, view.w, view.h])
  const [px, setPx] = useState({ w: 1000, h: 600 })
  const [vb, setVb] = useState<ViewBox>(fit)
  const [layers, setLayers] = useState({ coverage: true, mesh: true, people: true, labels: true })
  const drag = useRef<{ x: number; y: number; vb: ViewBox; moved: boolean } | null>(null)

  const zoom = fit.w / vb.w

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const ro = new ResizeObserver(([entry]) => setPx({ w: entry.contentRect.width, h: entry.contentRect.height }))
    ro.observe(svg)
    return () => ro.disconnect()
  }, [])

  // Center on a point when a command asks for it (adjusting state when the prop changes).
  const [seenFocus, setSeenFocus] = useState(focus?.key)
  if (focus && focus.key !== seenFocus) {
    setSeenFocus(focus.key)
    const w = Math.min(vb.w, fit.w / 2.4)
    const h = (w * fit.h) / fit.w
    setVb({ x: focus.x - w / 2, y: focus.y - h / 2, w, h })
  }

  // Wheel zoom around the cursor (non-passive so the page doesn't scroll).
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const pt = toSvg(svg, e.clientX, e.clientY)
      const factor = Math.exp(e.deltaY * 0.0015)
      setVb((cur) => {
        const w = clamp(cur.w * factor, fit.w / 8, fit.w * 1.2)
        const h = (cur.h * w) / cur.w
        return { x: pt.x - ((pt.x - cur.x) * w) / cur.w, y: pt.y - ((pt.y - cur.y) * h) / cur.h, w, h }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [fit.w])

  const onPointerDown = (e: ReactPointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, vb, moved: false }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
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
      const target = (e.target as Element).closest('[data-asset]')
      onSelect(target?.getAttribute('data-asset') ?? undefined)
    }
  }

  const zoomBy = (f: number) =>
    setVb((cur) => {
      const w = clamp(cur.w * f, fit.w / 8, fit.w * 1.2)
      const h = (cur.h * w) / cur.w
      return { x: cur.x + (cur.w - w) / 2, y: cur.y + (cur.h - h) / 2, w, h }
    })

  const relays = snapshot.assets.filter((a) => a.kind === 'relay')
  const relayById = new Map(relays.map((r) => [r.id, r]))
  const movers = snapshot.assets.filter((a) => a.kind === 'robot' || a.kind === 'machine' || a.kind === 'drone')
  const workers = snapshot.assets.filter((a) => a.kind === 'worker' && !a.inCab)
  const openRequests = snapshot.requests.filter((r) => !['done', 'cancelled'].includes(r.status))
  const showWorkerNames = layers.labels && zoom > 2.2
  // Draw marks and labels in screen pixels (1 unit inside a mark ≈ 1 px), growing a
  // little as you zoom in so a close-up still feels close.
  const pxPerUnit = Math.min(px.w / vb.w, px.h / vb.h) || 1
  const screenFactor = clamp(px.w / 1000, 0.6, 1)
  const k = (1 / pxPerUnit) * Math.min(1.5, Math.pow(zoom, 0.25)) * screenFactor
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
        aria-label={`Live site plan of ${snapshot.siteName}`}
        style={{ ['--zs' as string]: k }}
      >
        <defs>
          <pattern id="ground" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" fill="none" className="ground-grid" />
          </pattern>
        </defs>

        <rect x={0} y={0} width={snapshot.site.w} height={snapshot.site.h} className="ground" />
        {snapshot.terrainImage ? (
          <image
            href={snapshot.terrainImage.href}
            x={snapshot.terrainImage.x}
            y={snapshot.terrainImage.y}
            width={snapshot.terrainImage.w}
            height={snapshot.terrainImage.h}
            preserveAspectRatio="none"
            className="terrain-image"
          />
        ) : (
          <Contours w={snapshot.site.w} h={snapshot.site.h} />
        )}
        <rect x={0} y={0} width={snapshot.site.w} height={snapshot.site.h} fill="url(#ground)" />
        {underlay}

        {/* Site office: edge server, RTK base, laydown yard (labels only when there's room) */}
        <g className={`office ${snapshot.office.w * pxPerUnit < 120 ? 'office--small' : ''}`}>
          <rect x={snapshot.laydown.x} y={snapshot.laydown.y} width={snapshot.laydown.w} height={snapshot.laydown.h} className="laydown" />
          <text x={snapshot.laydown.x + 8} y={snapshot.laydown.y + snapshot.laydown.h - 10} className="area-label">Laydown yard</text>
          <rect x={snapshot.office.x} y={snapshot.office.y} width={snapshot.office.w} height={snapshot.office.h} className="office__pad" />
          <text x={snapshot.office.x + 8} y={snapshot.office.y + snapshot.office.h - 10} className="area-label">Site office</text>
          <rect x={snapshot.edgeServer.x - 10} y={snapshot.edgeServer.y - 10} width={20} height={20} className="edge-server" />
          <text x={snapshot.edgeServer.x + 16} y={snapshot.edgeServer.y + 5} className="small-label">Edge server</text>
          <path d={`M${snapshot.rtkBase.x} ${snapshot.rtkBase.y - 10}l9 16h-18z`} className="rtk" />
          <text x={snapshot.rtkBase.x + 14} y={snapshot.rtkBase.y + 4} className="small-label">RTK base</text>
        </g>

        {layers.coverage &&
          relays
            .filter((r) => r.mode !== 'offline')
            .map((r) => <circle key={`cov-${r.id}`} cx={r.x} cy={r.y} r={coverageM} className="coverage" />)}

        {/* Arrays */}
        {snapshot.blocks.map((b) => {
          const units = snapshot.units.filter((u) => u.block === b.id)
          const done = units.filter((u) => u.status === 'installed').length
          return (
            <g key={b.id}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} className="block" />
              <text x={b.x} y={b.y + b.h + 20} className="block-label">
                Block {b.id}
                <tspan className="block-label__count" dx={8}>{done}/{units.length} set</tspan>
              </text>
            </g>
          )
        })}
        {snapshot.units.map((u) => (
          <Unit key={u.id} x={u.x} y={u.y} status={u.status} />
        ))}

        {layers.mesh && meshUnder?.(k)}
        {layers.mesh &&
          !meshUnder &&
          snapshot.links.map((l) => {
            const a = relayById.get(l.a)
            const b = relayById.get(l.b)
            if (!a || !b) return null
            return <line key={`${l.a}-${l.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="mesh-link" style={{ opacity: 0.35 + l.quality * 0.55 }} />
          })}
        {layers.mesh && !meshUnder && (() => {
          const gw = relayById.get('GW')
          return gw ? <line x1={gw.x} y1={gw.y} x2={snapshot.edgeServer.x} y2={snapshot.edgeServer.y} className="wired-link" /> : null
        })()}

        {/* Open request targets */}
        {openRequests.map((r) => (
          <g key={r.id} className="request-pin" transform={`translate(${r.target.x} ${r.target.y}) scale(${k})`}>
            <path d="M0 0l-7 -14a8 8 0 1 1 14 0z" />
            <text y={-24} textAnchor="middle" className="small-label">{r.id}</text>
          </g>
        ))}

        {relays.map((r) => (
          <RelayMark key={r.id} relay={r} now={snapshot.now} selected={r.id === selectedId} label={layers.labels} k={k} />
        ))}

        {layers.people &&
          workers.map((w) => (
            <WorkerMark key={w.id} worker={w} now={snapshot.now} selected={w.id === selectedId} label={showWorkerNames || w.id === selectedId} k={k} />
          ))}

        {movers.map((m) => (
          <MachineMark key={m.id} asset={m} now={snapshot.now} selected={m.id === selectedId} label={layers.labels} note={layers.labels ? notes?.[m.id] : undefined} k={k} />
        ))}
        {meshOver?.(k)}
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
            ['mesh', 'Mesh links'],
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

      <MapKey extra={keyExtra} />
      {children}
    </div>
  )
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

function Contours({ w, h }: { w: number; h: number }) {
  // Faint terrain contours, like a survey plat.
  const lines = [0.18, 0.42, 0.66, 0.9].map((f, i) => {
    const y = h * f
    const a = 18 + i * 6
    return `M0 ${y} C ${w * 0.25} ${y - a}, ${w * 0.45} ${y + a}, ${w * 0.7} ${y - a / 2} S ${w} ${y + a / 3}, ${w} ${y}`
  })
  return (
    <g className="contours" aria-hidden="true">
      {lines.map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  )
}

function Unit({ x, y, status }: { x: number; y: number; status: string }) {
  if (status === 'installed') return <rect x={x - 6} y={y - 4} width={12} height={8} rx={1} className="unit unit--installed" />
  if (status === 'staked')
    return (
      <g className="unit unit--staked">
        <rect x={x - 6} y={y - 4} width={12} height={8} rx={1} />
        <path d={`M${x - 3.5} ${y - 2}v4M${x + 3.5} ${y - 2}v4`} />
      </g>
    )
  if (status === 'piled')
    return (
      <g className="unit unit--piled">
        <rect x={x - 6} y={y - 4} width={12} height={8} rx={1} />
        <circle cx={x - 3.5} cy={y} r={1.4} />
        <circle cx={x + 3.5} cy={y} r={1.4} />
      </g>
    )
  return <rect x={x - 6} y={y - 4} width={12} height={8} rx={1} className="unit unit--planned" />
}

function freshClass(a: Asset, now: number) {
  return `fresh--${freshness(a.lastHeard, now)}`
}

function StaleTag({ a, now }: { a: Asset; now: number }) {
  const age = ageSeconds(a.lastHeard, now)
  if (freshness(a.lastHeard, now) === 'live') return null
  return (
    <text y={30} textAnchor="middle" className="stale-tag">
      {formatAge(age)}
    </text>
  )
}

function MachineMark({ asset: a, now, selected, label, note, k }: { asset: Asset; now: number; selected: boolean; label: boolean; note?: string; k: number }) {
  const paused = a.mode === 'paused'
  return (
    <g data-asset={a.id} className={`asset asset--${a.kind} ${freshClass(a, now)} ${paused ? 'is-paused' : ''}`} transform={`translate(${a.x} ${a.y}) scale(${k})`}>
      <title>{`${a.name}, ${a.role}: ${a.task}`}</title>
      {selected && <circle r={22} className="selection" />}
      {a.kind === 'drone' ? (
        <g className="asset__body">
          <path d="M-9 -9L9 9M9 -9L-9 9" />
          <circle r={4} />
        </g>
      ) : (
        <g transform={`rotate(${a.heading})`} className="asset__body">
          <rect x={-11} y={-7} width={22} height={14} rx={a.kind === 'robot' ? 7 : 2} />
          <path d="M6 -4L11 0L6 4" className="asset__nose" />
        </g>
      )}
      {paused && <rect x={-4} y={-4} width={8} height={8} className="paused-mark" />}
      {label && (
        <text y={-15} textAnchor="middle" className="asset-label">
          {a.name}
        </text>
      )}
      {note && (
        <text y={22} textAnchor="middle" className="asset-note">
          {note}
        </text>
      )}
      <StaleTag a={a} now={now} />
    </g>
  )
}

function WorkerMark({ worker: w, now, selected, label, k }: { worker: Asset; now: number; selected: boolean; label: boolean; k: number }) {
  return (
    <g data-asset={w.id} className={`asset asset--worker ${freshClass(w, now)}`} transform={`translate(${w.x} ${w.y}) scale(${k})`}>
      <title>{`${w.name}, ${w.role}`}</title>
      {selected && <circle r={14} className="selection" />}
      <circle r={5.5} className="asset__body" />
      {label && (
        <text y={-10} textAnchor="middle" className="asset-label asset-label--small">
          {w.name}
        </text>
      )}
    </g>
  )
}

function RelayMark({ relay: r, now, selected, label, k }: { relay: Asset; now: number; selected: boolean; label: boolean; k: number }) {
  const down = r.mode === 'offline' || freshness(r.lastHeard, now) !== 'live'
  return (
    <g data-asset={r.id} className={`asset asset--relay ${down ? 'is-down' : ''}`} transform={`translate(${r.x} ${r.y}) scale(${k})`}>
      <title>{`${r.name}: ${down ? 'not reporting' : 'relaying'}`}</title>
      {selected && <circle r={20} className="selection" />}
      <path d="M0 -10L9 0L0 10L-9 0Z" className="asset__body" />
      {down && <circle r={15} className="relay-down-ring" />}
      {label && (
        <text x={13} y={4} className="asset-label">
          {r.name}
        </text>
      )}
    </g>
  )
}

function MapKey({ extra }: { extra?: ReactNode }) {
  return (
    <ul className="map__key" aria-label="Map key">
      <li><svg width="16" height="10"><rect x="2" y="1" width="12" height="8" rx="1" className="unit unit--installed" /></svg>P3 set</li>
      <li><svg width="16" height="10"><g className="unit unit--piled"><rect x="2" y="1" width="12" height="8" rx="1" /><circle cx="4.5" cy="5" r="1.4" /><circle cx="11.5" cy="5" r="1.4" /></g></svg>Foundation ready</li>
      {extra && <li><svg width="16" height="10"><g className="unit unit--staked"><rect x="2" y="1" width="12" height="8" rx="1" /><path d="M4.5 3v4M11.5 3v4" /></g></svg>Staked</li>}
      <li><svg width="16" height="10"><rect x="2" y="1" width="12" height="8" rx="1" className="unit unit--planned" /></svg>Planned</li>
      <li><svg width="16" height="12"><rect x="1" y="2" width="14" height="8" rx="4" className="key-machine" /></svg>Robot or machine</li>
      <li><svg width="12" height="12"><circle cx="6" cy="6" r="4.5" className="key-worker" /></svg>Person</li>
      <li><svg width="14" height="14"><path d="M7 1L13 7L7 13L1 7Z" className="key-relay" /></svg>Relay</li>
      <li><svg width="12" height="12"><circle cx="6" cy="6" r="4.5" className="key-stale" /></svg>Not heard 30 s+</li>
      {extra}
    </ul>
  )
}
