import type { Task } from '@/lib/types'

export type GovernanceIntent = 'milestone_card' | 'checklist_item' | 'comment_activity'
export type EntityType = 'milestone' | 'micro_task'

export type GovernanceAdvisory = {
  intent: GovernanceIntent
  entityType: EntityType
  healthScore: number
  healthReasons: string[]
  advisoryMode: true
  recommendedAction: 'keep_as_card' | 'consider_checklist' | 'consider_comment'
  recommendedParentMilestoneId: string | null
  missingMilestoneFields: Array<'owner' | 'workstream' | 'outcomeStatement' | 'acceptanceCriteria'>
}

type AdvisoryInput = {
  title: string
  description: string
  checklistCount: number
  assignee?: string
  category?: string
  workstream?: string
  outcomeStatement?: string
  acceptanceCriteria?: string[]
}

const WORKSTREAMS = new Set(['platform', 'pipeline', 'agents', 'automation', 'personal'])

function tokens(s: string): Set<string> {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((x) => x.length > 2)
  )
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function classifyIntent(input: AdvisoryInput): GovernanceIntent {
  const t = `${input.title} ${input.description}`.toLowerCase()

  const commentSignals = /(comment|note|log|status update|activity)/i.test(t)
  const microSignals = /(verify|verification|test|tweak|minor|small|quick|generated|temp|iso task|check)/i.test(t)
  const milestoneSignals = /(phase|milestone|hardening|dashboard|view|governance|foundation|v\d|release)/i.test(t)

  if (commentSignals && !milestoneSignals) return 'comment_activity'
  if (microSignals && !milestoneSignals) return 'checklist_item'
  if (input.checklistCount > 0 && !milestoneSignals) return 'checklist_item'
  return 'milestone_card'
}

function bestParentMilestone(tasks: Task[], category?: string): string | null {
  const candidates = tasks.filter((t) => !t.archived && t.status !== 'done' && t.entityType !== 'micro_task')
  const sameCategory = candidates.find((t) => t.category === category)
  return sameCategory?.id || candidates[0]?.id || null
}

export function buildGovernanceAdvisory(input: AdvisoryInput, existingTasks: Task[]): GovernanceAdvisory {
  const intent = classifyIntent(input)
  const reasons: string[] = []
  const missingMilestoneFields: Array<'owner' | 'workstream' | 'outcomeStatement' | 'acceptanceCriteria'> = []
  let score = 0

  // clear outcome (25)
  if (input.title.trim().length >= 12 && !/(task|todo|item)$/i.test(input.title.trim())) {
    score += 25
  } else {
    reasons.push('Outcome is unclear or title is too generic.')
  }

  // owner assigned (15)
  if (String(input.assignee || '').trim()) {
    score += 15
  } else {
    reasons.push('Owner is not assigned.')
    missingMilestoneFields.push('owner')
  }

  // acceptance criteria (25)
  if ((input.acceptanceCriteria || []).filter(Boolean).length > 0) {
    score += 25
  } else {
    reasons.push('Acceptance criteria are missing.')
    missingMilestoneFields.push('acceptanceCriteria')
  }

  // category/workstream (15)
  const hasCategory = !!String(input.category || '').trim()
  const hasWorkstream = WORKSTREAMS.has(String(input.workstream || '').toLowerCase())
  if (hasCategory && hasWorkstream) score += 15
  else if (hasCategory || hasWorkstream) {
    score += 8
    reasons.push('Category/workstream is only partially specified.')
    if (!hasWorkstream) missingMilestoneFields.push('workstream')
  } else {
    reasons.push('Category/workstream is missing.')
    missingMilestoneFields.push('workstream')
  }

  // outcome statement (milestone quality soft signal)
  const hasOutcomeStatement = String(input.outcomeStatement || '').trim().length >= 12
  if (hasOutcomeStatement) {
    score += 10
  } else {
    reasons.push('Outcome statement is missing or too short.')
    missingMilestoneFields.push('outcomeStatement')
  }

  // uniqueness (20)
  const newTokens = tokens(`${input.title} ${input.description}`)
  const maxSim = existingTasks.reduce((mx, t) => {
    const sim = jaccard(newTokens, tokens(`${t.title} ${t.desc || ''}`))
    return sim > mx ? sim : mx
  }, 0)
  if (maxSim < 0.45) score += 20
  else if (maxSim < 0.65) {
    score += 10
    reasons.push('Scope overlaps with an existing card.')
  } else {
    reasons.push('Likely duplicate of an existing card.')
  }

  if (intent !== 'milestone_card') {
    reasons.push('Intent suggests checklist/comment rather than standalone milestone.')
  } else if (missingMilestoneFields.length > 0) {
    reasons.push(`Milestone-quality fields missing: ${missingMilestoneFields.join(', ')}.`)
  }

  const entityType: EntityType = intent === 'milestone_card' ? 'milestone' : 'micro_task'
  const recommendedParentMilestoneId = intent === 'milestone_card' ? null : bestParentMilestone(existingTasks, input.category)

  const recommendedAction =
    intent === 'comment_activity' ? 'consider_comment'
    : intent === 'checklist_item' ? 'consider_checklist'
    : score >= 70 ? 'keep_as_card'
    : 'consider_checklist'

  const uniqMissing = [...new Set(missingMilestoneFields)]

  return {
    intent,
    entityType,
    healthScore: Math.max(0, Math.min(100, Math.round(score))),
    healthReasons: reasons,
    advisoryMode: true,
    recommendedAction,
    recommendedParentMilestoneId,
    missingMilestoneFields: uniqMissing,
  }
}
