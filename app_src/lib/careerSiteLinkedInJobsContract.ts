import {
  CAREER_SITE_ORGANIZATION_ID,
  CAREER_SITE_OWNER_EMAIL,
  CAREER_SITE_SOURCE_APP,
} from '@/lib/careerSiteAgentContract'

// 202506 in older Maton examples is retired. Keep the version explicit and
// change it only after a read-only production capability probe.
export const CAREER_LINKEDIN_API_VERSION = '202605'
export const CAREER_LINKEDIN_JOBS_SOURCE = 'linkedin-job-library'
export const MAX_LINKEDIN_JOBS = 10
export const LINKEDIN_JOB_MAX_AGE_DAYS = 45
// Larger pages currently produce intermittent upstream 500s; three was
// verified against the connected account. Eight pages bound the total work.
export const LINKEDIN_JOBS_PAGE_SIZE = 3
export const LINKEDIN_JOBS_MAX_PAGES = 8

export class CareerSiteLinkedInJobsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'CAREER_SITE_LINKEDIN_JOBS_REQUEST_INVALID',
  ) {
    super(message)
    this.name = 'CareerSiteLinkedInJobsError'
  }
}

export type CareerSiteLinkedInJobsRequest = { query: string; maxJobs: number }

export type CareerSiteLinkedInJobCandidate = {
  externalJobId: string
  sourceUrl: string
  evidenceUrl: string
  title: string
  company: string
  location: string
  description: string
  postedAt: string
  observedAt: string
  availability: 'unverified'
}

export function parseCareerSiteLinkedInJobsRequest(value: unknown): CareerSiteLinkedInJobsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CareerSiteLinkedInJobsError('Request body must be a JSON object')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !['query', 'maxJobs'].includes(key))) {
    throw new CareerSiteLinkedInJobsError('Unsupported LinkedIn job search field')
  }
  const query = record.query === undefined ? 'supply chain' : record.query
  if (typeof query !== 'string' || !/^[a-z0-9][a-z0-9 '\"&/().,-]{0,179}$/i.test(query.trim())) {
    throw new CareerSiteLinkedInJobsError('query must be 1–180 characters of plain job-search text')
  }
  const maxJobs = record.maxJobs === undefined ? MAX_LINKEDIN_JOBS : record.maxJobs
  if (typeof maxJobs !== 'number' || !Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_LINKEDIN_JOBS) {
    throw new CareerSiteLinkedInJobsError(`maxJobs must be an integer from 1 to ${MAX_LINKEDIN_JOBS}`)
  }
  return { query: query.trim(), maxJobs }
}

export function resolveCareerSiteLinkedInJobsConfiguration() {
  if (
    process.env.CAREER_SITE_AGENTS_ENABLED !== '1'
    || String(process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL || '').trim().toLowerCase() !== CAREER_SITE_OWNER_EMAIL
    || String(process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID || '').trim().toLowerCase() !== CAREER_SITE_ORGANIZATION_ID
  ) {
    throw new CareerSiteLinkedInJobsError('Career Desk job sources are not configured', 503, 'CAREER_SITE_LINKEDIN_JOBS_CONFIGURATION_INVALID')
  }
  return { sourceApp: CAREER_SITE_SOURCE_APP, ownerEmail: CAREER_SITE_OWNER_EMAIL, organizationId: CAREER_SITE_ORGANIZATION_ID }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  return cleaned && cleaned.length <= maximum ? cleaned : null
}

// The archive searches body text, so a coordinator mentioning a director is
// not an executive vacancy. These are candidate gates, never a fit verdict.
const SENIOR_TITLE = /\b(?:director|vice president|[se]?vp|head of|chief|coo|cto|cio|general manager|president)\b/i
const TARGET_ADVISORY_ROLE = /\b(?:senior|principal|advisory)\s+(?:(?:advisory|technical|business|enterprise)\s+)?(?:solutions?\s+(?:sales\s+executive|consultant|consulting)|value\s+engineer(?:ing)?|(?:ai|artificial intelligence)\s+(?:transformation|strategy|enablement))\b/i
const OPERATIONS_TITLE = /\b(?:operations?|supply chain|logistics|distribution|fulfillment|manufacturing|business|enterprise|transformation|technology|coo|cto|cio|general manager|president|procurement|sourcing|purchasing|materials|inventory|value engineering|artificial intelligence|ai|solutions? (?:sales|consultant|consulting))\b/i
// Require the country, not ambiguous place names such as Georgia or London.
const US_LOCATION = /\b(?:United States(?: of America)?|USA|US)\b/i

export function normalizeCareerSiteLinkedInJob(value: unknown, observedAt: Date): CareerSiteLinkedInJobCandidate | null {
  const item = record(value)
  const details = record(item?.jobDetails)
  if (!item || item.isRestricted !== false || !details) return null
  const title = text(details.jobTitle, 240)
  const company = text(details.organizationName, 240)
  const location = text(details.jobLocation, 240)
  const description = text(details.jobDescription, 40_000)
  if (!title || !company || !location || !description || description.length < 100) return null
  if ((!SENIOR_TITLE.test(title) && !TARGET_ADVISORY_ROLE.test(title)) || !OPERATIONS_TITLE.test(title) || !US_LOCATION.test(location)) return null
  const posted = details.jobListTimeInMilliseconds
  if (typeof posted !== 'number' || !Number.isSafeInteger(posted)) return null
  const now = observedAt.getTime()
  if (!Number.isFinite(now) || posted > now + 86_400_000 || posted < now - LINKEDIN_JOB_MAX_AGE_DAYS * 86_400_000) return null
  if (
    (typeof details.jobCloseTimeInMilliseconds === 'number' && details.jobCloseTimeInMilliseconds > 0 && details.jobCloseTimeInMilliseconds <= now)
    || /^(?:closed|expired|removed)$/i.test(String(details.jobStatus || ''))
  ) return null
  let externalJobId: string
  try {
    const url = new URL(String(item.jobPostingUrl || ''))
    const match = url.pathname.match(/^\/ad-library\/job\/detail\/([1-9][0-9]{4,19})\/?$/)
    if (url.protocol !== 'https:' || url.hostname !== 'www.linkedin.com' || url.port || url.username || url.password || url.search || url.hash || !match) return null
    externalJobId = match[1]
  } catch { return null }
  return {
    externalJobId,
    sourceUrl: `https://www.linkedin.com/jobs/view/${externalJobId}`,
    evidenceUrl: `https://www.linkedin.com/ad-library/job/detail/${externalJobId}`,
    title, company, location, description,
    postedAt: new Date(posted).toISOString(),
    observedAt: observedAt.toISOString(),
    availability: 'unverified',
  }
}
