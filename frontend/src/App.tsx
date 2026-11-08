import { useCallback, useMemo, useState } from 'react'
import './App.css'
import { SurveyView } from './components/SurveyView'
import { BuildupView } from './components/BuildupView'
import { ConstructionView } from './components/ConstructionView'
import { edge, STAGE_ORDER, useEdge } from './edge/client'
import type { Stage } from './edge/client'
import { buildRegion, renderHeatmap } from './survey/heatmap'

/**
 * The twin moves through three stages, all run by the edge service:
 *   survey       drones build the terrain model from scratch
 *   buildup      the planner lays out the units the build manager asked for and sizes the fleet
 *   construction the approved plan is built live, from bare ground
 * The UI follows the site forward and lets the manager look back at earlier stages.
 */
export default function App() {
  const st = useEdge()
  // The manager can look back at an earlier stage; when the site moves to a new stage, the view follows it.
  const [choice, setChoice] = useState<{ view: Stage; at: Stage }>()
  const view = choice && choice.at === st.stage ? choice.view : st.stage

  const goTo = useCallback((s: Stage) => {
    const at = edge.getState().stage
    if (STAGE_ORDER.indexOf(s) <= STAGE_ORDER.indexOf(at)) setChoice({ view: s, at })
  }, [])

  // Shaded terrain from the survey, drawn under the plan and the construction site.
  const s = st.survey
  const terrainImage = useMemo(() => {
    if (!s || !st.terrain) return undefined
    const region = buildRegion(s, edge.heights)
    if (!region) return undefined
    const { cellM } = st.terrain
    return { href: renderHeatmap(region, edge.coverage, st.terrain.cols), x: region.c0 * cellM, y: region.r0 * cellM, w: region.w * cellM, h: region.h * cellM }
  }, [st.coverageVersion, s?.perimeter.length, st.terrain]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!st.ready || !s) return <Connecting url={st.url} connection={st.connection} />

  const banner = st.connection !== 'open' && <div className="conn-banner" role="status">Lost the connection to the edge service. Reconnecting…</div>
  const common = { chat: st.chat, agent: st.agent, onStage: goTo, siteStage: st.stage }

  if (view === 'construction' && st.twin) {
    return (
      <>
        {banner}
        <ConstructionView snapshot={st.twin} terrainImage={terrainImage} coverageM={st.network.assetRangeM} {...common} />
      </>
    )
  }
  if (view === 'buildup' || (view === 'construction' && !st.twin)) {
    return (
      <>
        {banner}
        <BuildupView survey={s} plan={st.plan} preview={st.preview} terrainImage={terrainImage} coverageM={st.network.assetRangeM} {...common} />
      </>
    )
  }
  return (
    <>
      {banner}
      <SurveyView snapshot={s} {...common} />
    </>
  )
}

function Connecting({ url, connection }: { url: string; connection: string }) {
  return (
    <div className="connecting">
      <div className="connecting__card">
        <h1>Site Twin</h1>
        <p>{connection === 'closed' ? 'Waiting for the edge service…' : 'Connecting to the edge service…'}</p>
        <p className="hint">
          Looking for it at <code>{url}</code>. Start it from <code>frontend/</code> with <code>npm run edge</code>, or run <code>npm run app:dev</code> to start everything.
        </p>
      </div>
    </div>
  )
}
