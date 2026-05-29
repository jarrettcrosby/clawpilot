export const PRIORITY = ['low','medium','high'] as const

export type ValidationError = { path: string; message: string }

export function validateMilestone(obj: any): { valid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = []
  if (typeof obj !== 'object' || obj === null) {
    errors.push({ path: '', message: 'must be an object' })
    return { valid: false, errors }
  }
  if (!obj.title || typeof obj.title !== 'string') {
    errors.push({ path: 'title', message: 'title is required and must be a string' })
  }
  if (obj.owner && typeof obj.owner !== 'string') {
    errors.push({ path: 'owner', message: 'owner must be a string' })
  }
  if (obj.workstream && typeof obj.workstream !== 'string') {
    errors.push({ path: 'workstream', message: 'workstream must be a string' })
  }
  if (obj.category && typeof obj.category !== 'string') {
    errors.push({ path: 'category', message: 'category must be a string' })
  }
  if (obj.outcomeStatement && typeof obj.outcomeStatement !== 'string') {
    errors.push({ path: 'outcomeStatement', message: 'outcomeStatement must be a string' })
  }
  if (obj.acceptanceCriteria) {
    if (!Array.isArray(obj.acceptanceCriteria)) {
      errors.push({ path: 'acceptanceCriteria', message: 'must be an array of strings' })
    } else {
      obj.acceptanceCriteria.forEach((v: any, i: number) => { if (typeof v !== 'string') errors.push({ path: `acceptanceCriteria[${i}]`, message: 'must be a string' }) })
    }
  }
  if (obj.priority && !PRIORITY.includes(obj.priority)) {
    errors.push({ path: 'priority', message: `priority must be one of ${PRIORITY.join(',')}` })
  }
  if (obj.linkedAgents) {
    if (!Array.isArray(obj.linkedAgents)) {
      errors.push({ path: 'linkedAgents', message: 'must be an array of agent ids/strings' })
    } else {
      obj.linkedAgents.forEach((v: any, i: number) => { if (typeof v !== 'string') errors.push({ path: `linkedAgents[${i}]`, message: 'must be a string' }) })
    }
  }
  return { valid: errors.length === 0, errors }
}
