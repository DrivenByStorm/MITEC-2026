// Text-box commands for the buildup planning stage.

import type { SitePlan } from './types'

export interface BuildupCommandResult {
  reply: string
  /** New inputs to plan with, if the message asked for a plan. */
  plan?: { unitCount?: number; crewSize?: number }
  approve?: boolean
}

export function buildupExamples(plan: SitePlan | null): string[] {
  if (!plan) return ['plan 240 units with 30 people', 'plan 500 units with 60 people', 'help']
  return ['approve plan', `plan ${plan.input.unitCount} units with ${plan.input.crewSize + 10} people`, 'why this many relays?']
}

const HELP = [
  'Buildup planning commands:',
  '• plan <N> units with <M> people — e.g. "plan 240 units with 30 people"',
  '• units <N> / crew <M> — change one input and re-plan',
  '• why this many relays? / why this fleet? / what limits the schedule?',
  '• approve plan — start live construction of this plan',
  'You choose how many P3 units to build; the planner chooses where they go, the relays, robots, machines and crew.',
].join('\n')

export function runBuildupCommand(input: string, plan: SitePlan | null): BuildupCommandResult {
  const lower = input.trim().toLowerCase()
  if (/^(help|\?|what can you do)/.test(lower)) return { reply: HELP }

  const units = lower.match(/(\d[\d,]*)\s*(?:p3\s*)?(?:units?|power units?|p3s?)\b/)
  const crew = lower.match(/(\d[\d,]*)\s*(?:people|workers|crew|person)\b/) ?? lower.match(/\bcrew(?:\s+(?:of|size|to))?\s+(\d[\d,]*)/)
  const n = (m: RegExpMatchArray | null) => (m ? Number(m[1].replace(/,/g, '')) : undefined)
  if (/^(plan|build|layout|lay out|units?|crew|use|make|re-?plan)\b/.test(lower) && (units || crew)) {
    const unitCount = n(units)
    const crewSize = n(crew)
    if (unitCount !== undefined && (unitCount < 1 || unitCount > 5000)) return { reply: 'Pick between 1 and 5,000 units.' }
    if (crewSize !== undefined && (crewSize < 1 || crewSize > 400)) return { reply: 'Pick a crew between 1 and 400 people.' }
    return { reply: '', plan: { unitCount, crewSize } }
  }

  if (/^(approve|accept|go|start construction|build it|begin construction)/.test(lower)) {
    if (!plan) return { reply: 'Make a plan first, e.g. "plan 240 units with 30 people".' }
    return { reply: 'Plan approved. Starting construction.', approve: true }
  }

  if (!plan) return { reply: 'No plan yet. Try "plan 240 units with 30 people".' }

  if (/relay|mast|network|coverage/.test(lower)) {
    const r = plan.fleet.find((f) => f.key === 'relay')!
    const g = plan.fleet.find((f) => f.key === 'loraGateway')!
    return { reply: `${r.count} relay masts. ${r.why}\n${g.count} LoRa gateways: ${g.why.toLowerCase()}` }
  }
  if (/fleet|robot|machine|crane|telehandler|trencher|pile/.test(lower)) {
    return {
      reply: plan.fleet
        .filter((f) => ['pile', 'crane', 'telehandler', 'trencher'].includes(f.key))
        .map((f) => `${f.count} × ${f.name.toLowerCase()}: ${f.why}`)
        .join('\n'),
    }
  }
  if (/schedule|limit|bottleneck|how long|days|time/.test(lower)) {
    return {
      reply: [
        `About ${plan.totalDays} working days (10 h shifts). ${plan.bottleneck} is the slowest stage.`,
        ...plan.stages.map((s) => `${s.stage}: ${s.days.toFixed(1)} days with ${s.detail}`),
      ].join('\n'),
    }
  }
  if (/crew|people|workers|who/.test(lower)) {
    return { reply: [`Crew of ${plan.crewUsed}:`, ...plan.crew.map((c) => `${c.count} × ${c.role.toLowerCase()} (${c.with})`)].join('\n') }
  }
  if (/^(status|summary)/.test(lower)) return { reply: summary(plan) }

  return { reply: `I didn't understand "${input.trim()}". Type help to see buildup commands.` }
}

export function summary(plan: SitePlan) {
  const f = (k: string) => plan.fleet.find((x) => x.key === k)!.count
  return [
    `${plan.units.length} P3 units in ${plan.blocks.length} block${plan.blocks.length === 1 ? '' : 's'} on flat, mapped ground.`,
    `${f('pile')} pile-driving robot${f('pile') === 1 ? '' : 's'}, ${f('crane')} crane${f('crane') === 1 ? '' : 's'}, ${f('telehandler')} telehandler${f('telehandler') === 1 ? '' : 's'}, ${f('trencher')} trencher${f('trencher') === 1 ? '' : 's'} and a survey drone.`,
    `${f('relay')} relay masts with ${f('loraGateway')} LoRa gateways. Crew of ${plan.crewUsed}.`,
    `About ${plan.totalDays} working days; ${plan.bottleneck.toLowerCase()} is the slowest stage.`,
    ...plan.warnings,
  ].join('\n')
}
