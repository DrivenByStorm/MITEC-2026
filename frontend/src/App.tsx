import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { SiteMap } from './components/SiteMap'
import { StatePanel } from './components/StatePanel'
import { CommandConsole } from './components/CommandConsole'
import type { Message } from './components/CommandConsole'
import { ageSeconds, formatAge, getTwinSource, useTwin } from './twin/source'
import { runCommand } from './twin/commands'

const source = getTwinSource()

export default function App() {
  const snapshot = useTwin(source)
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [focus, setFocus] = useState<{ x: number; y: number; key: number }>()
  const [messages, setMessages] = useState<Message[]>([])
  const msgSeq = useRef(1)

  const handleCommand = useCallback((text: string) => {
    const result = runCommand(text, source.getSnapshot(), source)
    const now = Date.now()
    setMessages((m) => [
      ...m,
      { id: msgSeq.current++, from: 'you', text, at: now },
      { id: msgSeq.current++, from: 'site', text: result.reply, at: now },
    ])
    if (result.select) setSelectedId(result.select)
    if (result.focus) setFocus({ ...result.focus, key: now })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && expanded) setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  const relays = snapshot.assets.filter((a) => a.kind === 'relay')
  const relaysUp = relays.filter((r) => r.mode !== 'offline' && ageSeconds(r.lastHeard, snapshot.now) < 10).length

  return (
    <div className={`app ${expanded ? 'app--expanded' : ''}`}>
      <header className="topbar">
        <div className="topbar__site">
          <h1 className="topbar__title">{snapshot.siteName}</h1>
          <p className="topbar__sub">Build site digital twin</p>
        </div>
        <ul className="topbar__status" aria-label="System status">
          <li className={snapshot.edgeServer.online ? 'ok' : 'bad'}>Edge server {snapshot.edgeServer.online ? 'running' : 'down'}</li>
          <li className={relaysUp === relays.length ? 'ok' : 'warn'}>
            {relaysUp} of {relays.length} relays up
          </li>
          <li className={snapshot.uplink.online ? 'ok' : 'idle'}>
            {snapshot.uplink.online ? 'HQ uplink up' : `HQ uplink down, last sync ${formatAge(ageSeconds(snapshot.uplink.lastSync, snapshot.now))}`}
          </li>
          <li className="clock">{new Date(snapshot.now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</li>
        </ul>
      </header>

      <main className="workspace">
        <div className="map-wrap">
          <SiteMap snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} focus={focus} expanded={expanded} />
          <button type="button" className="btn btn--expand" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? 'Collapse twin' : 'Expand twin'}
          </button>
        </div>
        {expanded && <StatePanel snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} onCommand={handleCommand} />}
      </main>

      <CommandConsole messages={messages} onSubmit={handleCommand} compact={expanded} />
    </div>
  )
}
