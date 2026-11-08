import { useEffect, useMemo, useState } from 'react'
import { SiteMap } from './SiteMap'
import { CommandConsole } from './CommandConsole'
import { Topbar } from './Topbar'
import type { Stage } from './Topbar'
import { PlanPanel } from './PlanPanel'
import { groundOverlay } from '../buildup/overlay'
import type { SitePlan } from '../buildup/types'
import type { SurveySnapshot } from '../survey/types'
import type { TwinSnapshot } from '../twin/types'
import { edge } from '../edge/client'
import type { AgentState, ChatMessage } from '../edge/client'

interface Props {
  survey: SurveySnapshot
  plan: SitePlan | null
  /** The plan drawn as a site snapshot (units as planned footprints, relays live), from the edge service. */
  preview: TwinSnapshot | null
  terrainImage?: TwinSnapshot['terrainImage']
  coverageM: number
  chat: ChatMessage[]
  agent: AgentState
  siteStage: Stage
  onStage: (s: Stage) => void
}

/** Buildup planning: the build manager sets units and crew; the planner on the edge service lays out the site and sizes everything else. */
export function BuildupView({ survey: s, plan, preview, terrainImage, coverageM, chat, agent, siteStage, onStage }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [units, setUnits] = useState(plan?.input.unitCount ?? 240)
  const [crew, setCrew] = useState(plan?.input.crewSize ?? 30)
  const [showGround, setShowGround] = useState(true)
  const [busy, setBusy] = useState(false)
  const approved = siteStage === 'construction'

  // A plan can also come from the agent (an approved suggestion); keep the inputs in step with it.
  const [seenPlan, setSeenPlan] = useState(plan?.createdAt)
  if (plan && plan.createdAt !== seenPlan) {
    setSeenPlan(plan.createdAt)
    setUnits(plan.input.unitCount)
    setCrew(plan.input.crewSize)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const snapshot: TwinSnapshot = useMemo(
    () => (preview ? { ...preview, terrainImage } : blankPreview(s, terrainImage)),
    [preview, s.perimeter.length, terrainImage], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const overlay = useMemo(() => (plan ? groundOverlay(plan) : null), [plan])

  return (
    <div className={`app ${expanded ? 'app--expanded' : ''}`}>
      <Topbar
        title="New site, Pecos County TX"
        stage="buildup"
        surveyLocked
        constructionReady={approved}
        onStage={onStage}
        status={[
          { label: approved ? 'Plan approved' : plan ? 'Plan ready for approval' : 'No plan yet', tone: plan ? 'ok' : 'idle' },
          { label: `${Math.round(s.stats.coverage * 100)}% of site surveyed`, tone: 'plain' },
          { label: s.terrain.real ? 'Real terrain' : 'Synthetic terrain', tone: s.terrain.real ? 'ok' : 'idle' },
        ]}
      />
      <main className="workspace">
        <div className="map-wrap">
          <SiteMap
            key={plan ? `${plan.createdAt}` : 'blank'}
            snapshot={snapshot}
            onSelect={() => {}}
            expanded={expanded}
            coverageM={coverageM}
            underlay={
              overlay && showGround ? (
                <image href={overlay.href} x={overlay.x} y={overlay.y} width={overlay.w} height={overlay.h} preserveAspectRatio="none" style={{ imageRendering: 'pixelated' }} />
              ) : null
            }
          >
            <PlanCard
              plan={plan}
              units={units}
              crew={crew}
              setUnits={setUnits}
              setCrew={setCrew}
              busy={busy}
              approved={approved}
              onGenerate={() => run(() => edge.act('plan.generate', { unitCount: units, crewSize: crew }))}
              onApprove={() => run(() => edge.act('plan.approve'))}
              onDetails={() => setExpanded(true)}
              expanded={expanded}
              showGround={showGround}
              setShowGround={setShowGround}
            />
          </SiteMap>
          {plan && (
            <button type="button" className="btn btn--expand" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
              {expanded ? 'Hide plan details' : 'Plan details'}
            </button>
          )}
        </div>
        {expanded && plan && <PlanPanel plan={plan} />}
      </main>
      <CommandConsole
        messages={chat}
        agent={agent}
        onSubmit={edge.chat}
        onDecide={edge.decide}
        compact={expanded}
        examples={buildupExamples(plan)}
        intro="Set the P3 units and crew on the map, or tell the site agent. The planner decides the layout, relays, robots, machines and crew; the agent can explain any of it."
      />
    </div>
  )
}

function buildupExamples(plan: SitePlan | null): string[] {
  if (!plan) return ['Plan 240 units with 30 people', 'How many units fit on this site?', 'What crew do I need for 400 units?']
  return ['Why this many relays?', 'What is the bottleneck?', `What if I had ${plan.input.crewSize + 10} people?`, 'Approve the plan']
}

function PlanCard({
  plan, units, crew, setUnits, setCrew, busy, approved, onGenerate, onApprove, onDetails, expanded, showGround, setShowGround,
}: {
  plan: SitePlan | null
  units: number
  crew: number
  setUnits: (n: number) => void
  setCrew: (n: number) => void
  busy: boolean
  approved: boolean
  onGenerate: () => void
  onApprove: () => void
  onDetails: () => void
  expanded: boolean
  showGround: boolean
  setShowGround: (v: boolean) => void
}) {
  const changed = plan && (plan.input.unitCount !== units || plan.input.crewSize !== crew)
  const f = (k: string) => plan?.fleet.find((x) => x.key === k)?.count ?? 0
  return (
    <form
      className={`plan-card ${expanded ? 'plan-card--compact' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        onGenerate()
      }}
    >
      <h2 className="start-card__title">Plan the buildup</h2>
      {!plan && <p className="start-card__text">You set how many P3 units to build and the crew you have. The planner places them on flat surveyed ground and decides the relays, robots, machines and crew.</p>}
      <div className="plan-card__inputs">
        <label>
          <span>P3 units to build</span>
          <input type="number" min={1} max={5000} value={units} onChange={(e) => setUnits(Number(e.target.value))} />
        </label>
        <label>
          <span>Crew available</span>
          <input type="number" min={1} max={400} value={crew} onChange={(e) => setCrew(Number(e.target.value))} />
        </label>
      </div>
      <button type="submit" className={`btn ${plan && !changed ? '' : 'btn--primary'}`} disabled={busy || approved}>{plan ? (changed ? 'Update plan' : 'Re-plan') : 'Generate plan'}</button>

      {plan && (
        <div className="plan-card__result">
          <p className="plan-card__headline">
            {plan.units.length} units in {plan.blocks.length} block{plan.blocks.length === 1 ? '' : 's'}, about <strong>{plan.totalDays} working days</strong>
          </p>
          <ul className="plan-card__fleet">
            <li><strong>{f('pile')}</strong> pile-driving robot{f('pile') === 1 ? '' : 's'}</li>
            <li><strong>{f('crane')}</strong> crane{f('crane') === 1 ? '' : 's'}</li>
            <li><strong>{f('telehandler')}</strong> telehandler{f('telehandler') === 1 ? '' : 's'}</li>
            <li><strong>{f('trencher')}</strong> trencher{f('trencher') === 1 ? '' : 's'}</li>
            <li><strong>{f('relay')}</strong> relay masts</li>
            <li><strong>{f('anchor')}</strong> UWB anchors</li>
            <li><strong>{plan.crewUsed}</strong> people</li>
          </ul>
          <div className="button-row">
            <button type="button" className="btn btn--primary" onClick={onApprove} disabled={!!changed || busy || approved}>{approved ? 'Approved' : 'Approve and build'}</button>
            {!expanded && <button type="button" className="btn" onClick={onDetails}>Details</button>}
          </div>
          {changed && <p className="hint">Inputs changed. Update the plan before approving.</p>}
          <p className="hint">Slowest stage: {plan.bottleneck.toLowerCase()}.</p>
          {plan.warnings.map((w) => (
            <p key={w} className="plan-card__warn">{w}</p>
          ))}
          <label className="plan-card__toggle">
            <input type="checkbox" checked={showGround} onChange={() => setShowGround(!showGround)} />
            Show ground units can't use (red: too steep; grey: setback, office, yard)
          </label>
        </div>
      )}
    </form>
  )
}

function blankPreview(s: SurveySnapshot, terrainImage: TwinSnapshot['terrainImage']): TwinSnapshot {
  const [nw, , se] = s.perimeter.length ? s.perimeter : [{ x: s.launch.x - 500, y: s.launch.y - 500 }, null, { x: s.launch.x + 500, y: s.launch.y + 500 }]
  const pad = 80
  const now = s.now
  const office = { x: s.launch.x - 70, y: s.launch.y - 60, w: 140, h: 120 }
  return {
    now,
    siteName: 'New site',
    site: { w: s.terrain.cols * s.terrain.cellM, h: s.terrain.rows * s.terrain.cellM },
    view: { x: nw!.x - pad, y: nw!.y - pad, w: se!.x - nw!.x + 2 * pad, h: se!.y - nw!.y + 2 * pad },
    office,
    laydown: { x: s.launch.x + 85, y: s.launch.y - 80, w: 190, h: 160 },
    terrainImage,
    blocks: [],
    units: [],
    assets: [{ id: 'GW', name: 'Gateway', kind: 'relay', role: 'Gateway (wired to edge server)', x: office.x + 20, y: office.y + 20, heading: 0, mode: 'autonomous', task: 'Planned', energy: 100, lastHeard: now, link: 'mesh' }],
    links: [],
    edgeServer: { x: office.x + office.w - 30, y: office.y + 45, online: true },
    rtkBase: { x: office.x + office.w - 30, y: office.y + office.h - 30, online: true },
    uplink: { online: true, lastSync: now },
    events: [],
    requests: [],
  }
}
