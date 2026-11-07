import { gmailMailboxKey, verifyGmailMailboxBinding, type GmailMessageEvidence, type VerifiedGmailMailboxIdentity } from '@/lib/crm/emailIdentity'

export const CASEY_RETAINED_SCOPE = 'casey-reviewed-two-v1'
export const CASEY_FIRST_SEEN_SCOPE = 'casey-reviewed-two-first-seen-v1'
export type CaseyGmailScope = typeof CASEY_RETAINED_SCOPE | typeof CASEY_FIRST_SEEN_SCOPE

export const CASEY_PAIR = {
  ownerEmail: 'jarrett@suburbiasandwichco.com',
  connectionId: 'eb13a0fd-c0b2-4ad1-99b7-3bbda178a027',
  pipelineId: '587c8746-ecf6-40ae-8c50-e456f99ad555',
  threadId: '1a179e9e2743f926',
  mailboxKey: 'gmail:d5befcfd158c38e54e381a3bc3ac4d814f9e1874e4ba81e5f646226749526804',
  mailboxEmail: 'jarrett@bposupplychain.com',
  sender: 'casey@airspace.com',
  customerContact: 'jcook@globusmedical.com',
  primary: 'gagmco24va588e',
  secondary: 'gajl1dq5i03jga',
  messageIds: ['1a18e03ea586cd7e', '1a18f01749eb87a6'] as const,
} as const

export function isCaseyGmailScope(value: unknown): value is CaseyGmailScope {
  return value === CASEY_RETAINED_SCOPE || value === CASEY_FIRST_SEEN_SCOPE
}

export function matchesCaseyPair(value: { ownerEmail: string; connectionId: string; pipelineId: string; messageIds: readonly string[] }) {
  return value.ownerEmail === CASEY_PAIR.ownerEmail && value.connectionId === CASEY_PAIR.connectionId
    && value.pipelineId === CASEY_PAIR.pipelineId && [...value.messageIds].sort().join(',') === CASEY_PAIR.messageIds.join(',')
}

export function assertCaseyFirstSeenMailbox(identity: VerifiedGmailMailboxIdentity, observedAt = new Date().toISOString()) {
  if (gmailMailboxKey(identity) !== CASEY_PAIR.mailboxKey || identity.accountEmail !== CASEY_PAIR.mailboxEmail) {
    throw new Error('The selected Gmail mailbox does not match the reviewed Casey mailbox')
  }
  verifyGmailMailboxBinding({ identity, connectionId: CASEY_PAIR.connectionId, profileEmail: CASEY_PAIR.mailboxEmail, observedAt })
}

/** These are the two individually reviewed provider IDs, not a subject/thread rule.
 * Each current message must still have the same exact From/To placement. */
export function assertCaseyFirstSeenEvidence(input: { evidence: GmailMessageEvidence; labelIds: readonly string[] }) {
  const { evidence, labelIds } = input
  const headers = evidence.emailAddressHeaders
  const expectedTo: string[] = [CASEY_PAIR.customerContact]
  if (evidence.messageId === CASEY_PAIR.messageIds[0]) expectedTo.push(CASEY_PAIR.mailboxEmail)
  if (!(CASEY_PAIR.messageIds as readonly string[]).includes(evidence.messageId) || evidence.threadId !== CASEY_PAIR.threadId
    || evidence.senderEmail !== CASEY_PAIR.sender || headers.from?.length !== 1 || headers.from[0].address !== CASEY_PAIR.sender
    || headers.to?.map(address => address.address).sort().join(',') !== expectedTo.sort().join(',')
    || headers.cc?.length || headers.bcc?.length
    || !Array.isArray(labelIds) || labelIds.some(label => ['DRAFT', 'SPAM', 'TRASH', 'SENT'].includes(label))) {
    throw new Error('A Casey message no longer matches the reviewed provider evidence')
  }
}

export function assertCaseyFirstSeenPlacement(input: {
  primaryOrganization: { id: string; referenceCode: string }
  organizations: ReadonlyArray<{ id: string; referenceCode: string }>
  contacts: ReadonlyArray<{ email: string; organizationId: string }>
}) {
  const { primaryOrganization, organizations, contacts } = input
  const secondary = organizations.find(organization => organization.referenceCode === CASEY_PAIR.secondary)
  if (primaryOrganization.referenceCode !== CASEY_PAIR.primary || organizations.length !== 2
    || !organizations.some(organization => organization.id === primaryOrganization.id && organization.referenceCode === CASEY_PAIR.primary)
    || !secondary || secondary.id === primaryOrganization.id || contacts.length !== 2
    || !contacts.some(contact => contact.email === CASEY_PAIR.sender && contact.organizationId === secondary.id)
    || !contacts.some(contact => contact.email === CASEY_PAIR.customerContact && contact.organizationId === primaryOrganization.id)) {
    throw new Error('Casey review requires Globus as primary and Airspace as additional, with their exact participants')
  }
}
