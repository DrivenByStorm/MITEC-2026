import { useState } from 'react'
import type { Act } from '../edge/client'
import type { MeshRound, MeshSnapshot, MeshTask, PacketType, RobotView } from '../mesh/types'
import { PACKET_COLORS, PACKET_LABEL, PACKET_TYPES } from '../mesh/types'
import { MODE_LABEL, roundSummary } from '../mesh/labels'

const ACTIVE: MeshTask['state'][] = ['announced', 'bidding', 'awaiting', 'assigned', 'in_progress', 'release_requested', 'cancel_requested', 'no_eligible']
const FLOW: { key: MeshTask['state']; label: string }[] = [
  { key: 'announced', label: 'Announced' },
  { key: 'bidding', label: 'Bidding' },
  { key: 'awaiting', label: 'Awaiting agreement' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'completed', label: 'Completed' },
]

function roundOf(mesh: MeshSnapshot, id?: number) {
  return id ? mesh.rounds.find((r) => r.id === id) : undefined
}

// ---------- strip over the map ----------

export function AllocationStrip({ mesh, onOpenTask, packets, setPackets, showHeartbeats, setShowHeartbeats }: {
  mesh: MeshSnapshot
  onOpenTask: (id: string) => void
  packets: boolean
  setPackets: (v: boolean) => void
  showHeartbeats: boolean
  setShowHeartbeats: (v: boolean) => void
}) {
  const cur = mesh.rounds.find((r) => r.status === 'open')
  const last = mesh.rounds[0]
  const r = cur ?? last
  const task = r ? mesh.tasks.find((t) => t.id === r.taskId) : undefined
  const c = mesh.counts
  return (
    <div className="alloc-strip" role="status">
      <div className="alloc-strip__mode">{MODE_LABEL}</div>
      {!mesh.hub.online && <div className="alloc-strip__warn">Hub off: robots keep agreeing on tasks they already have</div>}
      {r && task ? (
        <button type="button" className={`alloc-strip__round ${r.stalled ? 'is-stalled' : ''}`} onClick={() => onOpenTask(task.id)}>
          <span className="alloc-strip__rid">Round {r.id}{cur ? '' : ' (last)'}</span>
          <span className="alloc-strip__task">{task.label}</span>
          <span className="alloc-strip__state">{r.stalled ? `Stalled ${Math.round(r.ageS)} s. ` : ''}{roundSummary(r)}</span>
        </button>
      ) : (
        <div className="alloc-strip__round">Waiting for the hub to announce the first task</div>
      )}
      <div className="alloc-strip__counts">
        {(c.in_progress ?? 0) + (c.assigned ?? 0)} working · {c.completed ?? 0} done · {(c.queued ?? 0) + (c.no_eligible ?? 0)} queued · {c.waiting ?? 0} waiting on earlier work
      </div>
      <div className="alloc-strip__toggles">
        <label><input type="checkbox" checked={packets} onChange={() => setPackets(!packets)} />Packets</label>
        <label><input type="checkbox" checked={showHeartbeats} onChange={() => setShowHeartbeats(!showHeartbeats)} disabled={!packets} />Heartbeats</label>
      </div>
    </div>
  )
}

export function PacketKey({ types }: { types: Set<PacketType> }) {
  return (
    <>
      {PACKET_TYPES.filter((t) => types.has(t)).map((t) => (
        <li key={t}>
          <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill={PACKET_COLORS[t]} /></svg>
          {PACKET_LABEL[t]}
        </li>
      ))}
    </>
  )
}

// ---------- Tasks tab ----------

export function TasksTab({ mesh, selectedTask, onSelectTask, onSelectAsset, act }: {
  mesh: MeshSnapshot
  selectedTask?: string
  onSelectTask: (id: string | undefined) => void
  onSelectAsset: (id: string) => void
  act: Act
}) {
  const [filter, setFilter] = useState<'active' | 'all' | 'completed'>('active')
  const task = mesh.tasks.find((t) => t.id === selectedTask)
  const list = mesh.tasks.filter((t) =>
    filter === 'all' ? true : filter === 'completed' ? t.state === 'completed' : ACTIVE.includes(t.state) || (t.state === 'queued'),
  )
  return (
    <div className="tasks">
      <p className="mode-label">{MODE_LABEL}</p>
      {task && <TaskDetail mesh={mesh} task={task} onClose={() => onSelectTask(undefined)} onSelectAsset={onSelectAsset} act={act} />}
      <div className="seg" role="radiogroup" aria-label="Which tasks">
        {(['active', 'completed', 'all'] as const).map((f) => (
          <button key={f} type="button" role="radio" aria-checked={filter === f} className="seg__btn" onClick={() => setFilter(f)}>
            {f === 'active' ? 'Open' : f === 'completed' ? 'Completed' : 'All'}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="hint">Nothing here yet.</p>
      ) : (
        <table className="table table--tasks">
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">State</th>
              <th scope="col">Owner</th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id} className={t.id === selectedTask ? 'is-selected' : ''} onClick={() => onSelectTask(t.id)}>
                <th scope="row">
                  <button type="button" className="row-btn" onClick={() => onSelectTask(t.id)}>{t.label}</button>
                  <span className="task-id">{t.id}</span>
                </th>
                <td>
                  <span className={`tstate tstate--${t.state} ${t.deferred ? 'tstate--held' : ''}`}>{t.stateLabel}</span>
                  {t.state === 'in_progress' && <span className="task-prog">{t.done}/{t.total}</span>}
                  {roundOf(mesh, t.roundId)?.stalled && <span className="tstate tstate--stalled">Stalled</span>}
                </td>
                <td>
                  {t.owner ?? '–'}
                  {t.uncertain && <span className="tstate tstate--uncertain" title="Owner not heard recently; task stays assigned">uncertain</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function TaskDetail({ mesh, task: t, onClose, onSelectAsset, act }: { mesh: MeshSnapshot; task: MeshTask; onClose: () => void; onSelectAsset: (id: string) => void; act: Act }) {
  const r = roundOf(mesh, t.roundId)
  const step = FLOW.findIndex((f) => f.key === t.state)
  return (
    <section className="detail" aria-label={`${t.label} details`}>
      <div className="detail__head">
        <div>
          <h2 className="detail__name">{t.label}</h2>
          <p className="detail__role">{t.id} · revision {t.revision} · priority {t.priority} · needs {t.requires} tool</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close task">×</button>
      </div>
      <ol className="steps steps--task" aria-label={`State: ${t.stateLabel}`}>
        {FLOW.map((f, i) => (
          <li key={f.key} className={step >= 0 && i <= step ? 'is-done' : ''}>{f.label}</li>
        ))}
      </ol>
      <p className="task-state-line">
        <span className={`tstate tstate--${t.state}`}>{t.stateLabel}</span>
        {t.owner && (
          <>
            {' '}
            by <button type="button" className="link-btn" onClick={() => onSelectAsset(t.owner!)}>{t.owner}</button>
            {t.state === 'in_progress' && `, ${t.done} of ${t.total} done`}
          </>
        )}
        {t.uncertain && <span className="hint hint--warn"> Owner not heard for {mesh.config.uncertainS}+ s; the task stays assigned until it reports stopped or released.</span>}
      </p>
      {r ? <RoundTable mesh={mesh} round={r} onSelectAsset={onSelectAsset} /> : <p className="hint">No round yet. {t.state === 'waiting' ? 'The hub unlocks it once the work before it is reported complete.' : ''}</p>}
      {t.rounds.length > 1 && <p className="hint">Rounds for this task: {t.rounds.join(', ')}</p>}
      <div className="detail__actions button-row">
        {(t.state === 'assigned' || t.state === 'in_progress') && (
          <button type="button" className="btn" onClick={() => act('task.release', { id: t.id })}>Release</button>
        )}
        {!['completed', 'cancelled', 'cancel_requested'].includes(t.state) && (
          <button type="button" className="btn btn--ghost" onClick={() => act('task.cancel', { id: t.id })}>Cancel task</button>
        )}
        {['waiting', 'queued', 'no_eligible'].includes(t.state) && (
          <button type="button" className="btn btn--ghost" onClick={() => act('task.priority', { id: t.id, priority: t.priority + 1 })}>Raise priority</button>
        )}
      </div>
    </section>
  )
}

function RoundTable({ mesh, round: r, onSelectAsset }: { mesh: MeshSnapshot; round: MeshRound; onSelectAsset: (id: string) => void }) {
  const robots = new Map(mesh.robots.map((x) => [x.id, x]))
  return (
    <div className="round">
      <p className="round__head">
        Round {r.id}: <strong>{roundSummary(r)}</strong>
        {r.stalled && <span className="tstate tstate--stalled">Stalled {Math.round(r.ageS)} s</span>}
      </p>
      <table className="table table--round">
        <thead>
          <tr>
            <th scope="col">Robot</th>
            <th scope="col" title="What the hub received">Bid</th>
            <th scope="col" title="The winner each robot proposed (its AGREE)">Proposes</th>
          </tr>
        </thead>
        <tbody>
          {r.participants.map((p) => {
            const bid = r.bids[p]
            const declined = r.declined.includes(p)
            const prop = r.proposedByRobot[p]
            const agree = r.agrees[p]
            const own = robots.get(p)?.openRounds.find((x) => x.id === r.id)
            return (
              <tr key={p} className={r.commit?.owner === p ? 'is-winner' : ''}>
                <th scope="row"><button type="button" className="row-btn" onClick={() => onSelectAsset(p)}>{p}</button></th>
                <td title={r.reasons[p] ?? ''}>
                  {bid !== undefined ? <strong>{bid}</strong> : declined ? <span className="muted">declined</span> : <span className="muted">not heard</span>}
                  {r.reasons[p] && <span className="reason">{r.reasons[p]}</span>}
                </td>
                <td>
                  {prop ? prop : agree ? (agree.winner ?? 'nobody') : own ? <span className="muted">waiting for bids ({own.bidsReceived}/{own.participants})</span> : <span className="muted">–</span>}
                  {agree && <span className="reason">fingerprint {agree.fp}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {r.tentative && (
        <p className="hint">
          Tentative winner {r.tentative.robot} has received {r.tentative.matching} of {r.tentative.of} matching agreements (its own included).
          {r.status === 'committed' ? ' It committed and started work.' : ' It commits only when all match.'}
        </p>
      )}
      <p className="hint">Bids and agreements above are what the hub has received over the mesh; "Proposes" comes from each robot's own copy of the round.</p>
    </div>
  )
}

// ---------- robot detail ----------

export function RobotMesh({ mesh, robot, onSelectTask, onSelectAsset, act }: { mesh: MeshSnapshot; robot: RobotView; onSelectTask: (id: string) => void; onSelectAsset: (id: string) => void; act: Act }) {
  const node = mesh.nodes.find((n) => n.id === robot.id)
  const neighbors = mesh.links.filter((l) => l.a === robot.id || l.b === robot.id).map((l) => (l.a === robot.id ? l.b : l.a))
  const cutHere = mesh.cut.filter(([a, b]) => a === robot.id || b === robot.id).map(([a, b]) => (a === robot.id ? b : a))
  const heard = mesh.heard[robot.id]
  const a = robot.assignment
  return (
    <div className="robot-mesh">
      <h3 className="section-title">On the mesh</h3>
      <dl className="detail__grid">
        <dt>Local view</dt>
        <dd>{robot.knownTasks} task{robot.knownTasks === 1 ? '' : 's'} learned from {robot.inbox} packets</dd>
        <dt>Assignment</dt>
        <dd>
          {a && a.state === 'in_progress' ? (
            <button type="button" className="link-btn" onClick={() => onSelectTask(a.taskId)}>{a.label} ({a.done}/{a.total})</button>
          ) : robot.available ? 'None, available' : 'None'}
        </dd>
        <dt>Hub last heard</dt>
        <dd className={heard && heard.ago > mesh.config.uncertainS ? 'text-alert' : ''}>{heard ? `${heard.ago} s ago` : 'never'}{node && !node.reachesHub ? ' (no path to hub)' : ''}</dd>
        <dt>Tools</dt>
        <dd>{robot.tools.join(', ')}</dd>
      </dl>
      {robot.openRounds.length > 0 && (
        <ul className="robot-rounds">
          {robot.openRounds.map((r) => (
            <li key={r.id}>
              <button type="button" className="link-btn" onClick={() => onSelectTask(r.taskId)}>Round {r.id}</button>: my bid {r.myBid?.score ?? 'decline'} · {r.bidsReceived}/{r.participants} bids
              {r.proposed ? ` · proposes ${r.proposed} (${r.matching}/${r.participants} match)` : ''}
            </li>
          ))}
        </ul>
      )}
      <h3 className="section-title">Neighbors</h3>
      {neighbors.length === 0 && cutHere.length === 0 ? (
        <p className="hint hint--warn">No neighbors in range: packets can't reach it.</p>
      ) : (
        <ul className="neighbors">
          {neighbors.map((n) => (
            <li key={n}>
              <button type="button" className="link-btn" onClick={() => onSelectAsset(n)}>{n}</button>
              <button type="button" className="mini-btn" onClick={() => act('mesh.cutLink', { a: robot.id, b: n })}>Cut link</button>
            </li>
          ))}
          {cutHere.map((n) => (
            <li key={`cut-${n}`} className="is-cut">
              {n} (removed)
              <button type="button" className="mini-btn" onClick={() => act('mesh.restoreLink', { a: robot.id, b: n })}>Restore</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Neighbors list for a relay, gateway or the hub, with cut/restore and up/down. */
export function NodeMesh({ mesh, id, onSelectAsset, act }: { mesh: MeshSnapshot; id: string; onSelectAsset: (id: string) => void; act: Act }) {
  const node = mesh.nodes.find((n) => n.id === id)
  if (!node) return null
  const neighbors = mesh.links.filter((l) => l.a === id || l.b === id).map((l) => (l.a === id ? l.b : l.a))
  const cutHere = mesh.cut.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a))
  return (
    <div className="robot-mesh">
      <h3 className="section-title">Mesh neighbors</h3>
      <ul className="neighbors">
        {neighbors.map((n) => (
          <li key={n}>
            <button type="button" className="link-btn" onClick={() => onSelectAsset(n)}>{n}</button>
            <button type="button" className="mini-btn" onClick={() => act('mesh.cutLink', { a: id, b: n })}>Cut link</button>
          </li>
        ))}
        {cutHere.map((n) => (
          <li key={`cut-${n}`} className="is-cut">
            {n} (removed)
            <button type="button" className="mini-btn" onClick={() => act('mesh.restoreLink', { a: id, b: n })}>Restore</button>
          </li>
        ))}
      </ul>
      {node.kind === 'relay' && (
        <button type="button" className={`btn ${node.up ? 'btn--stop' : ''}`} onClick={() => act('mesh.relay', { id, up: !node.up })}>
          {node.up ? `Take ${id} down` : `Bring ${id} back up`}
        </button>
      )}
    </div>
  )
}

// ---------- Mesh tab ----------

export function MeshTab({ mesh, onSelectAsset, act }: { mesh: MeshSnapshot; onSelectAsset: (id: string) => void; act: Act }) {
  const [latency, setLatency] = useState(mesh.config.latencyMs)
  const [loss, setLoss] = useState(mesh.config.lossPct)
  const robots = mesh.nodes.filter((n) => n.kind === 'robot')
  const relays = mesh.nodes.filter((n) => n.kind === 'relay' || n.kind === 'gateway')
  const s = mesh.stats
  return (
    <div className="mesh-tab">
      <section>
        <h3 className="section-title">Network conditions</h3>
        <label className="slider">
          <span>Delay per hop <strong>{latency} ms</strong></span>
          <input type="range" min={20} max={2000} step={10} value={latency} onChange={(e) => setLatency(Number(e.target.value))} onPointerUp={() => act('mesh.latency', { ms: latency })} onKeyUp={() => act('mesh.latency', { ms: latency })} />
        </label>
        <label className="slider">
          <span>Packet loss per hop <strong>{loss}%</strong></span>
          <input type="range" min={0} max={60} step={1} value={loss} onChange={(e) => setLoss(Number(e.target.value))} onPointerUp={() => act('mesh.loss', { pct: loss })} onKeyUp={() => act('mesh.loss', { pct: loss })} />
        </label>
        <div className="button-row">
          <button type="button" className={`btn ${mesh.hub.online ? 'btn--stop' : 'btn--primary'}`} onClick={() => act('mesh.hub', { online: !mesh.hub.online })}>
            {mesh.hub.online ? 'Switch hub off' : 'Switch hub on'}
          </button>
          {mesh.cutTotal > 0 && <button type="button" className="btn" onClick={() => act('mesh.restoreLink', {})}>Restore {mesh.cutTotal} removed link{mesh.cutTotal === 1 ? '' : 's'}</button>}
        </div>
        <p className="hint">Select a robot or relay on the map to cut one of its links. Retries every {mesh.config.retryS} s; a round open {mesh.config.stallS} s+ shows as stalled.</p>
      </section>
      <section>
        <h3 className="section-title">Robots</h3>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Robot</th>
              <th scope="col">Path to hub</th>
              <th scope="col">Heard</th>
              <th scope="col">Task</th>
            </tr>
          </thead>
          <tbody>
            {robots.map((n) => {
              const r = mesh.robots.find((x) => x.id === n.id)
              const h = mesh.heard[n.id]
              return (
                <tr key={n.id} onClick={() => onSelectAsset(n.id)}>
                  <th scope="row"><button type="button" className="row-btn" onClick={() => onSelectAsset(n.id)}>{n.id}</button></th>
                  <td className={n.reachesHub ? '' : 'text-alert'}>{n.reachesHub ? 'Yes' : 'No'}</td>
                  <td className={h && h.ago > mesh.config.uncertainS ? 'text-alert' : ''}>{h ? `${h.ago} s` : '–'}</td>
                  <td>{r?.assignment && r.assignment.state === 'in_progress' ? `${r.assignment.label} ${r.assignment.done}/${r.assignment.total}` : r?.available ? 'Available' : '–'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
      <section>
        <h3 className="section-title">Relays</h3>
        <ul className="chips">
          {relays.map((n) => (
            <li key={n.id}>
              <button type="button" className={`chip ${n.up ? '' : 'chip--down'}`} onClick={() => onSelectAsset(n.id)}>
                {n.id} {n.up ? '' : '(down)'}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="section-title">Packets</h3>
        <p className="hint">
          {s.sent} sent, {s.hops} hop transmissions, {s.delivered} delivered, {s.lost} lost, {s.broken} on links that broke mid-flight, {s.duplicates} duplicate copies suppressed.
        </p>
      </section>
    </div>
  )
}
