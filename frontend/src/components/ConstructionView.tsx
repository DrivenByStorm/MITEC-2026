import { useCallback, useEffect, useState } from 'react'
import { SiteMap } from './SiteMap'
import { StatePanel } from './StatePanel'
import { CommandConsole } from './CommandConsole'
import type { Message } from './CommandConsole'
import { Topbar } from './Topbar'
import type { Stage } from './Topbar'
import { ageSeconds, formatAge, useTwin } from '../twin/source'
import type { TwinSource } from '../twin/source'
import { runCommand } from '../twin/commands'
import type { TwinSnapshot } from '../twin/types'

interface Props {
  source: TwinSource
  surveyLocked: boolean
  onStage: (s: Stage) => void
  messages: Message[]
  addMessages: (m: Omit<Message, 'id'>[]) => void
}

/** Construction stage: the approved plan being built live, with machines, crews and the mesh. */
export function ConstructionView({ source, surveyLocked, onStage, messages, addMessages }: Props) {
  const snapshot = useTwin(source)
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [focus, setFocus] = useState<{ x: number; y: number; key: number }>()

  const handleCommand = useCallback(
    (text: string) => {
      const result = runCommand(text, source.getSnapshot(), source)
      const now = Date.now()
      addMessages([
        { from: 'you', text, at: now },
        { from: 'site', text: result.reply, at: now },
      ])
      if (result.select) setSelectedId(result.select)
      if (result.focus) setFocus({ ...result.focus, key: now })
    },
    [addMessages, source],
  )

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
        surveyLocked={surveyLocked}
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
          <SiteMap snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} focus={focus} expanded={expanded} />
          <button type="button" className="btn btn--expand" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? 'Collapse twin' : 'Expand twin'}
          </button>
        </div>
        {expanded && <StatePanel snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} onCommand={handleCommand} />}
      </main>
      <CommandConsole messages={messages} onSubmit={handleCommand} compact={expanded} examples={constructionExamples(snapshot)} />
    </div>
  )
}

function constructionExamples(s: TwinSnapshot) {
  const b = s.blocks[0]?.id ?? 'A'
  const row = s.units.find((u) => u.block === b)?.row ?? 1
  return ['status', 'where is RPD-1', `need a telehandler at ${b}${row}`, 'pause CR-1', `who is in block ${b}`, 'network']
}
