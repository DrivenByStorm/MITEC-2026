import { useEffect, useMemo, useState } from 'react'
import { SiteMap } from './SiteMap'
import { StatePanel } from './StatePanel'
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
          <SiteMap snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} focus={focus} expanded={expanded} coverageM={coverageM} />
          <button type="button" className="btn btn--expand" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? 'Collapse twin' : 'Expand twin'}
          </button>
        </div>
        {expanded && <StatePanel snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} act={edge.act} />}
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
  return ['How is the build going?', 'Where is RPD-1?', 'Anything I should worry about?', `Send a telehandler to ${b}${row}`, 'Is the network healthy?']
}
