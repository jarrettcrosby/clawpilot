import {
  assertSameRetainedGmailEvidence, gmailEvidenceHash, gmailMailboxKey,
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
