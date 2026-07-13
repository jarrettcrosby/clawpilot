export type ProductAgentId = 'projects' | 'pipeline' | 'docs' | 'calendar' | 'clawpilot'

export type RoutingMap = Record<Exclude<ProductAgentId, 'clawpilot'>, string>

export const PRODUCT_AGENT_IDS: ProductAgentId[] = ['projects', 'pipeline', 'docs', 'calendar', 'clawpilot']

export const PRODUCT_TO_EXECUTION: Record<ProductAgentId, string> = {
  projects: 'projects',
  pipeline: 'pipeline',
  docs: 'docs',
  calendar: 'calendar',
  clawpilot: 'main',
}

export const PRODUCT_AGENTS = [
  { id: 'projects' as const, name: 'Projects', owner: 'Execution', kind: 'product' as const, executionAgentId: PRODUCT_TO_EXECUTION.projects, summary: 'Plans and sequences assigned project work.' },
  { id: 'pipeline' as const, name: 'Pipeline', owner: 'Revenue', kind: 'product' as const, executionAgentId: PRODUCT_TO_EXECUTION.pipeline, summary: 'Reviews assigned pipeline work and drafts follow-up.' },
  { id: 'docs' as const, name: 'Docs', owner: 'Knowledge', kind: 'product' as const, executionAgentId: PRODUCT_TO_EXECUTION.docs, summary: 'Drafts task-linked working documentation.' },
  { id: 'calendar' as const, name: 'Calendar', owner: 'Scheduling', kind: 'product' as const, executionAgentId: PRODUCT_TO_EXECUTION.calendar, summary: 'Reviews scheduling work and drafts proposed changes.' },
  { id: 'clawpilot' as const, name: 'ClawPilot', owner: 'Orchestrator', kind: 'orchestrator' as const, executionAgentId: PRODUCT_TO_EXECUTION.clawpilot, summary: 'Reviews task context and proposes the next concrete move.' },
]

const LEGACY_PRODUCT_MAP: Record<string, ProductAgentId> = {
  projects: 'projects',
  'projects-agent': 'projects',
  pipeline: 'pipeline',
  'pipeline-agent': 'pipeline',
  docs: 'docs',
  'docs-agent': 'docs',
  calendar: 'calendar',
  'calendar-agent': 'calendar',
  clawpilot: 'clawpilot',
  'clawpilot-exec': 'clawpilot',
  builder: 'pipeline',
}

export const EXECUTION_TO_PRODUCT: Record<string, ProductAgentId> = {
  projects: 'projects',
  pipeline: 'pipeline',
  docs: 'docs',
  calendar: 'calendar',
  clawpilot: 'clawpilot',
  'clawpilot-exec': 'clawpilot',
  main: 'clawpilot',
  builder: 'pipeline',
  ...LEGACY_PRODUCT_MAP,
}

export const ROUTING_MAP: RoutingMap = {
  projects: PRODUCT_TO_EXECUTION.projects,
  pipeline: PRODUCT_TO_EXECUTION.pipeline,
  docs: PRODUCT_TO_EXECUTION.docs,
  calendar: PRODUCT_TO_EXECUTION.calendar,
}

export function isProductAgentId(value: string | undefined | null): value is ProductAgentId {
  return PRODUCT_AGENT_IDS.includes(String(value || '').trim().toLowerCase() as ProductAgentId)
}

function inferProductAgentFromContext(category?: string, tags?: string[]): ProductAgentId | null {
  const key = String(category || '').toLowerCase()
  if (key.includes('project') || key === 'projects') return 'projects'
  if (key.includes('pipeline') || key === 'pipeline') return 'pipeline'
  if (key.includes('doc') || key === 'docs') return 'docs'
  if (key.includes('calendar') || key === 'calendar') return 'calendar'

  const tagList = Array.isArray(tags) ? tags.map((tag) => String(tag).toLowerCase()) : []
  for (const tag of tagList) {
    const normalized = LEGACY_PRODUCT_MAP[tag]
    if (normalized) return normalized
  }

  return null
}

export function normalizeProductAgentId(
  agentId: string | undefined | null,
  context?: { category?: string; tags?: string[] },
): ProductAgentId | undefined {
  const raw = String(agentId || '').trim().toLowerCase()
  if (!raw) return inferProductAgentFromContext(context?.category, context?.tags) || undefined
  if (isProductAgentId(raw)) return raw
  if (LEGACY_PRODUCT_MAP[raw]) return LEGACY_PRODUCT_MAP[raw]
  if (raw === 'main') return inferProductAgentFromContext(context?.category, context?.tags) || 'clawpilot'
  return undefined
}

export function resolveExecutionAgentForControlAgent(agentId: string | undefined): string | null {
  const normalized = normalizeProductAgentId(agentId)
  return normalized ? PRODUCT_TO_EXECUTION[normalized] : null
}

export function resolveExecutionAgentForCategory(category: string | undefined): string | null {
  const productAgentId = inferProductAgentFromContext(category)
  return productAgentId ? PRODUCT_TO_EXECUTION[productAgentId] : null
}
