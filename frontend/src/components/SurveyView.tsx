import { useEffect, useState } from 'react'
import { SurveyMap } from './SurveyMap'
import { SurveyPanel } from './SurveyPanel'
import { CommandConsole } from './CommandConsole'
import { Topbar } from './Topbar'
import type { Stage } from './Topbar'
import type { SurveySnapshot } from '../survey/types'
import { phaseLabel } from '../survey/labels'
import { edge, useAgentSelection } from '../edge/client'
import type { AgentState, ChatMessage } from '../edge/client'

interface Props {
  snapshot: SurveySnapshot
  chat: ChatMessage[]
  agent: AgentState
  siteStage: Stage
  onStage: (s: Stage) => void
}

/** Survey stage: drones build the terrain model of a new site from scratch. */
export function SurveyView({ snapshot: s, chat, agent, siteStage, onStage }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [selectedDrone, setSelectedDrone] = useState<string>()
  useAgentSelection(chat, (id) => s.drones.some((d) => d.id === id) && setSelectedDrone(id))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const flying = s.drones.filter((d) => d.status !== 'docked' && d.status !== 'swapping').length
  const title = s.phase === 'idle' ? 'New site, Pecos County TX' : 'New site survey, Pecos County TX'

  return (
    <div className={`app ${expanded ? 'app--expanded' : ''}`}>
      <Topbar
        title={title}
        stage="survey"
        surveyLocked={siteStage !== 'survey'}
        constructionReady={siteStage === 'construction'}
        onStage={onStage}
        status={[
          { label: phaseLabel(s.phase), tone: s.phase === 'idle' ? 'idle' : s.phase === 'locked' ? 'ok' : 'warn' },
          { label: `${Math.round(s.stats.coverage * 100)}% mapped`, tone: 'plain' },
          { label: `${flying} of ${s.drones.length} drones flying`, tone: flying ? 'ok' : 'idle' },
          { label: s.terrain.real ? 'Real terrain' : 'Synthetic terrain', tone: s.terrain.real ? 'ok' : 'idle' },
        ]}
      />
      <main className="workspace">
        <div className="map-wrap">
          <SurveyMap
            snapshot={s}
            source={edge}
            expanded={expanded}
            hideStatus={expanded}
            selectedDrone={selectedDrone}
            onSelectDrone={setSelectedDrone}
            onSectionClick={(id) => void edge.act('survey.requestSections', { ids: [id] })}
            onStart={(m) => void edge.act('survey.start', { distanceM: m })}
            onLock={() => void edge.act('survey.lock')}
            onOpenBuildup={() => onStage('buildup')}
          />
          {s.phase !== 'idle' && (
            <button type="button" className="btn btn--expand" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
              {expanded ? 'Collapse twin' : 'Expand twin'}
            </button>
          )}
        </div>
        {expanded && <SurveyPanel snapshot={s} selectedDrone={selectedDrone} onSelectDrone={setSelectedDrone} act={edge.act} />}
      </main>
      <CommandConsole
        messages={chat}
        agent={agent}
        onSubmit={edge.chat}
        onDecide={edge.decide}
        compact={expanded}
        examples={surveyExamples(s)}
        intro="Start a survey from the map, or ask the site agent. It watches the drones and suggests what to do next; you approve each step."
      />
    </div>
  )
}

function surveyExamples(s: SurveySnapshot): string[] {
  if (s.phase === 'idle') return ['Start a 1.5 km survey', 'How big an area should I survey for 300 units?', 'What happens during the survey?']
  if (s.phase === 'scouting' || s.phase === 'surveying') return ['How is the survey going?', 'Where is SC-1?', 'Which drone has the lowest battery?']
  if (s.phase === 'review') return ['What should I map next?', 'Is there enough flat ground yet?', 'Lock the survey and move to buildup']
  return ['Summarize the survey']
}
