// Text-box commands for the survey stage. Rule-based so it works offline.

import type { SurveySnapshot } from './types'
import type { SurveySource } from './source'

export interface SurveyCommandResult {
  reply: string
  selectDrone?: string
  focus?: { x: number; y: number }
}

export function surveyExamples(s: SurveySnapshot): string[] {
  if (s.phase === 'idle') return ['start survey 1000 m', 'start survey 1.5 km', 'help']
  if (s.phase === 'scouting') return ['status', 'where is SC-1', 'recall drones']
  if (s.phase === 'surveying') return ['status', 'where is SV-2', 'recall drones']
  if (s.phase === 'review') return ['map more', s.suggestions[0] ? `survey ${s.suggestions[0]}` : 'status', 'move to buildup']
  return ['status']
}

const HELP = [
  'Survey commands:',
  '• start survey <distance> — e.g. "start survey 1200 m" or "start survey 1.5 km"',
  '• status — progress, coverage and elevation so far',
  '• map more — send drones to the best suggested gaps',
  '• survey <section> — map specific sections, e.g. "survey B1 C4"',
  '• where is <drone> — find SC-1 (scout) or SV-1 to SV-4',
  '• recall drones — bring every drone back to the launch point',
  '• move to buildup — lock the survey and hand the terrain to buildup planning',
].join('\n')

export function runSurveyCommand(input: string, s: SurveySnapshot, source: SurveySource): SurveyCommandResult {
  const text = input.trim()
  const lower = text.toLowerCase()

  if (/^(help|\?|what can you do)/.test(lower)) return { reply: HELP }

  const start = lower.match(/^(?:start|begin|launch|run)(?: the)?(?: site)? survey(?:\s+(?:to|at|out to|of|with)?\s*([\d.]+)\s*(km|kilometers?|m|meters?)?)?/)
  if (start || /^(build|create|start)( the)? (digital twin|twin|model)/.test(lower)) {
    let m: number | undefined
    if (start?.[1]) m = Number(start[1]) * (start[2]?.startsWith('k') ? 1000 : 1)
    if (m !== undefined && (m < 300 || m > s.maxDistanceM)) {
      return { reply: `Pick a distance between 300 m and ${s.maxDistanceM} m; that's how far the available terrain extends from the launch point.` }
    }
    return { reply: source.startSurvey(m), focus: s.launch }
  }

  if (/^(status|progress|summary|how.*(going|survey))/.test(lower)) return { reply: statusText(s) }

  if (/^(map|survey|fill)( the)? (more|gaps|rest)|^(send|map) more|^keep (mapping|going)/.test(lower)) return { reply: source.mapMore() }

  const sections = lower.match(/^(?:survey|map|scan|fly)\s+(?:sections?\s+)?((?:[a-f][1-6][\s,]*(?:and\s+)?)+)$/)
  if (sections) {
    const ids = sections[1].match(/[a-f][1-6]/g)!.map((x) => x.toUpperCase())
    const sec = s.sections.find((x) => x.id === ids[0])
    return { reply: source.requestSections(ids), focus: sec ? { x: sec.x + sec.w / 2, y: sec.y + sec.h / 2 } : undefined }
  }

  if (/^(recall|return|land|bring back)( all)?( the)? drones|^abort/.test(lower)) return { reply: source.recallAll() }

  if (/(move|go|proceed|continue)( forward)? (to|with) (buildup|build-up|build up)|^lock( the)? survey|^buildup|^finish( the)? survey/.test(lower)) {
    return { reply: source.lock() }
  }

  const where = lower.match(/^(?:where(?:'s| is)|find|show|locate)\s+(.+)$/)
  const droneQuery = where?.[1] ?? lower
  const drone = s.drones.find((d) => d.id.toLowerCase() === droneQuery.replace(/[?.!]/g, '').trim())
  if (drone) {
    const away = drone.status === 'docked' || drone.status === 'swapping' ? 'at the launch point' : `${Math.round(Math.hypot(drone.x - s.launch.x, drone.y - s.launch.y))} m from launch`
    return {
      reply: `${drone.id} (${drone.role.toLowerCase()} drone) is ${away}: ${drone.task.toLowerCase()}. Battery ${drone.battery}%.`,
      selectDrone: drone.id,
      focus: { x: drone.x, y: drone.y },
    }
  }

  return { reply: `I didn't understand "${text}". Type help to see survey commands.` }
}

export function statusText(s: SurveySnapshot) {
  if (s.phase === 'idle') return `No survey yet. The boundary is set to ${s.distanceM} m from the launch point; say "start survey" to begin.`
  const pct = Math.round(s.stats.coverage * 100)
  const lines = [
    `${phaseLabel(s.phase)}. ${pct}% of the ${s.stats.perimeterAreaKm2.toFixed(2)} km² site mapped (${s.stats.mappedAreaKm2.toFixed(2)} km²).`,
  ]
  if (s.stats.minM !== undefined) {
    lines.push(`Elevation so far ${s.stats.minM.toFixed(0)}–${s.stats.maxM!.toFixed(0)} m, mean ${s.stats.meanM!.toFixed(0)} m (relief ${(s.stats.maxM! - s.stats.minM).toFixed(0)} m).`)
  }
  const flying = s.drones.filter((d) => d.status !== 'docked' && d.status !== 'swapping')
  lines.push(flying.length ? `Flying: ${flying.map((d) => `${d.id} (${d.task.toLowerCase()})`).join('; ')}.` : 'All drones are at the launch point.')
  if (s.phase === 'review' && s.suggestions.length) lines.push(`Suggested next: ${s.suggestions.slice(0, 4).join(', ')}. Say "map more" or "move to buildup".`)
  return lines.join('\n')
}

export function phaseLabel(p: SurveySnapshot['phase']) {
  return {
    idle: 'Not started',
    scouting: 'Scouting the boundary',
    surveying: 'Mapping sections',
    review: 'Pass complete',
    locked: 'Survey locked for buildup',
  }[p]
}
