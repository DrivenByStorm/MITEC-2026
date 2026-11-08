import { useEffect, useMemo, useState } from 'react'
import { MeshMap } from './MeshMap'
import { MeshPanel } from './MeshPanel'
import { CommandConsole } from './CommandConsole'
import { Topbar } from './Topbar'
import type { Stage } from './Topbar'
import type { TwinSnapshot } from '../twin/types'
import type { SitePlan } from '../buildup/types'
import { buildView } from '../mesh/adapter'
import type { MeshConfig } from '../mesh/adapter'
import { Liveness, NodeKind, RobotMode } from '../mesh/types'
import { edge, useAgentSelection } from '../edge/client'
import type { AgentState, ChatMessage, EdgeState } from '../edge/client'

interface Props {
  twin: NonNullable<EdgeState['twin']>
  config: MeshConfig
  plan: SitePlan
  events: EdgeState['meshEvents']
  simLog: EdgeState['meshLog']
  terrainImage?: TwinSnapshot['terrainImage']
  chat: ChatMessage[]
  agent: AgentState
  siteStage: Stage
  onStage: (s: Stage) => void
}

const SPEEDS = [1, 2, 5, 10]
const FAILURES: [string, string][] = [
  ['relay_down', 'Relay goes down'],
  ['relay_up', 'Relay back up'],
  ['gateway_down', 'Gateway goes down'],
  ['robot_radio_off', "Robot's radio dies"],
  ['robot_radio_on', "Robot's radio back"],
  ['rtk_degraded', 'Robot loses RTK fix'],
  ['rtk_ok', 'Robot RTK fixed again'],
  ['robot_fault', 'Robot reports a fault'],
  ['stray_object', 'Vehicle without a badge'],
  ['crew_near_robot', 'Crew walks up to a robot'],
  ['crew_into_hazard', 'Crew walks into a hazard'],
  ['hub_down', 'Hub goes down'],
  ['hub_up', 'Hub back up'],
  ['starlink_down', 'Starlink down'],
  ['starlink_up', 'Starlink up'],
]

/** Construction: the approved plan being built over the site mesh. */
export function ConstructionView({ twin, config, plan, events, simLog, terrainImage, chat, agent, onStage }: Props) {
  const view = useMemo(() => buildView(twin.mesh, twin.planning, config), [twin, config])
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [focus, setFocus] = useState<{ x: number; y: number; key: number }>()
  const [packets, setPackets] = useState(false)
  const [follow, setFollow] = useState<string | null>(null)
  const [injectOpen, setInjectOpen] = useState(false)
  const [wallNow, setWallNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setWallNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // When the agent looks something up, highlight it on the map.
  useAgentSelection(chat, (id) => {
    const n = view.byId.get(id)
    const t = view.tracks.find((x) => String(x.id) === id)
    const target = n ? { id, x: n.x, y: n.y } : t ? { id: `t:${t.id}`, x: t.x, y: t.y } : null
    if (!target) return
    setSelectedId(target.id)
    setFocus({ x: target.x, y: target.y, key: Date.now() })
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setTracing = (on: boolean, msg: string | null = null) => {
    setPackets(on)
    setFollow(msg)
    void edge.act('mesh.trace', { enabled: on, follow: msg, classes: [0, 1] })
  }

  const relays = view.nodes.filter((n) => n.kind === NodeKind.RELAY || n.kind === NodeKind.GATEWAY)
  const relaysUp = relays.filter((r) => r.liveness !== Liveness.LOST).length
  const robots = view.nodes.filter((n) => n.kind === NodeKind.ROBOT)
  const stopped = robots.filter((r) => r.robot?.mode === RobotMode.STOPPED).length
  const units = twin.planning.units
  const piled = units.filter((u) => u.status !== 'planned').length
  const openAlerts = view.alerts.filter((a) => !a.ack && a.kind !== 10).length
  const simClock = new Date(view.now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  // Grouped losses from the hub (7.3), shown as a banner for a minute.
  const loss = [...events].reverse().find((e) => e.kind === 'node_lost' && wallNow - e.recv < 60_000)
  const lossText = (() => {
    if (!loss || loss.kind !== 'node_lost') return null
    const name = (id: string) => view.byId.get(id)?.name ?? id
    if (loss.cause === 2) return 'Hub isolated: both gateways lost. Robots keep working on what they know.'
    if (loss.cause === 1 && loss.causeNode) {
      const others = loss.nodes.filter((n) => n !== loss.causeNode)
      return `${name(loss.causeNode)} down${others.length ? `: ${others.map(name).join(', ')} lost with it` : '; everything rerouted'}`
    }
    return `Lost contact with ${loss.nodes.map(name).join(', ')} (cause unknown)`
  })()

  return (
    <div className={`app ${expanded ? 'app--expanded' : ''}`}>
      <Topbar
        title="New site, Pecos County TX"
        stage="construction"
        surveyLocked
        constructionReady
        onStage={onStage}
        status={[
          { label: twin.status.hubUp ? `Hub up, ${view.hubLinks.gatewaysUp.length}/2 gateways` : 'Hub down', tone: twin.status.hubUp && view.hubLinks.gatewaysUp.length === 2 ? 'ok' : 'bad' },
          { label: `${relaysUp} of ${relays.length} relays live`, tone: relaysUp === relays.length ? 'ok' : 'warn' },
          { label: stopped ? `${stopped} robot${stopped > 1 ? 's' : ''} stopped` : `${robots.length} robots running`, tone: stopped ? 'bad' : 'ok' },
          { label: `${piled} of ${units.length} piled`, tone: 'plain' },
          ...(openAlerts ? [{ label: `${openAlerts} open alert${openAlerts > 1 ? 's' : ''}`, tone: 'warn' as const }] : []),
          { label: simClock, tone: 'plain' as const },
        ]}
      />
      <main className="workspace">
        <div className="map-wrap">
          <MeshMap
            view={view}
            plan={plan}
            terrainImage={terrainImage}
            selectedId={selectedId}
            onSelect={setSelectedId}
            focus={focus}
            expanded={expanded}
            events={events}
            packets={packets}
            follow={follow}
            onFollow={(m) => setTracing(true, m)}
            speed={twin.status.speed}
            wallNow={wallNow}
          >
            {lossText && <div className={`loss-banner loss-banner--${loss && loss.kind === 'node_lost' ? loss.cause : 0}`} role="status">{lossText}</div>}
            <div className="sim-bar" role="toolbar" aria-label="Simulation controls">
              <span className="sim-bar__label">Sim</span>
              {SPEEDS.map((s) => (
                <button key={s} type="button" className={`seg ${twin.status.speed === s ? 'is-on' : ''}`} onClick={() => void edge.act('sim.speed', { value: s })}>{s}×</button>
              ))}
              <button type="button" className={`seg ${packets ? 'is-on' : ''}`} onClick={() => setTracing(!packets)} title="Animate packets moving through the mesh">Packets</button>
              <div className="inject">
                <button type="button" className="seg" aria-expanded={injectOpen} onClick={() => setInjectOpen((v) => !v)}>Inject failure ▾</button>
                {injectOpen && (
                  <ul className="inject__menu">
                    {FAILURES.map(([kind, label]) => (
                      <li key={kind}>
                        <button type="button" onClick={() => {
                          setInjectOpen(false)
                          void edge.act('sim.inject', { kind, ...(selectedId && view.byId.has(selectedId) ? { target: view.byId.get(selectedId)!.name } : {}) })
                        }}>{label}{selectedId && view.byId.has(selectedId) && /relay|robot|rtk/.test(kind) ? ` (${view.byId.get(selectedId)!.name})` : ''}</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </MeshMap>
          <button type="button" className="btn btn--expand" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? 'Collapse twin' : 'Expand twin'}
          </button>
        </div>
        {expanded && <MeshPanel view={view} planning={twin.planning} status={twin.status} hubLog={twin.hubLog} simLog={simLog} selectedId={selectedId} onSelect={setSelectedId} act={edge.act} />}
      </main>
      <CommandConsole
        messages={chat}
        agent={agent}
        onSubmit={edge.chat}
        onDecide={edge.decide}
        compact={expanded}
        examples={['How is the build going?', 'Anything I should worry about?', 'Why is RPD-1 stopped?', 'Is the mesh healthy?', 'Which items need sign-off?']}
        intro="The site agent is watching the mesh. Ask it anything, or tell it what you need; it suggests the action and you approve it."
      />
    </div>
  )
}
