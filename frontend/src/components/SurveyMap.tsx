import { useMemo, useState } from 'react'
import type { SurveyDrone, SurveySnapshot } from '../survey/types'
import type { SurveySource } from '../survey/source'
import { buildRegion, renderHeatmap, RAMP_CSS } from '../survey/heatmap'
import { usePanZoom } from './usePanZoom'
import type { ViewBox } from './usePanZoom'

interface Props {
  snapshot: SurveySnapshot
  source: SurveySource
  expanded: boolean
  /** Hide the floating status bar (e.g. when a panel or card already shows it). */
  hideStatus?: boolean
  selectedDrone?: string
  onSelectDrone: (id: string | undefined) => void
  onSectionClick: (id: string) => void
  onStart: (distanceM: number) => void
  onLock: () => void
  onOpenConstruction: () => void
}

export function SurveyMap(props: Props) {
  const { snapshot: s } = props
  // Re-fit the view whenever the area of interest changes size (distance picked, survey started).
  const fit = fitFor(s)
  const key = `${s.phase === 'idle' ? 'idle' : 'run'}-${Math.round(fit.w)}`
  return <SurveyMapInner key={key} {...props} fit={fit} />
}

function fitFor(s: SurveySnapshot): ViewBox {
  const d = s.distanceM * (s.phase === 'idle' ? 1.3 : 1.1)
  const extraTop = s.distanceM * 0.3 // room for the layer toggles and status bar above the site
  return { x: s.launch.x - d, y: s.launch.y - d - extraTop, w: d * 2, h: d * 2 + extraTop }
}

function SurveyMapInner({ snapshot: s, source, expanded, hideStatus, selectedDrone, onSelectDrone, onSectionClick, onStart, onLock, onOpenConstruction, fit }: Props & { fit: ViewBox }) {
  const [layers, setLayers] = useState({ elevation: true, sections: true, paths: true })
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)

  const { svgRef, vb, setVb, pxPerUnit, handlers, zoomBy, toSvg, px } = usePanZoom(fit, (target) => {
    const section = target.closest('[data-section]')?.getAttribute('data-section')
    if (section) return onSectionClick(section)
    onSelectDrone(target.closest('[data-drone]')?.getAttribute('data-drone') ?? undefined)
  })

  // Heat map: shaded colors are fixed once the boundary is known; the image redraws as ground is mapped.
  const perimeterKey = s.perimeter.map((p) => `${p.x},${p.y}`).join(';')
  const region = useMemo(() => buildRegion(s, source.heights), [perimeterKey, s.colorRange.min, s.colorRange.max, source]) // eslint-disable-line react-hooks/exhaustive-deps
  // coverage is a mutable array, so coverageVersion is what tells us it changed.
  const heatHref = useMemo(() => (region ? renderHeatmap(region, source.coverage, s.terrain.cols) : null), [region, s.coverageVersion, source, s.terrain.cols]) // eslint-disable-line react-hooks/exhaustive-deps

  const k = (1 / pxPerUnit) * Math.min(1.4, Math.max(0.7, px.w / 1000)) // 1 unit inside a mark ≈ 1 screen px
  const { cellM } = s.terrain
  const hoverElev = hover ? source.elevationAt(hover) : undefined
  const suggested = new Set(s.suggestions.slice(0, 6))
  const loopPct = perimeterProgress(s)

  return (
    <div className={`map ${expanded ? 'map--expanded' : ''}`}>
      <svg
        ref={svgRef}
        className="map__svg"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
        {...handlers}
        onPointerMove={(e) => {
          handlers.onPointerMove(e)
          setHover(toSvg(e.clientX, e.clientY))
        }}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="Survey map of the new site"
        style={{ ['--zs' as string]: k }}
      >
        <defs>
          <pattern id="survey-grid" width="100" height="100" patternUnits="userSpaceOnUse">
            <path d="M100 0H0V100" fill="none" className="ground-grid" />
          </pattern>
          <pattern id="unmapped" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="40" className="unmapped-hatch" />
          </pattern>
        </defs>

        <rect x={0} y={0} width={s.terrain.cols * cellM} height={s.terrain.rows * cellM} className="ground" />
        <rect x={0} y={0} width={s.terrain.cols * cellM} height={s.terrain.rows * cellM} fill="url(#survey-grid)" />

        {s.phase === 'idle' && <PlannedBoundary s={s} k={k} />}

        {s.perimeter.length > 0 && (
          <polygon points={s.perimeter.map((p) => `${p.x},${p.y}`).join(' ')} fill="url(#unmapped)" className="unmapped-area" />
        )}

        {layers.elevation && heatHref && region && (
          <image href={heatHref} x={region.c0 * cellM} y={region.r0 * cellM} width={region.w * cellM} height={region.h * cellM} preserveAspectRatio="none" />
        )}

        {s.perimeter.length > 0 && (
          <polygon points={s.perimeter.map((p) => `${p.x},${p.y}`).join(' ')} className="boundary-planned" />
        )}
        {s.perimeterFlown.length > 1 && <polyline points={s.perimeterFlown.map((p) => `${p.x},${p.y}`).join(' ')} className="boundary-flown" />}

        {layers.sections &&
          s.sections.map((sec) => {
            const isSuggested = suggested.has(sec.id)
            return (
              <g key={sec.id} data-section={sec.id} className={`section section--${sec.status} ${isSuggested ? 'is-suggested' : ''}`}>
                <rect x={sec.x} y={sec.y} width={sec.w} height={sec.h} className="section__box" />
                <text x={sec.x + 10 * k} y={sec.y + 20 * k} className="section__id">{sec.id}</text>
                {(isSuggested || sec.status === 'queued') && (
                  <text x={sec.x + 10 * k} y={sec.y + 37 * k} className="section__note">
                    {sec.status === 'queued' ? 'Queued' : `${Math.round(sec.coverage * 100)}%, click to map`}
                  </text>
                )}
              </g>
            )
          })}

        <g transform={`translate(${s.launch.x} ${s.launch.y}) scale(${k})`} className="launch">
          <circle r={16} />
          <path d="M-7 0H7M0 -7V7" />
          <text y={32} textAnchor="middle" className="asset-label asset-label--small">Launch</text>
        </g>

        {layers.paths &&
          s.drones
            .filter((d) => d.status !== 'docked' && d.status !== 'swapping')
            .map((d) => <DronePath key={`p-${d.id}`} d={d} s={s} />)}

        {s.drones
          .filter((d) => d.status !== 'docked' && d.status !== 'swapping')
          .map((d) => (
            <DroneMark key={d.id} d={d} k={k} selected={d.id === selectedDrone} showLabel={d.id === selectedDrone || Math.hypot(d.x - s.launch.x, d.y - s.launch.y) > 120} />
          ))}
      </svg>

      {s.phase === 'idle' && <StartCard s={s} source={source} onStart={onStart} />}
      {!hideStatus && <ActionBar s={s} loopPct={loopPct} onSectionClick={onSectionClick} onLock={onLock} onOpenConstruction={onOpenConstruction} />}

      <fieldset className="map__layers">
        <legend className="visually-hidden">Map layers</legend>
        {(
          [
            ['elevation', 'Elevation'],
            ['sections', 'Sections'],
            ['paths', 'Flight paths'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <input type="checkbox" checked={layers[key]} onChange={() => setLayers((l) => ({ ...l, [key]: !l[key] }))} />
            {label}
          </label>
        ))}
      </fieldset>

      <div className="map__tools" role="toolbar" aria-label="Map controls">
        <button type="button" onClick={() => zoomBy(0.7)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoomBy(1 / 0.7)} aria-label="Zoom out">−</button>
        <button type="button" onClick={() => setVb(fit)}>Fit site</button>
      </div>

      <div className="elev-legend">
        {s.phase !== 'idle' && (
          <>
            <div className="elev-legend__row">
              <span className="elev-legend__title">Elevation</span>
              <span className="elev-legend__hover">
                {hover && hoverElev !== undefined ? `${hoverElev.toFixed(1)} m at cursor` : hover ? 'Not mapped yet' : ''}
              </span>
            </div>
            <div className="elev-legend__bar" style={{ background: RAMP_CSS }} />
            <div className="elev-legend__row elev-legend__scale">
              <span>{s.colorRange.min.toFixed(0)} m</span>
              <span>{s.colorRange.max.toFixed(0)} m</span>
            </div>
          </>
        )}
        <p className={`elev-legend__source ${s.terrain.real ? '' : 'is-synthetic'}`}>{s.terrain.sourceLabel}</p>
      </div>
    </div>
  )
}

function perimeterProgress(s: SurveySnapshot) {
  if (!s.perimeter.length) return 0
  let len = 0
  for (let i = 1; i < s.perimeterFlown.length; i++) {
    len += Math.hypot(s.perimeterFlown[i].x - s.perimeterFlown[i - 1].x, s.perimeterFlown[i].y - s.perimeterFlown[i - 1].y)
  }
  return Math.min(1, len / (s.distanceM * 8))
}

function PlannedBoundary({ s, k }: { s: SurveySnapshot; k: number }) {
  const d = s.distanceM
  const { x, y } = s.launch
  return (
    <g className="planned">
      <rect x={x - d} y={y - d} width={d * 2} height={d * 2} className="planned__box" />
      <line x1={x} y1={y} x2={x} y2={y - d} className="planned__ray" />
      <g transform={`translate(${x} ${y - d / 2}) scale(${k})`}>
        <rect x={6} y={-12} width={74} height={24} rx={5} className="planned__tag" />
        <text x={43} y={5} textAnchor="middle" className="planned__label">{d} m</text>
      </g>
    </g>
  )
}

function DronePath({ d, s }: { d: SurveyDrone; s: SurveySnapshot }) {
  const home = { x: s.launch.x, y: s.launch.y }
  if (d.status === 'returning') return <line x1={d.x} y1={d.y} x2={home.x} y2={home.y} className="drone-path drone-path--home" />
  if (d.status === 'outbound' && d.sectionId) {
    const sec = s.sections.find((x) => x.id === d.sectionId)
    if (sec) return <line x1={d.x} y1={d.y} x2={sec.x + sec.w / 2} y2={sec.y + sec.h / 2} className="drone-path" />
  }
  return null
}

function DroneMark({ d, k, selected, showLabel }: { d: SurveyDrone; k: number; selected: boolean; showLabel: boolean }) {
  return (
    <g data-drone={d.id} className={`drone drone--${d.role.toLowerCase()} ${d.battery < 25 ? 'is-low' : ''}`} transform={`translate(${d.x} ${d.y}) scale(${k})`}>
      <title>{`${d.id}: ${d.task}, battery ${d.battery}%`}</title>
      {selected && <circle r={20} className="selection" />}
      <g transform={`rotate(${d.heading + 45})`} className="drone__body">
        <path d="M-9 -9L9 9M9 -9L-9 9" />
        <circle cx={-9} cy={-9} r={3.6} />
        <circle cx={9} cy={9} r={3.6} />
        <circle cx={9} cy={-9} r={3.6} />
        <circle cx={-9} cy={9} r={3.6} />
      </g>
      <circle r={4} className="drone__hub" />
      {showLabel && <text y={-17} textAnchor="middle" className="asset-label">{d.id}</text>}
    </g>
  )
}

function StartCard({ s, source, onStart }: { s: SurveySnapshot; source: SurveySource; onStart: (m: number) => void }) {
  return (
    <form
      className="start-card"
      onSubmit={(e) => {
        e.preventDefault()
        onStart(s.distanceM)
      }}
    >
      <h2 className="start-card__title">Survey the new site</h2>
      <p className="start-card__text">
        The scout drone flies out from the launch point and traces the site boundary at the distance you set. Survey drones then map the
        sections the selection algorithm picks, and the elevation map fills in as they fly.
      </p>
      <label className="start-card__field" htmlFor="survey-distance">
        <span>Boundary distance from launch</span>
        <span className="start-card__value">{s.distanceM} m</span>
      </label>
      <input
        id="survey-distance"
        type="range"
        min={300}
        max={s.maxDistanceM}
        step={50}
        value={s.distanceM}
        onChange={(e) => source.setDistance(Number(e.target.value))}
      />
      <p className="start-card__hint">
        Covers {(((s.distanceM * 2) / 1000) ** 2).toFixed(2)} km² ({((s.distanceM * 2) / 1000).toFixed(1)} km square).
      </p>
      <button type="submit" className="btn btn--primary">Start survey</button>
    </form>
  )
}

function ActionBar({ s, loopPct, onSectionClick, onLock, onOpenConstruction }: { s: SurveySnapshot; loopPct: number; onSectionClick: (id: string) => void; onLock: () => void; onOpenConstruction: () => void }) {
  if (s.phase === 'idle') return null
  const pct = Math.round(s.stats.coverage * 100)
  const flying = s.drones.filter((d) => d.status !== 'docked' && d.status !== 'swapping').length
  const mapping = [...new Set(s.drones.map((d) => d.sectionId).filter(Boolean))] as string[]
  let text = ''
  if (s.phase === 'scouting') text = `Scout is tracing the boundary: ${Math.round(loopPct * 100)}% of the loop flown.`
  if (s.phase === 'surveying') text = mapping.length ? `Mapping ${listText(mapping)} with ${flying} drone${flying === 1 ? '' : 's'}. ${pct}% of the site mapped.` : `Waiting for drones to swap batteries. ${pct}% of the site mapped.`
  if (s.phase === 'review') text = `Pass complete. ${pct}% of the site mapped.`
  if (s.phase === 'locked') text = `Survey locked at ${pct}% coverage. Buildup planning is next.`
  return (
    <div className={`action-bar action-bar--${s.phase}`} role="status">
      <p className="action-bar__text">{text}</p>
      {s.phase === 'review' && (
        <div className="action-bar__actions">
          {s.suggestions.length > 0 && <span className="action-bar__label">Map more:</span>}
          {s.suggestions.slice(0, 4).map((id) => {
            const sec = s.sections.find((x) => x.id === id)!
            return (
              <button key={id} type="button" className="chip" onClick={() => onSectionClick(id)}>
                {id} ({Math.round(sec.coverage * 100)}%)
              </button>
            )
          })}
          <button type="button" className="btn btn--primary" onClick={onLock}>Move forward with buildup</button>
        </div>
      )}
      {s.phase === 'locked' && (
        <div className="action-bar__actions">
          <button type="button" className="btn" onClick={onOpenConstruction}>Open construction demo</button>
        </div>
      )}
    </div>
  )
}

function listText(items: string[]) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
