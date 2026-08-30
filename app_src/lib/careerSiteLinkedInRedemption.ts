import crypto from 'node:crypto'

export type CareerSiteLinkedInRedemptionDisposition =
  | 'first'
  | 'idempotent'
  | 'adopt'
  | 'replay'

export function careerSiteLinkedInRedemptionLeaseDigest(leaseToken: string): string {
  return crypto.createHash('sha256').update(leaseToken, 'utf8').digest('hex')
}

export function classifyCareerSiteLinkedInRedemption(input: {
  redeemedAt: string | null
  redeemedLeaseDigest: string | null
  redeemedWorkerId: string | null
  currentLeaseToken: string
  currentWorkerId: string
  attempts: number
}): CareerSiteLinkedInRedemptionDisposition {
  if (!input.redeemedAt) return 'first'
  const currentLeaseDigest = careerSiteLinkedInRedemptionLeaseDigest(input.currentLeaseToken)
  if (input.redeemedLeaseDigest === currentLeaseDigest
    && input.redeemedWorkerId === input.currentWorkerId
  ) return 'idempotent'
  return input.attempts > 1 ? 'adopt' : 'replay'
}
