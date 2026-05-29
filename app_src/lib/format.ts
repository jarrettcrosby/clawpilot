// Canonical display names — single source of truth for all labels across the app

export const CATEGORY_DISPLAY: Record<string, string> = {
  clawpilot: 'ClawPilot',
  epi:       'EPI',
  suburbia:  'Suburbia',
  p9ine:     'P9INE',
  personal:  'Personal',
  ops:       'Operations',
  tech:      'Tech',
  marketing: 'Marketing',
  sales:     'Sales',
}

export const ACTOR_DISPLAY: Record<string, string> = {
  jarrett:        'Jarrett',
  clawpilot:      'ClawPilot',
  projects:       'Projects',
  pipeline:       'Pipeline',
  docs:           'Docs',
  calendar:       'Calendar',
  'projects-agent':'Projects',
  'pipeline-agent':'Pipeline',
  'docs-agent':    'Docs',
  'calendar-agent':'Calendar',
  main:           'Main',
  builder:        'Builder',
}

function normalizeKey(raw?: string): string {
  return String(raw || '').trim().toLowerCase()
}

function titleCase(raw?: string): string {
  const normalized = String(raw || '').trim().replace(/[-_]+/g, ' ')
  if (!normalized) return String(raw || '')
  return normalized
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function displayCategory(raw: string): string {
  const key = normalizeKey(raw)
  return CATEGORY_DISPLAY[key] || titleCase(raw)
}

export function displayActor(raw: string): string {
  const key = normalizeKey(raw)
  return ACTOR_DISPLAY[key] || titleCase(raw) || 'Jarrett'
}

export function displayStatus(raw: string): string {
  const key = normalizeKey(raw)
  const map: Record<string,string> = {
    backlog: 'Backlog',
    todo: 'To Do',
    'in-progress': 'In Progress',
    in_progress: 'In Progress',
    inprogress: 'In Progress',
    review: 'Review',
    blocked: 'Blocked',
    done: 'Done',
  }
  return map[key] || titleCase(raw)
}

export function displayPriority(raw: string): string {
  return titleCase(raw)
}
