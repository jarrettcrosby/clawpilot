export const CRM_ENTITIES = ['organizations', 'contacts', 'opportunities', 'interactions'] as const

export type CrmEntity = (typeof CRM_ENTITIES)[number]
export type CrmSyncStatus = 'pending' | 'syncing' | 'synced' | 'failed'

export type CrmOrganization = {
  id: string
  pipelineId: string
  parentOrganizationId: string | null
  parentOrganizationName: string
  workspaceOrganizationId: string | null
  relationshipType: 'workspace_root' | 'workspace_member' | 'customer'
  suiteCrmId: string | null
  sourceKey: string
  sourceRowNumber: number | null
  priority: string
  name: string
  accountType: string
  accountManager: string
  website: string
  linkedinUrl: string
  phone: string
  address: string
  city: string
  state: string
  postalCode: string
  country: string
  description: string
  syncStatus: CrmSyncStatus
  syncError: string | null
  updatedAt: string
}

export type CrmContact = {
  id: string
  pipelineId: string
  organizationId: string | null
  organizationName: string
  suiteCrmId: string | null
  sourceKey: string
  sourceRowNumber: number | null
  priority: string
  firstName: string
  lastName: string
  fullName: string
  contactType: string
  accountManager: string
  jobTitle: string
  email: string
  linkedinUrl: string
  phoneWork: string
  phoneMobile: string
  address: string
  city: string
  state: string
  postalCode: string
  country: string
  description: string
  syncStatus: CrmSyncStatus
  syncError: string | null
  updatedAt: string
}

export type CrmOpportunity = {
  id: string
  pipelineId: string
  organizationId: string | null
  suiteCrmId: string | null
  sourceKey: string
  sourceRowNumber: number | null
  priority: string
  name: string
  owner: string
  organization: string
  status: string
  stage: string
  lossReason: string
  source: string
  value: number
  probability: number
  expectedClose: string
  notes: string
  syncStatus: CrmSyncStatus
  syncError: string | null
  updatedAt: string
}

export type CrmInteraction = {
  id: string
  pipelineId: string
  organizationId: string | null
  contactId: string | null
  opportunityId: string | null
  suiteCrmId: string | null
  sourceKey: string
  sourceRowNumber: number | null
  interactionType: string
  subject: string
  agentName: string
  occurredAt: string | null
  description: string
  syncStatus: CrmSyncStatus
  syncError: string | null
  updatedAt: string
}

export type CrmRecord = CrmOrganization | CrmContact | CrmOpportunity | CrmInteraction

export type CrmSummary = {
  organizations: number
  contacts: number
  opportunities: number
  interactions: number
  openPipelineValue: number
  weightedPipelineValue: number
  pendingSync: number
  failedSync: number
}

export type SuiteCrmOutboxRecord = {
  entity: CrmEntity
  pipelineId: string
  localId: string
  suiteCrmId: string
  attributes: Record<string, unknown>
}
