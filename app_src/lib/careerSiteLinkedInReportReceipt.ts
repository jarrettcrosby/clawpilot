import crypto from 'node:crypto'

const SHA256_PATTERN = /^[0-9a-f]{64}$/

export type CareerSiteLinkedInReportReceipt = {
  bodyDigest: string
  leaseDigest: string
  workerId: string
  status: 'awaiting_auth' | 'running' | 'succeeded' | 'failed' | 'restricted'
}

export type StoredCareerSiteLinkedInReportReceipt = {
  last_report_body_digest: string | null
  last_report_lease_digest: string | null
  last_report_worker_id: string | null
  last_report_status: string | null
}

export function careerSiteLinkedInReportBodyDigest(rawBody: string): string {
  return crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex')
}

export function careerSiteLinkedInReportLeaseDigest(leaseToken: string): string {
  return crypto.createHash('sha256').update(leaseToken, 'utf8').digest('hex')
}

export function exactCareerSiteLinkedInReportReceipt(
  stored: StoredCareerSiteLinkedInReportReceipt,
  current: CareerSiteLinkedInReportReceipt,
): boolean {
  return SHA256_PATTERN.test(current.bodyDigest)
    && SHA256_PATTERN.test(current.leaseDigest)
    && stored.last_report_body_digest === current.bodyDigest
    && stored.last_report_lease_digest === current.leaseDigest
    && stored.last_report_worker_id === current.workerId
    && stored.last_report_status === current.status
}
