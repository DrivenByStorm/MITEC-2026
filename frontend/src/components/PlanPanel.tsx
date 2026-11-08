import { useState } from 'react'
import type { SitePlan } from '../buildup/types'

const TABS = ['Fleet', 'Crew', 'Schedule', 'Network', 'Assumptions'] as const
type Tab = (typeof TABS)[number]

/** Everything the planner decided, with the reason for each quantity. */
export function PlanPanel({ plan }: { plan: SitePlan }) {
  const [tab, setTab] = useState<Tab>('Fleet')
  const A = plan.assumptions
  return (
    <aside className="panel" aria-label="Plan details">
      <div className="tabs" role="tablist" aria-label="Plan views">
        {TABS.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="panel__body" role="tabpanel">
        {tab === 'Fleet' && (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Qty</th>
                <th scope="col">Why this many</th>
              </tr>
            </thead>
            <tbody>
              {plan.fleet.map((f) => (
                <tr key={f.key}>
                  <th scope="row">{f.name}</th>
                  <td className="num">{f.count}</td>
                  <td>{f.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'Crew' && (
          <>
            <p className="hint">
              {plan.crewUsed} of {plan.input.crewSize} people available.
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">People</th>
                  <th scope="col">Works on</th>
                </tr>
              </thead>
              <tbody>
                {plan.crew.map((c) => (
                  <tr key={c.role}>
                    <th scope="row">{c.role}</th>
                    <td className="num">{c.count}</td>
                    <td>{c.with}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {tab === 'Schedule' && (
          <div className="schedule">
            <p className="big-figure">
              {plan.totalDays} <span className="big-figure__of">working days (10 h shifts)</span>
            </p>
            <p className="hint">Stages run in parallel, block by block. The slowest one sets the pace; the planner added crews to it until people ran out or another crew stopped helping.</p>
            <ul className="stage-bars">
              {plan.stages.map((s) => {
                const max = Math.max(...plan.stages.map((x) => x.days)) || 1
                return (
                  <li key={s.stage} className={s.stage === plan.bottleneck ? 'is-bottleneck' : ''}>
                    <span className="stage-bars__name">{s.stage}</span>
                    <span className="stage-bars__bar">
                      <span style={{ width: `${(s.days / max) * 100}%` }} />
                    </span>
                    <span className="stage-bars__days">{s.days.toFixed(1)} d</span>
                    <span className="stage-bars__detail">{s.detail}</span>
                  </li>
                )
              })}
            </ul>
            <p className="hint">
              {(plan.trenchM / 1000).toFixed(1)} km of cable trench; average haul from the laydown yard {Math.round(plan.meanHaulM)} m.
            </p>
          </div>
        )}

        {tab === 'Network' && (
          <>
            <p className="hint">
              Each unit is within 300 m of at least two relays or gateways, so one mast failing never cuts a work area off. Masts marked "link"
              only carry traffic back to a gateway. Two gateways on the office are wired to the hub. Every mast carries a UWB anchor, and
              {` ${plan.anchors?.length ?? 0} `}anchor posts fill the gaps so crew badges always have three anchors in range.
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Relay</th>
                  <th scope="col">Units in reach</th>
                  <th scope="col">Role</th>
                </tr>
              </thead>
              <tbody>
                {plan.relays.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">{r.id}</th>
                    <td className="num">{r.covers}</td>
                    <td>{r.linkOnly ? 'Link to gateway' : 'Coverage'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {tab === 'Assumptions' && (
          <>
            <p className="hint">The planner's rates and limits. Values Built Robotics publishes are used where available; the rest are estimates to confirm with Exowatt. Change them in services/edge/edge/buildup/assumptions.py.</p>
            <dl className="assumptions">
              <dt>Piles per P3 unit</dt>
              <dd>{A.pilesPerUnit} (estimate)</dd>
              <dt>Pile-driving robot</dt>
              <dd>{A.pileRobotPilesPerDay} piles/day, {A.pileRobotCrew}-person crew (Built Robotics RPD 35)</dd>
              <dt>Crane</dt>
              <dd>{A.craneUnitsPerDay} units/day, crew of {A.craneCrew} (estimate)</dd>
              <dt>Telehandler</dt>
              <dd>{A.telehandlerSpeedKmh} km/h, {A.telehandlerLoadMin + A.telehandlerHandoffMin} min to load and hand off (estimate)</dd>
              <dt>Trencher</dt>
              <dd>{A.trencherMPerDay} m/day, crew of {A.trencherCrew} (estimate)</dd>
              <dt>Electrical crew</dt>
              <dd>{A.electricalUnitsPerDay} units/day, {A.electricalCrew} electricians (estimate)</dd>
              <dt>Supervision</dt>
              <dd>1 foreman per {A.workersPerForeman}, 1 safety lead per {A.workersPerSafetyLead}</dd>
              <dt>Buildable ground</dt>
              <dd>Mapped, slope ≤ {A.maxSlopePct}%, ≤ {A.maxFootprintReliefM} m relief under a unit, {A.boundarySetbackM} m from the boundary</dd>
              <dt>Layout</dt>
              <dd>{A.slotSpacingM} m between units, {A.rowSpacingM} m between rows, blocks of {A.blockRows} × {A.blockSlots}</dd>
              <dt>Network</dt>
              <dd>Machine-to-relay 270 m, relay-to-relay 460 m, two relays covering every unit</dd>
            </dl>
          </>
        )}
      </div>
    </aside>
  )
}
