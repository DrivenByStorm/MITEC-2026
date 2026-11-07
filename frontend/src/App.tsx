import { useCallback, useRef, useState } from 'react'
import './App.css'
import { SurveyView } from './components/SurveyView'
import { ConstructionView } from './components/ConstructionView'
import type { Stage } from './components/Topbar'
import type { Message } from './components/CommandConsole'
import { getSurveySource } from './survey/source'

type Conversation = 'survey' | 'construction'

export default function App() {
  const [stage, setStage] = useState<Stage>('survey')
  const [messages, setMessages] = useState<Record<Conversation, Message[]>>({ survey: [], construction: [] })
  const seq = useRef(1)

  const add = useCallback((conv: Conversation, items: Omit<Message, 'id'>[]) => {
    setMessages((m) => ({ ...m, [conv]: [...m[conv], ...items.map((it) => ({ ...it, id: seq.current++ }))] }))
  }, [])
  const addSurvey = useCallback((items: Omit<Message, 'id'>[]) => add('survey', items), [add])
  const addConstruction = useCallback((items: Omit<Message, 'id'>[]) => add('construction', items), [add])

  if (stage === 'construction') {
    return (
      <ConstructionView
        surveyLocked={getSurveySource().getSnapshot().phase === 'locked'}
        onStage={setStage}
        messages={messages.construction}
        addMessages={addConstruction}
      />
    )
  }
  return <SurveyView stage={stage} onStage={setStage} messages={messages.survey} addMessages={addSurvey} />
}
