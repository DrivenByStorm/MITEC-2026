import type { Act } from '../edge/client'
import type { SiteClock } from '../twin/types'
import { speedLabel } from '../twin/siteTime'

/**
 * Speed dial for the simulation. In construction it also shows the site day and time, and can
 * skip to the end of the shift or pause when each day ends.
 */
export function TimeDial({ clock, mode, act }: { clock: SiteClock; mode: 'survey' | 'construction'; act: Act }) {
  const speeds = mode === 'survey' ? clock.surveySpeeds : clock.speeds
  const current = mode === 'survey' ? Math.min(clock.speed, Math.max(...clock.surveySpeeds)) : clock.speed
  const left = clock.shiftLeftMin
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
          disabled={clock.skipping}
        >
          {clock.paused ? '▶' : '❚❚'}
        </button>
        <div className="seg seg--dial" role="radiogroup" aria-label="Speed">
          {speeds.map((x) => (
            <button key={x} type="button" role="radio" aria-checked={current === x && !clock.paused} className="seg__btn" disabled={clock.skipping} onClick={() => act('sim.speed', { x })}>
              {speedLabel(x)}
            </button>
          ))}
        </div>
        {mode === 'construction' && (
          <button type="button" className="btn btn--ghost time-dial__skip" onClick={() => act('sim.skipShift')} disabled={clock.skipping || !clock.onShift}>
            Skip to end of shift
          </button>
        )}
      </div>
      {mode === 'construction' && (
        <label className="time-dial__opt">
          <input type="checkbox" checked={clock.pauseAtDayEnd} onChange={() => act('sim.pauseAtDayEnd', { on: !clock.pauseAtDayEnd })} />
          Pause at the end of each day
        </label>
      )}
      {mode === 'construction' && clock.effectiveSpeed > clock.packetsMaxSpeed && <p className="time-dial__note">Packets are shown at {speedLabel(clock.packetsMaxSpeed)} or slower.</p>}
      {mode === 'construction' && clock.speed === 1 && !clock.paused && <p className="time-dial__note">1× is real time: a pile takes 2 minutes. Speed up to watch the build.</p>}
    </div>
  )
}
