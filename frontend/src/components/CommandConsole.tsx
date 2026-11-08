import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import type { AgentState, ChatMessage, Suggestion } from '../edge/client'

interface Props {
  messages: ChatMessage[]
  agent: AgentState
  onSubmit: (text: string) => void
  onDecide: (suggestionId: string, approve: boolean) => void
  compact: boolean
  examples?: string[]
  intro?: string
}

/** Chat with the site agent. The agent can look anything up but only suggests changes; you approve them here. */
export function CommandConsole({ messages, agent, onSubmit, onDecide, compact, examples = [], intro = 'Ask the site agent about the site or tell it what you want done. Try one of these:' }: Props) {
  const [value, setValue] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const sent = messages.filter((m) => m.from === 'you').map((m) => m.text)
  const lastStatuses = messages.at(-1)?.suggestions?.map((s) => s.status).join() ?? ''

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, lastStatuses, agent.busy])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const text = value.trim()
    if (!text) return
    onSubmit(text)
    setValue('')
    setHistoryIndex(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }
    // Up/Down cycle through what you've sent, like a terminal.
    if (e.key === 'ArrowUp' && (value === '' || historyIndex !== null) && sent.length) {
      e.preventDefault()
      const i = historyIndex === null ? sent.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(i)
      setValue(sent[i])
    } else if (e.key === 'ArrowDown' && historyIndex !== null) {
      e.preventDefault()
      const i = historyIndex + 1
      if (i >= sent.length) {
        setHistoryIndex(null)
        setValue('')
      } else {
        setHistoryIndex(i)
        setValue(sent[i])
      }
    }
  }

  const pending = messages.flatMap((m) => m.suggestions ?? []).filter((s) => s.status === 'pending')
  const lastReply = [...messages].reverse().find((m) => m.from !== 'you')

  return (
    <section className={`console ${compact ? 'console--compact' : ''}`} aria-label="Chat with the site agent">
      {!compact && (
        <div className="console__log" ref={logRef} aria-live="polite">
          {messages.length === 0 ? (
            <div className="console__empty">
              {!agent.online && <p className="console__offline">{agent.status}</p>}
              <p>{intro}</p>
              <ul className="chips">
                {examples.map((ex) => (
                  <li key={ex}>
                    <button type="button" className="chip" onClick={() => onSubmit(ex)}>{ex}</button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            messages.map((m) => <MessageRow key={m.id} m={m} onDecide={onDecide} />)
          )}
          {agent.busy && (
            <div className="msg msg--agent msg--busy">
              <span className="msg__who">Site agent</span>
              <p className="msg__text msg__activity">{agent.activity || 'Thinking'}…</p>
            </div>
          )}
        </div>
      )}
      {compact && (lastReply || pending.length > 0) && (
        <div className="console__last" aria-live="polite">
          {pending.length > 0 ? (
            <SuggestionCard s={pending[0]} onDecide={onDecide} inline />
          ) : (
            lastReply && (
              <p>
                <span className="msg__who">{lastReply.from === 'agent' ? 'Site agent' : 'Site'}</span> {lastReply.text.split('\n')[0]}
              </p>
            )
          )}
        </div>
      )}
      {!compact && messages.length > 0 && examples.length > 0 && (
        <ul className="chips console__quick" aria-label="Suggested questions">
          {examples.map((ex) => (
            <li key={ex}>
              <button type="button" className="chip" onClick={() => onSubmit(ex)}>{ex}</button>
            </li>
          ))}
        </ul>
      )}
      <form className="console__form" onSubmit={submit}>
        <label htmlFor="site-input" className="visually-hidden">Message to the site agent</label>
        <textarea
          id="site-input"
          className="console__input"
          rows={1}
          value={value}
          placeholder={agent.online ? 'Ask the site agent, or tell it what you want done' : 'Site agent offline: the map controls still work'}
          onChange={(e) => {
            setValue(e.target.value)
            setHistoryIndex(null)
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
        />
        <span className={`agent-dot agent-dot--${agent.online ? (agent.busy ? 'busy' : 'on') : 'off'}`} title={agent.online ? `Site agent online (${agent.model})` : agent.status} />
        <button type="submit" className="btn btn--send" disabled={!value.trim()}>Send</button>
      </form>
    </section>
  )
}

function MessageRow({ m, onDecide }: { m: ChatMessage; onDecide: (id: string, approve: boolean) => void }) {
  if (m.from === 'site') {
    return (
      <div className={`msg msg--site ${m.ok === false ? 'msg--failed' : ''}`}>
        <span className="msg__who">Site</span>
        <p className="msg__text">
          {m.action && <strong className="msg__action">{m.action}. </strong>}
          {m.text}
        </p>
      </div>
    )
  }
  if (m.from === 'you') {
    return (
      <div className="msg msg--you">
        <span className="msg__who">You</span>
        <p className="msg__text">{m.text}</p>
      </div>
    )
  }
  return (
    <div className={`msg msg--agent ${m.proactive ? 'msg--proactive' : ''}`}>
      <span className="msg__who">{m.proactive ? 'Site agent · heads-up' : 'Site agent'}</span>
      <div className="msg__body">
        {m.text && <p className="msg__text">{m.text}</p>}
        {m.tools && m.tools.length > 0 && <p className="msg__tools">{m.tools.filter((t) => !t.startsWith('Suggested')).join(' · ')}</p>}
        {m.suggestions?.map((s) => <SuggestionCard key={s.id} s={s} onDecide={onDecide} />)}
      </div>
    </div>
  )
}

function SuggestionCard({ s, onDecide, inline }: { s: Suggestion; onDecide: (id: string, approve: boolean) => void; inline?: boolean }) {
  return (
    <div className={`suggestion suggestion--${s.status} ${inline ? 'suggestion--inline' : ''}`}>
      <div className="suggestion__head">
        <span className="suggestion__tag">{inline ? 'Agent suggests' : 'Suggested action'}</span>
        <strong className="suggestion__label">{s.label}</strong>
      </div>
      {!inline && s.reason && <p className="suggestion__reason">{s.reason}</p>}
      {s.status === 'pending' ? (
        <div className="button-row">
          <button type="button" className="btn btn--primary btn--small" onClick={() => onDecide(s.id, true)}>Approve</button>
          <button type="button" className="btn btn--small" onClick={() => onDecide(s.id, false)}>Dismiss</button>
        </div>
      ) : (
        <p className="suggestion__status">
          {s.status === 'approved' ? 'Approved. ' : s.status === 'dismissed' ? 'Dismissed.' : s.status === 'failed' ? 'Approved, but it failed: ' : ''}
          {s.status !== 'dismissed' && s.result}
        </p>
      )}
    </div>
  )
}
