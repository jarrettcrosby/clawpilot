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

export function displayCategory(raw: string): string {
  return CATEGORY_DISPLAY[raw?.toLowerCase()] || raw?.charAt(0).toUpperCase() + raw?.slice(1) || raw
}

export function displayActor(raw: string): string {
  return ACTOR_DISPLAY[raw?.toLowerCase()] || raw || 'Jarrett'
}

export function displayStatus(raw: string): string {
  const map: Record<string,string> = {
    backlog: 'Backlog', todo: 'To Do', 'in-progress': 'In Progress',
    review: 'Review', done: 'Done',
  }
  return map[raw] || raw
}

export function displayPriority(raw: string): string {
  return raw?.charAt(0).toUpperCase() + raw?.slice(1) || raw
}
