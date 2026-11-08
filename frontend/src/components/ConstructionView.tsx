import { useEffect, useMemo, useState } from 'react'
import { SiteMap } from './SiteMap'
import { StatePanel } from './StatePanel'
import type { Tab } from './StatePanel'
import { MeshLinks, PacketLayer } from './MeshLayer'
import { AllocationStrip, PacketKey } from './MeshPanels'
import type { PacketType } from '../mesh/types'
import { CommandConsole } from './CommandConsole'
import { Topbar } from './Topbar'
import type { Stage } from './Topbar'
import { ageSeconds, formatAge } from '../twin/freshness'
import type { TwinSnapshot } from '../twin/types'
import { edge, useAgentSelection } from '../edge/client'
import type { AgentState, ChatMessage } from '../edge/client'

interface Props {
  snapshot: TwinSnapshot
  terrainImage?: TwinSnapshot['terrainImage']
  coverageM: number
  chat: ChatMessage[]
  agent: AgentState
  siteStage: Stage
  onStage: (s: Stage) => void
}

/** Construction stage: the approved plan being built live, with machines, crews and the mesh. */
export function ConstructionView({ snapshot: live, terrainImage, coverageM, chat, agent, onStage }: Props) {
  const snapshot = useMemo(() => ({ ...live, terrainImage }), [live, terrainImage])
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [focus, setFocus] = useState<{ x: number; y: number; key: number }>()
  const [selectedTask, setSelectedTask] = useState<string>()
  const [tab, setTab] = useState<Tab>('Overview')
  const [packets, setPackets] = useState(true)
  const [heartbeats, setHeartbeats] = useState(false)
  const mesh = live.mesh
  const packetTypes = useMemo(
    () => new Set<PacketType>(packets ? (['TASK_ANNOUNCE', 'BID', 'AGREE', 'COMMIT', 'STATUS', ...(heartbeats ? ['HEARTBEAT' as const] : [])] as PacketType[]) : []),
    [packets, heartbeats],
  )
  // Second line under each mesh robot: what it's working on.
  const notes = useMemo(() => {
    const out: Record<string, string> = {}
    for (const r of mesh?.robots ?? []) {
      const a = r.assignment
      if (a && a.state === 'in_progress') out[r.id] = `${a.label.replace(' row ', ' ')} ${a.done}/${a.total}`
    }
    return out
  }, [mesh])
  const task = mesh?.tasks.find((t) => t.id === selectedTask)
  const openTask = (id: string | undefined) => {
    setSelectedTask(id)
    const t = mesh?.tasks.find((x) => x.id === id)
    if (t) {
      setTab('Tasks')
      setExpanded(true)
      setFocus({ x: t.x, y: t.y, key: Date.now() })
    }
  }

  // When the agent looks something up, highlight it on the map.
  useAgentSelection(chat, (id) => {
    const a = live.assets.find((x) => x.id === id)
    if (!a) return
    setSelectedId(id)
    setFocus({ x: a.x, y: a.y, key: Date.now() })
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const relays = snapshot.assets.filter((a) => a.kind === 'relay')
  const relaysUp = relays.filter((r) => r.mode !== 'offline' && ageSeconds(r.lastHeard, snapshot.now) < 10).length
  const clock = new Date(snapshot.now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  return (
    <div className={`app ${expanded ? 'app--expanded' : ''}`}>
      <Topbar
        title={snapshot.siteName}
        stage="construction"
        surveyLocked
        constructionReady
        onStage={onStage}
        status={[
          { label: `Edge server ${snapshot.edgeServer.online ? 'running' : 'down'}`, tone: snapshot.edgeServer.online ? 'ok' : 'bad' },
          { label: `${relaysUp} of ${relays.length} relays up`, tone: relaysUp === relays.length ? 'ok' : 'warn' },
          ...(mesh ? [{ label: mesh.hub.online ? 'Hub on the mesh' : 'Hub off the mesh', tone: mesh.hub.online ? ('ok' as const) : ('bad' as const) }] : []),
          {
            label: snapshot.uplink.online ? 'HQ uplink up' : `HQ uplink down, last sync ${formatAge(ageSeconds(snapshot.uplink.lastSync, snapshot.now))}`,
            tone: snapshot.uplink.online ? 'ok' : 'idle',
          },
          { label: `${snapshot.units.filter((u) => u.status === 'installed').length} of ${snapshot.units.length} units set`, tone: 'plain' },
          { label: clock, tone: 'plain' },
        ]}
      />
      <main className="workspace">
        <div className="map-wrap">
          <SiteMap
            snapshot={snapshot}
            selectedId={selectedId}
            onSelect={setSelectedId}
            focus={focus}
            expanded={expanded}
            coverageM={coverageM}
            notes={notes}
            meshUnder={
              mesh
                ? (k) => (
                    <>
                      <MeshLinks mesh={mesh} selectedId={selectedId} k={k} />
                      {task && (
                        <g className="task-pin" transform={`translate(${task.x} ${task.y}) scale(${k})`}>
                          <circle r={18} />
                          <text y={-24} textAnchor="middle" className="pin-label">{task.label}</text>
                        </g>
                      )}
                    </>
                  )
                : undefined
            }
            meshOver={mesh && packets ? (k) => <PacketLayer mesh={mesh} types={packetTypes} k={k} taskId={selectedTask} /> : undefined}
            keyExtra={mesh ? <PacketKey types={packetTypes} /> : undefined}
          >
            {mesh && (
              <AllocationStrip mesh={mesh} onOpenTask={openTask} packets={packets} setPackets={setPackets} showHeartbeats={heartbeats} setShowHeartbeats={setHeartbeats} />
            )}
          </SiteMap>
          <button type="button" className="btn btn--expand" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? 'Collapse twin' : 'Expand twin'}
          </button>
        </div>
        {expanded && (
          <StatePanel snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} act={edge.act} selectedTask={selectedTask} onSelectTask={openTask} tab={tab} onTab={setTab} />
        )}
      </main>
      <CommandConsole
        messages={chat}
        agent={agent}
        onSubmit={edge.chat}
        onDecide={edge.decide}
        compact={expanded}
        examples={constructionExamples(snapshot)}
        intro="The site agent is watching the build. Ask it anything, or tell it what you need; it suggests the action and you approve it."
      />
    </div>
  )
}

function constructionExamples(s: TwinSnapshot) {
  const b = s.blocks[0]?.id ?? 'A'
  const row = s.units.find((u) => u.block === b)?.row ?? 1
  return ['How is the build going?', 'Who won the last round, and why?', 'Is any agreement stalled?', `Release ${b}-${String(row).padStart(2, '0')} stake`, 'Is the mesh healthy?']
}
