export const CRM_ENTITIES = [
  'organizations',
  'contacts',
  'leads',
  'opportunities',
  'meetings',
  'interactions',
  'campaigns',
] as const

export type CrmEntity = (typeof CRM_ENTITIES)[number]
export type CrmSyncStatus = 'pending' | 'syncing' | 'synced' | 'failed'

export type CrmOrganization = {
  id: string
  referenceCode: string
  shortUrl: string | null
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
  email: string
  emailOptOut: boolean
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
  referenceCode: string
  shortUrl: string | null
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
  emailOptOut: boolean
  syncStatus: CrmSyncStatus
  syncError: string | null
  updatedAt: string
}

export type CrmOpportunity = {
  id: string
  referenceCode: string
  shortUrl: string | null
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
  contactIds: string[]
  contacts: Array<{
    id: string
    referenceCode: string
    fullName: string
    email: string
    phoneWork: string
    phoneMobile: string
    jobTitle: string
    isPrimary: boolean
  }>
  syncStatus: CrmSyncStatus
  syncError: string | null
  updatedAt: string
}

export type CrmInteraction = {
  id: string
  referenceCode: string
  shortUrl: string | null
  pipelineId: string
  organizationId: string | null
  organizationName: string
  contactId: string | null
  opportunityId: string | null
  leadId: string | null
  meetingId: string | null
  campaignId: string | null
  suiteCrmId: string | null
  sourceKey: string
  sourceRowNumber: number | null
  interactionType: string
  subject: string
  agentEmail: string | null
  agentName: string
  occurredAt: string | null
  description: string
  direction: 'inbound' | 'outbound' | 'internal'
  deliveryStatus: string
  providerMessageId: string | null
  providerThreadId: string | null
  syncStatus: CrmSyncStatus
  syncError: string | null
  updatedAt: string
}

export type CrmLead = {
  id: string
  referenceCode: string
  shortUrl: string | null
  pipelineId: string
  organizationId: string | null
  organizationName: string
  convertedContactId: string | null
  convertedOpportunityId: string | null
  suiteCrmId: string | null
  sourceKey: string
  firstName: string
  lastName: string
  fullName: string
  companyName: string
  jobTitle: string
  email: string
  phoneWork: string
  phoneMobile: string
  status: string
  source: string
  assignedTo: string
  description: string
  emailOptOut: boolean
  syncStatus: CrmSyncStatus
  syncError: string | null
  updatedAt: string
}

export type CrmMeeting = {
  id: string
  referenceCode: string
  shortUrl: string | null
  pipelineId: string
  organizationId: string | null
  organizationName: string
  contactId: string | null
  contactName: string
  leadId: string | null
  leadName: string
  opportunityId: string | null
  opportunityName: string
  suiteCrmId: string | null
  sourceKey: string
  subject: string
  description: string
  startsAt: string
  endsAt: string
  timezone: string
  location: string
  attendeeEmails: string[]
  status: 'planned' | 'queued' | 'scheduled' | 'completed' | 'cancelled' | 'failed'
  provider: string
  externalEventId: string | null
  externalEventUrl: string | null
  joinUrl: string | null
  syncStatus: CrmSyncStatus
  syncError: string | null
  updatedAt: string
}

export type CrmCampaign = {
  id: string
  referenceCode: string
  shortUrl: string | null
  pipelineId: string
  suiteCrmId: string | null
  sourceKey: string
  name: string
  campaignType: 'email'
  status: 'draft' | 'queued' | 'sending' | 'sent' | 'paused' | 'failed'
  startDate: string
  endDate: string
  subjectTemplate: string
  bodyTemplate: string
  senderEmail: string
  description: string
  recipientCount: number
  sentCount: number
  failedCount: number
  syncStatus: CrmSyncStatus
  syncError: string | null
  updatedAt: string
}

export type CrmRecord =
  | CrmOrganization
  | CrmContact
  | CrmLead
  | CrmOpportunity
  | CrmMeeting
  | CrmInteraction
  | CrmCampaign

export type CrmSummary = {
  organizations: number
  contacts: number
  leads: number
  opportunities: number
  meetings: number
  interactions: number
  campaigns: number
  openPipelineValue: number
  weightedPipelineValue: number
  pendingSync: number
  failedSync: number
  needsReviewInteractions: number
}

export type SuiteCrmOutboxRecord = {
  entity: CrmEntity
  pipelineId: string
  localId: string
  suiteCrmId: string
  attributes: Record<string, unknown>
  relationships?: Array<{
    linkFieldName: 'accounts' | 'contact' | 'contacts' | 'leads' | 'opportunity'
    relatedModuleName: 'Accounts' | 'Contacts' | 'Leads' | 'Opportunities'
    relatedBeanId: string
  }>
}
