import { useState } from 'react'
import type { SurveySnapshot } from '../survey/types'
import { phaseLabel } from '../survey/commands'

interface Props {
  snapshot: SurveySnapshot
  selectedDrone?: string
  onSelectDrone: (id: string | undefined) => void
  onCommand: (text: string) => void
}

const TABS = ['Overview', 'Sections', 'Drones', 'Activity'] as const
type Tab = (typeof TABS)[number]

export function SurveyPanel({ snapshot: s, selectedDrone, onSelectDrone, onCommand }: Props) {
  const [tab, setTab] = useState<Tab>('Overview')
  return (
    <aside className="panel" aria-label="Survey state">
      <div className="tabs" role="tablist" aria-label="Survey views">
        {TABS.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="panel__body" role="tabpanel">
        {tab === 'Overview' && <Overview s={s} onCommand={onCommand} />}
        {tab === 'Sections' && <Sections s={s} onCommand={onCommand} />}
        {tab === 'Drones' && <Drones s={s} selected={selectedDrone} onSelect={onSelectDrone} />}
        {tab === 'Activity' && <Activity s={s} />}
      </div>
    </aside>
  )
}

function Overview({ s, onCommand }: { s: SurveySnapshot; onCommand: (t: string) => void }) {
  const pct = Math.round(s.stats.coverage * 100)
  return (
    <div className="overview">
      <section>
        <h3 className="section-title">{phaseLabel(s.phase)}</h3>
        <p className="big-figure">
          {pct}% <span className="big-figure__of">of the site mapped</span>
        </p>
        <span className="progress" aria-hidden="true">
          <span className="progress__fill" style={{ width: `${pct}%` }} />
        </span>
        <p className="hint">
          {s.phase === 'idle'
            ? `Boundary set to ${s.distanceM} m from the launch point.`
            : `${s.stats.mappedAreaKm2.toFixed(2)} of ${s.stats.perimeterAreaKm2.toFixed(2)} km² inside a boundary ${s.distanceM} m from launch.`}
        </p>
      </section>

      <section className="vitals">
        <div>
          <span className="vital__num">{s.stats.minM !== undefined ? `${s.stats.minM.toFixed(0)} m` : '–'}</span>
          <span className="vital__label">lowest point mapped</span>
        </div>
        <div>
          <span className="vital__num">{s.stats.maxM !== undefined ? `${s.stats.maxM.toFixed(0)} m` : '–'}</span>
          <span className="vital__label">highest point mapped</span>
        </div>
        <div>
          <span className="vital__num">{s.stats.minM !== undefined ? `${(s.stats.maxM! - s.stats.minM).toFixed(0)} m` : '–'}</span>
          <span className="vital__label">relief</span>
        </div>
        <div>
          <span className="vital__num">{s.drones.filter((d) => d.status !== 'docked' && d.status !== 'swapping').length}/{s.drones.length}</span>
          <span className="vital__label">drones flying</span>
        </div>
      </section>

      {s.phase === 'review' && (
        <section>
          <h3 className="section-title">What next</h3>
          <p className="hint">Suggested gaps are unmapped sections next to ground you've already mapped, closest to the launch point first.</p>
          <ul className="chips">
            {s.suggestions.slice(0, 6).map((id) => (
              <li key={id}>
                <button type="button" className="chip" onClick={() => onCommand(`survey ${id}`)}>
                  Map {id} ({Math.round((s.sections.find((x) => x.id === id)?.coverage ?? 0) * 100)}%)
                </button>
              </li>
            ))}
          </ul>
          <div className="button-row">
            <button type="button" className="btn" onClick={() => onCommand('map more')}>Map suggested gaps</button>
            <button type="button" className="btn btn--primary" onClick={() => onCommand('move to buildup')}>Move forward with buildup</button>
          </div>
        </section>
      )}

      <p className="hint">Drones shown at {s.speedup}× real speed.</p>
    </div>
  )
}

function Sections({ s, onCommand }: { s: SurveySnapshot; onCommand: (t: string) => void }) {
  if (!s.sections.length) return <p className="hint">Sections appear once the scout closes the boundary loop.</p>
  const k = Math.round(Math.sqrt(s.sections.length))
  return (
    <div className="sections">
      <p className="hint">Each tile is one section, north at the top. Click one to send drones there.</p>
      <div className="section-grid" style={{ gridTemplateColumns: `repeat(${k}, minmax(0, 1fr))` }}>
        {s.sections.map((sec) => (
          <button
            key={sec.id}
            type="button"
            className={`section-tile section-tile--${sec.status}`}
            onClick={() => onCommand(`survey ${sec.id}`)}
            disabled={sec.status === 'done' || sec.status === 'mapping' || s.phase === 'locked'}
            aria-label={`${sec.id}, ${Math.round(sec.coverage * 100)}% mapped, ${sec.status}`}
          >
            <span className="section-tile__fill" style={{ height: `${sec.coverage * 100}%` }} />
            <span className="section-tile__id">{sec.id}</span>
            <span className="section-tile__pct">{Math.round(sec.coverage * 100)}%</span>
            {sec.assignedTo.length > 0 && <span className="section-tile__crew">{sec.assignedTo.join(', ')}</span>}
            {sec.status === 'queued' && <span className="section-tile__crew">Queued</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

function Drones({ s, selected, onSelect }: { s: SurveySnapshot; selected?: string; onSelect: (id: string) => void }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Drone</th>
          <th scope="col">Doing</th>
          <th scope="col">Battery</th>
        </tr>
      </thead>
      <tbody>
        {s.drones.map((d) => (
          <tr key={d.id} className={d.id === selected ? 'is-selected' : ''} onClick={() => onSelect(d.id)}>
            <th scope="row">
              <button type="button" className="row-btn" onClick={() => onSelect(d.id)}>{d.id}</button>
              <span className="mode">{d.role}</span>
            </th>
            <td>{d.task}</td>
            <td>
              <span className={`meter ${d.battery < 25 ? 'meter--low' : ''}`}>
                <span className="meter__fill" style={{ width: `${d.battery}%` }} />
                <span className="meter__text">{d.battery}%</span>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Activity({ s }: { s: SurveySnapshot }) {
  return (
    <ul className="events events--full">
      {s.events.map((e) => (
        <li key={e.id} className={`event event--${e.level}`}>
          <time>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}</time>
          <span className="event__text">{e.text}</span>
        </li>
      ))}
    </ul>
  )
}
