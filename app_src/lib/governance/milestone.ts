export const PRIORITY = ['low','medium','high'] as const

export type ValidationError = { path: string; message: string }

type MilestoneInput = {
  title?: unknown
  owner?: unknown
  workstream?: unknown
  category?: unknown
  outcomeStatement?: unknown
  acceptanceCriteria?: unknown
  priority?: unknown
  linkedAgents?: unknown
}

export function validateMilestone(obj: unknown): { valid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = []
  if (typeof obj !== 'object' || obj === null) {
    errors.push({ path: '', message: 'must be an object' })
    return { valid: false, errors }
  }
  const milestone = obj as MilestoneInput
  if (!milestone.title || typeof milestone.title !== 'string') {
    errors.push({ path: 'title', message: 'title is required and must be a string' })
  }
  if (milestone.owner && typeof milestone.owner !== 'string') {
    errors.push({ path: 'owner', message: 'owner must be a string' })
  }
  if (milestone.workstream && typeof milestone.workstream !== 'string') {
    errors.push({ path: 'workstream', message: 'workstream must be a string' })
  }
  if (milestone.category && typeof milestone.category !== 'string') {
    errors.push({ path: 'category', message: 'category must be a string' })
  }
  if (milestone.outcomeStatement && typeof milestone.outcomeStatement !== 'string') {
    errors.push({ path: 'outcomeStatement', message: 'outcomeStatement must be a string' })
  }
  if (milestone.acceptanceCriteria) {
    if (!Array.isArray(milestone.acceptanceCriteria)) {
      errors.push({ path: 'acceptanceCriteria', message: 'must be an array of strings' })
    } else {
      milestone.acceptanceCriteria.forEach((value: unknown, i: number) => { if (typeof value !== 'string') errors.push({ path: `acceptanceCriteria[${i}]`, message: 'must be a string' }) })
    }
  }
  if (milestone.priority && !PRIORITY.includes(milestone.priority as (typeof PRIORITY)[number])) {
    errors.push({ path: 'priority', message: `priority must be one of ${PRIORITY.join(',')}` })
  }
  if (milestone.linkedAgents) {
    if (!Array.isArray(milestone.linkedAgents)) {
      errors.push({ path: 'linkedAgents', message: 'must be an array of agent ids/strings' })
    } else {
      milestone.linkedAgents.forEach((value: unknown, i: number) => { if (typeof value !== 'string') errors.push({ path: `linkedAgents[${i}]`, message: 'must be a string' }) })
    }
  }
  return { valid: errors.length === 0, errors }
}
