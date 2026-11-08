// Plain-language labels for survey phases.

import type { SurveySnapshot } from './types'

export function phaseLabel(p: SurveySnapshot['phase']) {
  return {
    idle: 'Not started',
    scouting: 'Scouting the boundary',
    surveying: 'Mapping sections',
    review: 'Pass complete',
    locked: 'Survey locked for buildup',
  }[p]
}
