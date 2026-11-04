import {
  assertSameRetainedGmailEvidence, gmailEvidenceHash, gmailMailboxKey, verifyGmailMailboxBinding,
  type GmailMessageEvidence, type VerifiedGmailMailboxIdentity,
} from '@/lib/crm/emailIdentity'

const LEGACY_MESSAGES = ['1a17e730c78d319c', '1a17f5004f29592c', '1a17f5d46a224e0a'] as const
const LEGACY_THREAD = '1a179e9e2743f926'
const LEGACY_PIPELINE = '587c8746-ecf6-40ae-8c50-e456f99ad555'

export type GmailLegacyAdoption = {
  version: 1
  kind: 'bounded-legacy-adoption'
  originalMailboxProvenance: 'unknown'
  messageId: string
  threadId: string
  pipelineId: string
  primaryOrganizationId: string
  primaryOrganizationReference: string
  relatedOrganizationIds: string[]
  relatedOrganizationReferences: string[]
  selectedMessageIds: string[]
  mailboxKey: string
  providerAccountId: string
  accountEmail: string
  observedConnectionId: string
  identityVerifiedAt: string
  retainedEvidenceHash: string
  currentEvidenceHash: string
}

export type GmailLegacyAdoptionScope = {
  pipelineId: string
  messageIds: string[]
  threadId: string
  primaryOrganization: { id: string; referenceCode: string }
  organizations: Array<{ id: string; referenceCode: string }>
}

/** This narrow legacy bridge is not a mailbox history import. Durable
 * persistence must revalidate every ID/reference/account and cached snapshot. */
export function prepareBoundedLegacyGmailAdoption(input: {
  scope: GmailLegacyAdoptionScope
  identity: VerifiedGmailMailboxIdentity
  adoptedAt: string
  cached: GmailMessageEvidence
  current: GmailMessageEvidence
}): GmailLegacyAdoption {
  const { scope, cached, current, identity } = input
  const refused = () => new Error('Legacy Gmail adoption is outside the explicitly reviewed three-message scope')
  if (scope.pipelineId !== LEGACY_PIPELINE || scope.threadId !== LEGACY_THREAD
    || scope.messageIds.length !== LEGACY_MESSAGES.length
    || new Set(scope.messageIds).size !== LEGACY_MESSAGES.length
    || scope.messageIds.some(id => !(LEGACY_MESSAGES as readonly string[]).includes(id))
    || !(LEGACY_MESSAGES as readonly string[]).includes(current.messageId)
    || current.threadId !== LEGACY_THREAD || cached.threadId !== LEGACY_THREAD
    || current.emailAddressHeaders.from?.length !== 1 || cached.emailAddressHeaders.from?.length !== 1
    || !scope.primaryOrganization.id || scope.primaryOrganization.referenceCode !== 'gagmco24va588e'
    || scope.organizations.length !== 2 || new Set(scope.organizations.map(company => company.id)).size !== 2
    || !scope.organizations.some(company => company.id === scope.primaryOrganization.id && company.referenceCode === 'gagmco24va588e')
    || !scope.organizations.some(company => company.id !== scope.primaryOrganization.id && company.referenceCode === 'gajl1dq5i03jga')) throw refused()
  if (!Number.isFinite(new Date(input.adoptedAt).getTime())) throw refused()
  const retainedEvidenceHash = assertSameRetainedGmailEvidence(cached, current)
  const result: GmailLegacyAdoption = { version: 1, kind: 'bounded-legacy-adoption', originalMailboxProvenance: 'unknown',
    messageId: current.messageId, threadId: LEGACY_THREAD, pipelineId: scope.pipelineId,
    primaryOrganizationId: scope.primaryOrganization.id,
    primaryOrganizationReference: scope.primaryOrganization.referenceCode,
    relatedOrganizationIds: scope.organizations.map(company => company.id).sort(),
    relatedOrganizationReferences: scope.organizations.map(company => company.referenceCode).sort(),
    selectedMessageIds: [...scope.messageIds].sort(),
    mailboxKey: gmailMailboxKey(identity), providerAccountId: identity.providerAccountId,
    accountEmail: identity.accountEmail, observedConnectionId: identity.verifiedConnectionId,
    identityVerifiedAt: identity.verifiedAt, retainedEvidenceHash,
    currentEvidenceHash: gmailEvidenceHash(current) }
  assertBoundedGmailLegacyAdoption(result)
  return result
}

export function assertBoundedGmailLegacyAdoption(value: GmailLegacyAdoption): void {
  if (!value || value.version !== 1 || value.kind !== 'bounded-legacy-adoption'
    || value.originalMailboxProvenance !== 'unknown' || value.pipelineId !== LEGACY_PIPELINE
    || value.threadId !== LEGACY_THREAD || !(LEGACY_MESSAGES as readonly string[]).includes(value.messageId)
    || !Array.isArray(value.selectedMessageIds) || [...value.selectedMessageIds].sort().join() !== [...LEGACY_MESSAGES].sort().join()
    || value.primaryOrganizationReference !== 'gagmco24va588e'
    || !Array.isArray(value.relatedOrganizationReferences)
    || [...value.relatedOrganizationReferences].sort().join() !== ['gagmco24va588e', 'gajl1dq5i03jga'].sort().join()
    || !Array.isArray(value.relatedOrganizationIds) || new Set(value.relatedOrganizationIds).size !== 2
    || value.relatedOrganizationIds.length !== 2 || !value.relatedOrganizationIds.includes(value.primaryOrganizationId)
    || !/^[a-f0-9]{64}$/.test(value.retainedEvidenceHash) || value.retainedEvidenceHash !== value.currentEvidenceHash
    || !value.providerAccountId || !value.accountEmail || !value.observedConnectionId
    || !Number.isFinite(new Date(value.identityVerifiedAt).getTime())) {
    throw new Error('Legacy Gmail adoption is outside the explicitly reviewed three-message scope')
  }
}

export type GmailCaseyAdoption = Omit<GmailLegacyAdoption, 'kind'> & {
  kind: 'reviewed-casey-two-adoption-v1'
  ownerEmail: string
  inboundMessageId: string
  intakePipelineId: string
}
export type GmailReviewedHistoricalAdoption = GmailLegacyAdoption | GmailCaseyAdoption
const CASEY_CACHE_IDS: Record<string, string> = {
  '1a18e03ea586cd7e': '756e4e17-2458-470b-b00c-129c85ee821a',
  '1a18f01749eb87a6': '78a5b2cc-ba50-4a71-a17c-adaf0c1041c2',
}
const CASEY_MESSAGES = ['1a18e03ea586cd7e', '1a18f01749eb87a6']
const CASEY_OWNER = 'jarrett@suburbiasandwichco.com'
const CASEY_CONNECTION = 'eb13a0fd-c0b2-4ad1-99b7-3bbda178a027'
const CASEY_INTAKE = '0ce9d945-0b71-495b-88ef-420ddd51fd9c'

/** A separate, finite admission; never an extension of the original three-
 * message bridge, a thread rule, or proof of the original mailbox identity. */
export function prepareCaseyGmailAdoption(input: {
  scope: GmailLegacyAdoptionScope & { ownerEmail: string; connectionId: string; inboundMessageId: string; intakePipelineId: string }
  identity: VerifiedGmailMailboxIdentity
  adoptedAt: string
  cached: GmailMessageEvidence
  current: GmailMessageEvidence
}): GmailCaseyAdoption {
  const { scope, cached, current, identity } = input
  const refused = () => new Error('Casey Gmail admission is outside the explicitly reviewed two-message scope')
  if (scope.ownerEmail !== CASEY_OWNER || scope.connectionId !== CASEY_CONNECTION
    || identity.verifiedConnectionId !== CASEY_CONNECTION || scope.intakePipelineId !== CASEY_INTAKE
    || scope.inboundMessageId !== CASEY_CACHE_IDS[current.messageId]
    || scope.pipelineId !== LEGACY_PIPELINE || scope.threadId !== LEGACY_THREAD
    || scope.messageIds.length !== 2 || new Set(scope.messageIds).size !== 2
    || scope.messageIds.some(id => !CASEY_MESSAGES.includes(id)) || !CASEY_MESSAGES.includes(current.messageId)
    || cached.messageId !== current.messageId || current.threadId !== LEGACY_THREAD || cached.threadId !== LEGACY_THREAD
    || cached.emailAddressHeaders.from?.length !== 1 || current.emailAddressHeaders.from?.length !== 1
    || !scope.primaryOrganization.id || scope.primaryOrganization.referenceCode !== 'gagmco24va588e'
    || scope.organizations.length !== 2 || new Set(scope.organizations.map(company => company.id)).size !== 2
    || !scope.organizations.some(company => company.id === scope.primaryOrganization.id && company.referenceCode === 'gagmco24va588e')
    || !scope.organizations.some(company => company.id !== scope.primaryOrganization.id && company.referenceCode === 'gajl1dq5i03jga')) throw refused()
  verifyGmailMailboxBinding({ identity, connectionId: CASEY_CONNECTION, profileEmail: identity.accountEmail, observedAt: input.adoptedAt })
  const retainedEvidenceHash = assertSameRetainedGmailEvidence(cached, current)
  const result: GmailCaseyAdoption = { version: 1, kind: 'reviewed-casey-two-adoption-v1', originalMailboxProvenance: 'unknown',
    ownerEmail: CASEY_OWNER, inboundMessageId: scope.inboundMessageId, intakePipelineId: CASEY_INTAKE,
    messageId: current.messageId, threadId: LEGACY_THREAD, pipelineId: LEGACY_PIPELINE,
    primaryOrganizationId: scope.primaryOrganization.id, primaryOrganizationReference: scope.primaryOrganization.referenceCode,
    relatedOrganizationIds: scope.organizations.map(company => company.id).sort(),
    relatedOrganizationReferences: scope.organizations.map(company => company.referenceCode).sort(),
    selectedMessageIds: [...scope.messageIds].sort(), mailboxKey: gmailMailboxKey(identity),
    providerAccountId: identity.providerAccountId, accountEmail: identity.accountEmail,
    observedConnectionId: CASEY_CONNECTION, identityVerifiedAt: identity.verifiedAt,
    retainedEvidenceHash, currentEvidenceHash: gmailEvidenceHash(current) }
  assertCaseyGmailAdoption(result)
  return result
}

export function assertCaseyGmailAdoption(value: GmailCaseyAdoption): void {
  const keys = ['version','kind','originalMailboxProvenance','ownerEmail','inboundMessageId','intakePipelineId','messageId',
    'threadId','pipelineId','primaryOrganizationId','primaryOrganizationReference','relatedOrganizationIds','relatedOrganizationReferences',
    'selectedMessageIds','mailboxKey','providerAccountId','accountEmail','observedConnectionId','identityVerifiedAt','retainedEvidenceHash','currentEvidenceHash']
  if (!value || Object.keys(value).sort().join() !== keys.sort().join() || value.version !== 1
    || value.kind !== 'reviewed-casey-two-adoption-v1' || value.originalMailboxProvenance !== 'unknown'
    || value.ownerEmail !== CASEY_OWNER || value.observedConnectionId !== CASEY_CONNECTION || value.intakePipelineId !== CASEY_INTAKE
    || !CASEY_MESSAGES.includes(value.messageId) || value.inboundMessageId !== CASEY_CACHE_IDS[value.messageId]
    || value.threadId !== LEGACY_THREAD || value.pipelineId !== LEGACY_PIPELINE
    || !Array.isArray(value.selectedMessageIds) || value.selectedMessageIds.length !== 2
    || value.selectedMessageIds.some(id => typeof id !== 'string' || !CASEY_MESSAGES.includes(id))
    || [...value.selectedMessageIds].sort().join() !== [...CASEY_MESSAGES].sort().join()
    || typeof value.primaryOrganizationId !== 'string' || !value.primaryOrganizationId
    || value.primaryOrganizationId.trim() !== value.primaryOrganizationId || value.primaryOrganizationReference !== 'gagmco24va588e'
    || !Array.isArray(value.relatedOrganizationReferences) || value.relatedOrganizationReferences.length !== 2
    || [...value.relatedOrganizationReferences].sort().join() !== ['gagmco24va588e','gajl1dq5i03jga'].sort().join()
    || !Array.isArray(value.relatedOrganizationIds) || value.relatedOrganizationIds.length !== 2
    || value.relatedOrganizationIds.some(id => typeof id !== 'string' || !id || id.trim() !== id || id.length > 200)
    || new Set(value.relatedOrganizationIds).size !== 2 || !value.relatedOrganizationIds.includes(value.primaryOrganizationId)
    || !/^[a-f0-9]{64}$/.test(value.retainedEvidenceHash) || value.retainedEvidenceHash !== value.currentEvidenceHash
    || typeof value.providerAccountId !== 'string' || !value.providerAccountId || value.providerAccountId.length > 512
    || /[\u0000-\u001f\u007f]/.test(value.providerAccountId) || value.providerAccountId.trim() !== value.providerAccountId
    || value.mailboxKey !== `gmail:${gmailEvidenceHash(['gmail', value.providerAccountId])}`
    || typeof value.accountEmail !== 'string' || value.accountEmail.length > 254 || value.accountEmail.trim().toLowerCase() !== value.accountEmail
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.accountEmail)
    || typeof value.identityVerifiedAt !== 'string' || value.identityVerifiedAt.length > 64 || !Number.isFinite(Date.parse(value.identityVerifiedAt))) {
    throw new Error('Casey Gmail admission is outside the explicitly reviewed two-message scope')
  }
}

/** A contact change schedules only a selected finite set of actual-participant
 * messages. Neither quoted text nor shared thread identity expands the set. */
export function selectLateContactGmailMessages(input: {
  messageIds: string[]
  participantEmail: string
  messages: GmailMessageEvidence[]
}): GmailMessageEvidence[] {
  const selected = new Set(input.messageIds)
  const address = input.participantEmail.trim().toLowerCase()
  if (!selected.size || selected.size > 25 || selected.size !== input.messageIds.length
    || input.messageIds.some(id => !/^[a-f0-9]{1,128}$/i.test(id))
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
    || input.messages.length !== selected.size || new Set(input.messages.map(message => message.messageId)).size !== selected.size) {
    throw new Error('Late-contact reconciliation requires 1–25 exact unique Gmail message IDs and one participant email')
  }
  const messages = input.messages.map(message => {
    if (!selected.has(message.messageId) || message.emailAddressHeaders.from?.length !== 1
      || !(['from', 'to', 'cc', 'bcc'] as const).some(kind => message.emailAddressHeaders[kind]?.some(mailbox => mailbox.address === address))) {
      throw new Error('Late-contact reconciliation requires the exact email in actual message headers')
    }
    return message
  })
  return messages.sort((a, b) => a.messageId.localeCompare(b.messageId))
}
