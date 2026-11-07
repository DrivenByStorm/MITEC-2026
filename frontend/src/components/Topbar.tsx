export type Stage = 'survey' | 'buildup' | 'construction'

interface Props {
  title: string
  stage: Stage
  surveyLocked: boolean
  onStage: (s: Stage) => void
  status: { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle' | 'plain' }[]
}

const STEPS: { id: Stage; label: string }[] = [
  { id: 'survey', label: 'Survey' },
  { id: 'buildup', label: 'Buildup plan' },
  { id: 'construction', label: 'Construction' },
]

export function Topbar({ title, stage, surveyLocked, onStage, status }: Props) {
  return (
    <header className="topbar">
      <div className="topbar__site">
        <h1 className="topbar__title">{title}</h1>
        <nav aria-label="Project stages">
          <ol className="stepper">
            {STEPS.map((s, i) => {
              const disabled = s.id === 'buildup' && !surveyLocked
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`stepper__step ${stage === s.id ? 'is-current' : ''}`}
                    aria-current={stage === s.id ? 'step' : undefined}
                    disabled={disabled}
                    title={disabled ? 'Lock the survey to start buildup planning' : s.id === 'construction' ? 'Demo of the construction stage' : undefined}
                    onClick={() => onStage(s.id)}
                  >
                    <span className="stepper__num">{i + 1}</span>
                    {s.label}
                    {s.id === 'construction' && <span className="stepper__tag">demo</span>}
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>
      </div>
      <ul className="topbar__status" aria-label="System status">
        {status.map((s) => (
          <li key={s.label} className={s.tone}>
            {s.label}
          </li>
        ))}
      </ul>
    </header>
  )
}
