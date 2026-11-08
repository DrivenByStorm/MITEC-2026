import { useState } from 'react'
import type { Act } from '../edge/client'
import type { SiteClock } from '../twin/types'
import { speedLabel } from '../twin/siteTime'

interface Props {
  clock: SiteClock
  mode: 'survey' | 'construction'
  act: Act
  /** Units set so far, for the skip-to-end progress bar. */
  progress?: { set: number; total: number }
  /** Manual changes that could stall a skip to the end (paused robots, cut links...). */
  manualChanges?: string[]
}

/**
 * Speed dial for the simulation. In construction it also shows the site day and time, and can
 * skip to the end of the shift or of the whole build, or pause when each day ends.
 */
export function TimeDial({ clock, mode, act, progress, manualChanges = [] }: Props) {
  const [confirming, setConfirming] = useState(false)
  const [dismissed, setDismissed] = useState<string>()
  const speeds = mode === 'survey' ? clock.surveySpeeds : clock.speeds
  const current = mode === 'survey' ? Math.min(clock.speed, Math.max(...clock.surveySpeeds)) : clock.speed
  const left = clock.shiftLeftMin
  const busy = clock.skipping || clock.finishing
  const done = !!progress && progress.set >= progress.total

  const finish = (resetManual: boolean) => {
    setConfirming(false)
    void act('sim.finishBuild', { resetManual })
  }
  const askFinish = () => (manualChanges.length ? setConfirming(true) : finish(false))

  if (mode === 'construction' && clock.finishing) {
    const pct = progress ? Math.round((progress.set / Math.max(1, progress.total)) * 100) : 0
    return (
      <div className="time-dial time-dial--finishing" role="status" aria-live="polite">
        <div className="time-dial__clock">
          <strong>Skipping to the end of the build</strong>
          <span className="time-dial__time">Day {clock.day} · {clock.time}</span>
        </div>
        {progress && (
          <div className="ff-progress" aria-label={`${progress.set} of ${progress.total} units set`}>
            <span className="ff-progress__fill" style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className="time-dial__controls">
          {progress && <span className="time-dial__shift">{progress.set} of {progress.total} units set ({pct}%)</span>}
          <button type="button" className="btn btn--ghost time-dial__skip" onClick={() => act('sim.cancelFinish')}>Cancel</button>
        </div>
        <p className="time-dial__note">Fast-forwarding in coarse steps; the agent stays quiet until it's done.</p>
      </div>
    )
  }

  const lf = clock.lastFinish
  return (
    <div className={`time-dial ${mode === 'survey' ? 'time-dial--survey' : ''}`} role="group" aria-label="Simulation speed">
      {mode === 'construction' && (
        <div className="time-dial__clock">
          <strong>Day {clock.day}</strong>
          <span className="time-dial__time">{clock.time}</span>
          <span className="time-dial__shift">
            {clock.skipping ? 'Skipping to end of shift…' : clock.onShift ? `Shift ends ${clock.shiftEnd} (${Math.floor(left / 60)} h ${left % 60} m)` : `Next shift ${clock.shiftStart}`}
          </span>
        </div>
      )}
      <div className="time-dial__controls">
        <button
          type="button"
          className="time-dial__play"
          onClick={() => act('sim.pause', { paused: !clock.paused })}
          aria-label={clock.paused ? 'Resume' : 'Pause'}
          title={clock.paused ? 'Resume' : 'Pause'}
          disabled={busy}
        >
          {clock.paused ? '▶' : '❚❚'}
        </button>
        <div className="seg seg--dial" role="radiogroup" aria-label="Speed">
          {speeds.map((x) => (
            <button key={x} type="button" role="radio" aria-checked={current === x && !clock.paused} className="seg__btn" disabled={busy} onClick={() => act('sim.speed', { x })}>
              {speedLabel(x)}
            </button>
          ))}
        </div>
        {mode === 'construction' && (
          <>
            <button type="button" className="btn btn--ghost time-dial__skip" onClick={() => act('sim.skipShift')} disabled={busy || !clock.onShift}>
              Skip to end of shift
            </button>
            <button type="button" className="btn btn--ghost time-dial__skip" onClick={askFinish} disabled={busy || done}>
              Skip to end of build
            </button>
          </>
        )}
      </div>
      {confirming && (
        <div className="ff-confirm" role="alertdialog" aria-label="Before skipping to the end">
          <p className="ff-confirm__title">These manual changes could stall the skip or skew the result:</p>
          <ul>
            {manualChanges.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="button-row">
            <button type="button" className="btn btn--primary" onClick={() => finish(true)}>Reset them and skip</button>
            <button type="button" className="btn btn--ghost" onClick={() => finish(false)}>Skip as is</button>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}
      {mode === 'construction' && lf && dismissed !== lf.text && (
        <p className={`ff-result ff-result--${lf.reason}`}>
          {lf.reason === 'complete' ? 'Build complete. ' : lf.reason === 'stalled' ? 'Skip stopped: stalled. ' : lf.reason === 'cancelled' ? 'Skip cancelled. ' : 'Skip stopped. '}
          {lf.text}
          <button type="button" className="icon-btn ff-result__x" onClick={() => setDismissed(lf.text)} aria-label="Dismiss">×</button>
        </p>
      )}
      {mode === 'construction' && (
        <label className="time-dial__opt">
          <input type="checkbox" checked={clock.pauseAtDayEnd} onChange={() => act('sim.pauseAtDayEnd', { on: !clock.pauseAtDayEnd })} />
          Pause at the end of each day
        </label>
      )}
      {mode === 'construction' && clock.effectiveSpeed > clock.packetsMaxSpeed && <p className="time-dial__note">Packets are shown at {speedLabel(clock.packetsMaxSpeed)} or slower.</p>}
      {mode === 'construction' && clock.speed === 1 && !clock.paused && !busy && <p className="time-dial__note">1× is real time: a pile takes 2 minutes. Speed up to watch the build.</p>}
    </div>
  )
}
