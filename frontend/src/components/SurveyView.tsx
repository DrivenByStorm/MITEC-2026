import { useCallback, useEffect, useState } from 'react'
import { SurveyMap } from './SurveyMap'
import { SurveyPanel } from './SurveyPanel'
import { CommandConsole } from './CommandConsole'
import type { Message } from './CommandConsole'
import { Topbar } from './Topbar'
import type { Stage } from './Topbar'
import { getSurveySource, useSurvey } from '../survey/source'
import { phaseLabel, runSurveyCommand, surveyExamples } from '../survey/commands'

const source = getSurveySource()

interface Props {
  stage: 'survey' | 'buildup'
  onStage: (s: Stage) => void
  messages: Message[]
  addMessages: (m: Omit<Message, 'id'>[]) => void
}

/** Survey stage: drones build the terrain model of a new site from scratch. */
export function SurveyView({ stage, onStage, messages, addMessages }: Props) {
  const s = useSurvey(source)
  const [expanded, setExpanded] = useState(false)
  const [selectedDrone, setSelectedDrone] = useState<string>()

  const handleCommand = useCallback(
    (text: string) => {
      const lower = text.toLowerCase()
      if (/construction demo/.test(lower)) {
        addMessages([{ from: 'you', text, at: Date.now() }])
        onStage('construction')
        return
      }
      const result = runSurveyCommand(text, source.getSnapshot(), source)
      const now = Date.now()
      addMessages([
        { from: 'you', text, at: now },
        { from: 'site', text: result.reply, at: now },
      ])
      if (result.selectDrone) setSelectedDrone(result.selectDrone)
      if (source.getSnapshot().phase === 'locked' && stage === 'survey' && /buildup|lock|finish/.test(lower)) onStage('buildup')
    },
    [addMessages, onStage, stage],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const flying = s.drones.filter((d) => d.status !== 'docked' && d.status !== 'swapping').length
  const title = s.phase === 'idle' ? 'New site, Pecos County TX' : `New site survey, Pecos County TX`

  return (
    <div className={`app ${expanded ? 'app--expanded' : ''}`}>
      <Topbar
        title={title}
        stage={stage}
        surveyLocked={s.phase === 'locked'}
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
            source={source}
            expanded={expanded}
            hideStatus={expanded || stage === 'buildup'}
            selectedDrone={selectedDrone}
            onSelectDrone={setSelectedDrone}
            onSectionClick={(id) => handleCommand(`survey ${id}`)}
            onStart={(m) => handleCommand(`start survey ${m} m`)}
            onLock={() => handleCommand('move to buildup')}
            onOpenConstruction={() => onStage('construction')}
          />
          {s.phase !== 'idle' && (
            <button type="button" className="btn btn--expand" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
              {expanded ? 'Collapse twin' : 'Expand twin'}
            </button>
          )}
          {stage === 'buildup' && (
            <div className="stage-card" role="dialog" aria-labelledby="buildup-title">
              <h2 id="buildup-title" className="start-card__title">Buildup planning</h2>
              <p className="start-card__text">
                The terrain model is ready: {s.stats.mappedAreaKm2.toFixed(2)} km² mapped
                {s.stats.minM !== undefined ? ` with ${(s.stats.maxM! - s.stats.minM).toFixed(0)} m of relief` : ''}. The buildup algorithm
                will use it to lay out P3 units, roads and trenches. That's the next piece to design.
              </p>
              <div className="button-row">
                <button type="button" className="btn" onClick={() => onStage('survey')}>Back to survey map</button>
                <button type="button" className="btn btn--primary" onClick={() => onStage('construction')}>Open construction demo</button>
              </div>
            </div>
          )}
        </div>
        {expanded && <SurveyPanel snapshot={s} selectedDrone={selectedDrone} onSelectDrone={setSelectedDrone} onCommand={handleCommand} />}
      </main>
      <CommandConsole
        messages={messages}
        onSubmit={handleCommand}
        compact={expanded}
        examples={surveyExamples(s)}
        intro='Build the site model by starting a survey. Set the distance on the map, or type a command:'
      />
    </div>
  )
}
