import { useState } from 'react'
import type { MeshView, PlanningView, SimStatus, ViewNode, ViewTrack } from '../mesh/adapter'
import { ALERT_LABEL, ITEM_LABEL, LIVENESS_LABEL, MODE_LABEL, ON_SITE_RESUME, STOP_LABEL } from '../mesh/adapter'
import { ItemState, Liveness, NodeKind, RobotMode, StopReason, TrackKind } from '../mesh/types'
import type { Act } from '../edge/client'

interface Props {
  view: MeshView
  planning: PlanningView
  status: SimStatus
  hubLog: { at: number; kind: string; text: string }[]
  simLog: { at: number; who: string; text: string }[]
  selectedId?: string
  onSelect: (id: string | undefined) => void
  act: Act
}

const TABS = ['Overview', 'Robots', 'People', 'Mesh', 'Tasks', 'Alerts', 'Activity'] as const
type Tab = (typeof TABS)[number]

const CLASS_NAMES = ['Safety', 'Control', 'Status', 'Bulk']

export function MeshPanel({ view, planning, status, hubLog, simLog, selectedId, onSelect, act }: Props) {
  const [tab, setTab] = useState<Tab>('Overview')
  const node = selectedId && !selectedId.startsWith('t:') ? view.byId.get(selectedId) : undefined
  const track = selectedId?.startsWith('t:') ? view.tracks.find((t) => `t:${t.id}` === selectedId) : undefined
  const openAlerts = view.alerts.filter((a) => !a.ack && a.kind !== 10).length
  return (
    <aside className="panel" aria-label="Site state">
      {node && <NodeDetail n={node} view={view} act={act} onClose={() => onSelect(undefined)} />}
      {track && <TrackDetail t={track} onClose={() => onSelect(undefined)} />}
      <div className="tabs" role="tablist" aria-label="Site views">
        {TABS.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>
            {t}
            {t === 'Alerts' && openAlerts > 0 && <span className="tab__badge">{openAlerts}</span>}
          </button>
        ))}
      </div>
      <div className="panel__body" role="tabpanel">
        {tab === 'Overview' && <Overview view={view} planning={planning} status={status} />}
        {tab === 'Robots' && <Robots view={view} onSelect={onSelect} act={act} />}
        {tab === 'People' && <People view={view} onSelect={onSelect} />}
        {tab === 'Mesh' && <Mesh view={view} status={status} onSelect={onSelect} />}
        {tab === 'Tasks' && <Tasks view={view} planning={planning} act={act} />}
        {tab === 'Alerts' && <Alerts view={view} act={act} onSelect={onSelect} />}
        {tab === 'Activity' && <Activity hubLog={hubLog} simLog={simLog} now={view.now} />}
      </div>
    </aside>
  )
}

function ago(now: number, at: number) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 5 ? 'just now' : s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`
}

// ---------- details ----------

function resumeHint(n: ViewNode): string | null {
  const s = n.robot!
  if (s.mode !== RobotMode.STOPPED) return null
  if (ON_SITE_RESUME.has(s.stopReason)) return 'Needs a supervisor standing at the robot to resume (spec 10.3).'
  if (s.stopReason === StopReason.LOW_BATTERY) return 'Goes to charge; no resume needed.'
  return null
}

function NodeDetail({ n, view, act, onClose }: { n: ViewNode; view: MeshView; act: Act; onClose: () => void }) {
  const s = n.robot
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const run = async (label: string, name: Parameters<Act>[0], args: Record<string, unknown>) => {
    setBusy(label)
    const r = await act(name, args)
    setMsg(r.text)
    setBusy('')
  }
  const kindLabel = { [NodeKind.RELAY]: 'Relay mast', [NodeKind.GATEWAY]: 'Gateway', [NodeKind.ROBOT]: s?.tag === 2 ? 'Survey bot' : 'Pile-driving robot', [NodeKind.ANCHOR]: 'UWB anchor', [NodeKind.SUPERVISOR]: 'Supervisor tablet', [NodeKind.HUB]: 'Hub' }[n.kind]
  const item = s && s.taskId ? view.items.find((i) => i.taskId === s.taskId && i.itemId === s.itemId) : undefined
  return (
    <section className="detail" aria-label={`${n.name} details`}>
      <header className="detail__head">
        <div>
          <h2 className="detail__title">{n.name}</h2>
          <p className="detail__sub">{kindLabel} · <code>{n.id}</code></p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details">×</button>
      </header>
      <dl className="kv">
        <dt>Heard</dt>
        <dd><span className={`dot dot--${LIVENESS_LABEL[n.liveness]}`} /> {LIVENESS_LABEL[n.liveness]}, {ago(view.now, n.lastHeard)}</dd>
        {s && (
          <>
            <dt>Mode</dt>
            <dd>{MODE_LABEL[s.mode as RobotMode]}{s.stopReason ? ` (${STOP_LABEL[s.stopReason]})` : ''}</dd>
            <dt>Work</dt>
            <dd>{item ? `${item.unitId ?? `item ${item.itemId}`} · ${ITEM_LABEL[item.entry.state]}` : 'None'}</dd>
            <dt>Mesh</dt>
            <dd>{s.viaName ? (s.viaIsRobot ? `through robot ${s.viaName} (outside relay range)` : `via ${s.viaName}`) : 'no path'}</dd>
            <dt>Position</dt>
            <dd>{['RTK fixed', 'RTK float', 'GPS', 'Dead reckoning'][s.posSource]}, ±{(s.posAcc / 100).toFixed(2)} m{s.flags & 4 ? ', in the 3 m band outside coverage' : ''}</dd>
            <dt>Battery</dt>
            <dd>{s.batteryPct}%{s.health ? `, ${['OK', 'degraded', 'damaged'][s.health]}` : ''}</dd>
            {s.flags & 8 ? (
              <>
                <dt>Tracks</dt>
                <dd>Stale: using its own crew fix and driving slowly</dd>
              </>
            ) : null}
          </>
        )}
        {n.relay && (
          <>
            <dt>To gateway</dt>
            <dd>{n.relay.gatewayHops === 255 ? 'no path' : `${n.relay.gatewayHops} hop(s)`}</dd>
            <dt>Neighbors</dt>
            <dd>{n.relay.neighbors.length} ({n.relay.neighbors.filter((x) => x.kind === NodeKind.ROBOT).length} robots heard directly)</dd>
            <dt>Forwarded</dt>
            <dd>{n.relay.fwd.map((v, i) => `${CLASS_NAMES[i]} ${v}`).join(' · ')}</dd>
            <dt>Dropped</dt>
            <dd>dup {n.relay.dup.reduce((a, b) => a + b, 0)} · hop limit {n.relay.hopDrop.reduce((a, b) => a + b, 0)} · queue {n.relay.qDrop.reduce((a, b) => a + b, 0)}</dd>
          </>
        )}
      </dl>
      {s && (
        <div className="button-row">
          {s.mode === RobotMode.STOPPED ? (
            <button type="button" className="btn" disabled={!!busy || !!resumeHint(n)} onClick={() => run('resume', 'robot.resume', { robot: n.name })}>{busy === 'resume' ? 'Sending…' : `Resume ${n.name}`}</button>
          ) : (
            <button type="button" className="btn btn--stop" disabled={!!busy} onClick={() => run('stop', 'robot.stop', { robot: n.name })}>{busy === 'stop' ? 'Sending…' : `Stop ${n.name}`}</button>
          )}
          {s.mode === RobotMode.OUT_OF_SERVICE ? (
            <button type="button" className="btn btn--ghost" disabled={!!busy} onClick={() => run('svc', 'robot.returnToService', { robot: n.name })}>Return to service</button>
          ) : (
            <button type="button" className="btn btn--ghost" disabled={!!busy} onClick={() => run('svc', 'robot.outOfService', { robot: n.name })}>Out of service</button>
          )}
        </div>
      )}
      {s && resumeHint(n) && <p className="hint">{resumeHint(n)}</p>}
      {msg && <p className="hint">{msg}</p>}
    </section>
  )
}

function TrackDetail({ t, onClose }: { t: ViewTrack; onClose: () => void }) {
  const kind = { [TrackKind.CREW]: 'Crew (UWB badge)', [TrackKind.SUPERVISOR]: 'Supervisor (UWB badge)', [TrackKind.MACHINE]: 'Manual machine (UWB badge)', [TrackKind.UNKNOWN]: 'Unknown object (robot lidar)' }[t.kind]
  return (
    <section className="detail">
      <header className="detail__head">
        <div>
          <h2 className="detail__title">{t.name}</h2>
          <p className="detail__sub">{kind}</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details">×</button>
      </header>
      <dl className="kv">
        <dt>Position</dt>
        <dd>±{t.accM.toFixed(1)} m{t.stale ? ', stale (fewer than 3 anchors in range)' : ''}</dd>
        <dt>Speed</dt>
        <dd>{Math.hypot(t.vx, t.vy).toFixed(1)} m/s</dd>
        <dt>Robots</dt>
        <dd>hold within {t.stopM.toFixed(1)} m, slow within {t.slowM.toFixed(1)} m</dd>
      </dl>
    </section>
  )
}

// ---------- tabs ----------

function Overview({ view, planning, status }: { view: MeshView; planning: PlanningView; status: SimStatus }) {
  const units = planning.units
  const piled = units.filter((u) => u.status !== 'planned').length
  const set = units.filter((u) => u.status === 'installed').length
  const robots = view.nodes.filter((n) => n.kind === NodeKind.ROBOT)
  const relays = view.nodes.filter((n) => n.kind === NodeKind.RELAY || n.kind === NodeKind.GATEWAY)
  const by = (m: RobotMode) => robots.filter((r) => r.robot?.mode === m).length
  return (
    <div className="overview">
      <section>
        <h3>Build progress</h3>
        <p className="big-number">{piled}<span> of {units.length} units piled · {set} set</span></p>
        <div className="meter" aria-hidden="true"><span style={{ width: `${(piled / Math.max(1, units.length)) * 100}%` }} /><span className="meter__set" style={{ width: `${(set / Math.max(1, units.length)) * 100}%` }} /></div>
      </section>
      <div className="stat-grid">
        <div><strong>{by(RobotMode.TO_ITEM) + by(RobotMode.WORKING)}</strong> of {robots.length} robots working</div>
        <div className={by(RobotMode.STOPPED) ? 'is-bad' : ''}><strong>{by(RobotMode.STOPPED)}</strong> stopped</div>
        <div><strong>{by(RobotMode.HOLD)}</strong> holding</div>
        <div className={relays.some((r) => r.liveness === Liveness.LOST) ? 'is-bad' : ''}><strong>{relays.filter((r) => r.liveness !== Liveness.LOST).length}/{relays.length}</strong> relays live</div>
        <div><strong>{view.tracks.filter((t) => t.kind === TrackKind.CREW || t.kind === TrackKind.SUPERVISOR).length}</strong> people tracked</div>
        <div><strong>{status.txPerSec}</strong> transmissions/s</div>
      </div>
      <p className="hint">Hub: {view.hubLinks.gatewaysUp.length}/2 gateways up · Starlink {view.hubLinks.starlinkUp ? 'up' : 'down'}{status.hubUp ? '' : ' · hub down'} · simulation {status.speed}×</p>
    </div>
  )
}

function Robots({ view, onSelect, act }: { view: MeshView; onSelect: (id: string) => void; act: Act }) {
  const robots = view.nodes.filter((n) => n.kind === NodeKind.ROBOT)
  return (
    <ul className="rows">
      {robots.map((r) => {
        const s = r.robot
        return (
          <li key={r.id} className="row">
            <button type="button" className="row__main" onClick={() => onSelect(r.id)}>
              <span className={`dot dot--${LIVENESS_LABEL[r.liveness]}`} />
              <strong>{r.name}</strong>
              <span className={`mode mode--${s?.mode}`}>{s ? MODE_LABEL[s.mode as RobotMode] : 'not heard'}{s?.stopReason ? ` · ${STOP_LABEL[s.stopReason]}` : ''}</span>
              <span className="row__meta">{s ? `${s.batteryPct}% · ${s.viaName ? (s.viaIsRobot ? `via robot ${s.viaName}` : `via ${s.viaName}`) : 'no path'}` : ''}</span>
            </button>
            {s?.mode === RobotMode.STOPPED && !ON_SITE_RESUME.has(s.stopReason) && s.stopReason !== StopReason.LOW_BATTERY && (
              <button type="button" className="link-btn" onClick={() => act('robot.resume', { robot: r.name })}>Resume</button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function People({ view, onSelect }: { view: MeshView; onSelect: (id: string) => void }) {
  const groups: [string, ViewTrack[]][] = [
    ['Supervisors', view.tracks.filter((t) => t.kind === TrackKind.SUPERVISOR)],
    ['Crew', view.tracks.filter((t) => t.kind === TrackKind.CREW)],
    ['Manual machines', view.tracks.filter((t) => t.kind === TrackKind.MACHINE)],
    ['Unknown objects', view.tracks.filter((t) => t.kind === TrackKind.UNKNOWN)],
  ]
  return (
    <div>
      {groups.map(([title, list]) =>
        list.length ? (
          <section key={title}>
            <h3>{title} ({list.length})</h3>
            <ul className="rows">
              {list.map((t) => (
                <li key={`${t.kind}-${t.id}`} className="row">
                  <button type="button" className="row__main" onClick={() => onSelect(`t:${t.id}`)}>
                    <span className={`dot dot--${t.stale ? 'late' : 'live'}`} />
                    <strong>{t.name}</strong>
                    <span className="row__meta">±{t.accM.toFixed(1)} m{t.stale ? ' · stale' : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  )
}

function Mesh({ view, status, onSelect }: { view: MeshView; status: SimStatus; onSelect: (id: string) => void }) {
  const relays = view.nodes.filter((n) => n.kind === NodeKind.RELAY || n.kind === NodeKind.GATEWAY)
  const anchors = view.nodes.filter((n) => n.kind === NodeKind.ANCHOR)
  return (
    <div>
      <p className="hint">{status.txPerSec} transmissions/s, {status.lossPerSec} lost receptions/s. Relays flood every packet once and drop duplicates; priority order is safety, control, status, bulk.</p>
      <table className="mesh-table">
        <thead>
          <tr><th>Relay</th><th>State</th><th>Hops to GW</th><th>Fwd/s*</th><th>Dup</th><th>Queue drops</th></tr>
        </thead>
        <tbody>
          {relays.map((r) => (
            <tr key={r.id} onClick={() => onSelect(r.id)}>
              <td><strong>{r.name}</strong>{r.kind === NodeKind.GATEWAY ? ' (GW)' : ''}</td>
              <td><span className={`dot dot--${LIVENESS_LABEL[r.liveness]}`} /> {LIVENESS_LABEL[r.liveness]}</td>
              <td>{r.relay ? (r.relay.gatewayHops === 255 ? '–' : r.relay.gatewayHops) : '?'}</td>
              <td>{r.relay ? Math.round(r.relay.fwd.reduce((a, b) => a + b, 0) / Math.max(1, r.relay.uptimeS)) : '?'}</td>
              <td>{r.relay ? r.relay.dup.reduce((a, b) => a + b, 0) : '?'}</td>
              <td>{r.relay ? r.relay.qDrop.reduce((a, b) => a + b, 0) : '?'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">*Average since boot, from RELAY_STATUS counters. Duplicates dropped are normal in a flood: each relay hears most packets from several neighbors. {view.links.length} relay links. {anchors.filter((a) => a.liveness !== Liveness.LOST).length}/{anchors.length} UWB anchor posts live.</p>
    </div>
  )
}

function Tasks({ view, planning, act }: { view: MeshView; planning: PlanningView; act: Act }) {
  const queued = planning.tasks.filter((t) => t.status === 'queued')
  return (
    <div>
      {view.tasks.map((t) => {
        const count = (s: ItemState) => t.items.filter((e) => e.state === s).length
        const special = t.items.filter((e) => e.state === ItemState.HELD || e.state === ItemState.AWAITING_SIGNOFF)
        const working = t.items.filter((e) => e.state === ItemState.ASSIGNED || e.state === ItemState.STARTED)
        const total = t.items.length
        const done = count(ItemState.DONE)
        const status = planning.tasks.find((p) => p.taskId === t.task.taskId)?.status
        return (
          <section key={t.task.taskId} className="task">
            <h3>
              {t.label}
              <span className="task__meta">{status === 'complete' ? 'complete' : `${done}/${total} done`}{t.shortfall ? ` · short ${t.shortfall}` : ''}</span>
            </h3>
            <div className="meter" aria-hidden="true"><span style={{ width: `${(done / Math.max(1, total)) * 100}%` }} /></div>
            {working.length > 0 && <p className="hint">{working.map((e) => `${view.byId.get(e.winNode ?? '')?.name ?? '?'}: ${view.items.find((i) => i.taskId === e.taskId && i.itemId === e.itemId)?.unitId ?? `item ${e.itemId}`} (${ITEM_LABEL[e.state].toLowerCase()})`).join(' · ')}</p>}
            {special.map((e) => {
              const it = view.items.find((i) => i.taskId === e.taskId && i.itemId === e.itemId)
              const name = it?.unitId ?? `item ${e.itemId}`
              return (
                <div key={e.itemId} className="task__item">
                  <span>{name}: {ITEM_LABEL[e.state]}</span>
                  {e.state === ItemState.HELD && <button type="button" className="link-btn" onClick={() => act('item.release', { taskId: e.taskId, itemId: e.itemId })}>Release</button>}
                  {e.state === ItemState.AWAITING_SIGNOFF && (
                    <>
                      <button type="button" className="link-btn" onClick={() => act('item.signOff', { taskId: e.taskId, itemId: e.itemId, ok: true })}>Sign off</button>
                      <button type="button" className="link-btn" onClick={() => act('item.signOff', { taskId: e.taskId, itemId: e.itemId, ok: false })}>Rework</button>
                    </>
                  )}
                </div>
              )
            })}
          </section>
        )
      })}
      {queued.length > 0 && <p className="hint">Queued: {queued.map((t) => t.label).join(', ')}.</p>}
    </div>
  )
}

function Alerts({ view, act, onSelect }: { view: MeshView; act: Act; onSelect: (id: string) => void }) {
  const list = view.alerts.filter((a) => a.kind !== 10).slice(0, 40)
  if (!list.length) return <p className="hint">No alerts yet. The hub sends alerts to the nearest supervisor on shift and escalates if nobody acknowledges.</p>
  return (
    <ul className="rows">
      {list.map((a) => {
        const names = a.subjects.map((s) => view.byId.get(s)?.name ?? view.tracks.find((t) => String(t.id) === s)?.name ?? s)
        return (
          <li key={a.alertId} className={`alert-row sev--${a.severity} ${a.ack ? 'is-acked' : ''}`}>
            <div className="alert-row__head">
              <strong>{ALERT_LABEL[a.kind] ?? a.kind}</strong>
              <span className="row__meta">#{a.alertId}</span>
            </div>
            <p className="alert-row__text">
              {names.length ? names.map((n, i) => (
                <button key={i} type="button" className="link-btn" onClick={() => a.subjects[i] && onSelect(view.byId.has(a.subjects[i]) ? a.subjects[i] : `t:${a.subjects[i]}`)}>{n}</button>
              )) : a.taskId ? `Task ${a.taskId}` : ''}
            </p>
            <p className="row__meta">
              Notified: {a.notified.map((n) => view.byId.get(n)?.name ?? n).join(' → ') || 'everyone'}
              {a.ack ? ` · ${view.byId.get(a.ack.by)?.name ?? a.ack.by}: ${['seen', 'handling', 'needs help'][a.ack.action]}` : ''}
            </p>
            {!a.ack && (
              <div className="button-row">
                <button type="button" className="link-btn" onClick={() => act('alert.ack', { alertId: a.alertId, action: 1 })}>I'm handling it</button>
                <button type="button" className="link-btn" onClick={() => act('alert.ack', { alertId: a.alertId, action: 0 })}>Seen</button>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Activity({ hubLog, simLog, now }: { hubLog: Props['hubLog']; simLog: Props['simLog']; now: number }) {
  const rows = [...hubLog.map((e) => ({ at: e.at, text: e.text, who: 'Hub' })), ...simLog.map((e) => ({ at: e.at, text: e.text, who: e.who }))].sort((a, b) => b.at - a.at).slice(0, 120)
  return (
    <ul className="log">
      {rows.map((r, i) => (
        <li key={i}>
          <span className="log__time">{ago(now, r.at)}</span>
          <span className="log__who">{r.who}</span>
          <span>{r.text}</span>
        </li>
      ))}
    </ul>
  )
}
