import { useCallback, useRef, useState } from 'react'
import './App.css'
import { SurveyView } from './components/SurveyView'
import { BuildupView } from './components/BuildupView'
import { ConstructionView } from './components/ConstructionView'
import type { Stage } from './components/Topbar'
import type { Message } from './components/CommandConsole'
import { getSurveySource } from './survey/source'
import { startConstruction } from './twin/source'
import type { TwinSource } from './twin/source'
import type { SitePlan } from './buildup/types'

type Conversation = 'survey' | 'buildup' | 'construction'

const survey = getSurveySource()

/**
 * The twin moves through three stages:
 *   survey       drones build the terrain model from scratch
 *   buildup      the planner lays out the units the build manager asked for and sizes the fleet
 *   construction the approved plan is built live, from bare ground
 */
export default function App() {
  const [stage, setStage] = useState<Stage>('survey')
  const [plan, setPlan] = useState<SitePlan | null>(null)
  const [twin, setTwin] = useState<TwinSource | null>(null)
  const [messages, setMessages] = useState<Record<Conversation, Message[]>>({ survey: [], buildup: [], construction: [] })
  const seq = useRef(1)

  const add = useCallback((conv: Conversation, items: Omit<Message, 'id'>[]) => {
    setMessages((m) => ({ ...m, [conv]: [...m[conv], ...items.map((it) => ({ ...it, id: seq.current++ }))] }))
  }, [])
  const addSurvey = useCallback((items: Omit<Message, 'id'>[]) => add('survey', items), [add])
  const addBuildup = useCallback((items: Omit<Message, 'id'>[]) => add('buildup', items), [add])
  const addConstruction = useCallback((items: Omit<Message, 'id'>[]) => add('construction', items), [add])

  const approve = useCallback((p: SitePlan) => {
    setTwin(startConstruction(p))
    setMessages((m) => ({ ...m, construction: [] }))
    setStage('construction')
  }, [])

  const goTo = useCallback(
    (s: Stage) => {
      if (s === 'buildup' && survey.getSnapshot().phase !== 'locked') return
      if (s === 'construction' && !twin) return
      setStage(s)
    },
    [twin],
  )

  if (stage === 'construction' && twin) {
    return <ConstructionView source={twin} surveyLocked onStage={goTo} messages={messages.construction} addMessages={addConstruction} />
  }
  if (stage === 'buildup') {
    return (
      <BuildupView
        survey={survey}
        plan={plan}
        setPlan={setPlan}
        onApprove={approve}
        onStage={goTo}
        constructionReady={!!twin}
        messages={messages.buildup}
        addMessages={addBuildup}
      />
    )
  }
  return <SurveyView onStage={goTo} constructionReady={!!twin} messages={messages.survey} addMessages={addSurvey} />
}
