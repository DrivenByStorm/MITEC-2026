import { useState } from 'react'
import type { Schedule, SiteClock } from '../twin/types'

// Validated with the dataviz palette script (light and dark): CVD ΔE 17.3, contrast ≥ 3:1.
const COLORS = { piled: '#0b8fa0', set: '#e2580b' } as const
type Series = keyof typeof COLORS
const LABEL: Record<Series, string> = { piled: 'Piled', set: 'Set' }

/** Day-by-day progress: plan vs actual chart, a table of days, and each finished day's summary. */
export function DaysTab({ schedule: s, clock }: { schedule: Schedule; clock?: SiteClock }) {
  const today = s.days[s.days.length - 1]
  const exp = today?.expected
  const behind = today && exp ? today.total.set - exp.set : 0
  return (
    <div className="days">
      <section>
        <h3 className="section-title">Day {today?.day ?? 1} of about {Math.ceil(s.planDays)} planned</h3>
        {today && (
          <p className="days__headline">
            <span className="big-figure">{today.total.set}</span> <span className="big-figure__of">of {s.units} units set</span>
            {exp && <span className={`days__delta ${behind < 0 ? 'is-behind' : ''}`}>{behind >= 0 ? `${behind} ahead of` : `${-behind} behind`} the plan's {exp.set} by end of today</span>}
          </p>
        )}
        <ProgressChart s={s} clock={clock} />
      </section>
      <section>
        <h3 className="section-title">By day</h3>
        <table className="table table--days">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Staked</th>
              <th scope="col">Piled</th>
              <th scope="col">Set</th>
              <th scope="col" title="Units set in total vs what the plan expects by the end of that day">Set vs plan</th>
              <th scope="col">Rounds</th>
            </tr>
          </thead>
          <tbody>
            {[...s.days].reverse().map((d) => {
              const gap = d.total.set - d.expected.set
              return (
                <tr key={d.day} className={d.live ? 'is-live' : ''}>
                  <th scope="row">{d.day}{d.live && <span className="days__live">today</span>}</th>
                  <td>{d.did.staked}</td>
                  <td>{d.did.piled}</td>
                  <td>{d.did.set}</td>
                  <td className={gap < 0 ? 'text-alert' : ''}>{d.total.set}/{d.expected.set}</td>
                  <td>
                    {d.rounds}
                    {d.roundsStalled > 0 && <span className="tstate tstate--stalled">{d.roundsStalled} stalled</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
      {s.days.some((d) => d.summary) && (
        <section>
          <h3 className="section-title">Daily log</h3>
          <ol className="day-log" reversed>
            {[...s.days].reverse().filter((d) => d.summary).map((d) => (
              <li key={d.day}>
                <strong>Day {d.day}.</strong> {d.summary}
              </li>
            ))}
          </ol>
        </section>
      )}
      {s.complete && <p className="hint">All units are set.</p>}
    </div>
  )
}

function ProgressChart({ s, clock }: { s: Schedule; clock?: SiteClock }) {
  const [hover, setHover] = useState<number>()
  const W = 400
  const H = 190
  const pad = { l: 36, r: 40, t: 10, b: 24 }
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const today = s.days[s.days.length - 1]
  const maxDay = Math.max(s.curve.length, s.days.length, 1)
  const x = (d: number) => pad.l + (d / maxDay) * iw
  const y = (v: number) => pad.t + ih - (v / Math.max(1, s.units)) * ih

  // Fraction of today's shift done, so the live point sits mid-day.
  const frac = clock && today?.live ? shiftFraction(clock) : 1
  const actual = (k: Series) => {
    const pts = [[0, 0], ...s.days.map((d) => [d.live ? d.day - 1 + frac : d.day, d.total[k]])]
    return pts
  }
  const plan = (k: Series) => [[0, 0], ...s.curve.map((c) => [c.day, c[k]])]
  const path = (pts: number[][]) => pts.map(([d, v], i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)} ${y(v).toFixed(1)}`).join('')
  const yTicks = niceTicks(s.units)
  const xTicks = Array.from({ length: maxDay + 1 }, (_, i) => i).filter((i) => maxDay <= 12 || i % Math.ceil(maxDay / 10) === 0)

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const d = Math.round(((e.clientX - r.left) / r.width) * maxDay)
    setHover(Math.max(1, Math.min(maxDay, d)))
  }
  const hv = hover !== undefined ? { day: hover, act: s.days.find((d) => d.day === hover), plan: s.curve[hover - 1] } : undefined

  return (
    <figure className="days-chart">
      <ul className="days-chart__legend" aria-label="Legend">
        {(Object.keys(COLORS) as Series[]).map((k) => (
          <li key={k}>
            <svg width="18" height="8" aria-hidden="true"><line x1="1" y1="4" x2="17" y2="4" stroke={COLORS[k]} strokeWidth="2" strokeLinecap="round" /></svg>
            {LABEL[k]}
          </li>
        ))}
        <li className="days-chart__key-style">
          <svg width="18" height="8" aria-hidden="true"><line x1="1" y1="4" x2="17" y2="4" stroke="currentColor" strokeWidth="2" /></svg>actual
          <svg width="18" height="8" aria-hidden="true"><line x1="1" y1="4" x2="17" y2="4" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" /></svg>plan
        </li>
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} className="days-chart__svg" role="img" aria-label={`Cumulative units piled and set by day, actual against plan. Today: ${today?.total.piled ?? 0} piled, ${today?.total.set ?? 0} set of ${s.units}.`}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="days-chart__grid" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="days-chart__tick">{v}</text>
          </g>
        ))}
        {xTicks.map((d) => (
          <text key={d} x={x(d)} y={H - 6} textAnchor="middle" className="days-chart__tick">{d}</text>
        ))}
        {(Object.keys(COLORS) as Series[]).map((k) => (
          <path key={`p-${k}`} d={path(plan(k))} fill="none" stroke={COLORS[k]} strokeWidth="2" strokeDasharray="4 3" strokeOpacity="0.7" strokeLinejoin="round" />
        ))}
        {(Object.keys(COLORS) as Series[]).map((k) => {
          const pts = actual(k)
          const [ld, lv] = pts[pts.length - 1]
          return (
            <g key={`a-${k}`}>
              <path d={path(pts)} fill="none" stroke={COLORS[k]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={x(ld)} cy={y(lv)} r="4" fill={COLORS[k]} stroke="var(--paper)" strokeWidth="2" />
              <text x={x(ld) + 7} y={y(lv) + 4} className="days-chart__end">{lv}</text>
            </g>
          )
        })}
        {hv && <line x1={x(hv.day)} x2={x(hv.day)} y1={pad.t} y2={pad.t + ih} className="days-chart__cross" />}
        <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(undefined)} />
      </svg>
      {hv && (
        <div className="days-chart__tip" style={{ left: `${(x(hv.day) / W) * 100}%` }} role="status">
          <div className="days-chart__tip-day">Day {hv.day}{hv.act?.live ? ' (so far)' : ''}</div>
          {(Object.keys(COLORS) as Series[]).map((k) => (
            <div key={k} className="days-chart__tip-row">
              <svg width="12" height="6" aria-hidden="true"><line x1="0" y1="3" x2="12" y2="3" stroke={COLORS[k]} strokeWidth="2" /></svg>
              <strong>{hv.act ? hv.act.total[k] : '–'}</strong>
              <span>{LABEL[k].toLowerCase()}, plan {hv.plan ? hv.plan[k] : s.units}</span>
            </div>
          ))}
        </div>
      )}
      <figcaption className="hint">Cumulative units. The plan's pace comes from the planner's stage durations; actual counts are what the twin has heard.</figcaption>
    </figure>
  )
}

function shiftFraction(c: SiteClock) {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }
  const start = toMin(c.shiftStart)
  const end = toMin(c.shiftEnd)
  const now = toMin(c.time)
  return Math.max(0, Math.min(1, (now - start) / Math.max(1, end - start)))
}

function niceTicks(max: number) {
  const step = [10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => max / s <= 5) ?? Math.ceil(max / 5)
  const out = []
  for (let v = 0; v <= max; v += step) out.push(v)
  return out
}
