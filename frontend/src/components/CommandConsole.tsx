import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { EXAMPLES } from '../twin/commands'

export interface Message {
  id: number
  from: 'you' | 'site'
  text: string
  at: number
}

interface Props {
  messages: Message[]
  onSubmit: (text: string) => void
  compact: boolean
}

export function CommandConsole({ messages, onSubmit, compact }: Props) {
  const [value, setValue] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sent = messages.filter((m) => m.from === 'you').map((m) => m.text)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

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

  return (
    <section className={`console ${compact ? 'console--compact' : ''}`} aria-label="Ask or instruct the site">
      {!compact && (
        <div className="console__log" ref={logRef} aria-live="polite">
          {messages.length === 0 ? (
            <div className="console__empty">
              <p>Ask about the site or give an instruction. Try one of these:</p>
              <ul className="chips">
                {EXAMPLES.map((ex) => (
                  <li key={ex}>
                    <button type="button" className="chip" onClick={() => onSubmit(ex)}>{ex}</button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`msg msg--${m.from}`}>
                <span className="msg__who">{m.from === 'you' ? 'You' : 'Site'}</span>
                <p className="msg__text">{m.text}</p>
              </div>
            ))
          )}
        </div>
      )}
      {compact && messages.length > 0 && (
        <p className="console__last" aria-live="polite">
          <span className="msg__who">Site</span> {[...messages].reverse().find((m) => m.from === 'site')?.text.split('\n')[0]}
        </p>
      )}
      <form className="console__form" onSubmit={submit}>
        <label htmlFor="site-input" className="visually-hidden">Message to the site</label>
        <textarea
          id="site-input"
          ref={inputRef}
          className="console__input"
          rows={1}
          value={value}
          placeholder="Ask the site or give an instruction"
          onChange={(e) => {
            setValue(e.target.value)
            setHistoryIndex(null)
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn btn--send" disabled={!value.trim()}>Send</button>
      </form>
    </section>
  )
}
