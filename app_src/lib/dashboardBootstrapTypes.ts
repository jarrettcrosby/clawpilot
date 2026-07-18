import type { Task } from '@/lib/types'

export type DashboardDocMeta = {
  id: string
  title: string
  category: string
  date: string
  slug: string
}

export type DashboardUserSummary = {
  displayName?: string | null
  email?: string
}

export type DashboardWorkspaceResource = {
  id: string
  name: string
  ownerEmail: string
  accessRole: 'owner' | 'editor' | 'viewer'
}

export type DashboardWorkspaceSnapshot = {
  boards: DashboardWorkspaceResource[]
  pipelines: DashboardWorkspaceResource[]
  selectedBoardId: string | null
  selectedPipelineId: string | null
  defaultBoardId: string | null
  defaultPipelineId: string | null
}

export type DashboardPipelineSnapshot = {
  summary: {
    opportunities: number
    organizations: number
    contacts: number
    totalOpenValue: number
  }
  pipeline?: { id: string; name: string } | null
}

export type DashboardAvailability = {
  tasks: boolean
  docs: boolean
  pipeline: boolean
}

export type DashboardBootstrapPayload = {
  ok: true
  organizationId: string
  generatedAt: string
  workspace: DashboardWorkspaceSnapshot
  tasks: Task[]
  docs: DashboardDocMeta[]
  pipelineSnapshot: DashboardPipelineSnapshot | null
  user: DashboardUserSummary
  availability: DashboardAvailability
  unavailable: Array<'tasks' | 'docs' | 'pipeline'>
}
