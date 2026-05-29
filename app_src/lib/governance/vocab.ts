// Canonical governance vocabulary and normalization utilities

export const ENTITY_TYPES = {
  TASK: 'task',
  NOTE: 'note',
  MILESTONE: 'milestone',
} as const

export const INTENTS = {
  DELIVERABLE: 'deliverable',
  RESEARCH: 'research',
  NOTE: 'note',
  DECISION: 'decision',
} as const

export const RECOMMENDED_ACTIONS = {
  MERGE_MILESTONE_PREFIX: 'merge:',
  ARCHIVE: 'archive',
  NONE: 'none',
} as const

// synonym maps
const INTENT_SYNONYMS: Record<string, string> = {
  'task': INTENTS.DELIVERABLE,
  'todo': INTENTS.DELIVERABLE,
  'deliverable': INTENTS.DELIVERABLE,
  'research': INTENTS.RESEARCH,
  'note': INTENTS.NOTE,
  'comment': INTENTS.NOTE,
  'decision': INTENTS.DECISION,
}

const ENTITY_SYNONYMS: Record<string, string> = {
  'task': ENTITY_TYPES.TASK,
  'note': ENTITY_TYPES.NOTE,
  'milestone': ENTITY_TYPES.MILESTONE,
}

export function normalizeIntent(raw: any): string | null {
  if (raw === undefined || raw === null) return null
  const s = String(raw).toLowerCase()
  return INTENT_SYNONYMS[s] || null
}

export function normalizeEntity(raw: any): string | null {
  if (raw === undefined || raw === null) return null
  const s = String(raw).toLowerCase()
  return ENTITY_SYNONYMS[s] || null
}

export default {
  ENTITY_TYPES,
  INTENTS,
  RECOMMENDED_ACTIONS,
  normalizeIntent,
  normalizeEntity,
}
