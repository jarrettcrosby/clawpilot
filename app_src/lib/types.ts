export type ActivityEntry = {
  type: 'created' | 'moved' | 'label_added' | 'label_removed' | 'comment' | 'updated' | 'checklist' | 'archived' | 'unarchived'
  message: string
  from?: string
  to?: string
  timestamp: string
  actor: string
  taskId?: string
  taskTitle?: string
  commentId?: string
}

export type Comment = {
  id: string
  text: string
  author: string
  // Legacy field used in some older records
  timestamp?: string
  // Preferred
  createdAt?: string
  // When removed (soft delete)
  deletedAt?: string
}

export type ChecklistItem = {
  id: string
  text: string
  done: boolean
  assignee?: string
  agentId?: string
  dueDate?: string
}

export type GovernanceInfo = {
  intent?: string | null
  entityType?: string | null
  healthScore?: number
  healthReasons?: string[]
  advisoryMode?: boolean
  recommendedAction?: string | null
  recommendedParentMilestoneId?: string | null
  milestoneName?: string | null
  missingMilestoneFields?: string[]
}

export type CanonicalWorkItem = {
  status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done'
  assignedAgent?: string
  nextAction?: string
  blocker?: string
  lastConcreteAction?: string
  waitingOn?: string
  activity: ActivityEntry[]
}

export type CrmTaskContext = {
  projectionVersion: 1
  entity: 'organizations' | 'contacts'
  entityId: string
  pipelineId: string
  referenceCode: string
  recordName: string
  recordUrl: string
  accountName: string
  accountReferenceCode?: string
  accountUrl: string
  email: string
  emailUrl?: string
  description: string
  descriptionHash: string
  syncStatus: 'synced' | 'conflict'
}

export type Task = {
  id: string
  boardId?: string
  title: string
  desc: string
  status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done'
  priority: 'high' | 'medium' | 'low'
  category: string
  tags: string[]
  assignedAgent?: string
  assignee?: string
  dueDate?: string
  createdAt: string
  updatedAt: string
  activity: ActivityEntry[]
  comments: Comment[]
  deletedComments?: Comment[]
  checklist: ChecklistItem[]
  archived?: boolean
  archivedAt?: string
  deletedAt?: string
  workstream?: string
  outcomeStatement?: string
  entityType?: string
  crm?: CrmTaskContext
  governance?: GovernanceInfo
  execution?: {
    assignedAgent?: string
    assignedAt?: string
    executionStatus?: string
    startedAt?: string
    lastUpdatedAt?: string
    latestExecutionNote?: string
    lastResult?: unknown
    suggestions?: unknown[]
    agentDispatch?: {
      id: string
      trigger: 'assignment' | 'comment' | 'continuation'
      status: 'queued' | 'running' | 'succeeded' | 'failed'
      attempts: number
      continuationDepth?: number
      queuedAt: string
      updatedAt: string
      error?: string
    }
  }
  workItem?: CanonicalWorkItem
}

export const COLUMNS: { status: Task['status']; label: string; color: string }[] = [
  { status: 'backlog',     label: 'Backlog',     color: '#546E7A' },
  { status: 'todo',        label: 'To Do',       color: '#A8C7FA' },
  { status: 'in-progress', label: 'In Progress', color: '#FFA726' },
  { status: 'review',      label: 'Review',      color: '#AB47BC' },
  { status: 'done',        label: 'Done',        color: '#66BB6A' },
]

export const PRIORITY_COLORS: Record<string, string> = {
  high: '#EF5350', medium: '#FFA726', low: '#66BB6A'
}
export const PRIORITY_LABELS: Record<string, string> = {
  high: 'High', medium: 'Medium', low: 'Low'
}
export const STATUS_LABELS: Record<Task['status'], string> = {
  backlog: 'Backlog', todo: 'To Do', 'in-progress': 'In Progress', review: 'Review', done: 'Done'
}
export const AVAILABLE_LABELS: { id: string; label: string; color: string }[] = [
  { id: 'urgent',    label: 'Urgent',    color: '#EF5350' },
  { id: 'feature',   label: 'Feature',   color: '#42A5F5' },
  { id: 'bug',       label: 'Bug',       color: '#FF7043' },
  { id: 'research',  label: 'Research',  color: '#AB47BC' },
  { id: 'blocked',   label: 'Blocked',   color: '#78909C' },
  { id: 'marketing', label: 'Marketing', color: '#EC407A' },
  { id: 'sales',     label: 'Sales',     color: '#26A69A' },
  { id: 'ops',       label: 'Ops',       color: '#8D6E63' },
  { id: 'tech',      label: 'Tech',      color: '#5C6BC0' },
  { id: 'content',   label: 'Content',   color: '#FFA726' },
  { id: 'epi',       label: 'EPI',       color: '#66BB6A' },
  { id: 'suburbia',  label: 'Suburbia',  color: '#FDD663' },
  { id: 'p9ine',     label: 'P9INE',     color: '#29B6F6' },
  { id: 'clawpilot', label: 'ClawPilot', color: '#CFC6EA' },
]
export const PEOPLE: { id: string; name: string; initials: string; color: string }[] = [
  { id: 'jarrett',  name: 'Jarrett',   initials: 'J',  color: '#A8C7FA' },
  { id: 'clawpilot',name: 'ClawPilot', initials: 'CP', color: '#CFC6EA' },
  { id: 'projects', name: 'Projects', initials: 'PR', color: '#8BC34A' },
  { id: 'pipeline', name: 'Pipeline', initials: 'PI', color: '#26A69A' },
  { id: 'docs',     name: 'Docs',     initials: 'D',  color: '#AB47BC' },
  { id: 'calendar', name: 'Calendar', initials: 'C',  color: '#42A5F5' },
]
export const ASSIGNABLE_PRODUCT_AGENT_IDS = ['projects', 'pipeline', 'docs', 'calendar', 'clawpilot'] as const
export const CATEGORY_OPTIONS = ['clawpilot', 'epi', 'suburbia', 'p9ine', 'personal', 'ops', 'tech', 'marketing']
